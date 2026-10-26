require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const path = require("path");
const mysql = require("mysql2/promise");
const QRCode = require("qrcode");
const { authenticator } = require("otplib");
const { newSalt,hashPassword, verifyPassword, encryptText, decryptText } = require("./security");

if (!process.env.PEPPER || process.env.PEPPER.length < 32 ||
    !process.env.TOTP_KEY || process.env.TOTP_KEY.length !== 64) {
  console.error("PEPPER or TOTP_KEY is missing or the wrong length in .env");
  process.exit(1);
}

authenticator.options = { window: 1 }; // allow a little clock drift

const app = express();
app.use(helmet());
app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

// ---------- Audit log helper ----------
async function audit(userId, usernameTried, action, details, ip, result) {
  try {
    await db.execute(
      "INSERT INTO audit_log (user_id, username_tried, action, details, ip_address, result) VALUES (?, ?, ?, ?, ?, ?)",
      [userId, usernameTried, action, details, ip, result]
    );
  } catch (err) {
    console.error("Audit write failed:", err.message);
  }
}

// ---------- Sessions (kept in server memory) ----------
const sessions = new Map();
const PENDING_MS = 5 * 60 * 1000;
const HOME = { Admin: "/admin.html", Manager: "/manager.html", Receptionist: "/receptionist.html" };

function createSession(data) {
  const id = crypto.randomBytes(32).toString("hex");
  sessions.set(id, { ...data, lastSeen: Date.now() });
  return id;
}

function setSessionCookie(res, id) {
  // httpOnly: page scripts cannot read it. sameSite: other sites cannot use it.
  res.cookie("sid", id, { httpOnly: true, sameSite: "strict", secure: false, path: "/" });
}

function getSession(req) {
  const id = req.cookies.sid;
  const s = id ? sessions.get(id) : null;
  if (!s) return null;
  const expired = s.stage === "pending"
    ? Date.now() > s.expires
    : Date.now() - s.lastSeen > s.timeoutMs;
  if (expired) { sessions.delete(id); return null; }
  if (s.stage === "full") s.lastSeen = Date.now();
  return { id, s };
}

// Only let in people wearing a full wristband with an allowed role
function requireRole(...roles) {
  return (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const cur = getSession(req);
    if (!cur || cur.s.stage !== "full" || !roles.includes(cur.s.role)) {
      return req.path.startsWith("/api/")
        ? res.status(401).json({ ok: false, message: "Not allowed." })
        : res.redirect("/login.html");
    }
    req.session = cur.s;
    next();
  };
}

// =====================================================
// PERMISSION GATEKEEPER: enforces the Roles & Permissions table
// =====================================================
const PERM_TTL_MS = 10 * 1000;   // changes made by the Admin take effect within ~10 seconds
const permCache = new Map();

async function permissionsFor(role) {
  const hit = permCache.get(role);
  if (hit && Date.now() - hit.at < PERM_TTL_MS) return hit.set;
  const [rows] = await db.execute(
    `SELECT p.name FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE r.name = ?`, [role]
  );
  const set = new Set(rows.map(r => r.name));
  permCache.set(role, { set, at: Date.now() });
  return set;
}

// [method, path pattern, permissions that allow it (any one is enough)]
const ROUTE_PERMISSIONS = [
  ["GET",   /^\/api\/guests$/,                      ["Register guests", "Update guest records", "Make reservations", "Handle complaints"]],
  ["POST",  /^\/api\/guests$/,                      ["Register guests"]],
  ["PATCH", /^\/api\/guests\/\d+$/,                 ["Update guest records"]],

  ["GET",   /^\/api\/rooms$/,                       ["Check room availability", "Manage room availability", "Make reservations"]],
  ["PATCH", /^\/api\/rooms\/\d+\/status$/,          ["Manage room availability"]],

  ["GET",   /^\/api\/bookings$/,                    ["Monitor bookings", "Make reservations", "Check guests in", "Check guests out", "Record payments"]],
  ["POST",  /^\/api\/bookings$/,                    ["Make reservations"]],
  ["POST",  /^\/api\/bookings\/\d+\/checkin$/,      ["Check guests in"]],
  ["POST",  /^\/api\/bookings\/\d+\/checkout$/,     ["Check guests out"]],

  ["GET",   /^\/api\/payments$/,                    ["Monitor payments", "Record payments"]],
  ["POST",  /^\/api\/payments$/,                    ["Record payments"]],

  ["GET",   /^\/api\/enquiries$/,                   ["Handle enquiries"]],
  ["POST",  /^\/api\/enquiries$/,                   ["Handle enquiries"]],
  ["PATCH", /^\/api\/enquiries\/\d+\/resolve$/,     ["Handle enquiries"]],

  ["GET",   /^\/api\/manager\/report$/,             ["View reports", "Monitor payments"]],

  ["GET",   /^\/api\/staff$/,                       ["Manage staff operations"]],
  ["GET",   /^\/api\/tasks$/,                       ["Manage staff operations"]],
  ["POST",  /^\/api\/tasks$/,                       ["Manage staff operations"]],
  ["PATCH", /^\/api\/tasks\/\d+\/done$/,            ["Manage staff operations"]],

  ["GET",   /^\/api\/complaints$/,                  ["Handle complaints"]],
  ["POST",  /^\/api\/complaints$/,                  ["Handle complaints"]],
  ["PATCH", /^\/api\/complaints\/\d+\/resolve$/,    ["Handle complaints"]],

  ["GET",   /^\/api\/decisions$/,                   ["Make decisions"]],
  ["POST",  /^\/api\/decisions$/,                   ["Make decisions"]],
  ["PATCH", /^\/api\/decisions\/\d+$/,              ["Make decisions"]]
];

app.use("/api", async (req, res, next) => {
  const fullPath = req.baseUrl + req.path;   // e.g. /api/guests
  const rule = ROUTE_PERMISSIONS.find(r => r[0] === req.method && r[1].test(fullPath));
  if (!rule) return next();                  // other routes keep their own role checks

  const cur = getSession(req);
  if (!cur || cur.s.stage !== "full") {
    return res.status(401).json({ ok: false, message: "Not allowed." });
  }
  if (cur.s.role === "Admin") return next();   // the Admin can never be locked out

  try {
    const allowed = await permissionsFor(cur.s.role);
    if (rule[2].some(p => allowed.has(p))) return next();

    await audit(cur.s.userId, cur.s.username, "Permission denied", req.method + " " + fullPath, req.ip, "Failed");
    res.status(403).json({ ok: false, message: "Your role does not have permission for this." });
  } catch (err) {
    console.error("Permission check failed:", err.message);
    res.status(500).json({ ok: false, message: "Could not check permissions." });
  }
});

// ---------- Protected pages (must come BEFORE the public files) ----------
const pub = path.join(__dirname, "Public");
app.get("/admin.html", requireRole("Admin"),
  (req, res) => res.sendFile(path.join(pub, "admin.html")));
app.get("/manager.html", requireRole("Admin", "Manager"),
  (req, res) => res.sendFile(path.join(pub, "manager.html")));
app.get("/receptionist.html", requireRole("Admin", "Receptionist"),
  (req, res) => res.sendFile(path.join(pub, "receptionist.html")));

app.use(express.static(pub));

// ---------- Rate limits ----------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20,
  message: { ok: false, message: "Too many attempts. Please wait a few minutes." }
});
const codeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30,
  message: { ok: false, message: "Too many attempts. Please wait a few minutes." }
});

// ---------- Health ----------
app.get("/api/health", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT COUNT(*) AS total FROM roles WHERE name <> ?", ["Nobody"]);
    res.json({ server: "running", database: "connected", roles: rows[0].total });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ server: "running", database: "NOT connected" });
  }
});

