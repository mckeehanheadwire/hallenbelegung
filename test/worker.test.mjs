// Runs the Worker in Node against an in-memory fake of the WREN API: node --test test/
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.js";

const ORIGIN = "https://muri.test";
const env = {
  WREN_BASE: "https://wren.test",
  WREN_ORG: "org",
  WREN_TREE: "site",
  WREN_API_KEY: "wren-key",
  ALLOWED_ORIGINS: "https://wren.test",
  ADMIN_EMAILS: "admin@example.com",
  ADMIN_DOMAINS: "gemeinde.test",
  LOGIN_CODE_DELIVERY: "screen",
  SESSION_SECRET: "test-session-secret",
  ADMIN_MCP_TOKEN: "test-mcp-token",
};
const ctx = { waitUntil: p => p };
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

/* ---------- fake WREN ---------- */

let db, calls;
function doc(coll, data) {
  const id = `${coll}-${db[coll].length + 1}`;
  const d = { id, versions: [structuredClone(data)], labels: {} };
  db[coll].push(d);
  return d;
}
const view = (d, label) => {
  const v = label ? d.labels[label] : d.versions.length;
  return v ? { id: d.id, version: v, data: d.versions[v - 1], labels: Object.keys(d.labels) } : null;
};
function seed() {
  db = { halls: [], bookings: [], requests: [], booking_holders: [], calendar: [], clubs: [] };
  doc("halls", { key: "moos", name: "Sporthalle Moos", size: "27 x 45m" });
  doc("halls", { key: "aebnit", name: "Sporthalle Aebnit", size: "14.2x25m" });
  const b = (hallKey, hall, day, from, to, category) =>
    doc("bookings", { key: `${hallKey}-${day.toLowerCase()}-ganzjaehrig-${from.replace(":", "")}`, hall, hallKey, day, season: "ganzjährig", from, to, category });
  b("moos", "Sporthalle Moos", "Montag", "07:30", "18:00", "Schule");
  b("moos", "Sporthalle Moos", "Montag", "18:00", "22:30", "Verein/Stiftung");
  b("moos", "Sporthalle Moos", "Dienstag", "07:30", "17:30", "Schule");
  b("aebnit", "Sporthalle Aebnit", "Samstag", "08:00", "22:00", "nicht verfügbar");
  doc("calendar", { key: "sj-2026-27", kind: "schuljahr", name: "Schuljahr 2026/27", from: "", to: "2099-07-02" });
  doc("calendar", { key: "herbst", kind: "ferien", name: "Herbstferien", from: "2026-09-19", to: "2026-10-11", effect: "school" });
  for (const d of [...db.bookings, ...db.halls, ...db.calendar]) d.labels.published = 1;
  calls = [];
}

