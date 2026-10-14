// The operations of the Hallenbelegung, defined once and exposed through
//   - the public MCP server (/mcp) and REST API (/api/*)    -> PUBLIC_TOOLS
//   - the admin MCP server (/mcp/admin) and the admin page  -> ADMIN_TOOLS (+ public ones)
// Admin writes create new WREN versions that stay *drafts* until a person publishes
// them in the admin page (the "published" label is moved for the whole plan tree).
import * as P from "../app/plan.js";
import { wren, WrenError } from "./wren.js";

export class ToolError extends Error {}

const SEASONS = ["ganzjährig", "summer", "winter"];
const REQUEST_STATUS = ["neu", "genehmigt", "abgelehnt"];
const TIME = /^([01]\d|2[0-3]):(00|30)$/;

/* ---------- argument helpers ---------- */

function str(args, name, { required = false, max = 200, values } = {}) {
  const v = args?.[name];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`Parameter «${name}» fehlt.`);
    return "";
  }
  if (typeof v !== "string") throw new ToolError(`Parameter «${name}» muss Text sein.`);
  const s = v.trim().slice(0, max);
  if (values && !values.includes(s)) throw new ToolError(`«${name}» muss einer von ${values.join(", ")} sein.`);
  return s;
}
function time(args, name, required = true) {
  const v = str(args, name, { required, max: 5 });
  if (v && !TIME.test(v)) throw new ToolError(`«${name}» muss eine Zeit im Halbstundenraster sein, z. B. 18:30.`);
  return v;
}
function day(args, name = "day", required = true) {
  const v = str(args, name, { required, max: 20 });
  if (!v) return "";
  const d = P.DAYS.find(x => x.toLowerCase() === v.toLowerCase() || x.slice(0, 2).toLowerCase() === v.toLowerCase());
  if (!d) throw new ToolError(`«${name}» muss ein Wochentag sein (${P.DAYS.join(", ")}).`);
  return d;
}
function season(args, name = "season") {
  const v = str(args, name) || P.currentSeason();
  if (v === "sommer") return "summer";
  if (!SEASONS.includes(v)) throw new ToolError(`«${name}» muss summer, winter oder ganzjährig sein.`);
  return v;
}
function bookingSeason(args) {
  // Bookings created here are year-round unless summer/winter is given explicitly.
  const v = str(args, "season") || "ganzjährig";
  if (!SEASONS.includes(v)) throw new ToolError("«season» muss ganzjährig, summer oder winter sein.");
  return v === "summer" ? "Sommer" : v === "winter" ? "Winter" : "ganzjährig";
}
function span(from, to) {
  const start = P.toMin(from), end = P.toMin(to);
  if (end <= start) throw new ToolError("«to» muss nach «from» liegen.");
  if (start < P.OPEN || end > P.CLOSE) throw new ToolError(`Hallenzeiten liegen zwischen ${P.toTime(P.OPEN)} und ${P.toTime(P.CLOSE)}.`);
  return { start, end };
}
const fmtBooking = b => ({
  key: b.key, hall: b.hall, hallKey: b.hallKey, space: b.space || undefined, spaceName: b.spaceName || undefined,
  day: b.day, season: b.season, from: b.from, to: b.to,
  category: b.category, holder: b.holder || undefined, holderPublic: b.holder ? !!b.holderPublic : undefined,
  validFrom: b.validFrom || undefined, validUntil: b.validUntil || undefined,
  note: b.note || undefined, status: b.status || undefined,
});
const fmtSlot = s => ({
  hall: s.hall.name, hallKey: s.hall.key, space: s.whole ? undefined : s.space.key, spaceName: s.whole ? undefined : s.space.name,
  day: s.day, from: P.toTime(s.start), to: P.toTime(s.end), minutes: s.end - s.start,
});
const fmtFacility = h => ({
  key: h.key, name: h.name, size: h.size || null, type: h.type || "Sporthalle", address: h.address || undefined, order: h.order ?? undefined,
  holidays: h.holidays === "open" ? "open" : "closed",
  units: P.hallUnits(h).length > 1 ? P.hallUnits(h) : [], spaces: P.hallUnits(h).length > 1 ? P.hallSpaces(h) : [],
});
// Booking key: hall-day-season[-space]-HHMM.
const bookingKey = (hall, day, seasonLabel, space, from) =>
  [hall.key, P.slug(day), P.slug(seasonLabel), ...(space && space !== P.WHOLE && P.hallUnits(hall).length > 1 ? [P.slug(space)] : []), from.replace(":", "")].join("-");
function resolveSpace(hall, key) {
  if (!key) return P.wholeSpace(hall);
  const s = P.findSpace(hall, key) || P.hallSpaces(hall).find(x => x.name.toLowerCase() === String(key).toLowerCase());
  if (!s) throw new ToolError(`Fläche «${key}» gibt es in ${hall.name} nicht. Verfügbar: ${P.hallSpaces(hall).map(x => `${x.key} (${x.name})`).join(", ")}.`);
  return s;
}

/* ---------- data access ---------- */

