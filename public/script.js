let currentAmount = 0;
let authToken = localStorage.getItem('authToken');
let shopName = localStorage.getItem('shopName');
let isProcessing = false;
let cooldownPeriod = 5000;

// DOM Elements
let amountInput, okBtn, amountSection, cartSection, cashBtn, gpayBtn, newOrderBtn;
let displayAmount, orderNumber, runningTotal, message, shopNameDisplay, logoutBtn, headerGrandTotal;
let confirmModal, confirmYes, confirmNo, confirmAmount, confirmMethod, recentOrdersList;
let statTotal, statCount;

document.addEventListener('DOMContentLoaded', () => {
    amountInput        = document.getElementById('amountInput');
    okBtn              = document.getElementById('okBtn');
    amountSection      = document.getElementById('amountSection');
    cartSection        = document.getElementById('cartSection');
    cashBtn            = document.getElementById('cashBtn');
    gpayBtn            = document.getElementById('gpayBtn');
    newOrderBtn        = document.getElementById('newOrderBtn');
    displayAmount      = document.getElementById('displayAmount');
    orderNumber        = document.getElementById('orderNumber');
    runningTotal       = document.getElementById('runningTotal');
    message            = document.getElementById('message');
    shopNameDisplay    = document.getElementById('shopNameDisplay');
    logoutBtn          = document.getElementById('logoutBtn');
    headerGrandTotal   = document.getElementById('headerGrandTotal');
    confirmModal       = document.getElementById('confirmModal');
    confirmYes         = document.getElementById('confirmYes');
    confirmNo          = document.getElementById('confirmNo');
    confirmAmount      = document.getElementById('confirmAmount');
    confirmMethod      = document.getElementById('confirmMethod');
    recentOrdersList   = document.getElementById('recentOrdersList');
    statTotal          = document.getElementById('statTotal');
    statCount          = document.getElementById('statCount');

    if (!authToken) {
        window.location.href = '/login.html';
    } else {
        shopNameDisplay.textContent = `📍 ${shopName}`;
        loadRecentOrders();
        updateHeaderTotal();
    }

    setupEventListeners();
});

function setupEventListeners() {
    // Logout
    logoutBtn.addEventListener('click', async () => {
        try {
            await fetch('/api/logout', {
                method: 'POST',
                headers: getAuthHeaders()
            });
        } catch (error) {
            console.error('Logout error:', error);
        }
        
        localStorage.removeItem('authToken');
        localStorage.removeItem('shopName');
        localStorage.removeItem('shopId');
        window.location.href = '/login.html';
    });

    // OK Button
    okBtn.addEventListener('click', async () => {
        const amount = parseFloat(amountInput.value);
        
        if (!amount || amount <= 0) {
            showMessage('Please enter a valid amount', 'error');
            return;
        }
        
        currentAmount = amount;
        displayAmount.textContent = amount.toFixed(2);
        
        try {
            const response = await fetch('/api/summary', {
                headers: getAuthHeaders()
            });
            
            if (response.status === 401) {
                window.location.href = '/login.html';
                return;
            }
            
            const data = await response.json();
            orderNumber.textContent = data.orderCount + 1;
            runningTotal.textContent = (data.total + amount).toFixed(2);
        } catch (error) {
            console.error('Error fetching summary:', error);
        }
        
        amountSection.classList.add('hidden');
        cartSection.classList.remove('hidden');
        showMessage('', '');
    });

    // Cash Button
    cashBtn.addEventListener('click', () => {
        if (isProcessing) return;
        showConfirmation('Cash');
    });

    // GPay Button
    gpayBtn.addEventListener('click', () => {
        if (isProcessing) return;
        showConfirmation('GPay');
    });

    // Confirm Yes
    confirmYes.addEventListener('click', async () => {
        closeModal();
        await processOrder(confirmMethod.textContent);
    });

    // Confirm No
    confirmNo.addEventListener('click', () => {
        closeModal();
    });

    // Close modal when clicking outside
    confirmModal.addEventListener('click', (e) => {
        if (e.target === confirmModal) {
            closeModal();
        }
    });

    // Close modal with Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !confirmModal.classList.contains('hidden')) {
            closeModal();
        }
    });

    // New Order Button
    newOrderBtn.addEventListener('click', () => {
        amountInput.value = '';
        cartSection.classList.add('hidden');
        amountSection.classList.remove('hidden');
        showMessage('', '');
    });

    // Allow Enter key to submit
    amountInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            okBtn.click();
        }
    });
}

// Get auth headers
function getAuthHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': authToken
    };
}

// Show confirmation modal
function showConfirmation(method) {
    confirmAmount.textContent = currentAmount.toFixed(2);
    confirmMethod.textContent = method;
    confirmModal.classList.remove('hidden');
}

// Close modal - globally accessible for inline onclick
window.closeModal = function() {
    if (confirmModal) {
        confirmModal.classList.add('hidden');
    }
};

