# Smart Labour Billing System

A simple billing system for your shop to prevent forgery with WhatsApp integration and daily PDF reports.

## Features

- ✅ Simple one-page interface
- ✅ Enter amount → Click OK → Show cart with payment options
- ✅ Cash & GPay payment buttons
- ✅ WhatsApp OTP notification on each order
- ✅ Auto-generated order tracking (e.g., "amount 500 # 1st order total till now 500")
- ✅ Daily PDF bill at 11 PM sent via WhatsApp
- ✅ Running total displayed for the day

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure WhatsApp (Twilio):
   - Create a `.env` file in the project root
   - Copy `.env.example` to `.env`
   - Fill in your Twilio credentials:
     - Get free account at https://www.twilio.com/
     - Account SID from Twilio console
     - Auth Token from Twilio console
     - Your WhatsApp number (format: whatsapp:+91XXXXXXXXXX)

3. Start the server:
```bash
npm start
```

4. Open browser: http://localhost:3000

## How It Works

1. **Enter Amount**: Type the bill amount and click OK
2. **Payment**: Choose Cash or GPay
3. **WhatsApp Notification**: You'll receive a message like:
   - "amount 500 # 1st order total till now 500"
4. **Daily Report**: At 11 PM, a PDF bill of all orders is sent to your WhatsApp

## Project Structure

```
SmartLabour/
├── server.js          # Express backend server
├── package.json       # Dependencies
├── billing.db         # SQLite database (auto-created)
├── public/
│   ├── index.html     # Frontend UI
│   ├── style.css      # Styling
│   └── script.js      # Frontend logic
├── .env.example       # Environment variables template
└── README.md          # This file
```

## API Endpoints

- `GET /api/summary` - Get today's total and order count
- `POST /api/order` - Add new order
- `POST /api/send-whatsapp` - Send WhatsApp message
- `GET /api/bill/:date` - Generate PDF bill for a date

## Notes

- The system runs in demo mode without Twilio credentials (messages won't be sent)
- PDF bills are saved in the `public/` folder
- Database is automatically created on first run
- Scheduler runs at 11 PM daily to generate and send PDF report
