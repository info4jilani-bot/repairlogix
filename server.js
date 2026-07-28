const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));

// Session Middleware (Keeps users logged in)
app.use(session({
    secret: 'repairlogix-super-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Ensure upload directories exist
const videoUploadDir = path.join(__dirname, 'public', 'uploads', 'videos');
const driverUploadDir = path.join(__dirname, 'public', 'uploads', 'driver');
const sigUploadDir = path.join(__dirname, 'public', 'uploads');
[videoUploadDir, driverUploadDir, sigUploadDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Initialize SQLite Database
const db = new Database('repairlogix.db');
db.pragma('journal_mode = WAL');

// Create Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT
  );
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
    cashier_id INTEGER,
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
try { db.exec(`ALTER TABLE orders ADD COLUMN cashier_id INTEGER`); } catch (e) {}

// --- SEED DEFAULT USERS ---
(async () => {
    const users = [
        { username: 'owner', password: 'owner123', role: 'owner' },
        { username: 'cashier', password: 'cashier123', role: 'cashier' },
        { username: 'driver', password: 'driver123', role: 'driver' },
        { username: 'tech', password: 'tech123', role: 'tech' }
    ];
    for (const u of users) {
        const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(u.username);
        if (!existing) {
            const hashed = await bcrypt.hash(u.password, 10);
            db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(u.username, hashed, u.role);
        }
    }
})();

// Configure Multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, videoUploadDir); },
  filename: function (req, file, cb) { cb(null, `vid_${Date.now()}.webm`); }
});
const upload = multer({ storage: storage });

// --- AUTH MIDDLEWARE ---
const requireAuth = (req, res, next) => {
    if (req.session && req.session.user) {
        next();
    } else {
        res.status(401).json({ error: "Unauthorized. Please login." });
    }
};

// --- AUTH ROUTES ---
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return res.status(401).json({ error: "Invalid username or password" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: "Invalid username or password" });

    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ success: true, user: req.session.user });
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
    if (req.session.user) res.json({ user: req.session.user });
    else res.status(401).json({ error: "Not logged in" });
});

// --- FINANCIAL RULES ENGINE ---
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

// --- PROTECTED API ROUTES ---

app.post('/api/upload-video', requireAuth, (req, res) => {
  upload.single('video')(req, res, function (err) {
    if (err) return res.status(500).json({ error: "File upload error: " + err.message });
    if (!req.file) return res.status(400).json({ error: "No video file received" });
    res.json({ success: true, videoUrl: `/uploads/videos/${req.file.filename}` });
  });
});

app.patch('/api/orders/:id/tech-video', requireAuth, (req, res) => {
  try {
    const { type, videoUrl } = req.body;
    const column = type === 'pre' ? 'tech_pre_repair_video_url' : 'tech_post_repair_video_url';
    db.prepare(`UPDATE orders SET ${column} = ? WHERE id = ?`).run(videoUrl, req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.patch('/api/orders/:id/driver-image', requireAuth, (req, res) => {
  try {
    const { type, imageBase64 } = req.body;
    const column = `driver_${type}_img`;
    const base64Data = imageBase64.split(',')[1];
    const fileName = `driver_${type}_${Date.now()}.png`;
    fs.writeFileSync(path.join(driverUploadDir, fileName), base64Data, 'base64');
    const imgUrl = `/uploads/driver/${fileName}`;
    db.prepare(`UPDATE orders SET ${column} = ? WHERE id = ?`).run(imgUrl, req.params.id);
    res.json({ success: true, imgUrl });
  } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.get('/api/orders', requireAuth, (req, res) => {
  try {
    const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
    res.json(orders);
  } catch (err) { res.status(500).json({ error: "Database error" }); }
});

app.post('/api/orders', requireAuth, (req, res) => {
  try {
    const { customerName, customerPhone, deviceModel, issue, repairCost, signatureBase64, diagVideoUrl } = req.body;
    if (!customerName || !customerPhone || !deviceModel || !issue || !repairCost) return res.status(400).json({ error: "Missing fields" });

    const payouts = calculatePayouts(repairCost);
    let signatureUrl = null;
    if (signatureBase64) signatureUrl = signatureBase64;

    const id = `RLX-${Date.now().toString(36).toUpperCase()}`;
    db.prepare(`
      INSERT INTO orders (id, customer_name, customer_phone, device_model, issue, repair_cost, station_cut, cashier_cut, driver_cut, tech_cut, business_cut, signature_url, diag_video_url, cashier_id)
      VALUES (@id, @customerName, @customerPhone, @deviceModel, @issue, @repairCost, @stationCut, @cashierCut, @driverCut, @techCut, @businessCut, @signatureUrl, @diagVideoUrl, @cashierId)
    `).run({ id, customerName, customerPhone, deviceModel, issue, ...payouts, signatureUrl, diagVideoUrl: diagVideoUrl || null, cashierId: req.session.user.id });

    if (process.env.TWILIO_ACCOUNT_SID) {
      try {
        const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        client.messages.create({
          body: `RepairLogix: We've received your ${deviceModel}. Estimate approved ($${repairCost}).`,
          from: process.env.TWILIO_PHONE_NUMBER, to: customerPhone
        }).catch(err => console.error("Twilio Error:", err.message));
      } catch (err) {}
    }
    res.status(201).json({ success: true, id });
  } catch (error) { res.status(500).json({ error: "Server Error" }); }
});

app.patch('/api/orders/:id/advance', requireAuth, (req, res) => {
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
         if (nextStatus === 'DRIVER_TO_TECH') msg = `Your driver has picked up your ${order.device_model}.`;
         else if (nextStatus === 'READY_FOR_CUSTOMER') msg = `Your ${order.device_model} is ready for pickup! Please bring $${order.repair_cost}.`;
         if (msg) client.messages.create({ body: `RepairLogix: ${msg}`, from: process.env.TWILIO_PHONE_NUMBER, to: order.customer_phone }).catch(() => {});
      }
      return res.json({ success: true, newStatus: nextStatus });
    }
    res.json({ success: true, newStatus: order.status });
  } catch (error) { res.status(500).json({ error: "Failed" }); }
});

app.listen(PORT, () => console.log(`RepairLogix running on port ${PORT}`));
