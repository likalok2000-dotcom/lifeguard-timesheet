/**
 * Cloudflare Worker — 我的工時 雲端 API + 靜態檔
 * 免費長駐：熄機都用得
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS,
    },
  });
}

function text(body, status = 200, type = "text/plain; charset=utf-8") {
  return new Response(body, {
    status,
    headers: { "Content-Type": type, "Cache-Control": "no-store", ...CORS },
  });
}

function b64url(buf) {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPassword(password, salt) {
  // PBKDF2-SHA256（Worker 環境無 scrypt）
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: enc.encode(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    key,
    256
  );
  return [...new Uint8Array(bits)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getSecret(env) {
  return env.JWT_SECRET || "lifeguard-default-secret-change-me";
}

async function createToken(username, env) {
  const exp = Date.now() + 90 * 24 * 60 * 60 * 1000;
  const payload = b64url(
    new TextEncoder().encode(JSON.stringify({ u: username, exp }))
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  return payload + "." + b64url(sig);
}

async function verifyToken(token, env) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlToBytes(sig),
    new TextEncoder().encode(payload)
  );
  if (!ok) return null;
  try {
    const data = JSON.parse(
      new TextDecoder().decode(b64urlToBytes(payload))
    );
    if (!data.u || !data.exp || Date.now() > data.exp) return null;
    return data.u;
  } catch {
    return null;
  }
}

function getAuthUser(request, env) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return verifyToken(m[1].trim(), env);
}

function normalizeUsername(u) {
  return String(u || "")
    .trim()
    .toLowerCase();
}

function validUsername(u) {
  return /^[a-z0-9_\u4e00-\u9fff]{2,32}$/i.test(u);
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

function userKey(username) {
  return "user:" + username;
}

function dataKey(username) {
  return "data:" + username;
}

async function handleApi(request, env, pathname) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (pathname === "/api/health") {
    return json({
      ok: true,
      service: "lifeguard-timesheet",
      auth: true,
      host: "cloudflare-workers",
      time: new Date().toISOString(),
    });
  }

  // 註冊
  if (pathname === "/api/register" && request.method === "POST") {
    try {
      const body = await request.json();
      const username = normalizeUsername(body.username);
      const password = String(body.password || "");
      if (!validUsername(username)) {
        return json({ error: "帳號要用 2–32 個字（英數或中文）" }, 400);
      }
      if (password.length < 4) {
        return json({ error: "密碼至少 4 個字" }, 400);
      }
      const existing = await env.DB.get(userKey(username));
      if (existing) {
        return json({ error: "呢個帳號已經有人用" }, 409);
      }
      const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
      const hash = await hashPassword(password, salt);
      await env.DB.put(
        userKey(username),
        JSON.stringify({
          salt,
          hash,
          algo: "pbkdf2",
          createdAt: new Date().toISOString(),
        })
      );

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
      init.updatedAt = new Date().toISOString();
      await env.DB.put(dataKey(username), JSON.stringify(init));

      const token = await createToken(username, env);
      return json(
        { token, username, data: init, message: "註冊成功" },
        201
      );
    } catch (e) {
      return json({ error: String(e.message || e) }, 400);
    }
  }

  // 登入
  if (pathname === "/api/login" && request.method === "POST") {
    try {
      const body = await request.json();
      const username = normalizeUsername(body.username);
      const password = String(body.password || "");
      const raw = await env.DB.get(userKey(username));
      if (!raw) return json({ error: "帳號或密碼唔正確" }, 401);
      const user = JSON.parse(raw);
      const hash = await hashPassword(password, user.salt);
      if (hash !== user.hash) {
        return json({ error: "帳號或密碼唔正確" }, 401);
      }
      let data = defaultUserData();
      const d = await env.DB.get(dataKey(username));
      if (d) data = JSON.parse(d);
      const token = await createToken(username, env);
      return json({ token, username, data, message: "登入成功" });
    } catch (e) {
      return json({ error: String(e.message || e) }, 400);
    }
  }

  // 資料
  if (pathname === "/api/data") {
    const username = await getAuthUser(request, env);
    if (!username) return json({ error: "請先登入" }, 401);

    if (request.method === "GET") {
      let data = defaultUserData();
      const d = await env.DB.get(dataKey(username));
      if (d) data = JSON.parse(d);
      return json({ username, data });
    }

    if (request.method === "PUT") {
      try {
        const body = await request.json();
        const payload = {
          me: body.me || null,
          shifts: Array.isArray(body.shifts) ? body.shifts : [],
          active: body.active || null,
          sentLog:
            body.sentLog && typeof body.sentLog === "object"
              ? body.sentLog
              : {},
          locations: Array.isArray(body.locations) ? body.locations : [],
          updatedAt: new Date().toISOString(),
        };
        await env.DB.put(dataKey(username), JSON.stringify(payload));
        return json({
          username,
          data: payload,
          message: "已同步雲端",
        });
      } catch (e) {
        return json({ error: String(e.message || e) }, 400);
      }
    }
  }

  if (pathname === "/api/me" && request.method === "GET") {
    const username = await getAuthUser(request, env);
    if (!username) return json({ error: "請先登入" }, 401);
    return json({ username });
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname.startsWith("/api/")) {
      return handleApi(request, env, pathname);
    }

    // 靜態資源（Workers Assets）
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return text("Not found", 404);
  },
};
