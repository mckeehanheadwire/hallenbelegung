// Admin authentication without dependencies:
//  - Browser: magic-code login for allow-listed emails -> signed session cookie (HMAC-SHA256).
//    LOGIN_CODE_DELIVERY="screen" (testing) returns the code in the response instead of emailing it.
//  - LLM clients (admin MCP): Authorization: Bearer <ADMIN_MCP_TOKEN>.

const enc = new TextEncoder();
const SESSION_COOKIE = "hb_admin";
const SESSION_TTL = 8 * 60 * 60;       // seconds
const CODE_TTL = 10 * 60;              // seconds

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = s => b64url(enc.encode(s));
const fromB64urlText = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)));

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

// Constant-time comparison: hash both values, then compare the digests byte by byte.
export async function safeEqual(a, b) {
  const [da, db] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(String(a))), crypto.subtle.digest("SHA-256", enc.encode(String(b)))]);
  const x = new Uint8Array(da), y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function adminEmails(env) {
  return (env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

export async function startLogin(email, env) {
  email = String(email || "").trim().toLowerCase();
  if (!adminEmails(env).includes(email)) return { ok: false };
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  const code = String(n).padStart(6, "0");
  const exp = Math.floor(Date.now() / 1000) + CODE_TTL;
  const payload = b64urlText(JSON.stringify({ email, exp }));
  const challenge = `${payload}.${await hmac(env.SESSION_SECRET, `code|${payload}|${code}`)}`;
  const screen = env.LOGIN_CODE_DELIVERY === "screen";
  // Email delivery is not implemented yet; in that mode the code is only logged as "not sent".
  if (!screen) console.warn(JSON.stringify({ msg: "login code email delivery not configured", email }));
  return { ok: true, challenge, delivery: screen ? "screen" : "email", code: screen ? code : undefined, expiresIn: CODE_TTL };
}

export async function verifyLogin(challenge, code, env) {
  const [payload, sig] = String(challenge || "").split(".");
  if (!payload || !sig || !/^\d{6}$/.test(String(code || ""))) return null;
  if (!(await safeEqual(sig, await hmac(env.SESSION_SECRET, `code|${payload}|${code}`)))) return null;
  const { email, exp } = JSON.parse(fromB64urlText(payload));
  if (exp < Date.now() / 1000 || !adminEmails(env).includes(email)) return null;
  const sPayload = b64urlText(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL }));
  const token = `${sPayload}.${await hmac(env.SESSION_SECRET, `session|${sPayload}`)}`;
  return { email, cookie: `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL}` };
}

export const logoutCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// Returns the admin email of a valid session cookie, or null.
export async function sessionUser(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  if (!(await safeEqual(sig, await hmac(env.SESSION_SECRET, `session|${payload}`)))) return null;
  try {
    const { email, exp } = JSON.parse(fromB64urlText(payload));
    return exp > Date.now() / 1000 && adminEmails(env).includes(email) ? email : null;
  } catch { return null; }
}

// Admin MCP: static bearer token from the ADMIN_MCP_TOKEN secret.
export async function mcpTokenValid(request, env) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m || !env.ADMIN_MCP_TOKEN) return false;
  return safeEqual(m[1].trim(), env.ADMIN_MCP_TOKEN);
}