// ---------- LOGIN step 1: username + password ----------
app.post("/api/login", loginLimiter, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const ip = req.ip;
  const generic = { ok: false, message: "Invalid username or password." };

  if (!username || !password || username.length > 50 || password.length > 200) {
    return res.status(400).json(generic);
  }

  try {
    const [settingRows] = await db.execute(
      "SELECT max_failed_attempts FROM security_settings WHERE id = ?", [1]
    );
    const maxAttempts = settingRows[0].max_failed_attempts;

    const [rows] = await db.execute(
      `SELECT u.id, u.full_name, u.password_hash, u.salt, u.is_active, u.failed_attempts,
              u.totp_secret, r.name AS role,
              (u.locked_until IS NOT NULL AND u.locked_until > NOW()) AS is_locked
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.username = ?`,
      [username]
    );
    const user = rows[0];

    if (!user) {
      await hashPassword(password, "0".repeat(32));
      await audit(null, username, "Login", "Unknown username", ip, "Failed");
      return res.status(401).json(generic);
    }
    if (!user.is_active) {
      await audit(user.id, username, "Login", "Account disabled", ip, "Failed");
      return res.status(401).json(generic);
    }
    if (user.is_locked) {
      await audit(user.id, username, "Login", "Blocked: account locked", ip, "Failed");
      return res.status(423).json({
        ok: false, message: "This account is locked. Try again later or ask an administrator."
      });
    }

    const correct = await verifyPassword(password, user.salt, user.password_hash);
    if (!correct) {
      const attempts = user.failed_attempts + 1;
      if (attempts >= maxAttempts) {
        await db.execute(
          "UPDATE users SET failed_attempts = ?, locked_until = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?",
          [0, user.id]
        );
        await audit(user.id, username, "Account locked", "Too many failed attempts", ip, "Failed");
      } else {
        await db.execute("UPDATE users SET failed_attempts = ? WHERE id = ?", [attempts, user.id]);
      }
      await audit(user.id, username, "Login", "Wrong password", ip, "Failed");
      return res.status(401).json(generic);
    }

    await db.execute("UPDATE users SET failed_attempts = ?, locked_until = NULL WHERE id = ?", [0, user.id]);
    await audit(user.id, username, "Login", "Password accepted, 2FA pending", ip, "Success");

    // Give a temporary "pending" wristband (not a full one yet)
    if (req.cookies.sid) sessions.delete(req.cookies.sid);
    const id = createSession({
      stage: "pending", userId: user.id, username, fullName: user.full_name,
      role: user.role, hasSecret: !!user.totp_secret, wrongCodes: 0,
      expires: Date.now() + PENDING_MS
    });
    setSessionCookie(res, id);
    res.json({ ok: true, next: user.totp_secret ? "2fa" : "2fa-setup" });

  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ ok: false, message: "Something went wrong. Try again." });
  }
});

// ---------- 2FA setup: make a secret and a QR code ----------
app.post("/api/2fa/setup", codeLimiter, async (req, res) => {
  const cur = getSession(req);
  if (!cur || cur.s.stage !== "pending" || cur.s.hasSecret) {
    return res.status(401).json({ ok: false, message: "Please sign in again.", restart: true });
  }
  try {
    const secret = authenticator.generateSecret();
    cur.s.setupSecret = secret; // kept in memory until the first code is confirmed
    const uri = authenticator.keyuri(cur.s.username, "Grand Hotel", secret);
    const qr = await QRCode.toDataURL(uri);
    res.json({ ok: true, qr, key: secret });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not create the QR code." });
  }
});

// ---------- LOGIN step 2: the 6-digit code ----------
app.post("/api/2fa/verify", codeLimiter, async (req, res) => {
  const cur = getSession(req);
  if (!cur || cur.s.stage !== "pending") {
    return res.status(401).json({ ok: false, message: "Session expired. Please sign in again.", restart: true });
  }
  const s = cur.s;
  const code = String(req.body.code || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ ok: false, message: "Enter the 6-digit code." });
  }

  try {
    let secret;
    if (s.hasSecret) {
      const [rows] = await db.execute("SELECT totp_secret FROM users WHERE id = ?", [s.userId]);
      secret = decryptText(rows[0].totp_secret);
    } else {
      secret = s.setupSecret;
      if (!secret) {
        return res.status(400).json({ ok: false, message: "Please sign in again.", restart: true });
      }
    }

    if (!authenticator.check(code, secret)) {
      s.wrongCodes++;
      await audit(s.userId, s.username, "2FA", "Wrong code", req.ip, "Failed");
      if (s.wrongCodes >= 5) {
        sessions.delete(cur.id);
        return res.status(401).json({ ok: false, message: "Too many wrong codes. Please sign in again.", restart: true });
      }
      return res.status(401).json({ ok: false, message: "Incorrect code. Try again." });
    }

    if (!s.hasSecret) {
      await db.execute(
        "UPDATE users SET totp_secret = ?, two_fa_enabled = ? WHERE id = ?",
        [encryptText(secret), 1, s.userId]
      );
      await audit(s.userId, s.username, "2FA setup", "Authenticator app linked", req.ip, "Success");
    }

    // Swap the pending wristband for a full one (new random ID)
    sessions.delete(cur.id);
    const [setRows] = await db.execute("SELECT session_timeout_min FROM security_settings WHERE id = ?", [1]);
    const id = createSession({
      stage: "full", userId: s.userId, username: s.username, fullName: s.fullName,
      role: s.role, timeoutMs: setRows[0].session_timeout_min * 60 * 1000
    });
    setSessionCookie(res, id);
    await db.execute("UPDATE users SET last_login = NOW() WHERE id = ?", [s.userId]);
    await audit(s.userId, s.username, "Login", "Login complete with 2FA", req.ip, "Success");

    res.json({ ok: true, redirect: HOME[s.role] });

  } catch (err) {
    console.error("2FA error:", err.message);
    res.status(500).json({ ok: false, message: "Something went wrong. Try again." });
  }
});

// ---------- Who am I / Logout ----------
app.get("/api/me", requireRole("Admin", "Manager", "Receptionist"), (req, res) => {
  res.json({ ok: true, username: req.session.username, fullName: req.session.fullName, role: req.session.role });
});

app.post("/api/logout", async (req, res) => {
  const cur = getSession(req);
  if (cur) {
    sessions.delete(cur.id);
    await audit(cur.s.userId, cur.s.username, "Logout", null, req.ip, "Success");
  }
  res.clearCookie("sid", { path: "/" });
  res.json({ ok: true });
});

// =====================================================
// ADMIN: user management (Admin only)
// =====================================================
const adminOnly = requireRole("Admin");
const ROLE_NAMES = ["Admin", "Manager", "Receptionist"];

function strongEnough(pw) {
  return pw.length >= 10 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) &&
         /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw);
}

async function passwordProblem(pw) {
  const [rows] = await db.execute("SELECT min_password_length FROM security_settings WHERE id = ?", [1]);
  if (pw.length < rows[0].min_password_length || !strongEnough(pw)) {
    return "Password needs " + rows[0].min_password_length + "+ characters with upper, lower, number and symbol.";
  }
  return null;
}

function endSessionsFor(userId) {
  for (const [sid, s] of sessions) if (s.userId === userId) sessions.delete(sid);
}

