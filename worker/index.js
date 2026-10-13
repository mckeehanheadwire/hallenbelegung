// Cloudflare Worker for the Hallenbelegung app (muri.example-company.xyz).
//   GET  /, /<file>, /admin    the app and the admin page, proxied from the published WREN tree "site"
//   GET  /api/halls|plan|free-slots, POST /api/requests     public REST
//   POST /mcp                  public MCP server (read tools + submit_request)
//   POST /mcp/admin            admin MCP server for LLM clients (Bearer ADMIN_MCP_TOKEN)
//   /admin/api/*               admin page API (magic-code login, session cookie)
//   GET  /llms.txt             how LLMs can use all of the above
import { handleMcp } from "./mcp.js";
import { PUBLIC_TOOLS, ADMIN_TOOLS, runTool, publishPlan, submitRequestData, ToolError } from "./tools.js";
import { startLogin, verifyLogin, sessionUser, logoutCookie, mcpTokenValid } from "./auth.js";
import { llmsTxt } from "./llms.js";

const MAX_BODY = 8 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env, url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      return withHeaders(await route(request, env, ctx, url), cors);
    } catch (err) {
      if (err instanceof ToolError) return withHeaders(json({ error: err.message }, err.status || 422), cors);
      console.error(JSON.stringify({ msg: "unhandled", path: url.pathname, error: String(err) }));
      return withHeaders(json({ error: "Interner Fehler" }, 500), cors);
    }
  },
};

