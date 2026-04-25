require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const PDFDocument = require('pdfkit');
const fs = require('fs');
const cron = require('node-cron');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
// Disable caching for static files so JS/CSS changes are always picked up
app.use(express.static('public', {
    etag: false,
    lastModified: false,
    setHeaders(res) {
        res.setHeader('Cache-Control', 'no-store');
    }
}));

// ─── Telegram Config ──────────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

// Send Telegram via direct HTTP (no library = no ETIMEDOUT bug)
async function sendTelegramMessage(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn('Telegram not configured – skipping send');
        return false;
    }

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await axios.post(url, {
                chat_id: TELEGRAM_CHAT_ID,
                text,
                parse_mode: 'HTML'
            }, { timeout: 15000 });
            console.log(`✅ Telegram sent (attempt ${attempt})`);
            return true;
        } catch (err) {
            const errMsg = err.response?.data?.description || err.message;
            console.error(`❌ Telegram attempt ${attempt} failed: ${errMsg}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
        }
    }
    return false;
}

console.log('Telegram configured via direct HTTP API');

// ─── Google Sheets Config ─────────────────────────────────────────────────────
// Reads GOOGLE_SERVICE_ACCOUNT_JSON env var (base64-encoded JSON) for cloud deploy,
// or falls back to local google-service-account.json for local dev.
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
const SERVICE_ACCOUNT_FILE = path.join(__dirname, 'google-service-account.json');

let sheetsClient = null;

async function getSheetsClient() {
    if (sheetsClient) return sheetsClient;
    try {
        let credentials = null;

        // 1. Try env var first (cloud deployment)
        if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
            const decoded = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, 'base64').toString('utf8');
            credentials = JSON.parse(decoded);
        }
        // 2. Fall back to local file (local dev)
        else if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
            credentials = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8'));
        }
        else {
            console.warn('⚠️  No Google service account found – Google Sheets disabled');
            return null;
        }

        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        sheetsClient = google.sheets({ version: 'v4', auth });
        console.log('✅ Google Sheets client initialised');
        return sheetsClient;
    } catch (err) {
        console.error('Google Sheets init error:', err.message);
        return null;
    }
}

// ── Shop names (must match DB exactly) ──
const SHOP_NAMES = ['Araku Valley', 'Chintapallee', 'Paderu', 'Semiliguda'];

// ── Column headers ──
const DAILY_SHOP_HEADERS = ['Date', 'Total Orders', 'Cash Orders', 'Cash Total (₹)', 'GPay Orders', 'GPay Total (₹)', 'Grand Total (₹)'];
const MONTH_HEADERS      = ['Month', 'Shop', 'Total Orders', 'Cash Orders', 'Cash Total (₹)', 'GPay Orders', 'GPay Total (₹)', 'Grand Total (₹)'];

// ── On startup: clear ALL existing tabs and rebuild fresh ──
async function clearAndSetupSheets() {
    if (!GOOGLE_SHEET_ID) return;
    const sheets = await getSheetsClient();
    if (!sheets) return;
    try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEET_ID });
        const existingSheets = meta.data.sheets;

        // Add any missing required tabs
        const requiredTabs = [...SHOP_NAMES, 'Monthly Reports'];
        const addRequests = requiredTabs
            .filter(name => !existingSheets.find(s => s.properties.title === name))
            .map(name => ({ addSheet: { properties: { title: name } } }));
        if (addRequests.length > 0) {
            await sheets.spreadsheets.batchUpdate({ spreadsheetId: GOOGLE_SHEET_ID, requestBody: { requests: addRequests } });
        }

        // Get fresh list after adding
        const updatedMeta = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEET_ID });
        const updatedSheets = updatedMeta.data.sheets;

        // Delete any tab NOT in our required list (e.g. Sheet1, old tabs)
        const keepTabs = new Set(requiredTabs);
        const deleteRequests = updatedSheets
            .filter(s => !keepTabs.has(s.properties.title))
            .map(s => ({ deleteSheet: { sheetId: s.properties.sheetId } }));
        if (deleteRequests.length > 0 && deleteRequests.length < updatedSheets.length) {
            await sheets.spreadsheets.batchUpdate({ spreadsheetId: GOOGLE_SHEET_ID, requestBody: { requests: deleteRequests } });
        }

        // Clear and write headers for each shop daily tab
        for (const tabName of SHOP_NAMES) {
            await sheets.spreadsheets.values.clear({ spreadsheetId: GOOGLE_SHEET_ID, range: `'${tabName}'!A:Z` });
            await sheets.spreadsheets.values.update({
                spreadsheetId: GOOGLE_SHEET_ID,
                range: `'${tabName}'!A1`,
                valueInputOption: 'RAW',
                requestBody: { values: [DAILY_SHOP_HEADERS] }
            });
        }

        // Clear and write headers for Monthly Reports tab
        await sheets.spreadsheets.values.clear({ spreadsheetId: GOOGLE_SHEET_ID, range: `'Monthly Reports'!A:Z` });
        await sheets.spreadsheets.values.update({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: `'Monthly Reports'!A1`,
            valueInputOption: 'RAW',
            requestBody: { values: [MONTH_HEADERS] }
        });

        console.log('✅ Google Sheets cleared and set up fresh (shop daily tabs + Monthly Reports tab)');
    } catch (err) {
        console.error('Setup sheets error:', err.message);
    }
}

// ── Append ONE daily summary row to the shop's tab (called at 11 PM cron) ──
async function appendDailyReportToSheet(shopName, date, data) {
    if (!GOOGLE_SHEET_ID) return;
    const sheets = await getSheetsClient();
    if (!sheets) return;
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: `'${shopName}'!A:G`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: {
                values: [[date, data.totalOrders, data.cashOrders, data.cashTotal, data.gpayOrders, data.gpayTotal, data.grandTotal]]
            }
        });
        console.log(`✅ Daily report for "${shopName}" on ${date} written to Sheets`);
    } catch (err) {
        console.error(`Daily report sheet error (${shopName}):`, err.message);
    }
}

// ── Append monthly summary rows to "Monthly Reports" tab ──
async function appendMonthlyReportToSheet(month, allShopsData) {
    if (!GOOGLE_SHEET_ID) return;
    const sheets = await getSheetsClient();
    if (!sheets) return;
    try {
        const rows = [];
        for (const s of allShopsData) {
            rows.push([month, s.shopName, s.totalOrders, s.cashOrders, s.cashTotal, s.gpayOrders, s.gpayTotal, s.grandTotal]);
        }
        // Grand total row
        const totalOrders = allShopsData.reduce((s, x) => s + x.totalOrders, 0);
        const cashOrders  = allShopsData.reduce((s, x) => s + x.cashOrders,  0);
        const cashTotal   = allShopsData.reduce((s, x) => s + x.cashTotal,   0);
        const gpayOrders  = allShopsData.reduce((s, x) => s + x.gpayOrders,  0);
        const gpayTotal   = allShopsData.reduce((s, x) => s + x.gpayTotal,   0);
        const grandTotal  = allShopsData.reduce((s, x) => s + x.grandTotal,  0);
        rows.push(['', '', '', '', '', '', '', '']);
        rows.push([month, '🏆 GRAND TOTAL', totalOrders, cashOrders, cashTotal, gpayOrders, gpayTotal, grandTotal]);

        await sheets.spreadsheets.values.append({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: `'Monthly Reports'!A:H`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values: rows }
        });
        console.log(`✅ Monthly report for ${month} written to "Monthly Reports" tab`);
    } catch (err) {
        console.error('Monthly report sheet error:', err.message);
    }
}



// ─── SQLite Database ──────────────────────────────────────────────────────────
const dbPath = process.env.DB_PATH || './billing.db';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log(`Connected to SQLite database at ${dbPath}`);
        initializeDatabase();
    }
});

function initializeDatabase() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS shops (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            amount REAL NOT NULL,
            payment_method TEXT NOT NULL,
            order_number INTEGER NOT NULL,
            running_total REAL NOT NULL,
            shop_id INTEGER NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (shop_id) REFERENCES shops(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS daily_totals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date DATE NOT NULL,
            shop_id INTEGER NOT NULL,
            total_amount REAL NOT NULL,
            order_count INTEGER NOT NULL,
            FOREIGN KEY (shop_id) REFERENCES shops(id)
        )`);

        const shops = [
            { name: 'Araku Valley',  password: 'gokulnath@1984' },
            { name: 'Chintapallee', password: 'gokulnath@1984' },
            { name: 'Paderu',        password: 'gokulnath@1984' },
            { name: 'Semiliguda',    password: 'gokulnath@1984' }
        ];

        shops.forEach(shop => {
            db.run('INSERT OR IGNORE INTO shops (name, password) VALUES (?, ?)',
                [shop.name, shop.password], (err) => {
                    if (err) console.error('Error inserting shop:', err);
                });
        });
    });
}

