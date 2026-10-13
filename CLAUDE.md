# Rules for working on Hallenbelegung

Prototype for municipalities (pilot: Muri bei Bern) to implement the Swiss Olympic guidelines
«Sporthallen effizient nutzen». How to run, test and deploy: see `README.md`.

## Technology

- **Front-end: plain HTML, CSS and vanilla JavaScript only.** No frameworks, libraries, CDNs, bundlers
  or build step. Ask before adding *any* external dependency.
- **Backend data: WREN** (wren.aemwip.com). All data lives there: halls, bookings, calendar, requests,
  booking holders, and the app files themselves (public tree `site`).
- **Server side: one Cloudflare Worker** (`worker/`), plain JavaScript, no runtime dependencies.
- **Wrangler is the only dependency** (dev-only: local dev and deploy).
- **Everything is self-hosted:** fonts (Figtree, woff2 in `app/`), logo and images are served with the
  app – no Google Fonts or other third-party hosts.
- **Scripts are written in Node.js** (plain `.mjs`, standard library and built-in `fetch` only).
  No Python – fewer languages in the project. `deploy_site.sh` (bash) may stay.
- Remove scripts that are no longer in use instead of keeping them around.
- Established choices (made during the build, keep unless there is a reason to change):
  - MCP server for LLMs is hand-written JSON-RPC (`worker/mcp.js`), no MCP SDK.
  - Tests use Node's built-in runner (`node --test`) with an in-memory fake of WREN; no test framework.
  - Shared plan logic lives in `app/plan.js` and is imported by both the browser and the Worker.

## Product rules

- **Drafts first, a person publishes.** Admin and LLM changes go to the WREN tree `plan` as drafts;
  only a human publishes them (label `published`). Publishing is never an MCP tool.
- Public read access only for `halls`, `bookings`, `calendar` (published versions) and the `site` tree.
  `requests` and `booking_holders` stay private.
- **Holder (club) names are private by default in storage** (`booking_holders`); shown publicly only when
  `holderPublic`. In a request the club chooses; the checkbox "show name" is **on by default**.
  Showing a name without the club's consent needs an explicit second confirmation.
- **School holidays:** per hall, default `closed` («Halle geschlossen»), as the Gemeinde does today.
  Single school-free days do not close halls. Bookings run until the end of the school year
  (`validUntil`, currently 2027-07-02).
- Subdivided halls are modelled as units + spaces (e.g. Moos: A/B/C, ganz, 2/3, thirds); a booking
  blocks the units of its space.
- «Testhalle» is fictional, for testing only, and must stay **last** in the list (`order` 999).
- Every UI text exists in **DE, FR and EN** (`app/i18n.js`); add all three when adding text.
- Design follows the Muri site (Figtree, short dark header, Muri menu structure, no big hero image),
  but must not pass as the official site: logo muted with the «Prototyp» stamp and the prototype banner
  stay. Clear the logo with the Gemeinde before sharing widely.
- Mobile first: compact navigation, day view by default on phones, sticky headers, legend at the bottom.

## Working rules

- **muri-guemligen.ch may only be accessed through the browser** – never curl, fetch or scrapers.
- Never create accounts or enter passwords on someone's behalf; the user does that.
- **Secrets never go into git or into output:** `.wren-key`, `.dev.vars`, `.admin-mcp-token` are
  git-ignored; production secrets live in Cloudflare (`wrangler secret put`). Scan for secrets before
  every commit – the repo is **public**.
- Local development uses your **own WREN test account** (optionally with `WREN_PREFIX`), never the
  production org `hallenbelegung-muri-guemligen`.
- The login code is shown on screen (`LOGIN_CODE_DELIVERY=screen`) **for testing only**; switch to email
  before real use.
- Run `npm test` before committing; keep the tests passing.