async function route(request, env, ctx, url) {
  const p = url.pathname, m = request.method;

  // ----- public REST -----
  if (p === "/api/requests") return m === "POST" ? createRequest(request, env) : notAllowed("POST");
  if (p === "/api/halls" || p === "/api/plan" || p === "/api/free-slots") {
    if (m !== "GET") return notAllowed("GET");
    const q = url.searchParams;
    const [tool, args] =
      p === "/api/halls" ? ["list_halls", { season: q.get("season") || undefined }] :
      p === "/api/plan" ? ["get_week_plan", { hall: q.get("hall") || "", season: q.get("season") || undefined }] :
      ["find_free_slots", {
        days: q.get("days") ? q.get("days").split(",") : undefined, from: q.get("from") || undefined,
        min_minutes: q.get("min") ? Number(q.get("min")) : undefined, hall: q.get("hall") || undefined,
        season: q.get("season") || undefined, limit: q.get("limit") ? Number(q.get("limit")) : undefined,
      }];
    return json(await runTool(tool, args, { env }), 200, { "Cache-Control": "public, max-age=60" });
  }
  if (p.startsWith("/api/")) return json({ error: "Not found" }, 404);

  // ----- MCP -----
  if (p === "/mcp") {
    if (!originAllowed(request, env, url)) return json({ error: "Origin not allowed" }, 403);
    return handleMcp(request, {
      tools: PUBLIC_TOOLS, ctx: { env }, name: "hallenbelegung-muri",
      instructions: "Hallenbelegung der Sporthallen in Muri bei Bern (Schweiz). Wochenpläne, freie Zeiten finden und Hallenzeiten anfragen. Antworte auf Deutsch, wenn der Nutzer Deutsch schreibt. submit_request nur auf ausdrücklichen Wunsch mit vollständigen Kontaktangaben aufrufen.",
    });
  }
  if (p === "/mcp/admin") {
    if (!(await mcpTokenValid(request, env))) {
      return json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="hallenbelegung-admin"' });
    }
    return handleMcp(request, {
      tools: [...PUBLIC_TOOLS.filter(t => t.name !== "submit_request"), ...ADMIN_TOOLS],
      ctx: { env, admin: true, actor: "LLM (Admin-MCP)" }, name: "hallenbelegung-muri-admin",
      instructions: "Admin-Werkzeuge für die Hallenbelegung Muri bei Bern. Alle Änderungen sind Entwürfe; veröffentlicht wird nur durch eine Person im Admin-Bereich (https://muri.example-company.xyz/admin). Prüfe vor approve_request mit get_week_plan/find_free_slots, ob die Zeit frei ist, und begründe Ablehnungen kurz und freundlich. Melde nach Änderungen, dass sie noch veröffentlicht werden müssen.",
    });
  }

  // ----- admin page API -----
  if (p.startsWith("/admin/api/")) return adminApi(request, env, url);

  // ----- static -----
  if (p === "/llms.txt") return new Response(llmsTxt(url.origin), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" } });
  if (m === "GET" || m === "HEAD") return serveSite(url, request, env, ctx);
  return notAllowed("GET, HEAD");
}

async function adminApi(request, env, url) {
  const p = url.pathname.slice("/admin/api".length), m = request.method;
  // Admin POSTs must come from this site's own pages (on top of SameSite=Strict cookies).
  if (m === "POST" && request.headers.get("Origin") !== url.origin) return json({ error: "Origin not allowed" }, 403);

  if (p === "/login/start" && m === "POST") {
    const body = await readJson(request);
    const r = await startLogin(body.email, env);
    if (!r.ok) return json({ error: "Diese E-Mail-Adresse ist nicht als Admin freigeschaltet." }, 403);
    console.log(JSON.stringify({ msg: "login code issued", delivery: r.delivery }));
    return json(r);
  }
  if (p === "/login/verify" && m === "POST") {
    const body = await readJson(request);
    const r = await verifyLogin(body.challenge, body.code, env);
    if (!r) return json({ error: "Code ungültig oder abgelaufen." }, 401);
    console.log(JSON.stringify({ msg: "admin login", email: r.email }));
    return json({ ok: true, email: r.email }, 200, { "Set-Cookie": r.cookie });
  }
  if (p === "/logout" && m === "POST") return json({ ok: true }, 200, { "Set-Cookie": logoutCookie });

  const user = await sessionUser(request, env);
  if (!user) return json({ error: "Nicht angemeldet" }, 401);

  if (p === "/me" && m === "GET") {
    return json({ email: user, mcp: { url: `${url.origin}/mcp/admin`, tokenConfigured: !!env.ADMIN_MCP_TOKEN }, loginDelivery: env.LOGIN_CODE_DELIVERY || "email" });
  }
  if (p === "/mcp-token" && m === "GET") {
    // Admins hand this token to their own LLM client (Claude Code / Desktop) for /mcp/admin.
    if (!env.ADMIN_MCP_TOKEN) return json({ error: "Kein Token konfiguriert" }, 404);
    console.log(JSON.stringify({ msg: "mcp token viewed", by: user }));
    return json({ token: env.ADMIN_MCP_TOKEN });
  }
  if (p === "/publish" && m === "POST") {
    const r = await publishPlan(env);
    console.log(JSON.stringify({ msg: "plan published", by: user, promoted: r.promoted }));
    return json(r);
  }
  const t = p.match(/^\/tools\/([a-z_]+)$/);
  if (t && m === "POST") {
    const args = await readJson(request);
    return json(await runTool(t[1], args, { env, admin: true, actor: user }));
  }
  return json({ error: "Not found" }, 404);
}

async function createRequest(request, env) {
  const body = await readJson(request);
  // Honeypot field: real users never fill it.
  if (body.website) return json({ ok: true }, 202);
  const r = await submitRequestData({ ...body, via: "web" }, env);
  console.log(JSON.stringify({ msg: "request stored", id: r.id }));
  return json({ ok: true, id: r.id }, 201);
}

async function readJson(request) {
  if (!(request.headers.get("Content-Type") || "").includes("application/json")) throw new HttpError(415, "JSON erwartet");
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new HttpError(413, "Anfrage zu gross");
  try { return JSON.parse(raw) || {}; } catch { throw new HttpError(400, "Ungültiges JSON"); }
}
class HttpError extends ToolError {
  constructor(status, message) { super(message); this.status = status; }
}

// Serve the app from the published WREN tree. Flat file names only (the app has no subfolders).
async function serveSite(url, request, env, ctx) {
  // Local development (wrangler dev --env dev): serve ./app from disk via the assets binding.
  if (env.ASSETS) {
    const local = new URL(url);
    if (url.pathname === "/admin") local.pathname = "/admin.html";
    return env.ASSETS.fetch(new Request(local, request));
  }
  const name = url.pathname === "/" ? "index.html" : url.pathname === "/admin" ? "admin.html" : url.pathname.slice(1);
  if (!/^[a-z0-9_-]+\.(html|css|js|svg|png|ico|webmanifest|woff2)$/i.test(name)) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  // Keep only the ?v=<hash> stamp that deploy_site.sh adds, so each deploy gets fresh cache entries.
  const v = url.searchParams.get("v");
  // Pages are never treated as versioned, so a ?v= on the page URL cannot pin an old page.
  const suffix = v && /^[0-9a-f]{6,40}$/.test(v) && !name.endsWith(".html") ? `?v=${v}` : "";
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/${name}${suffix}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  // Hash-stamped files never change -> cache long; unstamped ones (pages) at most a minute.
  const upstream = await fetch(`${env.WREN_BASE}/orgs/${env.WREN_ORG}/tree/${env.WREN_TREE}/${name}${suffix}`, {
    headers: { "User-Agent": "hallenbelegung-worker/1.0" },
    cf: { cacheTtl: suffix ? 86400 : 60 },
  });
  if (!upstream.ok) {
    if (upstream.status !== 404) console.error(JSON.stringify({ msg: "site fetch failed", name, status: upstream.status }));
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const res = new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "application/octet-stream",
      "Cache-Control": suffix ? "public, max-age=31536000, immutable" : "public, max-age=60",
      "X-Content-Type-Options": "nosniff",
      ...(name === "admin.html" ? { "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" } : {}),
    },
  });
  if (request.method === "GET") ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// Browsers may only call the API from the app's own origins; MCP clients send no Origin.
function originAllowed(request, env, url) {
  const origin = request.headers.get("Origin");
  if (!origin || origin === url.origin) return true;
  return (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).includes(origin);
}

function corsHeaders(request, env, url) {
  const origin = request.headers.get("Origin");
  // Public read endpoints are open to any origin.
  if (request.method === "GET" && /^\/api\/(halls|plan|free-slots)$/.test(url.pathname)) return { "Access-Control-Allow-Origin": "*" };
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin) || !url.pathname.startsWith("/api/")) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withHeaders(res, extra) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
  return out;
}

function notAllowed(allow) { return json({ error: "Method not allowed" }, 405, { Allow: allow }); }

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export { HttpError };
