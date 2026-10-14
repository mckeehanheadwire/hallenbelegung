// Load clubs.json (who trains where, club contacts) into WREN as DRAFTS.
//
// Usage: node scripts/node.mjs scripts/import-clubs.mjs            production (key from .wren-key)
//        node scripts/node.mjs scripts/import-clubs.mjs --dev      your test org (.dev.vars, WREN_PREFIX)
// Creates the collection "clubs" (natural key "key") and a public read rule for its *published*
// versions, writes every club by key and puts it into the plan tree. Nothing becomes public here:
// a person reviews the drafts in /admin (Entwürfe) and publishes. Idempotent.
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url);
const BASE = "https://wren.aemwip.com/api/v1";
const dev = process.argv.includes("--dev");

let KEY, PREFIX = "";
if (dev) {
  const vars = Object.fromEntries([...readFileSync(new URL(".dev.vars", ROOT), "utf8").matchAll(/^(\w+)=(.*)$/gm)].map(m => [m[1], m[2].trim()]));
  KEY = vars.WREN_API_KEY;
  PREFIX = vars.WREN_PREFIX || "";
} else {
  KEY = readFileSync(new URL(".wren-key", ROOT), "utf8").trim();
}
const { clubs } = JSON.parse(readFileSync(new URL("clubs.json", ROOT), "utf8"));

// Collections and trees get the prefix; /me and /permissions do not.
const prefixed = path => !PREFIX || /^\/(me|permissions)/.test(path) ? path
  : path.startsWith("/tree/") ? "/tree/" + PREFIX + path.slice(6) : "/" + PREFIX + path.slice(1);

async function call(method, path, body) {
  const res = await fetch(BASE + prefixed(path), {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "User-Agent": "hallenbelegung-import/1.0" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return data;
}

async function main() {
  const me = await call("GET", "/me");
  console.log(`WREN org '${me.org.slug}'${PREFIX ? ` (prefix '${PREFIX}')` : ""}: ${clubs.length} clubs as drafts …`);
  await call("PATCH", "/clubs/_schema", { naturalKey: "key", displayName: "{name}" });
  const rules = (await call("GET", "/permissions")).permissions;
  if (!rules.some(p => p.principal === "*" && p.resource === `collection:${PREFIX}clubs`)) {
    await call("POST", "/permissions", { principal: "*", resource: `collection:${PREFIX}clubs`, access: "read", labelFilter: "published" });
    console.log("  public read rule for published club entries added");
  }
  let changed = 0;
  for (const club of clubs) {
    const before = await call("GET", `/clubs/by-key/${club.key}`).catch(() => null);
    const saved = await call("PUT", `/clubs/by-key/${club.key}`, club);
    if (!before || before.version !== saved.version) changed++;
    await call("PUT", `/tree/plan/clubs/${club.key}`, { documentId: saved.id });
  }
  console.log(`  ${changed} new or changed. Review and publish in /admin → Entwürfe.`);
}

try {
  await main();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