function parseId(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// List all users
app.get("/api/admin/users", adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT u.id, u.full_name, u.username, r.name AS role, u.is_active,
              (u.totp_secret IS NOT NULL) AS two_fa_linked,
              (u.locked_until IS NOT NULL AND u.locked_until > NOW()) AS is_locked
       FROM users u JOIN roles r ON r.id = u.role_id
       ORDER BY u.id`
    );
    res.json({ ok: true, users: rows, me: req.session.userId });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load users." });
  }
});

// Create a user
app.post("/api/admin/users", adminOnly, async (req, res) => {
  const fullName = String(req.body.fullName || "").trim();
  const username = String(req.body.username || "").trim();
  const role = String(req.body.role || "");
  const password = String(req.body.password || "");

  if (!fullName || fullName.length > 100) {
    return res.status(400).json({ ok: false, message: "Enter the full name." });
  }
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) {
    return res.status(400).json({ ok: false, message: "Username: 3-30 letters, numbers, dot, dash or underscore (no spaces)." });
  }
  if (!ROLE_NAMES.includes(role)) {
    return res.status(400).json({ ok: false, message: "Choose a valid role." });
  }

  try {
    const problem = await passwordProblem(password);
    if (problem) return res.status(400).json({ ok: false, message: problem });

    const salt = newSalt();
    const hash = await hashPassword(password, salt);
    await db.execute(
      "INSERT INTO users (full_name, username, password_hash, salt, role_id) VALUES (?, ?, ?, ?, (SELECT id FROM roles WHERE name = ?))",
      [fullName, username, hash, salt, role]
    );
    await audit(req.session.userId, req.session.username, "Create user", "Created " + username + " as " + role, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, message: "That username already exists." });
    }
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not create the user." });
  }
});

// Change a role
app.patch("/api/admin/users/:id/role", adminOnly, async (req, res) => {
  const id = parseId(req);
  const role = String(req.body.role || "");
  if (!id || !ROLE_NAMES.includes(role)) return res.status(400).json({ ok: false, message: "Invalid request." });
  if (id === req.session.userId) return res.status(400).json({ ok: false, message: "You cannot change your own role." });

  try {
    const [result] = await db.execute(
      "UPDATE users SET role_id = (SELECT id FROM roles WHERE name = ?) WHERE id = ?", [role, id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ ok: false, message: "User not found." });
    for (const s of sessions.values()) if (s.userId === id) s.role = role;
    await audit(req.session.userId, req.session.username, "Change role", "User id " + id + " set to " + role, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not change the role." });
  }
});

// Enable or disable
app.patch("/api/admin/users/:id/status", adminOnly, async (req, res) => {
  const id = parseId(req);
  const active = req.body.active === true;
  if (!id) return res.status(400).json({ ok: false, message: "Invalid request." });
  if (id === req.session.userId) return res.status(400).json({ ok: false, message: "You cannot disable your own account." });

  try {
    const [result] = await db.execute("UPDATE users SET is_active = ? WHERE id = ?", [active ? 1 : 0, id]);
    if (result.affectedRows === 0) return res.status(404).json({ ok: false, message: "User not found." });
    if (!active) endSessionsFor(id);
    await audit(req.session.userId, req.session.username, active ? "Enable user" : "Disable user", "User id " + id, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not update the account." });
  }
});

// Unlock a locked account
app.post("/api/admin/users/:id/unlock", adminOnly, async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(400).json({ ok: false, message: "Invalid request." });
  try {
    await db.execute("UPDATE users SET failed_attempts = ?, locked_until = NULL WHERE id = ?", [0, id]);
    await audit(req.session.userId, req.session.username, "Unlock user", "User id " + id, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not unlock the account." });
  }
});

// Reset someone's 2FA (they scan a new QR next sign-in)
app.post("/api/admin/users/:id/reset-2fa", adminOnly, async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(400).json({ ok: false, message: "Invalid request." });
  try {
    await db.execute("UPDATE users SET totp_secret = NULL WHERE id = ?", [id]);
    endSessionsFor(id);
    await audit(req.session.userId, req.session.username, "Reset 2FA", "User id " + id, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not reset 2FA." });
  }
});

// Set a new password for someone
app.post("/api/admin/users/:id/password", adminOnly, async (req, res) => {
  const id = parseId(req);
  const password = String(req.body.password || "");
  if (!id) return res.status(400).json({ ok: false, message: "Invalid request." });
  try {
    const problem = await passwordProblem(password);
    if (problem) return res.status(400).json({ ok: false, message: problem });
    const salt = newSalt();
    const hash = await hashPassword(password, salt);
    const [result] = await db.execute(
      "UPDATE users SET password_hash = ?, salt = ?, failed_attempts = ?, locked_until = NULL WHERE id = ?",
      [hash, salt, 0, id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ ok: false, message: "User not found." });
    endSessionsFor(id);
    await audit(req.session.userId, req.session.username, "Reset password", "User id " + id, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not change the password." });
  }
});

// Delete: copy to the deleted-data database first, then remove
app.delete("/api/admin/users/:id", adminOnly, async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(400).json({ ok: false, message: "Invalid request." });
  if (id === req.session.userId) return res.status(400).json({ ok: false, message: "You cannot delete your own account." });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT u.id, u.full_name, u.username, r.name AS role, u.is_active, u.created_at
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? FOR UPDATE`,
      [id]
    );
    if (!rows[0]) {
      await conn.rollback();
      return res.status(404).json({ ok: false, message: "User not found." });
    }
    await conn.execute(
      "INSERT INTO hotel_deleted_db.deleted_records (source_table, source_id, record_data, deleted_by, reason) VALUES (?, ?, ?, ?, ?)",
      ["users", id, JSON.stringify(rows[0]), req.session.userId, "Deleted by administrator"]
    );
    await conn.execute("DELETE FROM users WHERE id = ?", [id]);
    await conn.commit();

    endSessionsFor(id);
    await audit(req.session.userId, req.session.username, "Delete user", "Deleted " + rows[0].username + " (copy kept in deleted-data database)", req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    try { await conn.rollback(); } catch (e) {}
    if (err.code === "ER_ROW_IS_REFERENCED_2") {
      return res.status(409).json({ ok: false, message: "This user has booking or payment records. Disable the account instead." });
    }
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not delete the user." });
  } finally {
    conn.release();
  }
});

// ---------- ADMIN: system activity (reads the audit log) ----------
app.get("/api/admin/activity", adminOnly, async (req, res) => {
  const filter = String(req.query.result || "");
  const params = [];
  let sql = "SELECT id, created_at, username_tried, action, details, ip_address, result FROM audit_log";
  if (filter === "Success" || filter === "Failed") {
    sql += " WHERE result = ?";   // the value still travels as a parameter
    params.push(filter);
  }
  sql += " ORDER BY id DESC LIMIT 100";

  try {
    const [rows] = await db.execute(sql, params);
    res.json({ ok: true, entries: rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load activity." });
  }
});

// =====================================================
// RECEPTION: guests, rooms, reservations
// =====================================================
const reception = requireRole("Admin", "Receptionist");
const staffAny = requireRole("Admin", "Manager", "Receptionist");
const ID_TYPES = ["Ghana Card", "Passport", "Driver's License"];

function todayString() { return new Date().toLocaleDateString("en-CA"); }
function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) &&
         new Date(s).toISOString().slice(0, 10) === s;
}
function nightsBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }

