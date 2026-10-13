// Shared hall-plan logic: used by the browser app (app.js, admin.js) and the Worker (MCP/REST tools),
// so the website and LLM answers always agree. Plain ES module, no dependencies.
//
// Facilities can be subdivided: a hall has *units* (the smallest parts, e.g. Moos: A, B, C) and
// bookable *spaces* made of contiguous units (e.g. "Ganze Halle" = A+B+C, "2/3" = A+B, "1/3 A" = A).
// Two bookings only conflict if their spaces share a unit. Halls without units are one implicit unit.

export const DAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
export const OPEN = toMin("07:00"), CLOSE = toMin("22:30"), STEP = 30;
export const CLOSED = "nicht verfügbar";
export const CATEGORIES = ["Schule", "Private Schule", "Schule extern", "Verein/Stiftung", "Private Gruppe", "Reinigung", CLOSED];
export const WHOLE = "ganz";

export function toMin(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
export function toTime(m) { return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; }

export function slug(s) {
  return String(s).toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .normalize("NFKD").replace(/[^\x00-\x7f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/* ---------- units and spaces ---------- */

export function hallUnits(hall) {
  return hall?.units?.length ? hall.units : [{ key: WHOLE, name: "Ganze Halle" }];
}
export function hallSpaces(hall) {
  if (hall?.spaces?.length) return hall.spaces;
  return [{ key: WHOLE, name: "Ganze Halle", units: hallUnits(hall).map(u => u.key) }];
}
// The space covering all units (the "whole hall"), or a synthetic one.
export function wholeSpace(hall) {
  const all = hallUnits(hall).map(u => u.key);
  return hallSpaces(hall).find(s => s.units.length === all.length) || { key: WHOLE, name: "Ganze Halle", units: all };
}
export function findSpace(hall, key) {
  if (!key || key === WHOLE) return wholeSpace(hall);
  return hallSpaces(hall).find(s => s.key === key) || null;
}
export const sharesUnit = (a, b) => a.some(u => b.includes(u));
// Facility order: optional numeric "order" first (e.g. 999 puts a test hall last), then name.
export const byOrder = (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.name.localeCompare(b.name, "de");

// Checks a facility definition; returns an error message or "".
export function validateFacility(f) {
  const units = f.units || [];
  const keys = units.map(u => u.key);
  if (new Set(keys).size !== keys.length) return "Teilbereiche müssen eindeutige Schlüssel haben.";
  if (units.length === 1) return "Eine Anlage hat entweder keinen oder mindestens zwei Teilbereiche.";
  if (!units.length) return f.spaces?.length ? "Buchbare Flächen brauchen Teilbereiche." : "";
  const spaceKeys = new Set();
  for (const s of f.spaces || []) {
    if (!s.key || !s.name) return "Jede buchbare Fläche braucht Schlüssel und Namen.";
    if (spaceKeys.has(s.key)) return `Fläche «${s.key}» ist doppelt.`;
    spaceKeys.add(s.key);
    if (!s.units?.length || s.units.some(u => !keys.includes(u))) return `Fläche «${s.name}» verweist auf unbekannte Teilbereiche.`;
    const idx = s.units.map(u => keys.indexOf(u)).sort((a, b) => a - b);
    if (idx.some((v, i) => i && v !== idx[i - 1] + 1)) return `Fläche «${s.name}» muss aus nebeneinanderliegenden Teilbereichen bestehen.`;
  }
  if (!(f.spaces || []).some(s => s.units.length === keys.length)) return "Es braucht eine Fläche, die die ganze Anlage umfasst.";
  return "";
}

/* ---------- seasons ---------- */

// Season columns in the PDF read e.g. "März-Okt." / "Nov-Feb." / "April-Sept." / "Okt.-März".
export function seasonKind(s) {
  if (!s || s === "ganzjährig") return "all";
  if (s === "Sommer") return "summer";
  if (s === "Winter") return "winter";
  return /^(Nov|Okt)/.test(s) ? "winter" : "summer";
}
export function currentSeason(date = new Date()) { const m = date.getMonth() + 1; return m >= 4 && m <= 9 ? "summer" : "winter"; }

/* ---------- bookings ---------- */

// Raw WREN booking data -> bookings with minute offsets and resolved units; cancelled ones are dropped.
export function prepare(items, halls = []) {
  const byKey = new Map(halls.map(h => [h.key, h]));
  return items.filter(b => b.status !== "storniert").map(b => {
    const hall = byKey.get(b.hallKey);
    const space = findSpace(hall, b.space) || wholeSpace(hall);
    return { ...b, start: toMin(b.from), end: toMin(b.to), units: space.units, spaceName: space.units.length === hallUnits(hall).length ? "" : space.name };
  });
}

export function dayBookings(bookings, hallKey, day, season) {
  return bookings.filter(b => b.hallKey === hallKey && b.day === day &&
    (seasonKind(b.season) === "all" || seasonKind(b.season) === season));
}
export function hasSeasons(bookings, hallKey) { return bookings.some(b => b.hallKey === hallKey && seasonKind(b.season) !== "all"); }
export function seasonLabels(bookings, hallKey) {
  const s = { summer: new Set(), winter: new Set() };
  bookings.filter(b => b.hallKey === hallKey).forEach(b => { const k = seasonKind(b.season); if (k !== "all") s[k].add(b.season); });
  return { summer: [...s.summer].join(" / "), winter: [...s.winter].join(" / ") };
}

// Maximal free windows (in minutes) of one hall/day for the given units (default: the whole hall).
export function freeWindows(bookings, hallKey, day, season, units = null) {
  const all = dayBookings(bookings, hallKey, day, season);
  // A day that is mostly "nicht verfügbar" (closed weekends) is closed as a whole.
  const closed = all.filter(b => b.category === CLOSED).reduce((s, b) => s + b.end - b.start, 0);
  if (closed > (CLOSE - OPEN) / 2) return [];
  const busy = units ? all.filter(b => !b.units || sharesUnit(b.units, units)) : all;
  const out = [];
  let start = null;
  for (let t = OPEN; t <= CLOSE; t += STEP) {
    const free = t < CLOSE && !busy.some(b => b.start <= t && t < b.end);
    if (free && start === null) start = t;
    if (!free && start !== null) { out.push({ start, end: t }); start = null; }
  }
  return out;
}

// Weekly figures; partial-hall bookings count by their share of the units.
export function hallStats(bookings, hall, season) {
  const units = hallUnits(hall).map(u => u.key), n = units.length;
  let booked = 0, free = 0, nv = 0, eveFree = 0, weekendFree = 0, weekendNv = 0;
  DAYS.forEach((day, i) => {
    for (const b of dayBookings(bookings, hall.key, day, season)) {
      const len = (b.end - b.start) * ((b.units?.length || n) / n);
      if (b.category !== CLOSED) booked += len;
      else { nv += len; if (i >= 5) weekendNv += len; }
    }
    for (const u of units) {
      for (const w of freeWindows(bookings, hall.key, day, season, n > 1 ? [u] : null)) {
        const len = (w.end - w.start) / n;
        free += len;
        if (i >= 5) weekendFree += len;
        else eveFree += Math.max(0, w.end - Math.max(w.start, toMin("17:00"))) / n;
      }
    }
  });
  // A hall whose weekend is mostly "nicht verfügbar" counts as closed; the leftover
  // edge slots (e.g. 07:00–08:00) are not usable training time.
  const weekendClosed = weekendNv > weekendFree;
  return { booked, free, nv, eveFree, weekendFree, weekendClosed, pct: booked / (booked + free || 1) };
}

// Free windows across halls/days and their bookable spaces, at least minLen minutes, starting no
// earlier than `from`. A slot of a smaller space is dropped when a larger space is free for the same time.
export function findFreeSlots(halls, bookings, { days = DAYS, from = "07:00", minLen = 60, hallKey = "", season = currentSeason() } = {}) {
  const out = [];
  for (const h of halls) {
    if (hallKey && h.key !== hallKey) continue;
    const spaces = [...hallSpaces(h)].sort((a, b) => b.units.length - a.units.length);
    for (const day of days) {
      const found = [];
      for (const s of spaces) {
        for (const w of freeWindows(bookings, h.key, day, season, s.units)) {
          const start = Math.max(w.start, toMin(from));
          if (w.end - start < minLen) continue;
          const covered = found.some(f => f.space.units.length > s.units.length && s.units.every(u => f.space.units.includes(u)) && f.start <= start && f.end >= w.end);
          if (!covered) found.push({ hall: h, day, start, end: w.end, space: s, whole: s.units.length === hallUnits(h).length });
        }
      }
      out.push(...found);
    }
  }
  return out.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start - b.start || b.space.units.length - a.space.units.length);
}

// Bookings overlapping [start, end) on a hall/day for the given units, in any season that could apply at the same time.
export function overlaps(bookings, { hallKey, day, season = "ganzjährig", start, end, units = null, ignoreKey = "" }) {
  const k = seasonKind(season);
  return bookings.filter(b => b.hallKey === hallKey && b.day === day && b.key !== ignoreKey &&
    (k === "all" || seasonKind(b.season) === "all" || seasonKind(b.season) === k) &&
    (!units || !b.units || sharesUnit(b.units, units)) &&
    b.start < end && start < b.end);
}

// Pairs of bookings that overlap each other (double bookings).
export function findConflicts(bookings) {
  const out = [];
  for (let i = 0; i < bookings.length; i++) {
    for (let j = i + 1; j < bookings.length; j++) {
      const a = bookings[i], b = bookings[j];
      if (a.hallKey !== b.hallKey || a.day !== b.day || !(a.start < b.end && b.start < a.end)) continue;
      if (a.units && b.units && !sharesUnit(a.units, b.units)) continue;
      const ka = seasonKind(a.season), kb = seasonKind(b.season);
      if (ka === "all" || kb === "all" || ka === kb) out.push([a, b]);
    }
  }
  return out;
}

/* ---------- dates (the weekly plan projected onto real calendar dates) ---------- */

const pad = n => String(n).padStart(2, "0");
export const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const weekdayOf = d => DAYS[(d.getDay() + 6) % 7];
export const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));
export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
}
// Next date (from `from`, inclusive) that is the given weekday and lies in the given season.
export function nextDateFor(day, season, from = new Date()) {
  let d = parseDate(isoDate(from));
  for (let i = 0; i < 400; i++, d = addDays(d, 1)) if (weekdayOf(d) === day && currentSeason(d) === season) return d;
  return d;
}

// One day of one hall: booked/free minutes (weighted by unit share) and free minutes from 17:00.
export function dayStats(bookings, hall, day, season) {
  const units = hallUnits(hall).map(u => u.key), n = units.length;
  let booked = 0, closed = 0, free = 0, eveFree = 0;
  for (const b of dayBookings(bookings, hall.key, day, season)) {
    const len = (b.end - b.start) * ((b.units?.length || n) / n);
    if (b.category === CLOSED) closed += len; else booked += len;
  }
  for (const u of units) {
    for (const w of freeWindows(bookings, hall.key, day, season, n > 1 ? [u] : null)) {
      free += (w.end - w.start) / n;
      eveFree += Math.max(0, w.end - Math.max(w.start, toMin("17:00"))) / n;
    }
  }
  return { booked, free, eveFree, closed: free === 0 && closed > 0, pct: booked / (booked + free || 1) };
}

/* ---------- holidays and validity (real dates) ---------- */

export const SCHOOL_CATEGORIES = ["Schule", "Private Schule", "Schule extern"];

// Calendar entries: { key, kind: "ferien"|"unterrichtsfrei"|"schuljahr", name, from, to, effect: "school"|"closed" }.
export function holidayOn(calendar, iso) {
  return (calendar || []).find(c => c.kind !== "schuljahr" && c.from <= iso && iso <= (c.to || c.from)) || null;
}

// Per facility: may non-school users use it during school holidays? hall.holidays = "closed" (default,
// current practice of the Gemeinde) | "open" (clubs/private groups keep their slots).
// A calendar entry with effect "closed" closes every hall; single school-free days never close a hall.
export function closedOn(hall, holiday) {
  if (!holiday) return false;
  return holiday.effect === "closed" || (holiday.kind === "ferien" && !!hall && (hall.holidays ?? "closed") === "closed");
}

// Does a booking take place on this date? Respects validFrom/validUntil, holidays and the hall's holiday rule.
export function activeOn(b, iso, holiday, hall = null) {
  if (b.validFrom && iso < b.validFrom) return false;
  if (b.validUntil && iso > b.validUntil) return false;
  if (closedOn(hall, holiday)) return false;
  if (holiday && SCHOOL_CATEGORIES.includes(b.category)) return false;
  return true;
}

// Bookings (already prepared) that apply on a given date, plus the holiday of that date.
// A "closed" holiday is represented as a synthetic whole-day "nicht verfügbar" booking per hall.
export function bookingsOn(bookings, calendar, date, halls = []) {
  const iso = isoDate(date), holiday = holidayOn(calendar, iso), day = weekdayOf(date);
  const byKey = new Map(halls.map(h => [h.key, h]));
  const list = bookings.filter(b => b.day === day && activeOn(b, iso, holiday, byKey.get(b.hallKey)));
  if (holiday) {
    for (const h of halls.filter(x => closedOn(x, holiday))) {
      list.push({ key: `closed-${h.key}-${iso}`, hallKey: h.key, day, season: "ganzjährig", from: toTime(OPEN), to: toTime(CLOSE),
        start: OPEN, end: CLOSE, category: CLOSED, note: holiday.name, units: hallUnits(h).map(u => u.key), spaceName: "" });
    }
  }
  return { list, holiday, iso };
}

// Latest validUntil of the plan (end of the current school year), or "".
export const planValidUntil = bookings => bookings.reduce((m, b) => (b.validUntil && b.validUntil > m ? b.validUntil : m), "");
