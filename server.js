const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 10000;

// ===== CONFIG =====
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Render Disk tip: zet DB_PATH in Render Environment naar /var/data/kc.sqlite
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "kc.sqlite");
const ADMIN_HTML_PATH = path.join(__dirname, "admin.html");

// ===== MIDDLEWARE =====
app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (CORS_ORIGINS.includes("*")) return cb(null, true);
      if (CORS_ORIGINS.includes(origin)) return cb(null, true);

      const ok = CORS_ORIGINS.some((o) => {
        if (!o.includes("*")) return false;
        const re = new RegExp("^" + o.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
        return re.test(origin);
      });

      return ok ? cb(null, true) : cb(new Error("CORS blocked"));
    },
  })
);

// Static files (admin.html, evt. css/js als je die later toevoegt)
app.use(express.static(__dirname, { etag: false, lastModified: false }));

// ===== STARTUP LOGS =====
console.log("==== STARTUP ====");
console.log("PORT =", PORT);
console.log("RENDER_GIT_COMMIT =", process.env.RENDER_GIT_COMMIT || "(none)");
console.log("DB_PATH =", DB_PATH);
console.log("DB exists =", fs.existsSync(DB_PATH));
console.log("ADMIN_HTML_PATH =", ADMIN_HTML_PATH);
console.log("admin.html exists =", fs.existsSync(ADMIN_HTML_PATH));
console.log("=================");

// ===== DATABASE =====
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("❌ SQLite error:", err.message);
    process.exit(1);
  }
  console.log("✅ SQLite connected:", DB_PATH);
});

db.run(
  `
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    createdAt TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    service TEXT NOT NULL,
    message TEXT NOT NULL,
    source TEXT NOT NULL
  )
`,
  (err) => {
    if (err) console.error("❌ Table create error:", err.message);
    else console.log("✅ Table ready: leads");
  }
);

// ===== AUTH =====
function requireAdmin(req, res, next) {
  const bearer = req.headers.authorization?.replace("Bearer ", "");
  const token = bearer || req.query.token;

  if (!ADMIN_TOKEN) return res.status(500).json({ ok: false, error: "ADMIN_TOKEN missing" });
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "Unauthorized" });

  next();
}

// ===== ROUTES =====
app.get("/", (_, res) => res.send("KC backend draait ✅"));

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    commit: process.env.RENDER_GIT_COMMIT || null,
  });
});

app.get("/debug", (_, res) => {
  res.json({
    ok: true,
    commit: process.env.RENDER_GIT_COMMIT || null,
    dirname: __dirname,
    adminHtmlPath: ADMIN_HTML_PATH,
    adminHtmlExists: fs.existsSync(ADMIN_HTML_PATH),
    dbPath: DB_PATH,
    dbExists: fs.existsSync(DB_PATH),
  });
});

// Admin page (NO CACHE + duidelijke foutmelding als sendFile faalt)
app.get("/admin", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (!fs.existsSync(ADMIN_HTML_PATH)) {
    return res.status(500).send("admin.html missing on server (check /debug)");
  }

  res.sendFile(ADMIN_HTML_PATH, (err) => {
    if (err) {
      console.error("❌ sendFile(/admin) error:", err);
      res.status(500).send("Failed to serve admin.html");
    }
  });
});

app.get("/admin/", (_, res) => res.redirect("/admin"));

// CREATE LEAD (public)
app.post("/api/leads", (req, res) => {
  const { name, email, phone, service, message, source } = req.body || {};

  if (!name || !email || !service || !message) {
    return res.status(400).json({ ok: false, error: "Missing fields" });
  }

  db.run(
    `
      INSERT INTO leads (createdAt, name, email, phone, service, message, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [new Date().toISOString(), name, email, phone || "", service, message, source || "unknown"],
    function (err) {
      if (err) {
        console.error("❌ Insert error:", err.message);
        return res.status(500).json({ ok: false, error: "Insert failed" });
      }
      res.json({ ok: true, id: this.lastID });
    }
  );
});

// ADMIN API
app.get("/api/admin/leads", requireAdmin, (req, res) => {
  db.all(`SELECT * FROM leads ORDER BY datetime(createdAt) DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: "DB read failed" });
    res.json({ ok: true, rows });
  });
});

app.delete("/api/admin/leads/:id", requireAdmin, (req, res) => {
  db.run(`DELETE FROM leads WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ ok: false, error: "DB delete failed" });
    res.json({ ok: true, deleted: this.changes });
  });
});

// 404 last
app.use((req, res) => res.status(404).send(`Cannot ${req.method} ${req.path}`));

app.listen(PORT, () => console.log(`🚀 Server live on port ${PORT}`));