// ---------- Guests ----------
app.get("/api/guests", staffAny, async (req, res) => {
  const q = "%" + String(req.query.q || "").trim().slice(0, 50) + "%";
  try {
    const [rows] = await db.execute(
      "SELECT id, full_name, phone, email, id_type, country FROM guests WHERE full_name LIKE ? OR phone LIKE ? ORDER BY full_name LIMIT 200",
      [q, q]
    );
    res.json({ ok: true, guests: rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load guests." });
  }
});

app.post("/api/guests", reception, async (req, res) => {
  const fullName = String(req.body.fullName || "").trim();
  const phone = String(req.body.phone || "").trim();
  const email = String(req.body.email || "").trim();
  const idType = String(req.body.idType || "");
  const idNumber = String(req.body.idNumber || "").trim();
  const country = String(req.body.country || "").trim();

  if (!fullName || fullName.length > 100) return res.status(400).json({ ok: false, message: "Enter the guest's full name." });
  if (!/^[0-9+ ]{9,15}$/.test(phone)) return res.status(400).json({ ok: false, message: "Enter a valid phone number." });
  if (email && (email.length > 100 || !/^\S+@\S+\.\S+$/.test(email))) return res.status(400).json({ ok: false, message: "Enter a valid email address." });
  if (!ID_TYPES.includes(idType)) return res.status(400).json({ ok: false, message: "Choose an ID type." });
  if (!idNumber || idNumber.length > 50) return res.status(400).json({ ok: false, message: "Enter the ID number." });
  if (country.length > 60) return res.status(400).json({ ok: false, message: "Country name is too long." });

  try {
    const [dup] = await db.execute("SELECT id FROM guests WHERE id_type = ? AND id_number = ?", [idType, idNumber]);
    if (dup.length) return res.status(409).json({ ok: false, message: "A guest with this ID is already registered." });

    const [result] = await db.execute(
      "INSERT INTO guests (full_name, phone, email, id_type, id_number, country) VALUES (?, ?, ?, ?, ?, ?)",
      [fullName, phone, email || null, idType, idNumber, country || null]
    );
    await audit(req.session.userId, req.session.username, "Register guest", "Guest id " + result.insertId, req.ip, "Success");
    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not register the guest." });
  }
});

app.patch("/api/guests/:id", reception, async (req, res) => {
  const id = parseId(req);
  const fullName = String(req.body.fullName || "").trim();
  const phone = String(req.body.phone || "").trim();
  const email = String(req.body.email || "").trim();

  if (!id) return res.status(400).json({ ok: false, message: "Invalid request." });
  if (!fullName || fullName.length > 100) return res.status(400).json({ ok: false, message: "Name cannot be empty." });
  if (!/^[0-9+ ]{9,15}$/.test(phone)) return res.status(400).json({ ok: false, message: "Enter a valid phone number." });
  if (email && (email.length > 100 || !/^\S+@\S+\.\S+$/.test(email))) return res.status(400).json({ ok: false, message: "Enter a valid email address." });

  try {
    const [result] = await db.execute(
      "UPDATE guests SET full_name = ?, phone = ?, email = ? WHERE id = ?",
      [fullName, phone, email || null, id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ ok: false, message: "Guest not found." });
    await audit(req.session.userId, req.session.username, "Update guest", "Guest id " + id, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not update the guest." });
  }
});

// ---------- Rooms (free or not for a date range; default is tonight) ----------
app.get("/api/rooms", staffAny, async (req, res) => {
  let arrival = String(req.query.arrival || "");
  let departure = String(req.query.departure || "");
  if (!validDate(arrival) || !validDate(departure) || nightsBetween(arrival, departure) < 1) {
    arrival = todayString();
    departure = new Date(Date.parse(arrival) + 86400000).toISOString().slice(0, 10);
  }
  try {
    const [rows] = await db.execute(
      `SELECT r.id, r.room_no, r.room_type, r.price, r.status,
              (r.status <> 'Maintenance' AND NOT EXISTS (
                 SELECT 1 FROM bookings b
                 WHERE b.room_id = r.id AND b.status IN ('Confirmed', 'Checked in')
                   AND b.arrival < ? AND b.departure > ?
              )) AS free
       FROM rooms r ORDER BY r.room_no`,
      [departure, arrival]
    );
    res.json({ ok: true, rooms: rows, arrival, departure });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load rooms." });
  }
});

// ---------- Make a reservation ----------
app.post("/api/bookings", reception, async (req, res) => {
  const guestId = Number(req.body.guestId);
  const roomId = Number(req.body.roomId);
  const arrival = String(req.body.arrival || "");
  const departure = String(req.body.departure || "");

  if (!Number.isInteger(guestId) || guestId < 1 || !Number.isInteger(roomId) || roomId < 1) {
    return res.status(400).json({ ok: false, message: "Choose a guest and a room." });
  }
  if (!validDate(arrival) || !validDate(departure)) {
    return res.status(400).json({ ok: false, message: "Choose valid dates." });
  }
  if (arrival < todayString()) {
    return res.status(400).json({ ok: false, message: "Arrival cannot be in the past." });
  }
  const n = nightsBetween(arrival, departure);
  if (n < 1 || n > 60) {
    return res.status(400).json({ ok: false, message: "A stay must be 1 to 60 nights." });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Lock the room row so two receptionists can't book it at the same moment
    const [roomRows] = await conn.execute("SELECT id, price, status FROM rooms WHERE id = ? FOR UPDATE", [roomId]);
    const [guestRows] = await conn.execute("SELECT id FROM guests WHERE id = ?", [guestId]);
    if (!roomRows[0] || !guestRows[0]) {
      await conn.rollback();
      return res.status(404).json({ ok: false, message: "Guest or room not found." });
    }
    if (roomRows[0].status === "Maintenance") {
      await conn.rollback();
      return res.status(409).json({ ok: false, message: "That room is under maintenance." });
    }

    const [clash] = await conn.execute(
      "SELECT id FROM bookings WHERE room_id = ? AND status IN ('Confirmed', 'Checked in') AND arrival < ? AND departure > ?",
      [roomId, departure, arrival]
    );
    if (clash.length) {
      await conn.rollback();
      return res.status(409).json({ ok: false, message: "That room is already booked for those dates." });
    }

    const total = n * Number(roomRows[0].price);   // price is calculated here, never trusted from the browser
    const [ins] = await conn.execute(
      "INSERT INTO bookings (booking_code, guest_id, room_id, arrival, departure, total_amount, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["TMP-" + crypto.randomBytes(5).toString("hex"), guestId, roomId, arrival, departure, total, req.session.userId]
    );
    const code = "B-" + (1000 + ins.insertId);
    await conn.execute("UPDATE bookings SET booking_code = ? WHERE id = ?", [code, ins.insertId]);
    await conn.commit();

    await audit(req.session.userId, req.session.username, "Make reservation", code + " for " + n + " night(s)", req.ip, "Success");
    res.json({ ok: true, code, total });
  } catch (err) {
    try { await conn.rollback(); } catch (e) {}
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not make the reservation." });
  } finally {
    conn.release();
  }
});

// =====================================================
// RECEPTION: bookings list, check-in/out, payments, enquiries
// =====================================================
const BOOKING_STATUSES = ["Confirmed", "Checked in", "Checked out", "Cancelled"];
const PAY_METHODS = ["Cash", "Card", "Mobile Money"];

function cents(value) { return Math.round(Number(value) * 100); }

// ---------- List bookings ----------
app.get("/api/bookings", staffAny, async (req, res) => {
  const status = String(req.query.status || "");
  const params = [];
  let sql = `SELECT b.id, b.booking_code, g.full_name AS guest, r.room_no,
                    DATE_FORMAT(b.arrival, '%Y-%m-%d') AS arrival,
                    DATE_FORMAT(b.departure, '%Y-%m-%d') AS departure,
                    b.total_amount, b.amount_paid, b.status
             FROM bookings b
             JOIN guests g ON g.id = b.guest_id
             JOIN rooms r ON r.id = b.room_id`;
  if (BOOKING_STATUSES.includes(status)) {
    sql += " WHERE b.status = ?";
    params.push(status);
  }
  sql += " ORDER BY b.id DESC LIMIT 200";

  try {
    const [rows] = await db.execute(sql, params);
    res.json({ ok: true, bookings: rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load bookings." });
  }
});

// ---------- Check in ----------
app.post("/api/bookings/:id/checkin", reception, async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(400).json({ ok: false, message: "Invalid request." });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT id, room_id, status, booking_code,
              DATE_FORMAT(arrival, '%Y-%m-%d') AS arrival,
              DATE_FORMAT(departure, '%Y-%m-%d') AS departure
       FROM bookings WHERE id = ? FOR UPDATE`, [id]
    );
    const b = rows[0];
    const fail = async (code, message) => {
      await conn.rollback();
      return res.status(code).json({ ok: false, message });
    };

    if (!b) return fail(404, "Booking not found.");
    if (b.status !== "Confirmed") return fail(409, "Only confirmed reservations can be checked in.");

    const today = todayString();
    if (b.arrival > today) return fail(409, "This guest arrives on " + b.arrival + ". Check-in opens that day.");
    if (b.departure <= today) return fail(409, "This reservation has already ended.");

    const [roomRows] = await conn.execute("SELECT status FROM rooms WHERE id = ? FOR UPDATE", [b.room_id]);
    if (roomRows[0].status === "Occupied") return fail(409, "The room is still occupied. Check the previous guest out first.");
    if (roomRows[0].status === "Maintenance") return fail(409, "The room is under maintenance.");

    await conn.execute("UPDATE bookings SET status = ? WHERE id = ?", ["Checked in", id]);
    await conn.execute("UPDATE rooms SET status = ? WHERE id = ?", ["Occupied", b.room_id]);
    await conn.commit();

    await audit(req.session.userId, req.session.username, "Check in", b.booking_code, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    try { await conn.rollback(); } catch (e) {}
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not check the guest in." });
  } finally {
    conn.release();
  }
});

// ---------- Check out (blocked while money is owed) ----------
app.post("/api/bookings/:id/checkout", reception, async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(400).json({ ok: false, message: "Invalid request." });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      "SELECT id, room_id, status, booking_code, total_amount, amount_paid FROM bookings WHERE id = ? FOR UPDATE", [id]
    );
    const b = rows[0];
    if (!b) { await conn.rollback(); return res.status(404).json({ ok: false, message: "Booking not found." }); }
    if (b.status !== "Checked in") {
      await conn.rollback();
      return res.status(409).json({ ok: false, message: "Only guests who are checked in can be checked out." });
    }

    const owed = cents(b.total_amount) - cents(b.amount_paid);
    if (owed > 0) {
      await conn.rollback();
      return res.status(409).json({
        ok: false,
        message: "Cannot check out: GHS " + (owed / 100).toFixed(2) + " is still unpaid. Record the payment first."
      });
    }

    await conn.execute("UPDATE bookings SET status = ? WHERE id = ?", ["Checked out", id]);
    await conn.execute("UPDATE rooms SET status = ? WHERE id = ?", ["Available", b.room_id]);
    await conn.commit();

    await audit(req.session.userId, req.session.username, "Check out", b.booking_code, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    try { await conn.rollback(); } catch (e) {}
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not check the guest out." });
  } finally {
    conn.release();
  }
});

// ---------- Payments ----------
app.get("/api/payments", staffAny, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT p.receipt_no, b.booking_code, g.full_name AS guest, p.amount, p.method,
              DATE_FORMAT(p.paid_at, '%Y-%m-%d %H:%i') AS paid_at
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       JOIN guests g ON g.id = b.guest_id
       ORDER BY p.id DESC LIMIT 100`
    );
    res.json({ ok: true, payments: rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load payments." });
  }
});

app.post("/api/payments", reception, async (req, res) => {
  const bookingId = Number(req.body.bookingId);
  const amount = Number(req.body.amount);
  const method = String(req.body.method || "");

  if (!Number.isInteger(bookingId) || bookingId < 1) {
    return res.status(400).json({ ok: false, message: "Choose a booking." });
  }
  if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
    return res.status(400).json({ ok: false, message: "Enter a valid amount (up to 2 decimal places)." });
  }
  if (!PAY_METHODS.includes(method)) {
    return res.status(400).json({ ok: false, message: "Choose a payment method." });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      "SELECT id, status, total_amount, amount_paid FROM bookings WHERE id = ? FOR UPDATE", [bookingId]
    );
    const b = rows[0];
    if (!b) { await conn.rollback(); return res.status(404).json({ ok: false, message: "Booking not found." }); }
    if (!["Confirmed", "Checked in"].includes(b.status)) {
      await conn.rollback();
      return res.status(409).json({ ok: false, message: "Payments can only be recorded for active reservations." });
    }

    const owed = cents(b.total_amount) - cents(b.amount_paid);
    const paying = Math.round(amount * 100);
    if (paying > owed) {
      await conn.rollback();
      return res.status(409).json({ ok: false, message: "That is more than the balance of GHS " + (owed / 100).toFixed(2) + "." });
    }

    const [ins] = await conn.execute(
      "INSERT INTO payments (receipt_no, booking_id, amount, method, recorded_by) VALUES (?, ?, ?, ?, ?)",
      ["TMP-" + crypto.randomBytes(5).toString("hex"), bookingId, amount, method, req.session.userId]
    );
    const receipt = "R-" + (5000 + ins.insertId);
    await conn.execute("UPDATE payments SET receipt_no = ? WHERE id = ?", [receipt, ins.insertId]);
    await conn.execute("UPDATE bookings SET amount_paid = amount_paid + ? WHERE id = ?", [amount, bookingId]);
    await conn.commit();

    await audit(req.session.userId, req.session.username, "Record payment", receipt + " (" + method + ")", req.ip, "Success");
    res.json({ ok: true, receipt, balance: (owed - paying) / 100 });
  } catch (err) {
    try { await conn.rollback(); } catch (e) {}
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not record the payment." });
  } finally {
    conn.release();
  }
});

// ---------- Enquiries ----------
app.get("/api/enquiries", reception, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT id, from_name, details, status FROM enquiries ORDER BY id DESC LIMIT 100"
    );
    res.json({ ok: true, enquiries: rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load enquiries." });
  }
});

app.post("/api/enquiries", reception, async (req, res) => {
  const fromName = String(req.body.fromName || "").trim();
  const details = String(req.body.details || "").trim();
  if (!fromName || fromName.length > 100) return res.status(400).json({ ok: false, message: "Enter who the enquiry is from." });
  if (!details || details.length > 500) return res.status(400).json({ ok: false, message: "Describe the enquiry (up to 500 characters)." });

  try {
    await db.execute(
      "INSERT INTO enquiries (from_name, details, logged_by) VALUES (?, ?, ?)",
      [fromName, details, req.session.userId]
    );
    await audit(req.session.userId, req.session.username, "Log enquiry", null, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not log the enquiry." });
  }
});

app.patch("/api/enquiries/:id/resolve", reception, async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(400).json({ ok: false, message: "Invalid request." });
  try {
    const [result] = await db.execute("UPDATE enquiries SET status = ? WHERE id = ?", ["Resolved", id]);
    if (result.affectedRows === 0) return res.status(404).json({ ok: false, message: "Enquiry not found." });
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not update the enquiry." });
  }
});

// =====================================================
// MANAGER: room status and reports
// =====================================================
const manager = requireRole("Admin", "Manager");

// Send a room to maintenance, or bring it back
app.patch("/api/rooms/:id/status", manager, async (req, res) => {
  const id = parseId(req);
  const status = String(req.body.status || "");
  if (!id || !["Available", "Maintenance"].includes(status)) {
    return res.status(400).json({ ok: false, message: "Invalid request." });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute("SELECT id, room_no, status FROM rooms WHERE id = ? FOR UPDATE", [id]);
    const room = rows[0];
    if (!room) {
      await conn.rollback();
      return res.status(404).json({ ok: false, message: "Room not found." });
    }
    if (room.status === "Occupied") {
      await conn.rollback();
      return res.status(409).json({ ok: false, message: "A guest is checked in. Check them out first." });
    }
    if (status === "Maintenance") {
      const [upcoming] = await conn.execute(
        "SELECT booking_code FROM bookings WHERE room_id = ? AND status = ? AND departure > CURDATE() LIMIT 1",
        [id, "Confirmed"]
      );
      if (upcoming.length) {
        await conn.rollback();
        return res.status(409).json({
          ok: false,
          message: "Room " + room.room_no + " has an upcoming reservation (" + upcoming[0].booking_code + "). Deal with that first."
        });
      }
    }
    await conn.execute("UPDATE rooms SET status = ? WHERE id = ?", [status, id]);
    await conn.commit();

    await audit(req.session.userId, req.session.username, "Room status", "Room " + room.room_no + " set to " + status, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    try { await conn.rollback(); } catch (e) {}
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not change the room status." });
  } finally {
    conn.release();
  }
});

// Numbers for the Reports and Payments screens
app.get("/api/manager/report", manager, async (req, res) => {
  try {
    const [rev] = await db.execute(
      `SELECT DATE_FORMAT(paid_at, '%Y-%m-%d') AS day, SUM(amount) AS total
       FROM payments
       WHERE paid_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
       GROUP BY day ORDER BY day`
    );
    const [roomRows] = await db.execute("SELECT status, COUNT(*) AS n FROM rooms GROUP BY status");
    const [bookRows] = await db.execute("SELECT status, COUNT(*) AS n FROM bookings GROUP BY status");
    const [recv] = await db.execute("SELECT COALESCE(SUM(amount), 0) AS received FROM payments");
    const [owed] = await db.execute(
      "SELECT COALESCE(SUM(total_amount - amount_paid), 0) AS outstanding FROM bookings WHERE status IN ('Confirmed', 'Checked in')"
    );
    const [comp] = await db.execute("SELECT COUNT(*) AS n FROM complaints WHERE status = 'Open'");

    const toMap = rows => Object.fromEntries(rows.map(r => [r.status, Number(r.n)]));
    res.json({
      ok: true,
      revenue: rev.map(r => ({ day: r.day, total: Number(r.total) })),
      rooms: toMap(roomRows),
      bookings: toMap(bookRows),
      received: Number(recv[0].received),
      outstanding: Number(owed[0].outstanding),
      openComplaints: Number(comp[0].n)
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not build the report." });
  }
});

// =====================================================
// MANAGER: staff tasks, complaints, decisions
// =====================================================
const SHIFTS = ["Morning", "Afternoon", "Night"];

// ---------- Staff list for the "assign a task" dropdown ----------
app.get("/api/staff", manager, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT u.id, u.full_name, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.is_active = ? ORDER BY u.full_name",
      [1]
    );
    res.json({ ok: true, staff: rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load staff." });
  }
});

// ---------- Staff tasks ----------
app.get("/api/tasks", manager, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT t.id, u.full_name AS staff, t.task, t.shift, t.is_done
       FROM staff_tasks t JOIN users u ON u.id = t.assigned_to
       ORDER BY t.id DESC LIMIT 100`
    );
    res.json({ ok: true, tasks: rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load tasks." });
  }
});

app.post("/api/tasks", manager, async (req, res) => {
  const assignedTo = Number(req.body.assignedTo);
  const task = String(req.body.task || "").trim();
  const shift = String(req.body.shift || "");
  if (!Number.isInteger(assignedTo) || assignedTo < 1) return res.status(400).json({ ok: false, message: "Choose a staff member." });
  if (!task || task.length > 200) return res.status(400).json({ ok: false, message: "Describe the task (up to 200 characters)." });
  if (!SHIFTS.includes(shift)) return res.status(400).json({ ok: false, message: "Choose a shift." });

  try {
    const [who] = await db.execute("SELECT id FROM users WHERE id = ? AND is_active = ?", [assignedTo, 1]);
    if (!who.length) return res.status(404).json({ ok: false, message: "That staff member was not found or is disabled." });

    await db.execute(
      "INSERT INTO staff_tasks (assigned_to, assigned_by, task, shift) VALUES (?, ?, ?, ?)",
      [assignedTo, req.session.userId, task, shift]
    );
    await audit(req.session.userId, req.session.username, "Assign task", "To user id " + assignedTo + " (" + shift + ")", req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not assign the task." });
  }
});

app.patch("/api/tasks/:id/done", manager, async (req, res) => {
  const id = parseId(req);
  const done = req.body.done === true;
  if (!id) return res.status(400).json({ ok: false, message: "Invalid request." });
  try {
    const [result] = await db.execute("UPDATE staff_tasks SET is_done = ? WHERE id = ?", [done ? 1 : 0, id]);
    if (result.affectedRows === 0) return res.status(404).json({ ok: false, message: "Task not found." });
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not update the task." });
  }
});

// ---------- Complaints ----------
app.get("/api/complaints", manager, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT c.id, g.full_name AS guest, c.description, c.status, c.resolution_note
       FROM complaints c JOIN guests g ON g.id = c.guest_id
       ORDER BY (c.status = 'Open') DESC, c.id DESC LIMIT 100`
    );
    res.json({ ok: true, complaints: rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load complaints." });
  }
});

app.post("/api/complaints", staffAny, async (req, res) => {
  const guestId = Number(req.body.guestId);
  const description = String(req.body.description || "").trim();
  if (!Number.isInteger(guestId) || guestId < 1) return res.status(400).json({ ok: false, message: "Choose a guest." });
  if (!description || description.length > 500) return res.status(400).json({ ok: false, message: "Describe the complaint (up to 500 characters)." });

  try {
    await db.execute("INSERT INTO complaints (guest_id, description) VALUES (?, ?)", [guestId, description]);
    await audit(req.session.userId, req.session.username, "Log complaint", "Guest id " + guestId, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "ER_NO_REFERENCED_ROW_2") return res.status(404).json({ ok: false, message: "Guest not found." });
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not log the complaint." });
  }
});

app.patch("/api/complaints/:id/resolve", manager, async (req, res) => {
  const id = parseId(req);
  const note = String(req.body.note || "").trim();
  if (!id) return res.status(400).json({ ok: false, message: "Invalid request." });
  if (!note || note.length > 500) return res.status(400).json({ ok: false, message: "Describe the action taken (up to 500 characters)." });

  try {
    const [result] = await db.execute(
      "UPDATE complaints SET status = ?, resolution_note = ?, handled_by = ? WHERE id = ? AND status = ?",
      ["Resolved", note, req.session.userId, id, "Open"]
    );
    if (result.affectedRows === 0) return res.status(409).json({ ok: false, message: "Complaint not found or already resolved." });
    await audit(req.session.userId, req.session.username, "Resolve complaint", "Complaint id " + id, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not resolve the complaint." });
  }
});

// ---------- Decisions ----------
app.get("/api/decisions", manager, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT d.id, d.request_text, u.full_name AS requested_by, d.status
       FROM decisions d JOIN users u ON u.id = d.requested_by
       ORDER BY (d.status = 'Pending') DESC, d.id DESC LIMIT 100`
    );
    res.json({ ok: true, decisions: rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load requests." });
  }
});

app.post("/api/decisions", staffAny, async (req, res) => {
  const text = String(req.body.text || "").trim();
  if (!text || text.length > 300) return res.status(400).json({ ok: false, message: "Describe the request (up to 300 characters)." });
  try {
    await db.execute("INSERT INTO decisions (request_text, requested_by) VALUES (?, ?)", [text, req.session.userId]);
    await audit(req.session.userId, req.session.username, "Submit request", null, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not submit the request." });
  }
});

app.patch("/api/decisions/:id", manager, async (req, res) => {
  const id = parseId(req);
  const decision = String(req.body.decision || "");
  if (!id || !["Approved", "Rejected"].includes(decision)) return res.status(400).json({ ok: false, message: "Invalid request." });

  try {
    const [result] = await db.execute(
      "UPDATE decisions SET status = ?, decided_by = ?, decided_at = NOW() WHERE id = ? AND status = ?",
      [decision, req.session.userId, id, "Pending"]
    );
    if (result.affectedRows === 0) return res.status(409).json({ ok: false, message: "Request not found or already decided." });
    await audit(req.session.userId, req.session.username, decision + " request", "Request id " + id, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not record the decision." });
  }
});

// =====================================================
// ADMIN: permissions, hotel info, records, security
// =====================================================

// ---------- Roles and permissions ----------
app.get("/api/admin/permissions", adminOnly, async (req, res) => {
  try {
    const [perms] = await db.execute("SELECT id, name FROM permissions ORDER BY id");
    const [grants] = await db.execute(
      "SELECT r.name AS role, rp.permission_id FROM role_permissions rp JOIN roles r ON r.id = rp.role_id"
    );
    res.json({ ok: true, permissions: perms, grants });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load permissions." });
  }
});

// Admin always keeps every permission, so only Manager and Receptionist can be changed
app.put("/api/admin/permissions", adminOnly, async (req, res) => {
  const grants = req.body.grants;
  if (!grants || typeof grants !== "object") {
    return res.status(400).json({ ok: false, message: "Invalid request." });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [perms] = await conn.execute("SELECT id FROM permissions");
    const valid = new Set(perms.map(p => p.id));

    for (const roleName of ["Manager", "Receptionist"]) {
      const ids = Array.isArray(grants[roleName]) ? [...new Set(grants[roleName].map(Number))] : [];
      if (ids.some(id => !valid.has(id))) {
        await conn.rollback();
        return res.status(400).json({ ok: false, message: "Unknown permission." });
      }
      const [roleRows] = await conn.execute("SELECT id FROM roles WHERE name = ?", [roleName]);
      const roleId = roleRows[0].id;
      await conn.execute("DELETE FROM role_permissions WHERE role_id = ?", [roleId]);
      for (const permId of ids) {
        await conn.execute("INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)", [roleId, permId]);
      }
    }
    await conn.commit();
    await audit(req.session.userId, req.session.username, "Change permissions", "Manager and Receptionist permissions saved", req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    try { await conn.rollback(); } catch (e) {}
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not save permissions." });
  } finally {
    conn.release();
  }
});

// ---------- Hotel information ----------
app.get("/api/admin/hotel", adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT name, phone, email, address,
              TIME_FORMAT(checkin_time, '%H:%i') AS checkin,
              TIME_FORMAT(checkout_time, '%H:%i') AS checkout
       FROM hotel_info WHERE id = ?`, [1]
    );
    res.json({ ok: true, hotel: rows[0] });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load hotel information." });
  }
});