async function fakeWren(url, init = {}) {
  const u = new URL(url), m = init.method || "GET";
  calls.push({ m, path: u.pathname + u.search, auth: init.headers?.Authorization });
  const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const body = init.body ? JSON.parse(init.body) : undefined;
  let p = u.pathname;
  if (p.startsWith("/orgs/org/tree/site/")) {
    return p.endsWith("/index.html") ? new Response("<!doctype html>", { headers: { "Content-Type": "text/html;charset=utf-8" } }) : new Response("", { status: 404 });
  }
  const isPublic = p.startsWith("/api/v1/orgs/org/");
  p = p.replace("/api/v1/orgs/org", "/api/v1").replace("/api/v1", "");
  if (!isPublic && init.headers?.Authorization !== "Bearer wren-key") return ok({ error: "unauthorized" }, 401);
  let mm;
  if (m === "POST" && p === "/tree/plan/_promote") {
    const promoted = [...db.halls, ...db.bookings, ...db.calendar, ...db.clubs].map(d => { d.labels.published = d.versions.length; return { documentId: d.id }; });
    return ok({ promoted });
  }
  if (m === "PUT" && (mm = p.match(/^\/tree\/plan\/(.+)$/))) return ok({ path: "/" + mm[1], documentId: body.documentId });
  if ((mm = p.match(/^\/(\w+)$/)) && db[mm[1]]) {
    const coll = mm[1];
    if (m === "POST") return ok(view(doc(coll, body)), 201);
    // Public reads of bookings only see the published label (like the WREN rule).
    const label = isPublic && ["bookings", "halls", "calendar", "clubs"].includes(coll) ? "published" : u.searchParams.get("label");
    const items = db[coll].map(d => view(d, label)).filter(Boolean);
    const offset = Number(u.searchParams.get("offset") || 0), limit = Number(u.searchParams.get("limit") || 50);
    return ok({ items: items.slice(offset, offset + limit), total: items.length });
  }
  if ((mm = p.match(/^\/(\w+)\/by-key\/(.+)$/))) {
    const [, coll, key] = mm;
    const d = db[coll].find(x => x.versions.at(-1).key === key);
    if (u.searchParams.get("ifVersion") === "0" && d) return ok({ error: "exists" }, 412);
    if (!d) return ok(view(doc(coll, body)), 201);
    d.versions.push(structuredClone(body));
    return ok(view(d));
  }
  if ((mm = p.match(/^\/(\w+)\/([\w-]+)$/))) {
    const d = db[mm[1]]?.find(x => x.id === mm[2]);
    if (!d) return ok({ error: "not found" }, 404);
    if (m === "PUT") d.versions.push(structuredClone(body));
    return ok(view(d));
  }
  return ok({ error: `fake WREN: unhandled ${m} ${p}` }, 500);
}
globalThis.fetch = fakeWren;
beforeEach(seed);

/* ---------- helpers ---------- */