// ─── Session Storage ──────────────────────────────────────────────────────────
const sessions = new Map();

function authenticate(req, res, next) {
    const token = req.headers.authorization;
    if (!token || !sessions.has(token)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    req.shopId   = sessions.get(token).shopId;
    req.shopName = sessions.get(token).shopName;
    next();
}

// ─── Helper ───────────────────────────────────────────────────────────────────
function getOrdinalSuffix(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
}

function getISTDateStr() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function getISTMonthStr() {
    return getISTDateStr().slice(0, 7);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Serve login.html as default
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Login
app.post('/api/login', (req, res) => {
    const { shopName, password } = req.body;
    db.get('SELECT * FROM shops WHERE name = ? AND password = ?', [shopName, password], (err, row) => {
        if (err)  return res.status(500).json({ error: err.message });
        if (!row) return res.status(401).json({ error: 'Invalid shop name or password' });

        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { shopId: row.id, shopName: row.name });
        res.json({ success: true, token, shopName: row.name, shopId: row.id });
    });
});

// Logout
app.post('/api/logout', (req, res) => {
    const token = req.headers.authorization;
    if (token) sessions.delete(token);
    res.json({ success: true });
});

// Get summary
app.get('/api/summary', authenticate, (req, res) => {
    const today  = getISTDateStr();
    const shopId = req.shopId;
    db.get(
        'SELECT SUM(amount) as total, COUNT(*) as count FROM orders WHERE DATE(timestamp, \'+5 hours\', \'+30 minutes\') = ? AND shop_id = ?',
        [today, shopId],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ total: row.total || 0, orderCount: row.count || 0, shopName: req.shopName });
        }
    );
});

