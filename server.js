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

// --- ENSURE UPLOAD DIRECTORIES EXIST AT STARTUP ---
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

// --- API ROUTES ---

// Video Upload Endpoint (With explicit error handling)
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
    const base64Data = imageBase64.replace(/^data:image\/png;base
