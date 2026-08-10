/**
 * 我的工時 — 雲端 API
 * - 帳號註冊 / 登入
 * - 每人獨立資料庫（工時、地址、設定）
 * - 同時提供靜態網頁
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 8765;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const USERS_PATH = path.join(DATA_DIR, "users.json");
const USER_DATA_DIR = path.join(DATA_DIR, "userdata");
const SECRET_PATH = path.join(DATA_DIR, "secret.key");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USER_DATA_DIR))
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

function getSecret() {
  ensureDirs();
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (fs.existsSync(SECRET_PATH)) {
    return fs.readFileSync(SECRET_PATH, "utf8").trim();
  }
  const s = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(SECRET_PATH, s, "utf8");
  return s;
}

function readUsers() {
  ensureDirs();
  try {
    if (!fs.existsSync(USERS_PATH)) {
      const empty = { users: {} };
      fs.writeFileSync(USERS_PATH, JSON.stringify(empty, null, 2), "utf8");
      return empty;
    }
    return JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
  } catch {
    return { users: {} };
  }
}

function writeUsers(db) {
  ensureDirs();
  const tmp = USERS_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, USERS_PATH);
}

function userDataPath(username) {
  // 安全檔名
  const safe = String(username).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "_");
  return path.join(USER_DATA_DIR, safe + ".json");
}

function defaultUserData() {
  return {
    me: null,
    shifts: [],
    active: null,
    sentLog: {},
    locations: [],
    updatedAt: new Date().toISOString(),
  };
}

function readUserData(username) {
  const p = userDataPath(username);
  try {
    if (!fs.existsSync(p)) return defaultUserData();
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      me: raw.me || null,
      shifts: Array.isArray(raw.shifts) ? raw.shifts : [],
      active: raw.active || null,
      sentLog: raw.sentLog && typeof raw.sentLog === "object" ? raw.sentLog : {},
      locations: Array.isArray(raw.locations) ? raw.locations : [],
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
  } catch {
    return defaultUserData();
  }
}

function writeUserData(username, data) {
  ensureDirs();
  const payload = {
    me: data.me || null,
    shifts: Array.isArray(data.shifts) ? data.shifts : [],
    active: data.active || null,
    sentLog:
      data.sentLog && typeof data.sentLog === "object" ? data.sentLog : {},
    locations: Array.isArray(data.locations) ? data.locations : [],
    updatedAt: new Date().toISOString(),
  };
  const p = userDataPath(username);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, p);
  return payload;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function createToken(username) {
  const secret = getSecret();
  const exp = Date.now() + 90 * 24 * 60 * 60 * 1000; // 90 日
  const payload = Buffer.from(
    JSON.stringify({ u: username, exp }),
    "utf8"
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return payload + "." + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const secret = getSecret();
  const expect = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.u || !data.exp || Date.now() > data.exp) return null;
    return data.u;
  } catch {
    return null;
  }
}

function getAuthUser(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return verifyToken(m[1].trim());
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...CORS,
  });
  res.end(body);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...CORS });
  res.end(text);
}

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent(reqPath.split("?")[0]);
  const clean = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(root, clean);
  if (!full.startsWith(root)) return null;
  return full;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 8 * 1024 * 1024;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function normalizeUsername(u) {
  return String(u || "")
    .trim()
    .toLowerCase();
}

function validUsername(u) {
  // 3–32 字，英數底線
  return /^[a-z0-9_\u4e00-\u9fff]{2,32}$/i.test(u);
}

async function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: "lifeguard-timesheet",
      auth: true,
      time: new Date().toISOString(),
    });
    return;
  }

  // 註冊
  if (pathname === "/api/register" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const username = normalizeUsername(body.username);
      const password = String(body.password || "");
      if (!validUsername(username)) {
        sendJson(res, 400, {
          error: "帳號要用 2–32 個字（英數或中文）",
        });
        return;
      }
      if (password.length < 4) {
        sendJson(res, 400, { error: "密碼至少 4 個字" });
        return;
      }
      const db = readUsers();
      if (db.users[username]) {
        sendJson(res, 409, { error: "呢個帳號已經有人用" });
        return;
      }
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = hashPassword(password, salt);
      db.users[username] = {
        salt,
        hash,
        createdAt: new Date().toISOString(),
      };
      writeUsers(db);

      // 初始化資料（可帶入現有 me）
      const init = defaultUserData();
      if (body.me && body.me.name) {
        init.me = {
          name: String(body.me.name).trim(),
          rate: Number(body.me.rate) || 0,
          phone: body.me.phone || "",
          bossPhone: body.me.bossPhone || "",
        };
      }
      if (Array.isArray(body.shifts)) init.shifts = body.shifts;
      if (Array.isArray(body.locations)) init.locations = body.locations;
      if (body.sentLog) init.sentLog = body.sentLog;
      writeUserData(username, init);

      const token = createToken(username);
      sendJson(res, 201, {
        token,
        username,
        data: init,
        message: "註冊成功",
      });
    } catch (e) {
      sendJson(res, 400, { error: String(e.message || e) });
    }
    return;
  }

  // 登入
  if (pathname === "/api/login" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const username = normalizeUsername(body.username);
      const password = String(body.password || "");
      const db = readUsers();
      const user = db.users[username];
      if (!user) {
        sendJson(res, 401, { error: "帳號或密碼唔正確" });
        return;
      }
      const hash = hashPassword(password, user.salt);
      const a = Buffer.from(hash);
      const b = Buffer.from(user.hash);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        sendJson(res, 401, { error: "帳號或密碼唔正確" });
        return;
      }
      const data = readUserData(username);
      const token = createToken(username);
      sendJson(res, 200, { token, username, data, message: "登入成功" });
    } catch (e) {
      sendJson(res, 400, { error: String(e.message || e) });
    }
    return;
  }

  // 讀取／儲存自己的資料
  if (pathname === "/api/data") {
    const username = getAuthUser(req);
    if (!username) {
      sendJson(res, 401, { error: "請先登入" });
      return;
    }
    if (req.method === "GET") {
      sendJson(res, 200, { username, data: readUserData(username) });
      return;
    }
    if (req.method === "PUT") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const saved = writeUserData(username, body);
        sendJson(res, 200, { username, data: saved, message: "已同步雲端" });
      } catch (e) {
        sendJson(res, 400, { error: String(e.message || e) });
      }
      return;
    }
  }

  // 誰在線
  if (pathname === "/api/me" && req.method === "GET") {
    const username = getAuthUser(req);
    if (!username) {
      sendJson(res, 401, { error: "請先登入" });
      return;
    }
    sendJson(res, 200, { username });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  let filePath = safeJoin(ROOT, rel);
  if (!filePath) {
    sendText(res, 403, "Forbidden");
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    const index = path.join(ROOT, "index.html");
    if (fs.existsSync(index)) {
      sendText(res, 200, fs.readFileSync(index, "utf8"), MIME[".html"]);
      return;
    }
    sendText(res, 404, "Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const cache =
    ext === ".html" || ext === ".js" || ext === ".css"
      ? "no-cache"
      : "public, max-age=86400";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": cache });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `localhost:${PORT}`;
    const u = new URL(req.url || "/", `http://${host}`);
    if (u.pathname.startsWith("/api/")) {
      await handleApi(req, res, u.pathname);
      return;
    }
    serveStatic(req, res, u.pathname);
  } catch (e) {
    console.error(e);
    sendText(res, 500, "Server error");
  }
});

ensureDirs();
getSecret();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`救生員工時 雲端 API → http://localhost:${PORT}`);
  console.log(`資料目錄：${DATA_DIR}`);
});
