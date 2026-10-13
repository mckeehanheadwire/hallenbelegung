# Hallenbelegung Muri bei Bern

Prototype for transparent sports-hall allocation, following the Swiss Olympic guidelines
«Sporthallen effizient nutzen». Live: <https://muri.example-company.xyz> · Admin: `/admin` · LLM docs: `/llms.txt`

> Prototype – not an official service of the Gemeinde Muri bei Bern. The Muri logo is shown muted and
> stamped «Prototyp»; clear its use with the Gemeinde before sharing widely.

## How it fits together

```
Browser ──► Cloudflare Worker (worker/)  ──►  WREN (wren.aemwip.com, org hallenbelegung-muri-guemligen)
              │  /                 app files (prod: from WREN tree "site"; dev: from ./app)
              │  /api/*            public REST (halls, plan, free slots, requests)
              │  /mcp              public MCP server for LLMs
              │  /mcp/admin        admin MCP server (Bearer ADMIN_MCP_TOKEN)
              │  /admin, /admin/api/*   admin page (magic-code login)
              └  /llms.txt
```

- **app/** – plain HTML/CSS/JS, no build step, no dependencies. `plan.js` holds the shared plan logic
  (free slots, subdivisions, holidays) and is imported by the browser *and* the Worker.
- **worker/** – the Cloudflare Worker (plain JS): router, MCP server, tools, auth, WREN client.
- **WREN collections** – `halls`, `bookings`, `calendar` (public, published versions only), `requests`,
  `booking_holders` (private). Admin/LLM changes are drafts; a person publishes them in the admin page,
  which moves the `published` label for the whole `plan` tree in one transaction.

## Run it locally

Prerequisites: Node.js 20+, npm and **your own WREN test
account** – local development never uses the production data.

1. **Create a WREN test account** at <https://wren.aemwip.com/admin>, then create an API key there.
2. **Configure** – copy the example and fill it in:

   ```bash
   npm install                      # installs Wrangler (the only dependency, dev-only)
   cp .dev.vars.example .dev.vars
   ```

   | Variable | What |
   |---|---|
   | `WREN_API_KEY` | API key of your WREN **test** account |
   | `WREN_ORG` | org slug of that account (`GET https://wren.aemwip.com/api/v1/me`, or printed by the setup script) |
   | `WREN_PREFIX` | optional, e.g. `anna-`: prefixes all collections and trees, so one WREN account can hold several test environments |
   | `ADMIN_EMAILS` | email(s) allowed to log in to `/admin` locally (code is shown on screen) |
   | `SESSION_SECRET`, `ADMIN_MCP_TOKEN` | any long random strings |

3. **Load test data** into your org (collections, public read rules, halls incl. the three-part Moos,
   the bookings from `belegung_bloecke.csv`, school holidays – all published):

   ```bash
   npm run setup:wren               # refuses to run against the production org
   ```

   Run it again with another `WREN_PREFIX` for an additional environment.
4. **Start**:

   ```bash
   npm run dev                      # http://localhost:8787  – admin: http://localhost:8787/admin
   ```

`npm run dev` runs `wrangler dev --env dev`: the Worker runs locally, serves `./app` straight from
disk (edits show up on reload) and generates `config.js` from `WREN_ORG`/`WREN_PREFIX`, so the browser
reads the public data of your test environment.

Try the MCP server locally:

```bash
curl -s -X POST http://localhost:8787/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
claude mcp add --transport http hallen-local http://localhost:8787/mcp   # Claude Code
```

## Tests

```bash
npm test
```

Runs `node --test` on `test/`: the plan logic and the Worker (called in-process against an in-memory
fake of the WREN API – no network, no Wrangler needed).

## Deploy

```bash
npm run publish:site   # upload ./app to the WREN tree "site" (hash-stamped URLs) and publish it
npm run deploy:api     # deploy the Worker to Cloudflare (muri.example-company.xyz)
```

Production only. Needs `.wren-key` (the *production* WREN API key, one line) for the site upload and a Wrangler login
(`npx wrangler login`) for the Worker. Production secrets live in Cloudflare:

```bash
npx wrangler secret put WREN_API_KEY      # also when rotating the WREN key (update .wren-key too)
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ADMIN_MCP_TOKEN
```

## Data

`belegung_bloecke.csv` holds the bookings read once from the Gemeinde's Fixbelegungsplan PDF
(`2026_Fixbelegungsplaene_Sportanlagen.pdf`, Stand 17.09.2026); `belegung_halbstunden.csv` is the same
plan in half-hour cells. The school holidays (Ferienordnung 2026-27) are in `scripts/setup-wren-dev.mjs`.
Production data is maintained in the admin page or via the admin MCP server, not by scripts.

## Files that must never be committed

`.wren-key`, `.admin-mcp-token`, `.dev.vars` (all in `.gitignore`).
