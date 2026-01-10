const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 10000;

// ===== CONFIG =====
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_API_KEY || "";

const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "kc.sqlite");
const ADMIN_HTML_PATH = path.join(__dirname, "admin.html");

// ===== MIDDLEWARE =====
app.use(express.json({ limit: "1mb" }));

const corsOptions = {
  origin(origin, cb) {
    // server-to-server / curl zonder Origin
    if (!origin) return cb(null, true);

    // allow all
    if (CORS_ORIGINS.includes("*")) return cb(null, true);

    // exact match
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);

    // wildcard support (optioneel)
    const ok = CORS_ORIGINS.some((o) => {
      if (!o.includes("*")) return false;
      const re = new RegExp("^" + o.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
      return re.test(origin);
    });

    return ok ? cb(null, true) : cb(new Error(`CORS blocked: ${origin}`));
  },
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Static files (admin.html)
app.use(express.static(__dirname, { etag: false, lastModified: false }));

// ===== STARTUP LOGS =====
console.log("==== STARTUP ====");
console.log("PORT =", PORT);
console.log("RENDER_GIT_COMMIT =", process.env.RENDER_GIT_COMMIT || "(none)");
console.log("DB_PATH =", DB_PATH);
console.log("DB exists =", fs.existsSync(DB_PATH));
console.log("ADMIN_HTML_PATH =", ADMIN_HTML_PATH);
console.log("admin.html exists =", fs.existsSync(ADMIN_HTML_PATH));
console.log("CORS_ORIGINS =", CORS_ORIGINS.join(", "));
console.log("ADMIN_TOKEN set =", Boolean(ADMIN_TOKEN));
console.log("MAIL_TO =", process.env.MAIL_TO ? "set" : "missing");
console.log("SMTP_USER =", process.env.SMTP_USER ? "set" : "missing");
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

// ===== HELPERS =====
function insertLead(payload) {
  const { name, email, phone, service, message, source } = payload;

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO leads (createdAt, name, email, phone, service, message, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [new Date().toISOString(), name, email, phone || "", service, message, source || "unknown"],
      function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

function getMailer() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  let pass = process.env.SMTP_PASS;

  if (!host || !port || !user || !pass) return null;

  // App password kan met spaties geplakt worden — haal weg
  pass = String(pass).replace(/\s+/g, "");

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,      // 465 = SSL
    requireTLS: port === 587,  // 587 = STARTTLS
    auth: { user, pass },
  });
}

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
    adminHtmlExists: fs.existsSync(ADMIN_HTML_PATH),
    dbExists: fs.existsSync(DB_PATH),
    corsOrigins: CORS_ORIGINS,
    adminTokenSet: Boolean(ADMIN_TOKEN),
    smtpConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    mailToSet: Boolean(process.env.MAIL_TO),
    mailFrom: process.env.MAIL_FROM || null,
  });
});

// Admin page
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

// Create lead (public)
app.post("/api/leads", async (req, res) => {
  try {
    const { name, email, phone, service, message, source } = req.body || {};

    if (!name || !email || !service || !message) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }

    const id = await insertLead({ name, email, phone, service, message, source });
    res.json({ ok: true, id });
  } catch (err) {
    console.error("❌ Insert error:", err);
    res.status(500).json({ ok: false, error: "Insert failed" });
  }
});

// Offerte via mail: opslaan + mailen
async function handleEmailLead(req, res) {
  try {
    const { name, email, phone, service, message } = req.body || {};

    if (!name || !email || !service || !message) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }

    const id = await insertLead({ name, email, phone, service, message, source: "email" });

    const to = process.env.MAIL_TO;
    if (!to) return res.status(500).json({ ok: false, error: "MAIL_TO missing" });

    const transporter = getMailer();
    if (!transporter) return res.status(500).json({ ok: false, error: "SMTP config missing" });

    const from = process.env.MAIL_FROM || process.env.SMTP_USER;

    const subject = `KC Detailing – Offerte aanvraag: ${service}`;
    const text =
`Nieuwe offerte aanvraag (id: ${id})

Naam: ${name}
E-mail: ${email}
Telefoon: ${phone || "-"}

Service: ${service}

Bericht:
${message}
`;

    await transporter.sendMail({ from, to, subject, text });

    return res.json({ ok: true, id, mailed: true });
  } catch (err) {
    console.error("❌ Email send error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Email send failed" });
  }
}

app.post("/api/leads/email", handleEmailLead);

// ✅ compat route voor jouw curl: /api/email
app.post("/api/email", handleEmailLead);

// Admin API
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