// Process Order
async function processOrder(paymentMethod) {
    if (isProcessing) return;
    
    isProcessing = true;
    disablePaymentButtons(true);
    
    try {
        const response = await fetch('/api/order', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                amount: currentAmount,
                paymentMethod: paymentMethod
            })
        });
        
        if (response.status === 401) {
            window.location.href = '/login.html';
            return;
        }
        
        const data = await response.json();
        
        if (response.ok) {
            // Telegram is sent server-side in /api/order — no duplicate needed here
            showMessage(`✅ ${paymentMethod} payment successful! Order #${data.orderNumber}`, 'success');
            
            // Update display
            orderNumber.textContent = data.orderNumber;
            runningTotal.textContent = data.runningTotal.toFixed(2);
            
            // Reload recent orders & update header total
            loadRecentOrders();
            updateHeaderTotal();
            
            // Start cooldown
            startCooldown();
        } else {
            showMessage('❌ Error processing order', 'error');
            isProcessing = false;
            disablePaymentButtons(false);
        }
    } catch (error) {
        console.error('Error:', error);
        showMessage('❌ Error processing order', 'error');
        isProcessing = false;
        disablePaymentButtons(false);
    }
}

// Disable/enable payment buttons during cooldown
function disablePaymentButtons(disabled) {
    cashBtn.disabled = disabled;
    gpayBtn.disabled = disabled;
    
    if (disabled) {
        cashBtn.style.opacity = '0.5';
        gpayBtn.style.opacity = '0.5';
    } else {
        cashBtn.style.opacity = '1';
        gpayBtn.style.opacity = '1';
    }
}

function startCooldown() {
    let remaining = cooldownPeriod / 1000;
    cashBtn.textContent = `💵 Pay with Cash (${remaining}s)`;
    gpayBtn.textContent = `📱 Pay with GPay (${remaining}s)`;

    const interval = setInterval(() => {
        remaining--;
        cashBtn.textContent = `💵 Pay with Cash (${remaining}s)`;
        gpayBtn.textContent = `📱 Pay with GPay (${remaining}s)`;

        if (remaining <= 0) {
            clearInterval(interval);
            cashBtn.textContent = '💵 Pay with Cash';
            gpayBtn.textContent = '📱 Pay with GPay';
            isProcessing = false;
            disablePaymentButtons(false);
        }
    }, 1000);
}

// Send Telegram
async function sendTelegram(message) {
    try {
        const response = await fetch('/api/send-telegram', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ message })
        });
        
        const data = await response.json();
        console.log('Telegram response:', data);
    } catch (error) {
        console.error('Telegram error:', error);
    }
}

// Update header grand total badge + stat pills
async function updateHeaderTotal() {
    try {
        const response = await fetch('/api/summary', { headers: getAuthHeaders() });
        if (!response.ok) return;
        const data = await response.json();
        const total = (data.total || 0).toFixed(2);
        const count = data.orderCount || 0;
        // Header badge
        headerGrandTotal.textContent = `₹${total}`;
        headerGrandTotal.classList.add('updated');
        setTimeout(() => headerGrandTotal.classList.remove('updated'), 400);
        // Stat pills
        if (statTotal) statTotal.textContent = `₹${total}`;
        if (statCount) statCount.textContent = count;
    } catch (e) {
        console.error('Header total error:', e);
    }
}

