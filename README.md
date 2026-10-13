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

Prerequisites: Node.js 20+ and npm. (Python 3 only for the data import scripts.)

```bash
npm install                      # installs Wrangler (the only dependency, dev-only)
cp .dev.vars.example .dev.vars   # then fill in the values (see below)
npm run dev                      # http://localhost:8787  – admin: http://localhost:8787/admin
```

`.dev.vars` needs:

| Variable | What |
|---|---|
| `WREN_API_KEY` | WREN API key (Admin UI → API keys). **Dev talks to the same WREN org as production** – use a separate WREN org/key if you want to experiment with data. |
| `SESSION_SECRET` | any long random string (signs admin sessions) |
| `ADMIN_MCP_TOKEN` | any long random string (Bearer token for `/mcp/admin`) |

`npm run dev` runs `wrangler dev --env dev`: the Worker runs locally and serves `./app` straight from
disk, so edits to HTML/CSS/JS show up on reload. Public data is read from WREN's public API (see
`app/config.js`); admin logins accept the emails in `wrangler.jsonc` (`ADMIN_EMAILS`) and show the
code on screen (`LOGIN_CODE_DELIVERY=screen`, testing only).

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

Needs `.wren-key` (WREN API key, one line) for the site upload and a Wrangler login
(`npx wrangler login`) for the Worker. Production secrets live in Cloudflare:

```bash
npx wrangler secret put WREN_API_KEY      # also when rotating the WREN key (update .wren-key too)
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ADMIN_MCP_TOKEN
```

## Data import scripts

| Script | Purpose |
|---|---|
| `scripts/pdf_extract.py` + `scripts/pdf_build_blocks.py` | Read the Gemeinde's colour-coded Fixbelegungsplan PDF into `belegung_bloecke.csv` (needs `pip install pymupdf`) |
| `wren_import.py` | Load `belegung_bloecke.csv` into WREN (`halls`, `bookings`) |
| `wren_calendar_import.py [--publish]` | School holidays (Ferienordnung) into `calendar`; limits bookings to the school year |

All scripts are idempotent (natural keys + by-key upserts) and read the key from `.wren-key`.

## Files that must never be committed

`.wren-key`, `.admin-mcp-token`, `.dev.vars` (all in `.gitignore`).
