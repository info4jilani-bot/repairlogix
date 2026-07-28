const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Limit to 10mb for base64 signatures
app.use(express.static('public'));

// Initialize SQLite Database
const db = new Database('repairlogix.db');
db.pragma('journal_mode = WAL');

// Create Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_name TEXT,
    customer_phone TEXT,
    device_model TEXT,
    issue TEXT,
    repair_cost INTEGER,
    station_cut INTEGER,
    cashier_cut INTEGER,
    driver_cut INTEGER,
    tech_cut INTEGER,
    business_cut INTEGER,
    status TEXT DEFAULT 'DROPPED_AT_STATION',
    signature_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// --- DYNAMIC FINANCIAL RULES ENGINE ---
function calculatePayouts(cost) {
  const repairCost = parseInt(cost);
  const stationCut = repairCost >= 100 ? 10 : 0;
  const cashierCut = 5;
  const driverCut = 7;
  const techCut = Math.round(repairCost * 0.75);
  const totalPayouts = stationCut + cashierCut + driverCut + techCut;
  
  let businessCut = repairCost - totalPayouts;
  
  // Prevent negative business margin. 
  let isProfitable = true;
  if (businessCut < 0) {
    businessCut = 0;
    isProfitable = false;
  }

  return { repairCost, stationCut, cashierCut, driverCut, techCut, businessCut, isProfitable };
}

// --- API ROUTES ---

// Get all orders
app.get('/api/orders', (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  res.json(orders);
});

// Create new order
app.post('/api/orders', (req, res) => {
  const { customerName, customerPhone, deviceModel, issue, repairCost, signatureBase64 } = req.body;

  if (!customerName || !customerPhone || !deviceModel || !issue || !repairCost) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (repairCost < 30 || repairCost > 350) {
    return res.status(400).json({ error: "Repair cost must be between $30 and $350" });
  }

  // 1. Calculate Dynamic Payouts
  const payouts = calculatePayouts(repairCost);
  if (!payouts.isProfitable) {
    return res.status(400).json({ error: "Repair cost too low. Minimum $50 required to cover flat payouts." });
  }

  // 2. Save Signature Image to Server
  let signatureUrl = null;
  if (signatureBase64) {
    const base64Data = signatureBase64.replace(/^data:image\/png;base64,/, "");
    const fileName = `sig_${Date.now()}.png`;
    const uploadDir = path.join(__dirname, 'public', 'uploads');
    
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    
    fs.writeFileSync(path.join(uploadDir, fileName), base64Data, 'base64');
    signatureUrl = `/uploads/${fileName}`;
  }

  // 3. Save to Database
  const id = `RLX-${Date.now().toString(36).toUpperCase()}`;
  const stmt = db.prepare(`
    INSERT INTO orders (id, customer_name, customer_phone, device_model, issue, repair_cost, station_cut, cashier_cut, driver_cut, tech_cut, business_cut, signature_url)
    VALUES (@id, @customerName, @customerPhone, @deviceModel, @issue, @repairCost, @stationCut, @cashierCut, @driverCut, @techCut, @businessCut, @signatureUrl)
  `);

  stmt.run({
    id, customerName, customerPhone, deviceModel, issue,
    ...payouts,
    signatureUrl
  });

  // 4. Send Twilio SMS (if configured)
  if (process.env.TWILIO_ACCOUNT_SID) {
    try {
      const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      client.messages.create({
        body: `RepairLogix: We've received your ${deviceModel}. Estimate approved ($${repairCost}). We'll keep you updated!`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: customerPhone
      }).catch(err => console.error("Twilio Error:", err.message));
    } catch (err) {
      console.error("Twilio Init Error:", err.message);
    }
  }

  res.status(201).json({ success: true, id });
});

// Advance Workflow Status
app.patch('/api/orders/:id/advance', (req, res) => {
  const workflow = ['DROPPED_AT_STATION', 'DRIVER_TO_TECH', 'AT_TECH', 'REPAIRING', 'REPAIR_DONE', 'DRIVER_TO_STATION', 'READY_FOR_CUSTOMER', 'COMPLETED'];
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  
  if (!order) return res.status(404).json({ error: "Order not found" });

  const currentIndex = workflow.indexOf(order.status);
  if (currentIndex < workflow.length - 1) {
    const nextStatus = workflow[currentIndex + 1];
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(nextStatus, req.params.id);
    
    // Comprehensive SMS triggers for all customer-facing milestones
    if (process.env.TWILIO_ACCOUNT_SID) {
       const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
       let msg = "";
       
       if (nextStatus === 'DRIVER_TO_TECH') msg = `Your driver has picked up your ${order.device_model} and is heading to the tech lab.`;
       else if (nextStatus === 'AT_TECH') msg = `Your ${order.device_model} has arrived at the tech lab. Repair starting soon.`;
       else if (nextStatus === 'REPAIRING') msg = `Technician has started repairing your ${order.device_model}.`;
       else if (nextStatus === 'REPAIR_DONE') msg = `Your ${order.device_model} is repaired! Driver is picking it up shortly.`;
       else if (nextStatus === 'DRIVER_TO_STATION') msg = `Your ${order.device_model} is on the way back to the gas station.`;
       else if (nextStatus === 'READY_FOR_CUSTOMER') msg = `Your ${order.device_model} is ready for pickup! Please bring $${order.repair_cost}.`;
       else if (nextStatus === 'COMPLETED') msg = `Payment received. Thank you for your business!`;

       if (msg) {
         client.messages.create({ body: `RepairLogix: ${msg}`, from: process.env.TWILIO_PHONE_NUMBER, to: order.customer_phone })
           .catch(err => console.error("Twilio Error:", err.message));
       }
    }
    
    return res.json({ success: true, newStatus: nextStatus });
  }
  res.json({ success: true, newStatus: order.status });
});

app.listen(PORT, () => console.log(`RepairLogix running on port ${PORT}`));