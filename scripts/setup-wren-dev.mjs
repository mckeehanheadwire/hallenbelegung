// Bootstrap a developer's own WREN *test* org with the Hallenbelegung data and publish it.
//
// Usage (from the repo root):  npm run setup:wren   (= node scripts/setup-wren-dev.mjs)
// Reads WREN_API_KEY (and optional WREN_PREFIX, e.g. "anna-") from .dev.vars; with a prefix, several
// test environments can live side by side in one WREN account. Creates collections, public read rules,
// halls (Moos as a three-part hall), the bookings from belegung_bloecke.csv, the school holidays, the
// clubs from clubs.json, and
// publishes everything (label "published" on the plan tree). Idempotent. Refuses the production org.
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url);
const PRODUCTION_ORG = "hallenbelegung-muri-guemligen";
const BASE = "https://wren.aemwip.com/api/v1";
const SOURCE = "2026_Fixbelegungsplaene_Sportanlagen.pdf (Stand 17.09.2026)";
const CAL_SOURCE = "Ferienordnung 2026-27, Gemeinde Muri bei Bern (Stand 14.07.2026)";
const LAST_SCHOOL_DAY = "2027-07-02"; // Friday before the summer holidays 2027

// [key, kind, name, from, to]
const CALENDAR = [
  ["schuljahr-2026-27", "schuljahr", "Schuljahr 2026/27", "", LAST_SCHOOL_DAY],
  ["herbstferien-2026", "ferien", "Herbstferien", "2026-09-19", "2026-10-11"],
  ["unterrichtsfrei-2026-11-20", "unterrichtsfrei", "Unterrichtsfrei (Weiterbildung Lehrpersonen)", "2026-11-20", "2026-11-20"],
  ["winterferien-2026", "ferien", "Winterferien", "2026-12-25", "2027-01-10"],
  ["februarferien-2027", "ferien", "Februar-Ferienwoche", "2027-02-06", "2027-02-14"],
  ["unterrichtsfrei-2027-03-24", "unterrichtsfrei", "Unterrichtsfrei", "2027-03-24", "2027-03-24"],
  ["fruehlingsferien-2027", "ferien", "Frühlingsferien", "2027-04-10", "2027-04-25"],
  ["sommerferien-2027", "ferien", "Sommerferien", "2027-07-03", "2027-08-15"],
  ["herbstferien-2027", "ferien", "Herbstferien", "2027-09-25", "2027-10-17"],
  ["unterrichtsfrei-2027-11-25", "unterrichtsfrei", "Unterrichtsfrei", "2027-11-25", "2027-11-26"],
  ["winterferien-2027", "ferien", "Winterferien", "2027-12-25", "2028-01-09"],
];

// Throw instead of process.exit(): exiting while a fetch connection is open crashes Node on Windows.
class Stop extends Error {}
const fail = msg => { throw new Stop(msg); };
const exitEarly = msg => { console.error(msg); process.exit(1); }; // only before the first fetch

let devVars;
try { devVars = readFileSync(new URL(".dev.vars", ROOT), "utf8"); }
catch { exitEarly("No .dev.vars found – copy .dev.vars.example to .dev.vars and fill it in."); }
const VARS = Object.fromEntries([...devVars.matchAll(/^(\w+)=(.*)$/gm)].map(m => [m[1], m[2].trim()]));
const KEY = VARS.WREN_API_KEY || "";
const PREFIX = VARS.WREN_PREFIX || "";
if (PREFIX && !/^[a-z0-9][a-z0-9-]*-$/.test(PREFIX))
  exitEarly("WREN_PREFIX must look like 'name-' (lowercase letters, digits, hyphens, ending with '-')");

// Collections and trees get the prefix; /me and /permissions do not.
function prefixed(path) {
  if (!PREFIX || path.startsWith("/me") || path.startsWith("/permissions")) return path;
  if (path.startsWith("/tree/")) return "/tree/" + PREFIX + path.slice("/tree/".length);
  return "/" + PREFIX + path.slice(1);
}

