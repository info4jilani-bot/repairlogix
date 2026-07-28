const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));

// Ensure upload directories exist at startup
const videoUploadDir = path.join(__dirname, 'public', 'uploads', 'videos');
const driverUploadDir = path.join(__dirname, 'public', 'uploads', 'driver');
const sigUploadDir = path.join(__dirname, 'public', 'uploads');

[videoUploadDir, driverUploadDir, sigUploadDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

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
    diag_video_url TEXT,
    tech_pre_repair_video_url TEXT,
    tech_post_repair_video_url TEXT,
    driver_station_pickup_img TEXT,
    driver_tech_dropoff_img TEXT,
    driver_tech_pickup_img TEXT,
    driver_station_dropoff_img TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Add columns if they don't exist
try { db.exec(`ALTER TABLE orders ADD COLUMN diag_video_url TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN tech_pre_repair_video_url TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN tech_post_repair_video_url TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN driver_station_pickup_img TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN driver_tech_dropoff_img TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN driver_tech_pickup_img TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN driver_station_dropoff_img TEXT`); } catch (e) {}

// Configure Multer for Video Uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, videoUploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, `vid_${Date.now()}.webm`);
  }
});
const upload = multer({ storage: storage });

// Financial Rules Engine
function calculatePayouts(cost) {
  const repairCost = parseInt(cost);
  const stationCut = repairCost >= 100 ? 10 : 0;
  const cashierCut = 5;
  const driverCut = 7;
  const techCut = Math.round(repairCost * 0.75);
  const totalPayouts = stationCut + cashierCut + driverCut + techCut;
  let businessCut = repairCost - totalPayouts;
  let isProfitable = true;
  if (businessCut < 0) { businessCut = 0; isProfitable = false; }
  return { repairCost, stationCut, cashierCut, driverCut, techCut, businessCut, isProfitable };
}

// API ROUTES

// Video Upload Endpoint
app.post('/api/upload-video', (req, res) => {
  upload.single('video')(req, res, function (err) {
    if (err) {
      console.error("Multer Error:", err);
      return res.status(500).json({ error: "File upload error: " + err.message });
    }
    if (!req.file) return res.status(400).json({ error: "No video file received" });
    res.json({ success: true, videoUrl: `/uploads/videos/${req.file.filename}` });
  });
});

// Save Tech Video URL
app.patch('/api/orders/:id/tech-video', (req, res) => {
  try {
    const { type, videoUrl } = req.body;
    if (!type || !videoUrl) return res.status(400).json({ error: "Missing video type or URL" });
    const column = type === 'pre' ? 'tech_pre_repair_video_url' : 'tech_post_repair_video_url';
    db.prepare(`UPDATE orders SET ${column} = ? WHERE id = ?`).run(videoUrl, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save video URL" });
  }
});

// Save Driver Photo
app.patch('/api/orders/:id/driver-image', (req, res) => {
  try {
    const { type, imageBase64 } = req.body;
    if (!type || !imageBase64) return res.status(400).json({ error: "Missing photo type or data" });

    const validTypes = ['station_pickup', 'tech_dropoff', 'tech_pickup', 'station_dropoff'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: "Invalid photo type" });

    const column = `driver_${type}_img`;
    
    // Using simple string replace to prevent regex syntax errors
    const base64Data = imageBase64.replace("data:image/png;base64,", "");
    const fileName = `driver_${type}_${Date.now()}.png`;
    
    fs.writeFileSync(path.join(driverUploadDir, fileName), base64Data, 'base64');
    const imgUrl = `/uploads/driver/${fileName}`;

    db.prepare(`UPDATE orders SET ${column} = ? WHERE id = ?`).run(imgUrl, req.params.id);
    res.json({ success: true, imgUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save photo" });
  }
});

// Get all orders
// Get all orders
app.get('/api/orders', (req, res) => {
  try {
    const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
    res.json(orders);
  } catch (err) {
    console.error("Database read error:", err.message);
    res.status(500).json({ error: "Database error: " + err.message });
  }
});

// Create new order
app.post('/api/orders', (req, res) => {
  try {
    const { customerName, customerPhone, deviceModel, issue, repairCost, signatureBase64, diagVideoUrl } = req.body;
    if (!customerName || !customerPhone || !deviceModel || !issue || !repairCost) return res.status(400).json({ error: "Missing required fields" });
    if (repairCost < 30 || repairCost > 1000) return res.status(400).json({ error: "Repair cost must be between $30 and $1000" });

    const payouts = calculatePayouts(repairCost);
    if (!payouts.isProfitable) return res.status(400).json({ error: "Repair cost too low. Minimum $50 required." });

    let signatureUrl = null;
    if (signatureBase64) {
      // Using simple string replace to prevent regex syntax errors
      const base64Data = signatureBase64.replace("data:image/png;base64,", "");
      const fileName = `sig_${Date.now()}.png`;
      fs.writeFileSync(path.join(sigUploadDir, fileName), base64Data, 'base64');
      signatureUrl = `/uploads/${fileName}`;
    }

    const id = `RLX-${Date.now().toString(36).toUpperCase()}`;
    const stmt = db.prepare(`
      INSERT INTO orders (id, customer_name, customer_phone, device_model, issue, repair_cost, station_cut, cashier_cut, driver_cut, tech_cut, business_cut, signature_url, diag_video_url)
      VALUES (@id, @customerName, @customerPhone, @deviceModel, @issue, @repairCost, @stationCut, @cashierCut, @driverCut, @techCut, @businessCut, @signatureUrl, @diagVideoUrl)
    `);

    stmt.run({ id, customerName, customerPhone, deviceModel, issue, ...payouts, signatureUrl, diagVideoUrl: diagVideoUrl || null });

    // Twilio SMS
    if (process.env.TWILIO_ACCOUNT_SID) {
      try {
        const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        client.messages.create({
          body: `RepairLogix: We've received your ${deviceModel}. Estimate approved ($${repairCost}). We'll keep you updated!`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: customerPhone
        }).catch(err => console.error("Twilio Error:", err.message));
      } catch (err) { console.error("Twilio Init error:", err.message); }
    }

    res.status(201).json({ success: true, id });
  } catch (error) {
    console.error("Order creation failed:", error);
    res.status(500).json({ error: "Internal Server Error: " + error.message });
  }
});

// Advance Workflow Status
app.patch('/api/orders/:id/advance', (req, res) => {
  try {
    const workflow = ['DROPPED_AT_STATION', 'DRIVER_TO_TECH', 'AT_TECH', 'REPAIRING', 'REPAIR_DONE', 'DRIVER_TO_STATION', 'READY_FOR_CUSTOMER', 'COMPLETED'];
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const currentIndex = workflow.indexOf(order.status);
    if (currentIndex < workflow.length - 1) {
      const nextStatus = workflow[currentIndex + 1];
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(nextStatus, req.params.id);
      
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
  } catch (error) {
    res.status(500).json({ error: "Failed to advance order" });
  }
});

app.listen(PORT, () => console.log(`RepairLogix running on port ${PORT}`));