// Add new order → save to DB, send Telegram, update Google Sheets
app.post('/api/order', authenticate, (req, res) => {
    const { amount, paymentMethod } = req.body;
    const shopId   = req.shopId;
    const shopName = req.shopName;
    const today    = getISTDateStr();

    db.get(
        'SELECT COUNT(*) as count, SUM(amount) as total FROM orders WHERE DATE(timestamp, \'+5 hours\', \'+30 minutes\') = ? AND shop_id = ?',
        [today, shopId],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });

            const orderNumber  = (row.count || 0) + 1;
            const runningTotal = (row.total || 0) + parseFloat(amount);

            db.run(
                'INSERT INTO orders (amount, payment_method, order_number, running_total, shop_id) VALUES (?, ?, ?, ?, ?)',
                [amount, paymentMethod, orderNumber, runningTotal, shopId],
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });

                    const orderId = this.lastID;

                    db.all(
                        'SELECT payment_method, COUNT(*) as count, SUM(amount) as total FROM orders WHERE DATE(timestamp, \'+5 hours\', \'+30 minutes\') = ? AND shop_id = ? GROUP BY payment_method',
                        [today, shopId],
                        async (err, rows) => {
                            const cashCount = rows?.find(r => r.payment_method === 'Cash')?.count || 0;
                            const gpayCount = rows?.find(r => r.payment_method === 'GPay')?.count  || 0;
                            const cashTotal = rows?.find(r => r.payment_method === 'Cash')?.total || 0;
                            const gpayTotal = rows?.find(r => r.payment_method === 'GPay')?.total  || 0;

                            const tgMessage =
`🛒 <b>SAI KRISHNA HOT CHIPS</b>

📍 Shop: ${shopName}
💰 Amount: ₹${amount}
📦 Order: #${orderNumber}${getOrdinalSuffix(orderNumber)}
💳 Payment: ${paymentMethod}
📊 Total Till Now: ₹${runningTotal}

💵 Cash: ${cashCount} orders (₹${cashTotal})
📱 GPay: ${gpayCount} orders (₹${gpayTotal})`;

                            // Fire-and-forget: Telegram notification only (Sheets updated at 11 PM via cron)
                            sendTelegramMessage(tgMessage).catch(e => console.error(e));

                            res.json({
                                orderId, orderNumber, runningTotal, shopName,
                                message: tgMessage.replace(/<[^>]+>/g, '') // plain-text for frontend
                            });
                        }
                    );
                }
            );
        }
    );
});

