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

// CORS: zet in Render ENV bijv:
// CORS_ORIGINS=https://kcdetailingstudio.nl,https://www.kcdetailingstudio.nl
// Voor debug mag "*"
const CORS_ORIGINS_RAW = process.env.CORS_ORIGINS || "*";
const CORS_ORIGINS = CORS_ORIGINS_RAW
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "kc.sqlite");
const ADMIN_HTML_PATH = path.join(__dirname, "admin.html");

// ===== MIDDLEWARE =====
app.use(express.json({ limit: "1mb" }));

/**
 * ✅ CORS FIX (Wix iframe / Safari friendly)
 * - OPTIONS preflight altijd OK
 * - headers altijd mee terug
 */
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // server-to-server / curl

    if (CORS_ORIGINS.includes("*")) return cb(null, true);
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);

    // wildcard support
    const ok = CORS_ORIGINS.some((o) => {
      if (!o.includes("*")) return false;
      const re = new RegExp("^" + o.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
      return re.test(origin);
    });

    return ok ? cb(null, true) : cb(new Error(`CORS blocked: ${origin}`));
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
  maxAge: 86400,
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
console.log("SMTP_HOST =", process.env.SMTP_HOST ? "set" : "missing");
console.log("SMTP_USER =", process.env.SMTP_USER ? "set" : "missing");
console.log("MAIL_FROM =", process.env.MAIL_FROM ? "set" : "missing");
console.log("LOGO_URL =", process.env.LOGO_URL ? "set" : "missing");
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

  pass = String(pass).replace(/\s+/g, "");

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: { user, pass },
  });
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || "").trim());
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
    logoUrlSet: Boolean(process.env.LOGO_URL),
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

// Create lead (public) - alleen opslaan
app.post("/api/leads", async (req, res) => {
  try {
    const { name, email, phone, service, message, source } = req.body || {};

    if (!name || !email || !service || !message) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: "Invalid email" });
    }

    const id = await insertLead({ name, email, phone, service, message, source });
    res.json({ ok: true, id });
  } catch (err) {
    console.error("❌ Insert error:", err);
    res.status(500).json({ ok: false, error: "Insert failed" });
  }
});

// Offerte via mail: opslaan + mailen (jullie) + bevestiging klant
async function handleEmailLead(req, res) {
  try {
    const { name, email, phone, service, message } = req.body || {};

    if (!name || !email || !service || !message) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: "Invalid email" });
    }

    const id = await insertLead({ name, email, phone, service, message, source: "email" });

    const transporter = getMailer();
    if (!transporter) return res.status(500).json({ ok: false, error: "SMTP config missing" });

    // ===== BRAND/CONTACT (via ENV) =====
    const from = process.env.MAIL_FROM || process.env.SMTP_USER;
    const brand = process.env.BRAND_NAME || "KC Detailing Studio";
    const logoUrl = process.env.LOGO_URL || "";

    const shopAddress = process.env.SHOP_ADDRESS || "Installatieweg 13, Huizen";
    const shopPhone = process.env.SHOP_PHONE || "+31 6 2130 7621";
    const shopEmail = process.env.SHOP_EMAIL || "kcdetailingstudio@gmail.com";
    const shopWebsite = process.env.SHOP_WEBSITE || "https://kcdetailingstudio.nl";
    const waNumber = process.env.WA_NUMBER || "31648367981";
    const waLink = `https://wa.me/${waNumber}`;

    // -----------------------
    // 1) Mail naar jullie (owner)
    // -----------------------
    const ownerTo = process.env.MAIL_TO;
    if (!ownerTo) return res.status(500).json({ ok: false, error: "MAIL_TO missing" });

    const ownerSubject = `Nieuwe aanvraag #${id} – ${service}`;

    const ownerText =
