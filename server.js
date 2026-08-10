/**
 * 救生員工時 — 雲端伺服器
 * - 提供靜態網頁（手機可長期開）
 * - /api/state 共用資料庫（JSON 檔），唔使靠你部電腦
 * - 熄主機唔影響：部署到 Railway / Render 後 24 小時可開
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 8765;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");

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

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function defaultState() {
  return {
    staff: [],
    shifts: [],
    active: null,
    updatedAt: new Date().toISOString(),
  };
}

function readStore() {
  ensureDataDir();
  try {
    if (!fs.existsSync(STORE_PATH)) {
      const empty = defaultState();
      fs.writeFileSync(STORE_PATH, JSON.stringify(empty, null, 2), "utf8");
      return empty;
    }
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      staff: Array.isArray(parsed.staff) ? parsed.staff : [],
      shifts: Array.isArray(parsed.shifts) ? parsed.shifts : [],
      active: parsed.active || null,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
    };
  } catch (e) {
    console.error("readStore error", e);
    return defaultState();
  }
}

function writeStore(state) {
  ensureDataDir();
  const payload = {
    staff: Array.isArray(state.staff) ? state.staff : [],
    shifts: Array.isArray(state.shifts) ? state.shifts : [],
    active: state.active || null,
    updatedAt: new Date().toISOString(),
  };
  // 原子寫入：先寫 temp 再 rename，減少損壞風險
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, STORE_PATH);
  return payload;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
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
    const MAX = 5 * 1024 * 1024; // 5MB
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

async function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: "lifeguard-timesheet",
      time: new Date().toISOString(),
    });
    return;
  }

  if (pathname === "/api/state") {
    if (req.method === "GET") {
      sendJson(res, 200, readStore());
      return;
    }
    if (req.method === "PUT") {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw || "{}");
        if (!Array.isArray(body.staff) || !Array.isArray(body.shifts)) {
          sendJson(res, 400, { error: "格式錯誤：需要 staff 與 shifts 陣列" });
          return;
        }
        const saved = writeStore(body);
        sendJson(res, 200, saved);
      } catch (e) {
        sendJson(res, 400, { error: String(e.message || e) });
      }
      return;
    }
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

  // 目錄 → index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    // SPA fallback
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
  // HTML/JS/CSS 唔 cache，方便更新；其他可短 cache
  const cache =
    ext === ".html" || ext === ".js" || ext === ".css"
      ? "no-cache"
      : "public, max-age=86400";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": cache,
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `localhost:${PORT}`;
    const u = new URL(req.url || "/", `http://${host}`);
    const pathname = u.pathname;

    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }
    serveStatic(req, res, pathname);
  } catch (e) {
    console.error(e);
    sendText(res, 500, "Server error");
  }
});

ensureDataDir();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`救生員工時 已啟動 → http://localhost:${PORT}`);
  console.log(`資料檔：${STORE_PATH}`);
  console.log(`健康檢查：http://localhost:${PORT}/api/health`);
});