app.put("/api/admin/hotel", adminOnly, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const phone = String(req.body.phone || "").trim();
  const email = String(req.body.email || "").trim();
  const address = String(req.body.address || "").trim();
  const checkin = String(req.body.checkin || "");
  const checkout = String(req.body.checkout || "");
  const timeOk = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

  if (!name || name.length > 100) return res.status(400).json({ ok: false, message: "Enter the hotel name." });
  if (!/^[0-9+ ()-]{0,20}$/.test(phone)) return res.status(400).json({ ok: false, message: "Enter a valid phone number." });
  if (email && (email.length > 100 || !/^\S+@\S+\.\S+$/.test(email))) return res.status(400).json({ ok: false, message: "Enter a valid email address." });
  if (address.length > 200) return res.status(400).json({ ok: false, message: "The address is too long." });
  if (!timeOk(checkin) || !timeOk(checkout)) return res.status(400).json({ ok: false, message: "Enter valid check-in and check-out times." });

  try {
    await db.execute(
      "UPDATE hotel_info SET name = ?, phone = ?, email = ?, address = ?, checkin_time = ?, checkout_time = ? WHERE id = ?",
      [name, phone || null, email || null, address || null, checkin + ":00", checkout + ":00", 1]
    );
    await audit(req.session.userId, req.session.username, "Update hotel information", null, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not save hotel information." });
  }
});