async function call(method, path, body) {
  const res = await fetch(BASE + prefixed(path), {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "User-Agent": "hallenbelegung-dev-setup/1.0" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

function ok({ status, data }, what) {
  if (status !== 200 && status !== 201) fail(`${what} failed: ${status} ${JSON.stringify(data)}`);
  return data;
}

function slug(s) {
  s = s.toLowerCase().replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue");
  s = s.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  return s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Semicolon-separated CSV with header row (UTF-8, optional BOM, optional "quoted" fields).
function readCsv(url) {
  const text = readFileSync(url, "utf8").replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ";") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(f => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows;
  return data.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

// "Sporthalle Moos (27x45m)" -> full name "Sporthalle Moos", size "27x45m", key "moos"
function splitHall(name) {
  const m = name.match(/^(.*?)\s*\((.*)\)$/);
  const full = m ? m[1] : name;
  return { full, size: m ? m[2] : null, key: slug(full.replace(/^Sporthalle /, "")) };
}

// Create or update by natural key and make sure the document is in the plan tree.
async function upsert(coll, key, doc) {
  const saved = ok(await call("PUT", `/${coll}/by-key/${key}`, doc), `${coll}/${key}`);
  ok(await call("PUT", `/tree/plan/${coll}/${key}`, { documentId: saved.id }), `tree ${coll}/${key}`);
}

async function main() {
  if (!KEY) fail("WREN_API_KEY missing in .dev.vars");
  const me = ok(await call("GET", "/me"), "GET /me");
  const org = me.org.slug;
  if (org === PRODUCTION_ORG) fail(`Refusing to run against the production org '${org}'. Use your own WREN test account.`);
  if (VARS.WREN_ORG && VARS.WREN_ORG !== org)
    console.log(`Note: .dev.vars has WREN_ORG=${VARS.WREN_ORG}, but the key belongs to '${org}'. Set WREN_ORG=${org}.`);
  console.log(`Setting up WREN org '${org}'${PREFIX ? ` with prefix '${PREFIX}'` : ""} …`);

  for (const coll of ["halls", "bookings", "calendar", "booking_holders", "clubs"])
    await call("PATCH", `/${coll}/_schema`, { naturalKey: "key" });

  // Public read rules (published versions only); requests and booking_holders stay private.
  const perms = ok(await call("GET", "/permissions"), "permissions").permissions;
  const have = new Set(perms.filter(p => p.principal === "*").map(p => p.resource));
  for (const coll of ["halls", "bookings", "calendar", "clubs"]) {
    if (!have.has(`collection:${PREFIX}${coll}`))
      ok(await call("POST", "/permissions", { principal: "*", resource: `collection:${PREFIX}${coll}`, access: "read", labelFilter: "published" }), `rule ${coll}`);
  }

  const rows = readCsv(new URL("belegung_bloecke.csv", ROOT));
  const halls = {};
  for (const r of rows) {
    const { full, size, key } = splitHall(r.Halle);
    halls[key] = { key, name: full, size, type: "Sporthalle", holidays: "closed", source: SOURCE };
  }
  Object.assign(halls.moos, {
    type: "Dreifachhalle",
    units: [{ key: "A", name: "Drittel A" }, { key: "B", name: "Drittel B" }, { key: "C", name: "Drittel C" }],
    spaces: [
      { key: "ganz", name: "Ganze Halle", units: ["A", "B", "C"] }, { key: "gross", name: "2/3 (A+B)", units: ["A", "B"] },
      { key: "a", name: "1/3 A", units: ["A"] }, { key: "b", name: "1/3 B", units: ["B"] }, { key: "c", name: "1/3 C", units: ["C"] },
    ],
  });
  for (const [key, h] of Object.entries(halls)) await upsert("halls", key, h);
  console.log(`  halls: ${Object.keys(halls).length}`);

  for (const r of rows) {
    const { full, key: hk } = splitHall(r.Halle);
    const key = [hk, slug(r.Tag), slug(r.Saison), r.Von.replaceAll(".", "")].join("-");
    await upsert("bookings", key, {
      key, hall: full, hallKey: hk, day: r.Tag, season: r.Saison,
      from: r.Von.replaceAll(".", ":"), to: r.Bis.replaceAll(".", ":"), category: r.Kategorie,
      note: r.Notiz, validUntil: LAST_SCHOOL_DAY, source: SOURCE,
    });
  }
  console.log(`  bookings: ${rows.length}`);

  for (const [key, kind, name, from, to] of CALENDAR)
    await upsert("calendar", key, { key, kind, name, from, to, effect: "school", source: CAL_SOURCE });
  console.log(`  calendar: ${CALENDAR.length}`);

  const { clubs } = JSON.parse(readFileSync(new URL("clubs.json", ROOT), "utf8"));
  for (const club of clubs) await upsert("clubs", club.key, club);
  console.log(`  clubs: ${clubs.length}`);

  const promoted = ok(await call("POST", "/tree/plan/_promote", { label: "published" }), "publish");
  console.log(`Published ${(promoted.promoted || []).length} documents. Set WREN_ORG=${org}${PREFIX ? ` and WREN_PREFIX=${PREFIX}` : ""} in .dev.vars and run: npm run dev`);
}

try {
  await main();
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  console.error(e.message);
  process.exitCode = 1;
}