`Nieuwe offerte aanvraag (#${id})

Naam: ${name}
E-mail: ${email}
Telefoon: ${phone || "-"}

Service: ${service}

Bericht:
${message}

Pagina: ${req.body?.pageUrl || "-"}
Datum: ${new Date().toLocaleString("nl-NL")}
`;

    const ownerHtml = `
      <div style="font-family:Arial,sans-serif;line-height:1.55;color:#111;background:#f6f7fb;padding:18px">
        <div style="max-width:720px;margin:0 auto;background:#fff;border:1px solid #e9e9ef;border-radius:14px;overflow:hidden">
          <div style="padding:16px 18px;background:#0b0f1a;color:#fff">
            <div style="display:flex;align-items:center;gap:12px">
              ${logoUrl ? `<img src="${logoUrl}" alt="${escapeHtml(brand)}" style="height:34px;max-width:180px;object-fit:contain;background:#fff;border-radius:8px;padding:6px">` : ""}
              <div>
                <div style="font-size:12px;opacity:.85;margin:0 0 4px">Nieuwe aanvraag</div>
                <div style="font-size:20px;font-weight:800;margin:0">Aanvraag #${id} – ${escapeHtml(service)}</div>
              </div>
            </div>
          </div>

          <div style="padding:16px 18px">
            <table style="border-collapse:collapse;width:100%;font-size:14px">
              <tr><td style="padding:8px 0;width:160px"><b>Naam</b></td><td style="padding:8px 0">${escapeHtml(name)}</td></tr>
              <tr><td style="padding:8px 0"><b>E-mail</b></td><td style="padding:8px 0"><a href="mailto:${escapeHtml(email)}" style="color:#111">${escapeHtml(email)}</a></td></tr>
              <tr><td style="padding:8px 0"><b>Telefoon</b></td><td style="padding:8px 0">${escapeHtml(phone || "-")}</td></tr>
              <tr><td style="padding:8px 0"><b>Dienst</b></td><td style="padding:8px 0">${escapeHtml(service)}</td></tr>
              <tr><td style="padding:8px 0"><b>Pagina</b></td><td style="padding:8px 0">${escapeHtml(req.body?.pageUrl || "-")}</td></tr>
            </table>

            <div style="margin-top:14px;padding:12px 12px;border:1px solid #eee;border-radius:12px;background:#fafafa">
              <div style="font-weight:800;margin:0 0 6px">Bericht</div>
              <div>${escapeHtml(message).replaceAll("\n","<br/>")}</div>
            </div>

            <div style="margin-top:14px;font-size:12px;color:#555">
              Referentie: <b>#${id}</b> • ${new Date().toLocaleString("nl-NL")}
            </div>
          </div>
        </div>
      </div>
    `;

    await transporter.sendMail({
      from,
      to: ownerTo,
      subject: ownerSubject,
      text: ownerText,
      html: ownerHtml,
      replyTo: email, // replies gaan direct naar klant
    });

    // -----------------------
    // 2) Bevestiging naar klant
    // -----------------------
    const confirmSubject = `Bevestiging aanvraag #${id} – ${brand}`;

    const confirmHtml = `
      <div style="font-family:Arial,sans-serif;line-height:1.55;color:#111;background:#f6f7fb;padding:18px">
        <div style="max-width:720px;margin:0 auto;background:#fff;border:1px solid #e9e9ef;border-radius:14px;overflow:hidden">

          <div style="padding:18px 18px;background:#0b0f1a;color:#fff">
            <div style="display:flex;align-items:center;gap:12px">
              ${logoUrl ? `<img src="${logoUrl}" alt="${escapeHtml(brand)}" style="height:34px;max-width:180px;object-fit:contain;background:#fff;border-radius:8px;padding:6px">` : ""}
              <div>
                <div style="font-size:18px;font-weight:800;margin:0">${escapeHtml(brand)}</div>
                <div style="font-size:13px;opacity:.85;margin-top:2px">We hebben je aanvraag ontvangen</div>
              </div>
            </div>
          </div>

          <div style="padding:16px 18px">
            <p style="margin:0 0 10px">Hoi ${escapeHtml(name)},</p>
            <p style="margin:0 0 12px">
              Bedankt voor je aanvraag. We nemen zo snel mogelijk contact met je op met een voorstel op maat.
            </p>

            <div style="border:1px solid #eee;border-radius:12px;padding:14px;background:#fafafa;margin:12px 0">
              <div style="font-weight:800;margin:0 0 8px">Samenvatting</div>
              <table style="border-collapse:collapse;width:100%;font-size:14px">
                <tr><td style="padding:6px 0;width:160px"><b>Aanvraagnummer</b></td><td style="padding:6px 0">#${id}</td></tr>
                <tr><td style="padding:6px 0"><b>Dienst</b></td><td style="padding:6px 0">${escapeHtml(service)}</td></tr>
                ${phone ? `<tr><td style="padding:6px 0"><b>Telefoon</b></td><td style="padding:6px 0">${escapeHtml(phone)}</td></tr>` : ""}
                <tr><td style="padding:6px 0"><b>E-mail</b></td><td style="padding:6px 0">${escapeHtml(email)}</td></tr>
              </table>

              <div style="margin-top:10px">
                <div style="font-weight:800;margin:0 0 6px">Jouw bericht</div>
                <div>${escapeHtml(message).replaceAll("\n","<br/>")}</div>
              </div>
            </div>

            <div style="display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 6px">
              <a href="${waLink}" style="display:inline-block;background:#25D366;color:#0b0f1a;text-decoration:none;font-weight:800;padding:10px 14px;border-radius:10px">WhatsApp</a>
              <a href="${shopWebsite}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;font-weight:800;padding:10px 14px;border-radius:10px">Website</a>
            </div>

            <div style="font-size:12px;color:#555;margin-top:10px">
              <b>Contact</b><br/>
              ${escapeHtml(shopAddress)}<br/>
              Tel: ${escapeHtml(shopPhone)} • E-mail: ${escapeHtml(shopEmail)}
            </div>

            <div style="margin-top:14px;border-top:1px solid #eee;padding-top:12px;font-size:11px;color:#6b7280">
              Tip: Bewaar je aanvraagnummer <b>#${id}</b> voor snelle communicatie.
            </div>
          </div>
        </div>
      </div>
    `;

    await transporter.sendMail({
      from,
      to: email,
      subject: confirmSubject,
      html: confirmHtml,
      replyTo: process.env.REPLY_TO || from,
    });

    return res.json({ ok: true, id, mailed: true, confirmationMailed: true });
  } catch (err) {
    console.error("❌ Email send error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Email send failed" });
  }
}

app.post("/api/leads/email", handleEmailLead);
app.post("/api/email", handleEmailLead); // compat

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
app.use((req, res) => res.status(404).json({ ok: false, error: `Cannot ${req.method} ${req.path}` }));

app.listen(PORT, () => console.log(`🚀 Server live on port ${PORT}`));