const req = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env, ctx);
const postJson = (path, body, headers = {}) => req(path, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
let rpcId = 0;
async function mcp(path, method, params, headers = {}) {
  const r = await req(path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
}
async function login() {
  const s = await (await postJson("/admin/api/login/start", { email: "Admin@Example.com" })).json();
  const v = await postJson("/admin/api/login/verify", { challenge: s.challenge, code: s.code });
  assert.equal(v.status, 200);
  return v.headers.get("Set-Cookie").split(";")[0];
}
const valid = { hall: "Sporthalle Moos", day: "Samstag", from: "13:00", to: "15:00", club: "TEST Club", contact: "Test Person", email: "test@example.com", team: "Erwachsene", people: 14, share: true };

/* ---------- static site ---------- */

test("/ serves index.html from the WREN tree; bad paths are 404 without upstream calls", async () => {
  const r = await req("/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Content-Type"), /text\/html/);
  calls = [];
  for (const p of ["/../secret", "/a/b.js", "/.wren-key", "/x.exe"]) assert.equal((await req(p)).status, 404, p);
  assert.equal(calls.length, 0);
});

/* ---------- public REST ---------- */

test("POST /api/requests validates and stores a request with the secret key", async () => {
  assert.equal((await postJson("/api/requests", { hall: "x" })).status, 422);
  assert.equal((await postJson("/api/requests", { ...valid, email: "nope" })).status, 422);
  assert.equal((await postJson("/api/requests", { ...valid, from: "13:15" })).status, 422);
  assert.equal((await postJson("/api/requests", { ...valid, from: "15:00", to: "13:00" })).status, 422);
  assert.equal((await req("/api/requests", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" })).status, 415);
  assert.equal((await postJson("/api/requests", { ...valid, website: "spam" })).status, 202);
  assert.equal(db.requests.length, 0);
  const r = await postJson("/api/requests", valid);
  assert.equal(r.status, 201);
  assert.equal(db.requests.length, 1);
  assert.equal(db.requests[0].versions[0].status, "neu");
  assert.ok(calls.some(c => c.m === "POST" && c.path === "/api/v1/requests" && c.auth === "Bearer wren-key"));
});

test("GET /api/free-slots uses the published plan and the shared logic", async () => {
  const r = await (await req("/api/free-slots?days=Montag&from=17:00&min=30&season=winter")).json();
  // Moos is booked all Monday; Aebnit has no Monday bookings -> free 17:00–22:30.
  assert.deepEqual(r.slots.map(s => [s.hallKey, s.day, s.from, s.to]), [["aebnit", "Montag", "17:00", "22:30"]]);
  const sat = await (await req("/api/free-slots?days=Samstag&season=winter")).json();
  assert.ok(!sat.slots.some(s => s.hallKey === "aebnit"), "closed Saturday must not show free slots");
});

/* ---------- public MCP ---------- */

test("public MCP: initialize, tools/list, tools/call, errors", async () => {
  const init = await mcp("/mcp", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.ok(init.body.result.capabilities.tools);
  const n = await req("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(n.status, 202);
  const list = await mcp("/mcp", "tools/list", {});
  assert.deepEqual(list.body.result.tools.map(t => t.name), ["list_halls", "get_week_plan", "find_free_slots", "list_holidays", "list_clubs", "submit_request"]);
  const plan = await mcp("/mcp", "tools/call", { name: "get_week_plan", arguments: { hall: "moos", season: "winter" } });
  assert.equal(plan.body.result.isError, false);
  assert.equal(plan.body.result.structuredContent.days[0].bookings.length, 2);
  const bad = await mcp("/mcp", "tools/call", { name: "get_week_plan", arguments: { hall: "nowhere" } });
  assert.equal(bad.body.result.isError, true);
  assert.match(bad.body.result.content[0].text, /unbekannt/);
  const admin = await mcp("/mcp", "tools/call", { name: "approve_request", arguments: { id: "x" } });
  assert.equal(admin.body.error.code, -32602, "admin tools are not reachable on the public server");
  assert.equal((await req("/mcp", { method: "POST", headers: { Origin: "https://evil.example" }, body: "{}" })).status, 403);
  assert.equal((await req("/mcp")).status, 405);
});

/* ---------- admin MCP ---------- */

test("admin MCP requires the bearer token", async () => {
  assert.equal((await mcp("/mcp/admin", "tools/list", {})).status, 401);
  assert.equal((await mcp("/mcp/admin", "tools/list", {}, { Authorization: "Bearer wrong" })).status, 401);
  const ok = await mcp("/mcp/admin", "tools/list", {}, { Authorization: "Bearer test-mcp-token" });
  const names = ok.body.result.tools.map(t => t.name);
  assert.ok(names.includes("approve_request") && names.includes("list_pending_changes"));
  assert.ok(!names.includes("submit_request"));
});

test("LLM approves a request -> draft booking, request approved, public plan unchanged until published", async () => {
  await postJson("/api/requests", { ...valid, day: "Dienstag", from: "18:00", to: "19:30" });
  const auth = { Authorization: "Bearer test-mcp-token" };
  const open = await mcp("/mcp/admin", "tools/call", { name: "list_requests", arguments: { status: "neu" } }, auth);
  const id = open.body.result.structuredContent.requests[0].id;

  const ap = await mcp("/mcp/admin", "tools/call", { name: "approve_request", arguments: { id, note: "passt" } }, auth);
  assert.equal(ap.body.result.isError, false, ap.body.result.content[0].text);
  assert.equal(ap.body.result.structuredContent.booking.key, "moos-dienstag-ganzjaehrig-1800");
  assert.equal(db.requests[0].versions.at(-1).status, "genehmigt");
  assert.equal(db.requests[0].versions.at(-1).decidedBy, "LLM (Admin-MCP)");
  assert.ok(calls.some(c => c.m === "PUT" && c.path === "/api/v1/tree/plan/bookings/moos-dienstag-ganzjaehrig-1800"));

  // Not public yet.
  const pub = await (await req("/api/plan?hall=moos&season=winter")).json();
  assert.equal(pub.days[1].bookings.length, 1);
  const pending = await mcp("/mcp/admin", "tools/call", { name: "list_pending_changes", arguments: {} }, auth);
  assert.equal(pending.body.result.structuredContent.total, 1);
  assert.equal(pending.body.result.structuredContent.changes[0].type, "neu");

  // A second approval for the same time conflicts.
  await postJson("/api/requests", { ...valid, day: "Dienstag", from: "18:30", to: "20:00", club: "Other" });
  const id2 = (await mcp("/mcp/admin", "tools/call", { name: "list_requests", arguments: { status: "neu" } }, auth)).body.result.structuredContent.requests[0].id;
  const clash = await mcp("/mcp/admin", "tools/call", { name: "approve_request", arguments: { id: id2 } }, auth);
  assert.equal(clash.body.result.isError, true);
  assert.match(clash.body.result.content[0].text, /Überschneidung/);
});

/* ---------- admin page API ---------- */

test("magic-code login: allow-list, on-screen code, session cookie, origin check", async () => {
  assert.equal((await postJson("/admin/api/login/start", { email: "someone@else.com" })).status, 403);
  const s = await (await postJson("/admin/api/login/start", { email: "admin@example.com" })).json();
  assert.equal(s.delivery, "screen");
  assert.match(s.code, /^\d{6}$/);
  const wrong = String((Number(s.code) + 1) % 1_000_000).padStart(6, "0");
  assert.equal((await postJson("/admin/api/login/verify", { challenge: s.challenge, code: wrong })).status, 401);
  const cookie = await login();
  assert.match(cookie, /^hb_admin=/);
  assert.equal((await req("/admin/api/me")).status, 401);
  const me = await (await req("/admin/api/me", { headers: { Cookie: cookie } })).json();
  assert.equal(me.email, "admin@example.com");
  assert.equal((await postJson("/admin/api/tools/list_requests", {}, { Cookie: cookie, Origin: "https://evil.example" })).status, 403);
  const forged = cookie.replace(/\.[^.]+$/, ".AAAA");
  assert.equal((await req("/admin/api/me", { headers: { Cookie: forged } })).status, 401);
});

test("login allowed for whole email domains, but not for look-alikes", async () => {
  const start = email => postJson("/admin/api/login/start", { email });
  const ok = await (await start(" Laura@Gemeinde.TEST ")).json();
  assert.equal(ok.email, "laura@gemeinde.test");
  for (const bad of ["x@sub.gemeinde.test", "x@gemeinde.test.evil.com", "x@evilgemeinde.test", "gemeinde.test", "a b@gemeinde.test"])
    assert.equal((await start(bad)).status, 403, bad);
  const v = await postJson("/admin/api/login/verify", { challenge: ok.challenge, code: ok.code });
  assert.equal(v.status, 200);
});

test("admin page: create, cancel and publish", async () => {
  const cookie = await login();
  const H = { Cookie: cookie };
  const c = await postJson("/admin/api/tools/create_booking", { hall: "aebnit", day: "Montag", from: "19:00", to: "20:30", category: "Verein/Stiftung", holder: "TV Muri" }, H);
  assert.equal(c.status, 200, await c.clone().text());
  const clash = await postJson("/admin/api/tools/create_booking", { hall: "aebnit", day: "Montag", from: "20:00", to: "21:00", category: "Private Gruppe" }, H);
  assert.equal(clash.status, 422);
  const cancel = await postJson("/admin/api/tools/cancel_booking", { key: "moos-montag-ganzjaehrig-1800", reason: "Verein aufgelöst" }, H);
  assert.equal(cancel.status, 200);
  const pending = await (await postJson("/admin/api/tools/list_pending_changes", {}, H)).json();
  assert.deepEqual(pending.changes.map(x => x.type).sort(), ["neu", "storniert"]);
  // Publishing makes both visible publicly.
  const pub = await (await postJson("/admin/api/publish", {}, H)).json();
  assert.ok(pub.promoted >= 2);
  const plan = await (await req("/api/plan?hall=moos&season=winter")).json();
  assert.equal(plan.days[0].bookings.length, 1, "cancelled booking is gone after publishing");
  assert.equal((await (await postJson("/admin/api/tools/list_pending_changes", {}, H)).json()).total, 0);
});

test("llms.txt documents public and admin endpoints", async () => {
  const t = await (await req("/llms.txt")).text();
  assert.match(t, /https:\/\/muri\.test\/mcp\b/);
  assert.match(t, /find_free_slots/);
  assert.match(t, /\/mcp\/admin/);
});

test("LLM creates a divisible facility and books thirds in parallel; whole hall then conflicts", async () => {
  const auth = { Authorization: "Bearer test-mcp-token" };
  const call = async (name, args) => (await mcp("/mcp/admin", "tools/call", { name, arguments: args }, auth)).body.result;
  const f = await call("create_facility", { name: "Sporthalle Neu", size: "27 x 45 m", units: ["A", "B", "C"],
    spaces: [{ key: "ganz", name: "Ganze Halle", units: ["A", "B", "C"] }, { key: "gross", name: "2/3", units: ["A", "B"] },
      { key: "a", name: "1/3 A", units: ["A"] }, { key: "b", name: "1/3 B", units: ["B"] }, { key: "c", name: "1/3 C", units: ["C"] }] });
  assert.equal(f.isError, false, f.content[0].text);
  assert.equal(f.structuredContent.facility.key, "neu");
  assert.equal((await call("create_booking", { hall: "neu", space: "a", day: "Mittwoch", from: "18:00", to: "20:00", category: "Verein/Stiftung", holder: "VBC" })).isError, false);
  const b = await call("create_booking", { hall: "neu", space: "c", day: "Mittwoch", from: "18:00", to: "20:00", category: "Verein/Stiftung", holder: "UHC" });
  assert.equal(b.isError, false, b.content[0].text);
  assert.equal(b.structuredContent.booking.key, "neu-mittwoch-ganzjaehrig-c-1800");
  const whole = await call("create_booking", { hall: "neu", day: "Mittwoch", from: "19:00", to: "21:00", category: "Private Gruppe" });
  assert.equal(whole.isError, true);
  assert.match(whole.content[0].text, /Überschneidung/);
  const bad = await call("create_booking", { hall: "neu", space: "xyz", day: "Mittwoch", from: "07:00", to: "08:00", category: "Schule" });
  assert.match(bad.content[0].text, /Fläche «xyz»/);
  // Removing a space that is in use is refused.
  const upd = await call("update_facility", { key: "neu", units: ["A", "B"], spaces: [{ key: "ganz", name: "Ganze Halle", units: ["A", "B"] }] });
  assert.equal(upd.isError, true);
  // Not public before publishing; free slots afterwards include the remaining third.
  assert.ok(!(await (await req("/api/halls")).json()).halls.some(h => h.key === "neu"));
  const pending = (await call("list_pending_changes", {})).structuredContent;
  assert.deepEqual(pending.changes.map(c => c.kind).sort(), ["booking", "booking", "facility"]);
  const cookie = await login();
  await postJson("/admin/api/publish", {}, { Cookie: cookie });
  const free = await (await req("/api/free-slots?days=Mittwoch&from=18:00&min=120&hall=neu")).json();
  // B is free all evening; from 20:00 the whole hall is free again (A and C end at 20:00).
  assert.deepEqual(free.slots.map(s => [s.space ?? "ganz", s.from, s.to]), [["b", "18:00", "22:30"], ["ganz", "20:00", "22:30"]]);
});

test("club name on a booking is private by default and public only with show_holder", async () => {
  const cookie = await login();
  const H = { Cookie: cookie };
  await postJson("/admin/api/tools/create_booking", { hall: "aebnit", day: "Mittwoch", from: "18:00", to: "20:00", category: "Verein/Stiftung", holder: "Geheimer Club" }, H);
  await postJson("/admin/api/tools/create_booking", { hall: "aebnit", day: "Mittwoch", from: "20:00", to: "21:30", category: "Verein/Stiftung", holder: "Taekwondo Bern", show_holder: true }, H);
  // Public booking documents never contain the private name.
  assert.ok(!JSON.stringify(db.bookings.map(d => d.versions)).includes("Geheimer Club"));
  assert.equal(db.booking_holders.find(d => d.versions.at(-1).holder === "Geheimer Club").versions.at(-1).key, "aebnit-mittwoch-ganzjaehrig-1800");
  // Admin sees both names.
  const adm = await (await postJson("/admin/api/tools/list_bookings", { hall: "aebnit", day: "Mittwoch" }, H)).json();
  assert.deepEqual(adm.bookings.map(b => [b.holder, b.holderPublic]), [["Geheimer Club", false], ["Taekwondo Bern", true]]);
  await postJson("/admin/api/publish", {}, H);
  const plan = await (await req("/api/plan?hall=aebnit&season=winter")).json();
  assert.deepEqual(plan.days[2].bookings.map(b => b.holder ?? null), [null, "Taekwondo Bern"]);
  // Switching visibility off moves the name back to the private collection.
  await postJson("/admin/api/tools/update_booking", { key: "aebnit-mittwoch-ganzjaehrig-2000", show_holder: false }, H);
  assert.equal(db.bookings.find(d => d.versions.at(-1).key === "aebnit-mittwoch-ganzjaehrig-2000").versions.at(-1).holder, undefined);
});

test("the club's choice in the request decides whether its name becomes public", async () => {
  const auth = { Authorization: "Bearer test-mcp-token" };
  const call = async (name, args) => (await mcp("/mcp/admin", "tools/call", { name, arguments: args }, auth)).body.result;
  // Default is public; the club can opt out.
  await postJson("/api/requests", { ...valid, club: "Offener Club", day: "Dienstag", from: "18:00", to: "19:00" });
  await postJson("/api/requests", { ...valid, club: "Stiller Club", day: "Dienstag", from: "19:00", to: "20:00", show_name: false });
  assert.deepEqual(db.requests.map(d => d.versions[0].showName), [true, false]);
  const open = (await call("list_requests", { status: "neu" })).structuredContent.requests;
  for (const q of open) assert.equal((await call("approve_request", { id: q.id })).isError, false);
  const cookie = await login();
  await postJson("/admin/api/publish", {}, { Cookie: cookie });
  const tue = (await (await req("/api/plan?hall=moos&season=winter")).json()).days[1].bookings;
  assert.deepEqual(tue.map(b => b.holder ?? null), [null, "Offener Club", null]);
  assert.ok(!JSON.stringify(db.bookings.map(d => d.versions)).includes("Stiller Club"));
});

test("holidays are public via list_holidays; new bookings get the school-year end as validUntil", async () => {
  const hol = (await mcp("/mcp", "tools/call", { name: "list_holidays", arguments: {} })).body.result.structuredContent;
  assert.deepEqual(hol.entries.map(e => e.key).sort(), ["herbst", "sj-2026-27"]);
  const cookie = await login();
  const c = await (await postJson("/admin/api/tools/create_booking", { hall: "aebnit", day: "Montag", from: "19:00", to: "20:00", category: "Verein/Stiftung" }, { Cookie: cookie })).json();
  assert.equal(c.booking.validUntil, "2099-07-02");
  const auth = { Authorization: "Bearer test-mcp-token" };
  const e = (await mcp("/mcp/admin", "tools/call", { name: "set_calendar_entry", arguments: { key: "sommerferien-2027", kind: "ferien", name: "Sommerferien", from: "2027-07-03", to: "2027-08-15", effect: "closed" } }, auth)).body.result;
  assert.equal(e.isError, false, e.content[0].text);
  const bad = (await mcp("/mcp/admin", "tools/call", { name: "set_calendar_entry", arguments: { key: "x", name: "X", from: "2027-08-15", to: "2027-07-03" } }, auth)).body.result;
  assert.equal(bad.isError, true);
  const pending = (await mcp("/mcp/admin", "tools/call", { name: "list_pending_changes", arguments: {} }, auth)).body.result.structuredContent;
  assert.ok(pending.changes.some(x => x.kind === "calendar" && x.key === "sommerferien-2027"));
});

test("hall lookup prefers exact keys; ambiguous partial names are refused", async () => {
  doc("halls", { key: "melchenbuehl", name: "Sporthalle Melchenbühl" });
  doc("halls", { key: "lehrschwimmbecken-melchenbuehl", name: "Lehrschwimmbecken Melchenbühl" });
  const call = async (name, args) => (await mcp("/mcp", "tools/call", { name, arguments: args })).body.result;
  // Unpublished in the fake, so use the admin server (draft view).
  const auth = { Authorization: "Bearer test-mcp-token" };
  const adm = async (name, args) => (await mcp("/mcp/admin", "tools/call", { name, arguments: args }, auth)).body.result;
  assert.equal((await adm("get_week_plan", { hall: "melchenbuehl" })).structuredContent.hallKey, "melchenbuehl");
  assert.equal((await adm("get_week_plan", { hall: "Sporthalle Melchenbühl" })).structuredContent.hallKey, "melchenbuehl");
  assert.equal((await adm("get_week_plan", { hall: "lehrschwimm" })).structuredContent.hallKey, "lehrschwimmbecken-melchenbuehl");
  const amb = await adm("get_week_plan", { hall: "melchen" });
  assert.equal(amb.isError, true);
  assert.match(amb.content[0].text, /nicht eindeutig/);
  assert.equal((await call("get_week_plan", { hall: "moos" })).structuredContent.hallKey, "moos");
});

test("WREN_PREFIX puts every collection and tree name of the Worker into its own namespace", async () => {
  const { prefixed } = await import("../worker/wren.js");
  assert.equal(prefixed("/bookings/by-key/x", "anna-"), "/anna-bookings/by-key/x");
  assert.equal(prefixed("/tree/plan/bookings/x", "anna-"), "/tree/anna-plan/bookings/x");
  assert.equal(prefixed("/tree/plan/_promote", ""), "/tree/plan/_promote");
  calls = [];
  const env2 = { ...env, WREN_PREFIX: "anna-" };
  await worker.fetch(new Request(ORIGIN + "/api/requests", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify(valid) }), env2, ctx);
  await worker.fetch(new Request(ORIGIN + "/api/halls"), env2, ctx);
  assert.ok(calls.some(c => c.m === "POST" && c.path === "/api/v1/anna-requests"), JSON.stringify(calls));
  assert.ok(calls.some(c => c.path.startsWith("/api/v1/orgs/org/anna-halls")));
  assert.ok(!calls.some(c => /\/api\/v1\/(orgs\/org\/)?(requests|halls|bookings)\b/.test(c.path)), "no unprefixed access");
  const bad = await worker.fetch(new Request(ORIGIN + "/api/halls"), { ...env, WREN_PREFIX: "Bad Prefix" }, ctx);
  assert.equal(bad.status, 500);
});

test("clubs: public list_clubs shows only published entries, filters by hall and day; drafts appear as pending changes", async () => {
  const club = (key, name, sport, sessions) => doc("clubs", { key, name, sport, sessions, website: `https://${key}.example`, checkedAt: "2026-10-14" });
  club("uhc", "UHC Test", "Unihockey", [{ group: "U18", day: "Montag", from: "19:00", to: "20:30", hallKey: "moos" }, { group: "Damen", day: "Dienstag", from: "20:00", to: "22:00", hallKey: "aebnit" }]);
  club("tv", "TV Test", "Turnen", [{ group: "Jugi", day: "Donnerstag", from: "18:00", to: "19:30", hallKey: "moos" }]);
  db.clubs[0].labels.published = 1; // TV Test stays a draft
  const call = async (args, path = "/mcp", headers = {}) => (await mcp(path, "tools/call", { name: "list_clubs", arguments: args }, headers)).body.result.structuredContent;

  const all = await call({});
  assert.deepEqual(all.clubs.map(c => c.name), ["UHC Test"], "unpublished clubs are not public");
  const moos = await call({ hall: "Moos" });
  assert.deepEqual(moos.clubs[0].sessions.map(x => x.group), ["U18"], "only sessions in the hall");
  assert.equal((await call({ day: "Freitag" })).total, 0);
  assert.equal((await call({ sport: "unihockey" })).total, 1);

  const auth = { Authorization: "Bearer test-mcp-token" };
  assert.equal((await call({}, "/mcp/admin", auth)).total, 2, "the admin MCP sees drafts, like its other tools");
  const pending = (await mcp("/mcp/admin", "tools/call", { name: "list_pending_changes", arguments: {} }, auth)).body.result.structuredContent;
  const c = pending.changes.find(x => x.kind === "club");
  assert.equal(c.club.name, "TV Test");
  assert.equal(c.type, "neu");
});
