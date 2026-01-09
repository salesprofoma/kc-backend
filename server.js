const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();

console.log("🔥 server.js gestart (KC Backend)");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// SQLite
const db = new sqlite3.Database("./kc.sqlite", (err) => {
  if (err) {
    console.error("❌ SQLite open error:", err.message);
    process.exit(1);
  }
  console.log("✅ SQLite connected: ./kc.sqlite");
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      createdAt TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      service TEXT NOT NULL,
      message TEXT NOT NULL
    )
  `, (err) => {
    if (err) {
      console.error("❌ Table create error:", err.message);
      process.exit(1);
    }
    console.log("✅ Table ready: leads");
  });
});

// routes
app.get("/", (req, res) => res.send("KC backend draait ✅"));
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.post("/api/leads", (req, res) => {
  const { name, email, phone, service, message } = req.body || {};
  if (!name || !email || !service || !message) {
    return res.status(400).json({ ok: false, error: "Missing required fields" });
  }

  db.run(
    `INSERT INTO leads (createdAt, name, email, phone, service, message) VALUES (?, ?, ?, ?, ?, ?)`,
    [new Date().toISOString(), String(name), String(email), String(phone || ""), String(service), String(message)],
    function (err) {
      if (err) {
        console.error("❌ Insert error:", err.message);
        return res.status(500).json({ ok: false, error: "DB insert failed" });
      }
      return res.json({ ok: true, id: this.lastID });
    }
  );
});

// server listen (dit houdt je proces alive)
app.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});

// keep-alive + zichtbaar bewijs
setInterval(() => {
  console.log("⏳ server alive");
}, 10000);