// Manual Telegram send (used by frontend)
app.post('/api/send-telegram', async (req, res) => {
    const { message } = req.body;
    const ok = await sendTelegramMessage(message);
    if (ok) {
        res.json({ success: true, message: 'Telegram sent successfully' });
    } else {
        res.status(500).json({ error: 'Telegram send failed – check BOT_TOKEN and CHAT_ID' });
    }
});

// Recent orders
app.get('/api/recent-orders', authenticate, (req, res) => {
    const shopId = req.shopId;
    const today  = getISTDateStr();
    db.all(
        'SELECT * FROM orders WHERE shop_id = ? AND DATE(timestamp, \'+5 hours\', \'+30 minutes\') = ? ORDER BY timestamp DESC LIMIT 10',
        [shopId, today],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// Generate PDF bill
app.get('/api/bill/:date', async (req, res) => {
    const date = req.params.date;
    db.all('SELECT * FROM orders WHERE DATE(timestamp, \'+5 hours\', \'+30 minutes\') = ? ORDER BY timestamp', [date], async (err, rows) => {
        if (err)          return res.status(500).json({ error: err.message });
        if (!rows.length) return res.status(404).json({ error: 'No orders found for this date' });

        const doc      = new PDFDocument();
        const filename = `bill_${date}.pdf`;
        const filepath = path.join(__dirname, 'public', filename);
        doc.pipe(fs.createWriteStream(filepath));

        doc.fontSize(20).text('SAI KRISHNA HOT CHIPS', { align: 'center' });
        doc.moveDown();
        doc.fontSize(14).text(`Date: ${date}`, { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text('Order No | Amount | Payment Method | Time');
        doc.text('---------|--------|----------------|------');

        let grandTotal = 0;
        rows.forEach(order => {
            const time = new Date(order.timestamp + 'Z').toLocaleTimeString('en-IN', {
                hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata'
            });
            doc.text(`${order.order_number} | ₹${order.amount} | ${order.payment_method} | ${time}`);
            grandTotal += order.amount;
        });

        doc.moveDown();
        doc.fontSize(16).text(`Total Orders: ${rows.length}`, { align: 'right' });
        doc.text(`Grand Total: ₹${grandTotal}`, { align: 'right' });
        doc.end();
        doc.on('end', () => res.json({ success: true, filename, url: `/${filename}` }));
    });
});

// ─── Daily Report ─────────────────────────────────────────────────────────────
// Returns shop data object so caller can aggregate grand totals
async function generateAndSendDailyBill(shop, date) {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT * FROM orders WHERE shop_id = ? AND DATE(timestamp, \'+5 hours\', \'+30 minutes\') = ? ORDER BY timestamp',
            [shop.id, date],
            async (err, rows) => {
                if (err) { console.error(err); return reject(err); }
                if (!rows.length) { console.log(`No orders for ${shop.name} on ${date}`); return resolve(null); }

                const cashOrders = rows.filter(r => r.payment_method === 'Cash').length;
                const gpayOrders = rows.filter(r => r.payment_method === 'GPay').length;
                const cashTotal  = rows.filter(r => r.payment_method === 'Cash').reduce((s, r) => s + r.amount, 0);
                const gpayTotal  = rows.filter(r => r.payment_method === 'GPay').reduce((s, r) => s + r.amount, 0);
                const grandTotal = cashTotal + gpayTotal;

                let orderDetails = '';
                rows.forEach(order => {
                    const time = new Date(order.timestamp + 'Z').toLocaleTimeString('en-IN', {
                        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata'
                    });
                    orderDetails += `Order #${order.order_number} | ₹${order.amount} | ${order.payment_method} | ${time}\n`;
                });

                const message =
`📊 <b>SAI KRISHNA HOT CHIPS – DAILY REPORT</b>

📍 Shop: ${shop.name}
📅 Date: ${date}
📦 Total Orders: ${rows.length}
💰 Grand Total: ₹${grandTotal}

💵 Cash: ${cashOrders} orders (₹${cashTotal})
📱 GPay: ${gpayOrders} orders (₹${gpayTotal})

📋 Order Details:
${orderDetails}`;

                await sendTelegramMessage(message);

                // Daily report: Telegram only — orders are already logged instantly to shop tab
                console.log(`Daily Telegram report sent for ${shop.name}`);
                resolve({ shopName: shop.name, totalOrders: rows.length, grandTotal, cashOrders, cashTotal, gpayOrders, gpayTotal });
            }
        );
    });
}


// ─── Monthly Report ───────────────────────────────────────────────────────────
// Returns shop summary object for aggregation into Google Sheets monthly totals
async function generateAndSendMonthlyBill(shop, month) {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT * FROM orders WHERE shop_id = ? AND strftime("%Y-%m", timestamp, \'+5 hours\', \'+30 minutes\') = ? ORDER BY timestamp',
            [shop.id, month],
            async (err, rows) => {
                if (err) { console.error(err); return reject(err); }
                if (!rows.length) {
                    console.log(`No orders for ${shop.name} in ${month}`);
                    return resolve(null);
                }

                const cashOrders = rows.filter(r => r.payment_method === 'Cash').length;
                const gpayOrders = rows.filter(r => r.payment_method === 'GPay').length;
                const cashTotal  = rows.filter(r => r.payment_method === 'Cash').reduce((s, r) => s + r.amount, 0);
                const gpayTotal  = rows.filter(r => r.payment_method === 'GPay').reduce((s, r) => s + r.amount, 0);
                const grandTotal = cashTotal + gpayTotal;

                const message =
`📊 <b>SAI KRISHNA HOT CHIPS – MONTHLY REPORT</b>

📍 Shop: ${shop.name}
📅 Month: ${month}
📦 Total Orders: ${rows.length}
💰 Grand Total: ₹${grandTotal}

💵 Cash: ${cashOrders} orders (₹${cashTotal})
📱 GPay: ${gpayOrders} orders (₹${gpayTotal})`;

                await sendTelegramMessage(message);
                console.log(`Monthly Telegram report sent for ${shop.name}`);

                // Return data for Google Sheets monthly totals block
                resolve({ shopName: shop.name, totalOrders: rows.length, grandTotal, cashOrders, cashTotal, gpayOrders, gpayTotal });
            }
        );
    });
}

// ─── Manual Trigger Endpoints ─────────────────────────────────────────────────
app.post('/api/test-daily-report', async (req, res) => {
    const today = getISTDateStr();
    console.log(`Manual trigger: daily report for ${today}`);
    try {
        db.all('SELECT * FROM shops', async (err, shops) => {
            if (err) return res.status(500).json({ error: err.message });
            for (const shop of shops) {
                const data = await generateAndSendDailyBill(shop, today);
                if (data) await appendDailyReportToSheet(shop.name, today, data);
            }
            res.json({ success: true, message: 'Daily report sent via Telegram + written to Sheets' });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/test-monthly-report', async (req, res) => {
    const month = getISTMonthStr();
    console.log(`Manual trigger: monthly report for ${month}`);
    try {
        db.all('SELECT * FROM shops', async (err, shops) => {
            if (err) return res.status(500).json({ error: err.message });
            const results = [];
            for (const shop of shops) {
                const data = await generateAndSendMonthlyBill(shop, month);
                if (data) results.push(data);
            }
            if (results.length > 0) await appendMonthlyReportToSheet(month, results);
            res.json({ success: true, message: 'Monthly report sent via Telegram + written to Monthly Reports tab' });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ─── Per-Shop Manual Report Endpoints (used by frontend buttons) ──────────────

// Day report for the logged-in shop only
app.post('/api/my-daily-report', authenticate, async (req, res) => {
    const today    = getISTDateStr();
    const shopId   = req.shopId;
    const shopName = req.shopName;
    console.log(`Manual trigger: daily report for shop "${shopName}" on ${today}`);
    try {
        const data = await generateAndSendDailyBill({ id: shopId, name: shopName }, today);
        if (data) {
            res.json({ success: true, message: `Daily report sent for ${shopName}` });
        } else {
            res.json({ success: false, message: `No orders found for ${shopName} today` });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Monthly report for the logged-in shop only
app.post('/api/my-monthly-report', authenticate, async (req, res) => {
    const month    = getISTMonthStr();
    const shopId   = req.shopId;
    const shopName = req.shopName;
    console.log(`Manual trigger: monthly report for shop "${shopName}" in ${month}`);
    try {
        const data = await generateAndSendMonthlyBill({ id: shopId, name: shopName }, month);
        if (data) {
            res.json({ success: true, message: `Monthly report sent for ${shopName}` });
        } else {
            res.json({ success: false, message: `No orders found for ${shopName} in ${month}` });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ─── Reset Helper ─────────────────────────────────────────────────────────────
// Deletes all orders for a given date so each new day starts fresh (order #1, ₹0)
function resetDailyOrders(date) {
    return new Promise((resolve, reject) => {
        db.run('DELETE FROM orders WHERE DATE(timestamp, \'+5 hours\', \'+30 minutes\') = ?', [date], function (err) {
            if (err) {
                console.error(`❌ Reset failed for ${date}:`, err.message);
                return reject(err);
            }
            console.log(`🗑️  Reset complete: deleted ${this.changes} order(s) for ${date}`);
            resolve(this.changes);
        });
    });
}

// ─── Cron Jobs ────────────────────────────────────────────────────────────────
// Runs every night at 11 PM IST:
//   1. If last day of month → send monthly report via Telegram + write to "Monthly Reports" tab
//   2. Send daily report for every shop via Telegram + append summary row to shop's own tab
//   3. Delete today's orders so tomorrow starts at Order #1 / ₹0
cron.schedule('0 23 * * *', async () => {
    const dateStr = getISTDateStr();
    const month   = getISTMonthStr();
    
    // Calculate if today is the last day of the month in IST
    const todayObj  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const lastDay   = new Date(todayObj.getFullYear(), todayObj.getMonth() + 1, 0).getDate();
    const isLastDay = todayObj.getDate() === lastDay;

    console.log(`\n🕚 CRON 11 PM IST — ${dateStr} | Last day of month: ${isLastDay}`);

    try {
        const shops = await new Promise((res, rej) =>
            db.all('SELECT * FROM shops', (err, rows) => err ? rej(err) : res(rows))
        );

        // ── Step 1: Monthly report first (data must exist before reset) ────────
        if (isLastDay) {
            console.log(`📆 Sending monthly report for ${month}...`);
            const results = [];
            for (const shop of shops) {
                const data = await generateAndSendMonthlyBill(shop, month);
                if (data) results.push(data);
            }
            if (results.length > 0) await appendMonthlyReportToSheet(month, results);
            console.log(`✅ Monthly reports done for ${month}`);
        }

        // ── Step 2: Daily reports – Telegram + write summary to shop's Sheets tab
        console.log(`📅 Sending daily reports for ${dateStr}...`);
        for (const shop of shops) {
            const data = await generateAndSendDailyBill(shop, dateStr);
            if (data) await appendDailyReportToSheet(shop.name, dateStr, data);
        }
        console.log(`✅ Daily reports done for ${dateStr}`);

        // ── Step 3: Reset – delete today's orders so tomorrow starts fresh ─────
        await resetDailyOrders(dateStr);
        console.log(`✅ Orders reset. Tomorrow starts at Order #1 / ₹0\n`);

    } catch (err) {
        console.error('❌ CRON error:', err.message);
    }
}, {
    timezone: "Asia/Kolkata"
});

// ─── Start Server ───────────────────────────────────────────────────────────
app.listen(PORT, async () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`📊 Google Sheets ID: ${GOOGLE_SHEET_ID || 'NOT SET – add GOOGLE_SHEET_ID to .env'}`);
    console.log(`📱 Telegram Chat ID: ${TELEGRAM_CHAT_ID || 'NOT SET'}`);
    // Clear all existing sheet data and set up fresh shop tabs
    await clearAndSetupSheets();
});