// ---------- All records (the SQL for each type is fixed here, never built from user input) ----------
const RECORD_QUERIES = {
  guests: {
    head: ["Guest", "Phone", "Email", "ID", "Country", "Registered"],
    sql: `SELECT full_name, phone, IFNULL(email, '') AS email,
                 CONCAT(id_type, ' ', REPEAT('*', GREATEST(CHAR_LENGTH(id_number) - 4, 0)), RIGHT(id_number, 4)) AS id_info,
                 IFNULL(country, '') AS country, DATE_FORMAT(created_at, '%Y-%m-%d') AS registered
          FROM guests ORDER BY id DESC LIMIT 200`
  },
  bookings: {
    head: ["Booking", "Guest", "Room", "Stay", "Total", "Paid", "Status"],
    sql: `SELECT b.booking_code, g.full_name, r.room_no,
                 CONCAT(DATE_FORMAT(b.arrival, '%Y-%m-%d'), ' to ', DATE_FORMAT(b.departure, '%Y-%m-%d')) AS stay,
                 b.total_amount, b.amount_paid, b.status
          FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN rooms r ON r.id = b.room_id
          ORDER BY b.id DESC LIMIT 200`
  },
  payments: {
    head: ["Receipt", "Booking", "Guest", "Amount", "Method", "Paid at"],
    sql: `SELECT p.receipt_no, b.booking_code, g.full_name, p.amount, p.method,
                 DATE_FORMAT(p.paid_at, '%Y-%m-%d %H:%i') AS paid_at
          FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN guests g ON g.id = b.guest_id
          ORDER BY p.id DESC LIMIT 200`
  },
  deleted: {
    head: ["Table", "Record id", "Saved data", "Deleted at"],
    sql: `SELECT source_table, source_id, CAST(record_data AS CHAR) AS saved_data,
                 DATE_FORMAT(deleted_at, '%Y-%m-%d %H:%i') AS deleted_at
          FROM hotel_deleted_db.deleted_records ORDER BY id DESC LIMIT 200`
  }
};

