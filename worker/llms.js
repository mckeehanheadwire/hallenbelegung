// /llms.txt — tells LLMs and agent builders how to use the Hallenbelegung.
import { PUBLIC_TOOLS, ADMIN_TOOLS } from "./tools.js";

export function llmsTxt(origin) {
  const list = tools => tools.map(t => `- \`${t.name}\` — ${t.description}`).join("\n");
  return `# Hallenbelegung Muri bei Bern

> Weekly occupancy of the municipal sports halls of Muri bei Bern / Gümligen (Switzerland):
> who uses which hall when, where there are free slots, and how clubs can request time.
> Prototype – not an official service of the municipality. Data: Fixbelegungspläne 2026.

All times are local (Europe/Zurich), half-hour grid between 07:00 and 22:30.
Weekdays are German: ${["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"].join(", ")}.
Seasons: "summer" (about April–September) and "winter" (about October–March); most bookings are year-round.
Booking categories: Schule, Private Schule, Schule extern, Verein/Stiftung, Private Gruppe, Reinigung, nicht verfügbar (closed).

## MCP server (recommended)

Endpoint: ${origin}/mcp (Streamable HTTP, no authentication)

${list(PUBLIC_TOOLS)}

Only call \`submit_request\` when the user explicitly wants to send a request and has given club, contact person and email.

## REST API (read-only, JSON, CORS open)

- GET ${origin}/api/halls?season=summer|winter
- GET ${origin}/api/plan?hall=moos&season=winter
- GET ${origin}/api/free-slots?days=Dienstag,Donnerstag&from=17:00&min=90&hall=&season=winter&limit=50
- POST ${origin}/api/requests (JSON: hall, day, from, to, club, contact, email, team, kind, people, share, note)

## Admin MCP server (staff only)

Endpoint: ${origin}/mcp/admin — requires \`Authorization: Bearer <admin token>\`.
All changes are drafts; a person publishes them at ${origin}/admin.

${list(ADMIN_TOOLS)}

## Human pages

- ${origin}/ — public weekly plans and free-slot finder
- ${origin}/admin — admin area (login required)
`;
}