// Public tools see the published plan; admin tools see the current (draft) state.
async function loadPlan(ctx, { drafts = false } = {}) {
  const key = drafts ? "draftPlan" : "publicPlan";
  if (ctx[key]) return ctx[key];
  const w = wren(ctx.env);
  const [h, b, cal] = drafts
    ? await Promise.all([w.list("halls"), w.list("bookings"), w.list("calendar").catch(() => [])])
    : await Promise.all([w.listPublic("halls"), w.listPublic("bookings"), w.listPublic("calendar").catch(() => [])]);
  const halls = h.map(i => i.data).sort(P.byOrder);
  let raw = b.map(i => ({ ...i.data, _id: i.id, _version: i.version }));
  if (drafts) {
    // Holder names that are not public live in the private collection "booking_holders".
    const priv = new Map((await w.list("booking_holders").catch(() => [])).map(i => [i.data.key, i.data.holder]));
    raw = raw.map(x => (!x.holder && priv.get(x.key) ? { ...x, holder: priv.get(x.key), holderPublic: false } : x));
  }
  const calendar = cal.map(i => i.data).sort((a, x) => String(a.from).localeCompare(String(x.from)));
  ctx[key] = { halls, raw, bookings: P.prepare(raw, halls), calendar };
  return ctx[key];
}
// Exact key, then exact name (with or without "Sporthalle"), then a *unique* partial match —
// so "melchenbuehl" is the hall, not "lehrschwimmbecken-melchenbuehl".
function findHall(halls, value) {
  if (!value) return null;
  const raw = String(value).trim().toLowerCase();
  const v = raw.replace(/^sporthalle\s+/, "");
  const exact = halls.find(x => x.key === raw) || halls.find(x => x.key === v)
    || halls.find(x => x.name.toLowerCase() === raw) || halls.find(x => x.name.toLowerCase().replace(/^sporthalle\s+/, "") === v);
  if (exact) return exact;
  const partial = halls.filter(x => P.slug(x.name).includes(P.slug(v)) || x.key.includes(P.slug(v)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new ToolError(`Halle «${value}» ist nicht eindeutig: ${partial.map(x => `${x.key} (${x.name})`).join(", ")}.`);
  throw new ToolError(`Halle «${value}» unbekannt. Verfügbar: ${halls.map(x => x.key).join(", ")}.`);
}

// New bookings are valid until the end of the school year that contains today (or the next one).
function schoolYearEnd(calendar, today = P.isoDate(new Date())) {
  const years = calendar.filter(c => c.kind === "schuljahr" && c.to >= today).sort((a, b) => a.to.localeCompare(b.to));
  return years[0]?.to || "";
}

/* ---------- public tools ---------- */

const listHalls = {
  name: "list_halls",
  title: "Sporthallen auflisten",
  description: "Lists all facilities (sports halls, teaching pool) of Muri bei Bern with size, subdivisions (units and bookable spaces, e.g. Moos: whole hall, 2/3, thirds), weekly occupancy and free hours (weekday evenings from 17:00, weekends).",
  inputSchema: { type: "object", properties: { season: { type: "string", enum: SEASONS, description: "summer (Apr–Sep) or winter (Oct–Mar); default: current season" } } },
  async run(args, ctx) {
    const s = season(args);
    const { halls, bookings } = await loadPlan(ctx, { drafts: ctx.drafts });
    return {
      season: s,
      halls: halls.map(h => {
        const st = P.hallStats(bookings, h, s === "ganzjährig" ? P.currentSeason() : s);
        return {
          ...fmtFacility(h),
          occupancyPercent: Math.round(st.pct * 100),
          bookedHours: st.booked / 60, freeHours: st.free / 60,
          freeWeekdayEveningHours: st.eveFree / 60,
          weekend: st.weekendClosed ? "geschlossen" : `${st.weekendFree / 60} h frei`,
        };
      }),
    };
  },
};

const getWeekPlan = {
  name: "get_week_plan",
  title: "Wochenplan einer Halle",
  description: "Returns the weekly plan of one hall: all bookings per weekday (category, time, space for subdivided halls) and the free windows (per bookable space; a smaller space is listed only where the larger one is not free).",
  inputSchema: {
    type: "object", required: ["hall"],
    properties: {
      hall: { type: "string", description: "Hall key or name, e.g. 'moos' or 'Sporthalle Moos'" },
      season: { type: "string", enum: ["summer", "winter"], description: "default: current season" },
    },
  },
  async run(args, ctx) {
    const { halls, bookings } = await loadPlan(ctx, { drafts: ctx.drafts });
    const h = findHall(halls, str(args, "hall", { required: true }));
    const s = season(args) === "ganzjährig" ? P.currentSeason() : season(args);
    return {
      ...fmtFacility(h), hall: h.name, hallKey: h.key, season: s,
      days: P.DAYS.map(d => ({
        day: d,
        bookings: P.dayBookings(bookings, h.key, d, s).sort((a, b) => a.start - b.start).map(fmtBooking),
        free: P.findFreeSlots([h], bookings, { days: [d], minLen: 30, season: s }).map(fmtSlot)
          .map(({ from, to, space, spaceName }) => ({ from, to, space, spaceName })),
      })),
    };
  },
};

const findFreeSlots = {
  name: "find_free_slots",
  title: "Freie Hallenzeiten finden",
  description: "Finds free time windows across all halls (or one hall), including partial spaces of subdivided halls (e.g. a third of Moos). Use this to answer questions like 'Where can our U14 team train on Tuesday evening for 90 minutes?'",
  inputSchema: {
    type: "object",
    properties: {
      days: { type: "array", items: { type: "string", enum: P.DAYS }, description: "Weekdays to search; default all" },
      from: { type: "string", description: "Earliest start, HH:MM (half-hour grid); default 07:00" },
      min_minutes: { type: "integer", minimum: 30, description: "Minimum length in minutes; default 60" },
      hall: { type: "string", description: "Restrict to one hall (key or name)" },
      season: { type: "string", enum: ["summer", "winter"], description: "default: current season" },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Max results; default 50" },
    },
  },
  async run(args, ctx) {
    const { halls, bookings } = await loadPlan(ctx, { drafts: ctx.drafts });
    const days = Array.isArray(args?.days) && args.days.length ? args.days.map(d => day({ d }, "d")) : P.DAYS;
    const from = time(args, "from", false) || "07:00";
    const minLen = Number.isInteger(args?.min_minutes) ? Math.max(30, args.min_minutes) : 60;
    const hall = args?.hall ? findHall(halls, str(args, "hall")) : null;
    const s = season(args) === "ganzjährig" ? P.currentSeason() : season(args);
    const limit = Number.isInteger(args?.limit) ? Math.min(200, Math.max(1, args.limit)) : 50;
    const all = P.findFreeSlots(halls, bookings, { days, from, minLen, hallKey: hall?.key || "", season: s });
    return { season: s, total: all.length, slots: all.slice(0, limit).map(fmtSlot) };
  },
};

// Shared validation for slot requests (REST form, public MCP).
export async function submitRequestData(args, env) {
  const email = str(args, "email", { required: true });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ToolError("Ungültige E-Mail-Adresse.");
  const from = time(args, "from"), to = time(args, "to");
  span(from, to);
  const people = Number(args?.people);
  const doc = {
    hall: str(args, "hall", { required: true }),
    space: str(args, "space", { max: 40 }),
    day: day(args),
    // Desired first date (YYYY-MM-DD) when the request came from a dated calendar view.
    date: /^\d{4}-\d{2}-\d{2}$/.test(args?.date || "") ? args.date : "",
    from, to,
    club: str(args, "club", { required: true }),
    contact: str(args, "contact", { required: true }),
    email,
    team: str(args, "team", { max: 60 }),
    kind: str(args, "kind", { max: 60 }),
    people: Number.isInteger(people) && people > 0 && people < 1000 ? people : null,
    share: args?.share === true,
    // The club decides whether its name may appear in the public plan.
    showName: args?.show_name !== false,
    // Language of the requester, so the office can reply in it.
    lang: ["de", "fr", "en"].includes(args?.lang) ? args.lang : "de",
    note: str(args, "note", { max: 2000 }),
    status: "neu",
    submittedAt: new Date().toISOString(),
    via: args?.via === "mcp" ? "mcp" : "web",
  };
  const saved = await wren(env).post("/requests", doc);
  return { id: saved.id, status: "neu" };
}

const submitRequest = {
  name: "submit_request",
  title: "Hallenzeit anfragen",
  description: "Submits a request for a hall time slot to the municipality's sports office. Only call this when the user explicitly wants to send a request and has provided club, contact person and email. The office replies by email.",
  inputSchema: {
    type: "object", required: ["hall", "day", "from", "to", "club", "contact", "email"],
    properties: {
      hall: { type: "string", description: "Hall name, e.g. 'Sporthalle Moos'" },
      space: { type: "string", description: "For subdivided halls: bookable space key from list_halls (e.g. 'a' for a third of Moos); default whole hall" },
      day: { type: "string", enum: P.DAYS },
      from: { type: "string", description: "HH:MM, half-hour grid" },
      to: { type: "string", description: "HH:MM, half-hour grid" },
      club: { type: "string" }, contact: { type: "string" }, email: { type: "string" },
      team: { type: "string", description: "e.g. 'Junioren / Jugend (U20)', 'Erwachsene'" },
      kind: { type: "string", description: "'Dauerbelegung (wöchentlich)' or 'Einzelbelegung'" },
      people: { type: "integer" },
      share: { type: "boolean", description: "Open to sharing the hall / co-training" },
      lang: { type: "string", enum: ["de", "fr", "en"], description: "Language the user writes in (for the reply); default de" },
      show_name: { type: "boolean", description: "Whether the club name may be shown in the public plan. Default true; tell the user and set false if they prefer not to be listed." },
      note: { type: "string" },
    },
  },
  async run(args, ctx) {
    const r = await submitRequestData({ ...args, via: "mcp" }, ctx.env);
    return { ...r, message: "Anfrage eingegangen. Die Abteilung Sport antwortet per E-Mail." };
  },
};

/* ---------- admin tools ---------- */

async function loadRequests(env, status) {
  const items = await wren(env).list("requests");
  return items
    .map(i => ({ id: i.id, version: i.version, ...i.data }))
    .filter(r => !status || r.status === status)
    .sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
}

// The public booking document only carries the holder (club) name when holderPublic is set;
// otherwise the name goes to the private collection "booking_holders" (not readable publicly).
async function writeBooking(ctx, input, { create }) {
  const w = wren(ctx.env);
  const { holder = "", holderPublic = false, ...rest } = input;
  const data = holder && holderPublic ? { ...rest, holder, holderPublic: true } : rest;
  let key = data.key;
  let saved;
  if (create) {
    // Create-only upsert; on a key collision add a suffix.
    for (let n = 1; ; n++) {
      key = n === 1 ? data.key : `${data.key}-${n}`;
      try { saved = await w.put(`/bookings/by-key/${key}?ifVersion=0`, { ...data, key }); break; }
      catch (e) { if (!(e instanceof WrenError && e.status === 412) || n > 9) throw e; }
    }
    await w.put(`/tree/plan/bookings/${key}`, { documentId: saved.id });
  } else {
    saved = await w.put(`/bookings/by-key/${key}`, data);
  }
  await w.put(`/booking_holders/by-key/${key}`, { key, holder: holder && !holderPublic ? holder : "" });
  ctx.draftPlan = null;
  return { key, id: saved.id, version: saved.version };
}

function checkFree(bookings, hall, b, force) {
  const units = resolveSpace(hall, b.space).units;
  const hits = P.overlaps(bookings, { hallKey: b.hallKey, day: b.day, season: b.season, start: P.toMin(b.from), end: P.toMin(b.to), units, ignoreKey: b.key });
  if (hits.length && !force) {
    throw new ToolError(`Überschneidung mit bestehender Belegung: ${hits.map(h => `${h.key} (${h.from}–${h.to}, ${h.category}${h.spaceName ? ", " + h.spaceName : ""})`).join("; ")}. Mit force=true trotzdem speichern.`);
  }
  return hits;
}

const listRequests = {
  name: "list_requests",
  title: "Anfragen auflisten",
  description: "Lists slot requests from clubs, newest first. Filter by status (neu = open, genehmigt = approved, abgelehnt = rejected).",
  inputSchema: { type: "object", properties: { status: { type: "string", enum: REQUEST_STATUS } } },
  async run(args, ctx) {
    const status = str(args, "status", { values: REQUEST_STATUS });
    const list = await loadRequests(ctx.env, status);
    return { total: list.length, requests: list };
  },
};

const approveRequest = {
  name: "approve_request",
  title: "Anfrage genehmigen",
  description: "Approves a club's request: creates a DRAFT booking (visible publicly only after a person publishes in the admin page) and marks the request as approved. Refuses if the time overlaps an existing booking unless force=true. Optionally adjust time, category or season.",
  inputSchema: {
    type: "object", required: ["id"],
    properties: {
      id: { type: "string", description: "Request id" },
      from: { type: "string" }, to: { type: "string", description: "Override the requested time (HH:MM)" },
      space: { type: "string", description: "Override the requested space (subdivided halls)" },
      show_holder: { type: "boolean", description: "Show the club name publicly. Default: what the club chose in its request (showName). Only set true if the club agreed." },
      category: { type: "string", enum: P.CATEGORIES, description: "default: Verein/Stiftung" },
      season: { type: "string", enum: SEASONS, description: "default: ganzjährig" },
      note: { type: "string", description: "Note stored on the request (reason / remarks for the club)" },
      force: { type: "boolean", description: "Save even if it overlaps" },
    },
  },
  async run(args, ctx) {
    const id = str(args, "id", { required: true });
    const w = wren(ctx.env);
    const reqDoc = await w.get(`/requests/${id}`).catch(e => { throw e instanceof WrenError && e.status === 404 ? new ToolError(`Anfrage ${id} nicht gefunden.`) : e; });
    const r = reqDoc.data;
    if (r.status !== "neu") throw new ToolError(`Anfrage ist bereits «${r.status}».`);
    const { halls, bookings } = await loadPlan(ctx, { drafts: true });
    const hall = findHall(halls, r.hall);
    const from = time(args, "from", false) || r.from, to = time(args, "to", false) || r.to;
    span(from, to);
    const seasonLabel = bookingSeason(args);
    const space = resolveSpace(hall, str(args, "space", { max: 40 }) || r.space);
    const booking = {
      key: bookingKey(hall, r.day, seasonLabel, space.key, from),
      hall: hall.name, hallKey: hall.key, space: space.key, day: r.day, season: seasonLabel, from, to,
      category: str(args, "category", { values: P.CATEGORIES }) || "Verein/Stiftung",
      holder: r.club, holderPublic: typeof args?.show_holder === "boolean" ? args.show_holder : r.showName === true, note: r.team || "", requestId: id,
      validUntil: schoolYearEnd((await loadPlan(ctx, { drafts: true })).calendar),
      source: `Anfrage ${id}`, changedBy: ctx.actor, changedAt: new Date().toISOString(),
    };
    checkFree(bookings, hall, booking, args?.force === true);
    const saved = await writeBooking(ctx, booking, { create: true });
    await w.put(`/requests/${id}`, { ...r, status: "genehmigt", bookingKey: saved.key, decisionNote: str(args, "note", { max: 2000 }), decidedBy: ctx.actor, decidedAt: new Date().toISOString() });
    return { request: id, status: "genehmigt", booking: { ...fmtBooking(booking), key: saved.key }, published: false, message: "Entwurf erstellt – wird nach dem Veröffentlichen im Admin-Bereich öffentlich sichtbar." };
  },
};

const rejectRequest = {
  name: "reject_request",
  title: "Anfrage ablehnen",
  description: "Rejects a club's request with a reason (stored on the request for the reply to the club).",
  inputSchema: { type: "object", required: ["id", "reason"], properties: { id: { type: "string" }, reason: { type: "string" } } },
  async run(args, ctx) {
    const id = str(args, "id", { required: true });
    const reason = str(args, "reason", { required: true, max: 2000 });
    const w = wren(ctx.env);
    const doc = await w.get(`/requests/${id}`).catch(e => { throw e instanceof WrenError && e.status === 404 ? new ToolError(`Anfrage ${id} nicht gefunden.`) : e; });
    if (doc.data.status !== "neu") throw new ToolError(`Anfrage ist bereits «${doc.data.status}».`);
    await w.put(`/requests/${id}`, { ...doc.data, status: "abgelehnt", decisionNote: reason, decidedBy: ctx.actor, decidedAt: new Date().toISOString() });
    return { request: id, status: "abgelehnt" };
  },
};

const listBookings = {
  name: "list_bookings",
  title: "Belegungen auflisten",
  description: "Lists bookings in the current (draft) state, optionally filtered by hall and/or day. Includes cancelled bookings (status 'storniert').",
  inputSchema: { type: "object", properties: { hall: { type: "string" }, day: { type: "string", enum: P.DAYS } } },
  async run(args, ctx) {
    const { halls, raw } = await loadPlan(ctx, { drafts: true });
    const hall = args?.hall ? findHall(halls, str(args, "hall")) : null;
    const d = day(args, "day", false);
    const list = raw.filter(b => (!hall || b.hallKey === hall.key) && (!d || b.day === d))
      .sort((a, b) => P.DAYS.indexOf(a.day) - P.DAYS.indexOf(b.day) || a.from.localeCompare(b.from));
    return { total: list.length, bookings: list.map(fmtBooking) };
  },
};

const createBooking = {
  name: "create_booking",
  title: "Belegung erfassen",
  description: "Creates a new DRAFT booking (published after a person publishes in the admin page). Refuses overlaps unless force=true.",
  inputSchema: {
    type: "object", required: ["hall", "day", "from", "to", "category"],
    properties: {
      hall: { type: "string" }, day: { type: "string", enum: P.DAYS },
      space: { type: "string", description: "Subdivided halls: space key (see list_halls); default whole hall" },
      from: { type: "string" }, to: { type: "string" },
      category: { type: "string", enum: P.CATEGORIES },
      season: { type: "string", enum: SEASONS, description: "default ganzjährig" },
      holder: { type: "string", description: "Club / group using the slot" },
      show_holder: { type: "boolean", description: "Show the holder name publicly in the plan (default false)" },
      note: { type: "string" }, force: { type: "boolean" },
    },
  },
  async run(args, ctx) {
    const { halls, bookings } = await loadPlan(ctx, { drafts: true });
    const hall = findHall(halls, str(args, "hall", { required: true }));
    const d = day(args), from = time(args, "from"), to = time(args, "to");
    span(from, to);
    const seasonLabel = bookingSeason(args);
    const space = resolveSpace(hall, str(args, "space", { max: 40 }));
    const b = {
      key: bookingKey(hall, d, seasonLabel, space.key, from),
      hall: hall.name, hallKey: hall.key, space: space.key, day: d, season: seasonLabel, from, to,
      category: str(args, "category", { required: true, values: P.CATEGORIES }),
      holder: str(args, "holder"), holderPublic: args?.show_holder === true, note: str(args, "note", { max: 500 }),
      validUntil: schoolYearEnd((await loadPlan(ctx, { drafts: true })).calendar),
      source: "Admin", changedBy: ctx.actor, changedAt: new Date().toISOString(),
    };
    checkFree(bookings, hall, b, args?.force === true);
    const saved = await writeBooking(ctx, b, { create: true });
    return { booking: { ...fmtBooking(b), key: saved.key }, published: false };
  },
};

const updateBooking = {
  name: "update_booking",
  title: "Belegung ändern",
  description: "Changes an existing booking (time, day, space, category, holder and whether the holder name is shown publicly, note). Creates a new DRAFT version; the previous version stays in the history. Refuses overlaps unless force=true.",
  inputSchema: {
    type: "object", required: ["key"],
    properties: {
      key: { type: "string" }, day: { type: "string", enum: P.DAYS }, from: { type: "string" }, to: { type: "string" },
      space: { type: "string", description: "Subdivided halls: move to another space" },
      category: { type: "string", enum: P.CATEGORIES }, holder: { type: "string" },
      show_holder: { type: "boolean", description: "Show the holder name publicly in the plan" },
      note: { type: "string" }, force: { type: "boolean" },
    },
  },
  async run(args, ctx) {
    const key = str(args, "key", { required: true });
    const { raw, bookings, halls } = await loadPlan(ctx, { drafts: true });
    const cur = raw.find(b => b.key === key);
    if (!cur) throw new ToolError(`Belegung ${key} nicht gefunden.`);
    const hall = findHall(halls, cur.hallKey);
    const { _id, _version, ...base } = cur;
    const next = {
      ...base,
      space: args?.space ? resolveSpace(hall, str(args, "space", { max: 40 })).key : cur.space,
      day: day(args, "day", false) || cur.day,
      from: time(args, "from", false) || cur.from,
      to: time(args, "to", false) || cur.to,
      category: str(args, "category", { values: P.CATEGORIES }) || cur.category,
      holder: args?.holder !== undefined ? str(args, "holder") : cur.holder,
      holderPublic: typeof args?.show_holder === "boolean" ? args.show_holder : !!cur.holderPublic,
      note: args?.note !== undefined ? str(args, "note", { max: 500 }) : cur.note,
      changedBy: ctx.actor, changedAt: new Date().toISOString(),
    };
    span(next.from, next.to);
    if (next.status !== "storniert") checkFree(bookings, hall, next, args?.force === true);
    const saved = await writeBooking(ctx, next, { create: false });
    return { booking: fmtBooking(next), version: saved.version, published: false };
  },
};

const cancelBooking = {
  name: "cancel_booking",
  title: "Belegung stornieren",
  description: "Cancels a booking (sets status 'storniert' as a new DRAFT version; the slot becomes free once published). Reversible via update_booking or history.",
  inputSchema: { type: "object", required: ["key", "reason"], properties: { key: { type: "string" }, reason: { type: "string" } } },
  async run(args, ctx) {
    const key = str(args, "key", { required: true });
    const reason = str(args, "reason", { required: true, max: 500 });
    const { raw } = await loadPlan(ctx, { drafts: true });
    const cur = raw.find(b => b.key === key);
    if (!cur) throw new ToolError(`Belegung ${key} nicht gefunden.`);
    const { _id, _version, ...base } = cur;
    await writeBooking(ctx, { ...base, status: "storniert", cancelReason: reason, changedBy: ctx.actor, changedAt: new Date().toISOString() }, { create: false });
    return { key, status: "storniert", published: false };
  },
};

const findConflictsTool = {
  name: "find_conflicts",
  title: "Überschneidungen finden",
  description: "Finds bookings that overlap each other in the current (draft) plan.",
  inputSchema: { type: "object", properties: {} },
  async run(args, ctx) {
    const { bookings } = await loadPlan(ctx, { drafts: true });
    const pairs = P.findConflicts(bookings);
    return { total: pairs.length, conflicts: pairs.map(([a, b]) => ({ a: fmtBooking(a), b: fmtBooking(b) })) };
  },
};

const pendingChanges = {
  name: "list_pending_changes",
  title: "Unveröffentlichte Änderungen",
  description: "Lists draft changes that are not yet published (new, changed or cancelled bookings; new or changed facilities, calendar entries and club entries). Publishing is done by a person in the admin page.",
  inputSchema: { type: "object", properties: {} },
  async run(args, ctx) {
    const w = wren(ctx.env);
    const load = coll => Promise.all([w.list(coll), w.list(coll, { label: "published" }).catch(() => [])]);
    const [[curB, pubB], [curH, pubH], [curC, pubC], [curV, pubV]] = await Promise.all([load("bookings"), load("halls"),
      load("calendar").catch(() => [[], []]), load("clubs").catch(() => [[], []])]);
    const changes = [];
    const diff = (cur, pub, kind, fmt) => {
      const pubById = new Map(pub.map(i => [i.id, i]));
      for (const c of cur) {
        const p = pubById.get(c.id);
        if (p && p.version === c.version) continue;
        const fields = p ? Object.keys({ ...c.data, ...p.data }).filter(k => !["changedAt", "changedBy"].includes(k) && JSON.stringify(c.data[k]) !== JSON.stringify(p.data[k])) : [];
        changes.push({
          kind, key: c.data.key, type: !p ? "neu" : c.data.status === "storniert" && p.data.status !== "storniert" ? "storniert" : "geändert",
          [kind]: fmt(c.data), changedFields: fields, before: p ? fmt(p.data) : null,
          changedBy: c.data.changedBy || null, changedAt: c.data.changedAt || null,
        });
      }
    };
    diff(curH, pubH, "facility", fmtFacility);
    diff(curC, pubC, "calendar", ({ changedBy, changedAt, ...c }) => c);
    diff(curV, pubV, "club", ({ changedBy, changedAt, ...c }) => c);
    diff(curB, pubB, "booking", fmtBooking);
    return { total: changes.length, changes };
  },
};

/* ---------- facilities ---------- */

// Units may be given as ["A","B","C"] or [{key, name}]; spaces as [{key?, name, units:[...]}].
function facilityFromArgs(args, base = {}) {
  const units = args?.units === undefined ? (base.units || []) : (Array.isArray(args.units) ? args.units : []).map(u =>
    typeof u === "string" ? { key: u.trim(), name: `Teil ${u.trim()}` } : { key: String(u.key || "").trim(), name: String(u.name || `Teil ${u.key}`).trim() });
  let spaces = args?.spaces === undefined ? (base.spaces || []) : (Array.isArray(args.spaces) ? args.spaces : []).map(s => ({
    key: String(s.key || P.slug(s.name || "")).trim().slice(0, 40), name: String(s.name || "").trim().slice(0, 80),
    units: Array.isArray(s.units) ? s.units.map(String) : [],
  }));
  // Units without explicit spaces: whole facility + each unit on its own.
  if (units.length > 1 && !spaces.length) {
    spaces = [{ key: P.WHOLE, name: "Ganze Anlage", units: units.map(u => u.key) }, ...units.map(u => ({ key: P.slug(u.key), name: u.name, units: [u.key] }))];
  }
  if (units.length < 2) spaces = [];
  const f = {
    ...base,
    name: str(args, "name", { max: 80 }) || base.name,
    size: args?.size !== undefined ? str(args, "size", { max: 80 }) : base.size || "",
    type: args?.type !== undefined ? str(args, "type", { max: 40 }) : base.type || "Sporthalle",
    address: args?.address !== undefined ? str(args, "address", { max: 120 }) : base.address || "",
    order: Number.isInteger(args?.order) ? args.order : base.order,
    holidays: args?.holidays !== undefined ? str(args, "holidays", { values: ["open", "closed"] }) : base.holidays || "closed",
    units, spaces,
  };
  if (!f.name) throw new ToolError("Parameter «name» fehlt.");
  const err = P.validateFacility(f);
  if (err) throw new ToolError(err);
  return f;
}

const FACILITY_PROPS = {
  name: { type: "string", description: "e.g. 'Sporthalle Moos'" },
  size: { type: "string", description: "e.g. '27 x 45 m'" },
  type: { type: "string", description: "e.g. Sporthalle, Lehrschwimmbecken, Mehrzweckraum" },
  address: { type: "string" },
  order: { type: "integer", description: "Sort position in lists (default 100; e.g. 999 = last)" },
  holidays: { type: "string", enum: ["open", "closed"], description: "During school holidays: 'closed' = the facility is closed (default, current practice), 'open' = clubs/private groups keep their slots (school use drops out)" },
  units: { type: "array", description: "Smallest parts of a divisible facility, in order, e.g. ['A','B','C'] (omit or [] for an undivided one)", items: { anyOf: [{ type: "string" }, { type: "object", properties: { key: { type: "string" }, name: { type: "string" } } }] } },
  spaces: {
    type: "array", description: "Bookable spaces = contiguous units, must include one covering all units. Default: whole + each unit.",
    items: { type: "object", required: ["name", "units"], properties: { key: { type: "string" }, name: { type: "string" }, units: { type: "array", items: { type: "string" } } } },
  },
};

const createFacility = {
  name: "create_facility",
  title: "Anlage erfassen",
  description: "Creates a new facility (hall, pool, room) as a DRAFT, optionally divisible into units and bookable spaces (e.g. a triple hall: units A,B,C; spaces whole, 2/3 = A+B, and each third).",
  inputSchema: { type: "object", required: ["name"], properties: { ...FACILITY_PROPS, key: { type: "string", description: "Optional short key; default derived from the name" } } },
  async run(args, ctx) {
    const f = facilityFromArgs(args);
    const key = str(args, "key", { max: 40 }) ? P.slug(str(args, "key")) : P.slug(f.name.replace(/^Sporthalle\s+/i, ""));
    if (!key) throw new ToolError("Kein gültiger Schlüssel.");
    const w = wren(ctx.env);
    let saved;
    try { saved = await w.put(`/halls/by-key/${key}?ifVersion=0`, { ...f, key, changedBy: ctx.actor, changedAt: new Date().toISOString() }); }
    catch (e) { if (e instanceof WrenError && e.status === 412) throw new ToolError(`Anlage «${key}» gibt es schon.`); throw e; }
    await w.put(`/tree/plan/halls/${key}`, { documentId: saved.id });
    ctx.draftPlan = null;
    return { facility: fmtFacility({ ...f, key }), published: false };
  },
};

const updateFacility = {
  name: "update_facility",
  title: "Anlage ändern",
  description: "Changes a facility (name, size, type, address, units and bookable spaces) as a DRAFT. Refuses to remove spaces that existing bookings use.",
  inputSchema: { type: "object", required: ["key"], properties: { key: { type: "string" }, ...FACILITY_PROPS } },
  async run(args, ctx) {
    const { halls, raw } = await loadPlan(ctx, { drafts: true });
    const cur = findHall(halls, str(args, "key", { required: true }));
    const f = facilityFromArgs(args, cur);
    // Bookings on a space that no longer exists would become ambiguous.
    const used = new Set(raw.filter(b => b.hallKey === cur.key && b.status !== "storniert" && b.space && b.space !== P.WHOLE).map(b => b.space));
    const missing = [...used].filter(k => !P.findSpace(f, k));
    if (missing.length) throw new ToolError(`Flächen ${missing.join(", ")} werden von Belegungen verwendet und können nicht entfernt werden.`);
    await wren(ctx.env).put(`/halls/by-key/${cur.key}`, { ...f, key: cur.key, changedBy: ctx.actor, changedAt: new Date().toISOString() });
    ctx.draftPlan = null;
    return { facility: fmtFacility({ ...f, key: cur.key }), published: false };
  },
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const listHolidays = {
  name: "list_holidays",
  title: "Schulferien und Planperiode",
  description: "Lists school holidays and school-free days of Muri bei Bern (dates YYYY-MM-DD, inclusive) and the school years the occupancy plan covers. During holidays school bookings do not take place (effect 'school'); effect 'closed' means the halls are closed. The weekly plan applies only within its validity (validUntil, usually the last school day).",
  inputSchema: { type: "object", properties: {} },
  async run(args, ctx) {
    const { calendar, raw } = await loadPlan(ctx, { drafts: ctx.drafts });
    const validUntil = raw.reduce((m, b) => (b.validUntil && b.validUntil > m ? b.validUntil : m), "");
    return { planValidUntil: validUntil || null, entries: calendar.map(({ changedBy, changedAt, ...c }) => c) };
  },
};

const listClubs = {
  name: "list_clubs",
  title: "Vereine: wer trainiert wo",
  description: "Lists the sports clubs of Muri bei Bern with their training times and places and how to contact them (website, contact page, club email). The times come from the clubs' own websites (see sources, checkedAt) and may be outdated or differ from the official occupancy plan, which is authoritative. Filter by hall, weekday or sport.",
  inputSchema: {
    type: "object",
    properties: {
      hall: { type: "string", description: "Hall key or name, e.g. 'moos'" },
      day: { type: "string", enum: P.DAYS },
      sport: { type: "string", description: "Part of the sport, e.g. 'Unihockey'" },
    },
  },
  async run(args, ctx) {
    const w = wren(ctx.env);
    let clubs = (await (ctx.drafts ? w.list("clubs") : w.listPublic("clubs")).catch(() => [])).map(i => i.data);
    let hallKey = null;
    if (args?.hall) {
      const { halls } = await loadPlan(ctx, { drafts: ctx.drafts });
      const h = findHall(halls, args.hall);
      if (!h) throw new ToolError(`Halle «${args.hall}» nicht gefunden.`);
      hallKey = h.key;
    }
    const hit = x => (!hallKey || x.hallKey === hallKey) && (!args?.day || x.day === args.day);
    if (args?.sport) clubs = clubs.filter(c => String(c.sport || "").toLowerCase().includes(String(args.sport).toLowerCase()));
    if (hallKey || args?.day) clubs = clubs.filter(c => (c.sessions || []).some(hit)).map(c => ({ ...c, sessions: c.sessions.filter(hit) }));
    clubs = clubs.map(({ changedBy, changedAt, ...c }) => c).sort((a, b) => a.name.localeCompare(b.name, "de"));
    return { total: clubs.length, note: "Angaben von den Websites der Vereine, ohne Gewähr; massgebend ist der Belegungsplan der Gemeinde.", clubs };
  },
};

const setCalendarEntry = {
  name: "set_calendar_entry",
  title: "Ferien / Planperiode erfassen",
  description: "Creates or changes a calendar entry as a DRAFT: school holidays (kind 'ferien'), school-free days ('unterrichtsfrei') or a school year ('schuljahr', its 'to' = last school day = default validity of new bookings). effect 'school' (default): school bookings drop out; 'closed': halls closed.",
  inputSchema: {
    type: "object", required: ["key"],
    properties: {
      key: { type: "string", description: "e.g. 'sommerferien-2027'" },
      kind: { type: "string", enum: ["ferien", "unterrichtsfrei", "schuljahr"] },
      name: { type: "string" }, from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD (inclusive)" },
      effect: { type: "string", enum: ["school", "closed"] },
    },
  },
  async run(args, ctx) {
    const key = P.slug(str(args, "key", { required: true, max: 60 }));
    const { calendar } = await loadPlan(ctx, { drafts: true });
    const cur = calendar.find(c => c.key === key) || {};
    const e = {
      key,
      kind: str(args, "kind", { values: ["ferien", "unterrichtsfrei", "schuljahr"] }) || cur.kind || "ferien",
      name: str(args, "name", { max: 80 }) || cur.name || "",
      from: str(args, "from", { max: 10 }) || cur.from || "",
      to: str(args, "to", { max: 10 }) || cur.to || "",
      effect: str(args, "effect", { values: ["school", "closed"] }) || cur.effect || "school",
      changedBy: ctx.actor, changedAt: new Date().toISOString(),
    };
    if (!e.name) throw new ToolError("Parameter «name» fehlt.");
    if ((e.from && !ISO.test(e.from)) || !ISO.test(e.to || e.from) || (e.from && e.to && e.to < e.from)) throw new ToolError("Daten im Format YYYY-MM-DD, «to» nicht vor «from».");
    const w = wren(ctx.env);
    if (cur.key) await w.put(`/calendar/by-key/${key}`, e);
    else {
      const saved = await w.put(`/calendar/by-key/${key}?ifVersion=0`, e);
      await w.put(`/tree/plan/calendar/${key}`, { documentId: saved.id });
    }
    ctx.draftPlan = null;
    return { entry: e, published: false };
  },
};

export const PUBLIC_TOOLS = [listHalls, getWeekPlan, findFreeSlots, listHolidays, listClubs, submitRequest];
export const ADMIN_TOOLS = [listRequests, approveRequest, rejectRequest, listBookings, createBooking, updateBooking, cancelBooking, findConflictsTool, createFacility, updateFacility, setCalendarEntry, pendingChanges];

// Run a tool by name. Admin context reads the draft plan for the read tools too.
export async function runTool(name, args, ctx) {
  const tools = ctx.admin ? [...PUBLIC_TOOLS, ...ADMIN_TOOLS] : PUBLIC_TOOLS;
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new ToolError(`Unbekanntes Werkzeug «${name}».`);
  return tool.run(args || {}, { ...ctx, drafts: !!ctx.admin });
}

// Publish all draft changes: move the "published" label for the whole plan tree in one transaction.
export async function publishPlan(env) {
  const res = await wren(env).post("/tree/plan/_promote", { label: "published" });
  return { promoted: (res.promoted || []).length };
}