app.get("/api/admin/records", adminOnly, async (req, res) => {
  const type = String(req.query.type || "");
  if (!Object.hasOwn(RECORD_QUERIES, type)) {
    return res.status(400).json({ ok: false, message: "Unknown record type." });
  }
  try {
    const [rows] = await db.execute(RECORD_QUERIES[type].sql);
    res.json({ ok: true, head: RECORD_QUERIES[type].head, rows: rows.map(r => Object.values(r)) });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load records." });
  }
});

// ---------- Security settings ----------
app.get("/api/admin/security", adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT max_failed_attempts, session_timeout_min, min_password_length FROM security_settings WHERE id = ?", [1]
    );
    const [locked] = await db.execute(
      "SELECT id, username FROM users WHERE locked_until IS NOT NULL AND locked_until > NOW() ORDER BY username"
    );
    res.json({ ok: true, settings: rows[0], locked });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load security settings." });
  }
});

app.put("/api/admin/security", adminOnly, async (req, res) => {
  const attempts = Number(req.body.maxFailedAttempts);
  const timeout = Number(req.body.sessionTimeoutMin);
  const length = Number(req.body.minPasswordLength);
  const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

  if (!inRange(attempts, 3, 10)) return res.status(400).json({ ok: false, message: "Failed attempts must be between 3 and 10." });
  if (!inRange(timeout, 5, 120)) return res.status(400).json({ ok: false, message: "Session timeout must be between 5 and 120 minutes." });
  if (!inRange(length, 8, 32)) return res.status(400).json({ ok: false, message: "Minimum password length must be between 8 and 32." });

  try {
    await db.execute(
      "UPDATE security_settings SET max_failed_attempts = ?, session_timeout_min = ?, min_password_length = ? WHERE id = ?",
      [attempts, timeout, length, 1]
    );
    await audit(req.session.userId, req.session.username, "Change security settings",
      "Attempts " + attempts + ", timeout " + timeout + " min, min length " + length, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not save security settings." });
  }
});

// =====================================================
// ADMIN: backups and restore points
// =====================================================
const fs = require("fs");
const BACKUP_DIR = path.join(__dirname, "backups");   // outside Public, so the web can never reach it
const AUTO_BACKUP_HOURS = 24;

// Fixed list of our own tables (never built from user input)
const BACKUP_TABLES = [
  "roles", "permissions", "role_permissions", "users", "guests", "rooms", "bookings", "payments",
  "complaints", "staff_tasks", "enquiries", "decisions", "hotel_info", "security_settings",
  "audit_log", "restore_points"
];

function backupKey() {
  if (!process.env.BACKUP_KEY || process.env.BACKUP_KEY.length !== 64) {
    throw new Error("BACKUP_KEY is missing or the wrong length in .env");
  }
  return Buffer.from(process.env.BACKUP_KEY, "hex");
}

// Encrypted file layout: 12 bytes IV + 16 bytes tag + encrypted data
function encryptBuffer(buf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", backupKey(), iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

function decryptBuffer(buf) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", backupKey(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

async function buildSnapshot() {
  const snapshot = { createdAt: new Date().toISOString(), hotel_db: {}, hotel_deleted_db: {} };
  for (const table of BACKUP_TABLES) {
    const [rows] = await db.query("SELECT * FROM " + table);
    snapshot.hotel_db[table] = rows;
  }
  const [deleted] = await db.query("SELECT * FROM hotel_deleted_db.deleted_records");
  snapshot.hotel_deleted_db.deleted_records = deleted;
  return snapshot;
}

let backupRunning = false;

async function runBackup(type, userId) {
  backupKey();   // stops early with a clear message if the key is missing
  if (backupRunning) throw new Error("A backup is already running.");
  backupRunning = true;

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const fileName = "hotel-backup-" + stamp + "-" + crypto.randomBytes(2).toString("hex") + ".bak";

  try {
    const snapshot = await buildSnapshot();
    const encrypted = encryptBuffer(Buffer.from(JSON.stringify(snapshot), "utf8"));
    await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
    await fs.promises.writeFile(path.join(BACKUP_DIR, fileName), encrypted, { flag: "wx" });

    const checksum = crypto.createHash("sha256").update(encrypted).digest("hex");
    await db.execute(
      "INSERT INTO backups (type, file_name, checksum, location, status, taken_by) VALUES (?, ?, ?, ?, ?, ?)",
      [type, fileName, checksum, "Local folder", "Success", userId || null]
    );
    return { fileName, checksum };
  } catch (err) {
    try {
      await db.execute(
        "INSERT INTO backups (type, file_name, location, status, taken_by) VALUES (?, ?, ?, ?, ?)",
        [type, "none", "Local folder", "Failed", userId || null]
      );
    } catch (e) {}
    throw err;
  } finally {
    backupRunning = false;
  }
}

app.get("/api/admin/backups", adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT id, DATE_FORMAT(taken_at, '%Y-%m-%d %H:%i') AS taken_at, type, file_name, location, status FROM backups ORDER BY id DESC LIMIT 50"
    );
    res.json({ ok: true, backups: rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load backups." });
  }
});

app.post("/api/admin/backups", adminOnly, async (req, res) => {
  try {
    const result = await runBackup("Manual", req.session.userId);
    await audit(req.session.userId, req.session.username, "Backup", result.fileName, req.ip, "Success");
    res.json({ ok: true, fileName: result.fileName });
  } catch (err) {
    console.error("Backup failed:", err.message);
    await audit(req.session.userId, req.session.username, "Backup", err.message.slice(0, 200), req.ip, "Failed");
    res.status(500).json({ ok: false, message: "Backup failed: " + err.message });
  }
});

// Verify: does the file still match its checksum, and does it decrypt cleanly?
app.post("/api/admin/backups/:id/verify", adminOnly, async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(400).json({ ok: false, message: "Invalid request." });
  try {
    const [rows] = await db.execute("SELECT file_name, checksum FROM backups WHERE id = ? AND status = ?", [id, "Success"]);
    if (!rows[0]) return res.status(404).json({ ok: false, message: "Backup not found." });

    const file = path.join(BACKUP_DIR, path.basename(rows[0].file_name));
    let buf;
    try { buf = await fs.promises.readFile(file); }
    catch (e) { return res.json({ ok: false, message: "The backup file is missing from the backups folder." }); }

    const checksum = crypto.createHash("sha256").update(buf).digest("hex");
    if (checksum !== rows[0].checksum) {
      await audit(req.session.userId, req.session.username, "Verify backup", rows[0].file_name + ": CHECKSUM MISMATCH", req.ip, "Failed");
      return res.json({ ok: false, message: "WARNING: the file does not match its checksum. It may be damaged or tampered with." });
    }
    let snapshot;
    try { snapshot = JSON.parse(decryptBuffer(buf).toString("utf8")); }
    catch (e) { return res.json({ ok: false, message: "Checksum matches, but the file could not be decrypted. Check BACKUP_KEY." }); }

    const tables = Object.keys(snapshot.hotel_db).length;
    await audit(req.session.userId, req.session.username, "Verify backup", rows[0].file_name + ": OK", req.ip, "Success");
    res.json({ ok: true, message: "Backup is intact: checksum matches and it decrypts correctly (" + tables + " tables)." });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not verify the backup." });
  }
});