// Load recent orders
async function loadRecentOrders() {
    try {
        const response = await fetch('/api/recent-orders', {
            headers: getAuthHeaders()
        });

        if (response.status === 401) {
            window.location.href = '/login.html';
            return;
        }

        const orders = await response.json();

        if (orders.length === 0) {
            recentOrdersList.innerHTML = '<p class="no-orders">No orders yet today</p>';
            return;
        }

        recentOrdersList.innerHTML = orders.map(order => {
            const time = new Date(order.timestamp + 'Z').toLocaleTimeString('en-IN', {
                hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata'
            });
            const isCash = order.payment_method === 'Cash';
            const badgeClass = isCash ? 'badge badge-cash' : 'badge badge-gpay';
            const badgeLabel = isCash ? '💵 Cash' : '📱 GPay';
            return `
                <div class="order-item">
                    <div class="order-time">${time} &nbsp;·&nbsp; #${order.order_number}</div>
                    <div class="order-details">
                        <span>₹${order.amount}</span>
                        <span class="${badgeClass}">${badgeLabel}</span>
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Error loading recent orders:', error);
    }
}

// Show message
function showMessage(text, type) {
    message.textContent = text;
    message.className = 'message';
    if (type) {
        message.classList.add(type);
    }
}

// ─── Report Password Gate ─────────────────────────────────────────────────────
let pendingReportType = null; // 'day' or 'month'

const reportAuthModal    = document.getElementById('reportAuthModal');
const reportAuthPassword = document.getElementById('reportAuthPassword');
const reportAuthError    = document.getElementById('reportAuthError');
const reportAuthConfirm  = document.getElementById('reportAuthConfirm');
const reportAuthTitle    = document.getElementById('reportAuthTitle');
const reportAuthDesc     = document.getElementById('reportAuthDesc');

// Open the password modal for a given report type
function showReportAuth(type) {
    pendingReportType = type;
    reportAuthPassword.value = '';
    reportAuthError.classList.add('hidden');
    reportAuthTitle.textContent = type === 'day' ? '📅 Day Report' : '📆 Monthly Report';
    reportAuthDesc.textContent  = `Enter your password to send the ${type === 'day' ? 'Day' : 'Monthly'} Report for ${shopName}.`;
    reportAuthModal.classList.remove('hidden');
    setTimeout(() => reportAuthPassword.focus(), 120);
}

// Close the password modal
window.closeReportModal = function () {
    reportAuthModal.classList.add('hidden');
    pendingReportType = null;
    reportAuthPassword.value = '';
    reportAuthError.classList.add('hidden');
};

// Allow Enter key to submit in the password field
reportAuthPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') reportAuthConfirm.click();
});

// Confirm button — verify password then fire the report
reportAuthConfirm.addEventListener('click', async () => {
    const pwd = reportAuthPassword.value.trim();
    if (!pwd) {
        reportAuthError.textContent = '⚠️ Please enter your password.';
        reportAuthError.classList.remove('hidden');
        return;
    }

    // Show loading state
    reportAuthConfirm.textContent = 'Verifying…';
    reportAuthConfirm.disabled = true;
    reportAuthError.classList.add('hidden');

    try {
        // Verify password via the login endpoint
        const verifyRes = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shopName, password: pwd })
        });
        const verifyData = await verifyRes.json();

        if (!verifyRes.ok || !verifyData.success) {
            // Wrong password — shake the error in
            reportAuthError.textContent = '❌ Incorrect password. Please try again.';
            reportAuthError.classList.remove('hidden');
            // Re-trigger shake animation
            reportAuthError.style.animation = 'none';
            reportAuthError.offsetHeight; // reflow
            reportAuthError.style.animation = '';
            reportAuthPassword.value = '';
            reportAuthPassword.focus();
            reportAuthConfirm.textContent = 'Send Report →';
            reportAuthConfirm.disabled = false;
            return;
        }

        // Password correct — close modal and fire report
        closeReportModal();
        if (pendingReportType === 'day') {
            await runDayReport();
        } else {
            await runMonthReport();
        }
    } catch (err) {
        reportAuthError.textContent = '❌ Network error. Please try again.';
        reportAuthError.classList.remove('hidden');
        reportAuthConfirm.textContent = 'Send Report →';
        reportAuthConfirm.disabled = false;
    } finally {
        if (!reportAuthModal.classList.contains('hidden')) {
            reportAuthConfirm.textContent = 'Send Report →';
            reportAuthConfirm.disabled = false;
        }
    }
});

// Wire report buttons → open password modal
document.getElementById('dayReportBtn').addEventListener('click', () => showReportAuth('day'));
document.getElementById('monthReportBtn').addEventListener('click', () => showReportAuth('month'));

// ── Actual report API calls (called after password verified) ──
async function runDayReport() {
    const reportStatus = document.getElementById('reportStatus');
    reportStatus.textContent = `Generating Day Report for ${shopName}…`;
    reportStatus.className = 'report-status';

    try {
        const response = await fetch('/api/my-daily-report', {
            method: 'POST',
            headers: getAuthHeaders()
        });
        const data = await response.json();

        if (data.success) {
            reportStatus.textContent = `✅ Day Report sent for ${shopName}!`;
            reportStatus.className = 'report-status success';
        } else {
            reportStatus.textContent = `⚠️ ${data.message}`;
            reportStatus.className = 'report-status error';
        }
    } catch (error) {
        console.error('Error:', error);
        reportStatus.textContent = '❌ Error generating Day Report';
        reportStatus.className = 'report-status error';
    }
    setTimeout(() => { reportStatus.textContent = ''; reportStatus.className = 'report-status'; }, 6000);
}

async function runMonthReport() {
    const reportStatus = document.getElementById('reportStatus');
    reportStatus.textContent = `Generating Monthly Report for ${shopName}…`;
    reportStatus.className = 'report-status';

    try {
        const response = await fetch('/api/my-monthly-report', {
            method: 'POST',
            headers: getAuthHeaders()
        });
        const data = await response.json();

        if (data.success) {
            reportStatus.textContent = `✅ Monthly Report sent for ${shopName}!`;
            reportStatus.className = 'report-status success';
        } else {
            reportStatus.textContent = `⚠️ ${data.message}`;
            reportStatus.className = 'report-status error';
        }
    } catch (error) {
        console.error('Error:', error);
        reportStatus.textContent = '❌ Error generating Monthly Report';
        reportStatus.className = 'report-status error';
    }
    setTimeout(() => { reportStatus.textContent = ''; reportStatus.className = 'report-status'; }, 6000);
}