// ---------- Restore points (settings only) ----------
async function configSnapshot(conn) {
  const [hotel] = await conn.execute(
    `SELECT name, phone, email, address,
            TIME_FORMAT(checkin_time, '%H:%i:%s') AS checkin_time,
            TIME_FORMAT(checkout_time, '%H:%i:%s') AS checkout_time
     FROM hotel_info WHERE id = ?`, [1]
  );
  const [sec] = await conn.execute(
    "SELECT require_2fa, max_failed_attempts, session_timeout_min, min_password_length FROM security_settings WHERE id = ?", [1]
  );
  const [grants] = await conn.execute(
    `SELECT r.name AS role, p.name AS permission
     FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     ORDER BY r.name, p.name`
  );
  return { hotel: hotel[0], security: sec[0], grants };
}

app.get("/api/admin/restore-points", adminOnly, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT id, label, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at FROM restore_points ORDER BY id DESC LIMIT 50"
    );
    res.json({ ok: true, points: rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not load restore points." });
  }
});

app.post("/api/admin/restore-points", adminOnly, async (req, res) => {
  const label = String(req.body.label || "").trim();
  if (!label || label.length > 100) return res.status(400).json({ ok: false, message: "Give the restore point a label (up to 100 characters)." });
  try {
    const cfg = await configSnapshot(db);
    await db.execute(
      "INSERT INTO restore_points (label, config_json, created_by) VALUES (?, ?, ?)",
      [label, JSON.stringify(cfg), req.session.userId]
    );
    await audit(req.session.userId, req.session.username, "Create restore point", label, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not create the restore point." });
  }
});

app.post("/api/admin/restore-points/:id/apply", adminOnly, async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(400).json({ ok: false, message: "Invalid request." });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute("SELECT label, config_json FROM restore_points WHERE id = ? FOR UPDATE", [id]);
    if (!rows[0]) {
      await conn.rollback();
      return res.status(404).json({ ok: false, message: "Restore point not found." });
    }
    const cfg = typeof rows[0].config_json === "string" ? JSON.parse(rows[0].config_json) : rows[0].config_json;
    if (!cfg || !cfg.hotel || !cfg.security || !Array.isArray(cfg.grants)) {
      await conn.rollback();
      return res.status(400).json({ ok: false, message: "This restore point is damaged." });
    }

    // Safety net: save today's settings first, so the restore can itself be undone
    const current = await configSnapshot(conn);
    await conn.execute(
      "INSERT INTO restore_points (label, config_json, created_by) VALUES (?, ?, ?)",
      ["Automatic: before restoring \"" + rows[0].label + "\"", JSON.stringify(current), req.session.userId]
    );

    // Settings only. No guest, booking, payment or user data is touched.
    await conn.execute(
      "UPDATE hotel_info SET name = ?, phone = ?, email = ?, address = ?, checkin_time = ?, checkout_time = ? WHERE id = ?",
      [cfg.hotel.name, cfg.hotel.phone, cfg.hotel.email, cfg.hotel.address, cfg.hotel.checkin_time, cfg.hotel.checkout_time, 1]
    );
    await conn.execute(
      "UPDATE security_settings SET require_2fa = ?, max_failed_attempts = ?, session_timeout_min = ?, min_password_length = ? WHERE id = ?",
      [cfg.security.require_2fa, cfg.security.max_failed_attempts, cfg.security.session_timeout_min, cfg.security.min_password_length, 1]
    );
    for (const roleName of ["Manager", "Receptionist"]) {   // Admin always keeps every permission
      const [r] = await conn.execute("SELECT id FROM roles WHERE name = ?", [roleName]);
      await conn.execute("DELETE FROM role_permissions WHERE role_id = ?", [r[0].id]);
      for (const g of cfg.grants.filter(x => x.role === roleName)) {
        await conn.execute(
          "INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE name = ?",
          [r[0].id, g.permission]
        );
      }
    }
    await conn.commit();

    await audit(req.session.userId, req.session.username, "Apply restore point", rows[0].label, req.ip, "Success");
    res.json({ ok: true });
  } catch (err) {
    try { await conn.rollback(); } catch (e) {}
    console.error(err.message);
    res.status(500).json({ ok: false, message: "Could not apply the restore point." });
  } finally {
    conn.release();
  }
});

// ---------- Automatic backups: checks every hour, backs up if the last one is 24+ hours old ----------
async function autoBackupCheck() {
  try {
    const [rows] = await db.execute(
      "SELECT TIMESTAMPDIFF(HOUR, MAX(taken_at), NOW()) AS hours FROM backups WHERE status = ?", ["Success"]
    );
    const hours = rows[0].hours;
    if (hours === null || hours >= AUTO_BACKUP_HOURS) {
      const result = await runBackup("Automatic", null);
      await audit(null, "system", "Automatic backup", result.fileName, null, "Success");
      console.log("Automatic backup saved: " + result.fileName);
    }
  } catch (err) {
    console.error("Automatic backup problem:", err.message);
  }
}
setTimeout(autoBackupCheck, 60 * 1000);
setInterval(autoBackupCheck, 60 * 60 * 1000);

app.get("/", (req, res) => res.redirect("/login.html"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "127.0.0.1", (err) => {
  if (err) {
    console.error("Cannot start server: " + err.message);
    process.exit(1);
  }
  console.log("Server running at http://localhost:" + PORT);
});