import { test } from "node:test";
import assert from "node:assert/strict";
import * as P from "../app/plan.js";

const b = (hallKey, day, from, to, category = "Verein/Stiftung", season = "ganzjährig", key = `${hallKey}-${day}-${from}`) =>
  ({ key, hallKey, day, from, to, category, season });

test("freeWindows returns gaps between bookings", () => {
  const bookings = P.prepare([b("h", "Montag", "08:00", "12:00"), b("h", "Montag", "18:00", "20:00")]);
  assert.deepEqual(P.freeWindows(bookings, "h", "Montag", "winter").map(w => [P.toTime(w.start), P.toTime(w.end)]),
    [["07:00", "08:00"], ["12:00", "18:00"], ["20:00", "22:30"]]);
});

test("mostly-closed days have no free windows; cancelled bookings are ignored", () => {
  const bookings = P.prepare([b("h", "Samstag", "08:00", "22:00", P.CLOSED), { ...b("h", "Sonntag", "08:00", "22:00"), status: "storniert" }]);
  assert.deepEqual(P.freeWindows(bookings, "h", "Samstag", "winter"), []);
  assert.equal(P.freeWindows(bookings, "h", "Sonntag", "winter").length, 1);
});

test("season-specific bookings only block their season", () => {
  const bookings = P.prepare([b("h", "Mittwoch", "18:00", "20:00", "Verein/Stiftung", "Nov-Feb.")]);
  assert.equal(P.freeWindows(bookings, "h", "Mittwoch", "summer").length, 1);
  assert.equal(P.freeWindows(bookings, "h", "Mittwoch", "winter").length, 2);
});

test("overlaps and findConflicts", () => {
  const bookings = P.prepare([b("h", "Montag", "18:00", "20:00"), b("h", "Montag", "19:30", "21:00"), b("h", "Montag", "21:00", "22:00"),
    b("h", "Dienstag", "18:00", "20:00", "Schule", "März-Okt."), b("h", "Dienstag", "18:00", "20:00", "Schule", "Nov-Feb.")]);
  assert.equal(P.overlaps(bookings, { hallKey: "h", day: "Montag", start: P.toMin("20:00"), end: P.toMin("21:00") }).length, 1);
  assert.equal(P.findConflicts(bookings).length, 1, "summer and winter bookings at the same time do not conflict");
});

test("slug handles umlauts", () => {
  assert.equal(P.slug("Melchenbühl Ganzjährig"), "melchenbuehl-ganzjaehrig");
});

/* ---------- subdivided facilities ---------- */

const moos = {
  key: "moos", name: "Sporthalle Moos",
  units: [{ key: "A", name: "Teil A" }, { key: "B", name: "Teil B" }, { key: "C", name: "Teil C" }],
  spaces: [
    { key: "ganz", name: "Ganze Halle", units: ["A", "B", "C"] },
    { key: "gross", name: "2/3 (A+B)", units: ["A", "B"] },
    { key: "a", name: "1/3 A", units: ["A"] }, { key: "b", name: "1/3 B", units: ["B"] }, { key: "c", name: "1/3 C", units: ["C"] },
  ],
};
const sb = (space, from, to, day = "Montag") => ({ key: `${space}-${from}`, hallKey: "moos", day, from, to, category: "Verein/Stiftung", season: "ganzjährig", space });

test("thirds can be used in parallel; whole hall and 2/3 conflict with the parts they contain", () => {
  const bookings = P.prepare([sb("a", "18:00", "20:00"), sb("b", "18:00", "20:00")], [moos]);
  const t = { hallKey: "moos", day: "Montag", start: P.toMin("18:00"), end: P.toMin("19:00") };
  assert.equal(P.overlaps(bookings, { ...t, units: ["C"] }).length, 0, "C is still free");
  assert.equal(P.overlaps(bookings, { ...t, units: ["A", "B", "C"] }).length, 2, "whole hall conflicts");
  assert.equal(P.overlaps(bookings, { ...t, units: ["A", "B"] }).length, 2, "2/3 conflicts");
  assert.equal(P.findConflicts(bookings).length, 0);
  assert.equal(P.findConflicts(P.prepare([sb("gross", "18:00", "20:00"), sb("a", "19:00", "21:00")], [moos])).length, 1);
});

test("free slots are reported per space without redundant smaller spaces", () => {
  const bookings = P.prepare([sb("a", "18:00", "20:00")], [moos]);
  const slots = P.findFreeSlots([moos], bookings, { days: ["Montag"], from: "17:00", minLen: 60 })
    .map(s => `${s.space.key} ${P.toTime(s.start)}-${P.toTime(s.end)}`);
  // 17:00–18:00 is the whole hall; 18:00–20:00 only B+C are free (no B+C space defined -> b and c), from 20:00 whole hall again.
  assert.deepEqual([...slots].sort(), ["b 17:00-22:30", "c 17:00-22:30", "ganz 17:00-18:00", "ganz 20:00-22:30"]);
  assert.ok(slots.includes("ganz 20:00-22:30"));
  assert.ok(slots.includes("c 17:00-22:30"));
  assert.ok(!slots.some(s => s.startsWith("gross")), "2/3 (A+B) is never free for 60 min across 18–20");
  assert.ok(!slots.includes("a 20:00-22:30"), "a third is not listed when the whole hall is free for that time");
});

test("hallStats weights partial bookings by their share", () => {
  const s = P.hallStats(P.prepare([sb("a", "18:00", "21:00")], [moos]), moos, "winter");
  assert.equal(s.booked, 60, "3 h on one of three units = 1 h of the whole hall");
});

test("validateFacility rejects bad subdivisions", () => {
  assert.equal(P.validateFacility(moos), "");
  assert.match(P.validateFacility({ ...moos, spaces: [{ key: "x", name: "A+C", units: ["A", "C"] }, moos.spaces[0]] }), /nebeneinander/);
  assert.match(P.validateFacility({ ...moos, spaces: moos.spaces.slice(1) }), /ganze Anlage/);
  assert.match(P.validateFacility({ ...moos, units: [{ key: "A", name: "A" }], spaces: [] }), /mindestens zwei/);
});

test("calendar dates: weekday, ISO week, Monday, next date in a season", () => {
  const d = P.parseDate("2026-10-14");
  assert.equal(P.weekdayOf(d), "Mittwoch");
  assert.equal(P.isoWeek(d), 42);
  assert.equal(P.isoDate(P.mondayOf(d)), "2026-10-12");
  assert.equal(P.isoDate(P.nextDateFor("Montag", "summer", d)), "2027-04-05");
  assert.equal(P.isoDate(P.nextDateFor("Mittwoch", "winter", d)), "2026-10-14");
  assert.equal(P.isoWeek(P.parseDate("2027-01-01")), 53);
});

test("dayStats: free evening and closed days", () => {
  const bookings = P.prepare([sb("a", "18:00", "20:00")], [moos]);
  const s = P.dayStats(bookings, moos, "Montag", "winter");
  assert.equal(s.booked, 40, "2 h on one third");
  assert.equal(s.eveFree, 330 - 40, "5.5 h evening minus the booked third");
  const closedDay = P.dayStats(P.prepare([sb("ganz", "08:00", "22:00", "Samstag")].map(b => ({ ...b, category: P.CLOSED })), [moos]), moos, "Samstag", "winter");
  assert.equal(closedDay.closed, true);
});

test("holidays and validity: school bookings drop out, closed holidays close the hall, plan ends at validUntil", () => {
  const cal = [
    { key: "herbst", kind: "ferien", name: "Herbstferien", from: "2026-09-19", to: "2026-10-11", effect: "school" },
    { key: "sommer", kind: "ferien", name: "Sommerferien", from: "2027-07-03", to: "2027-08-15", effect: "closed" },
  ];
  const raw = [
    { ...sb("ganz", "08:00", "16:00"), category: "Schule", validUntil: "2027-07-02" },
    { ...sb("a", "18:00", "20:00"), validUntil: "2027-07-02" },
  ];
  const bookings = P.prepare(raw, [moos]);
  const keys = d => P.bookingsOn(bookings, cal, P.parseDate(d), [moos]).list.map(b => b.category);
  assert.deepEqual(keys("2026-10-12"), ["Schule", "Verein/Stiftung"], "normal Monday");
  assert.deepEqual(keys("2026-10-05"), [P.CLOSED], "autumn holidays: hall closed (default)");
  assert.deepEqual(keys("2027-07-05"), [P.CLOSED], "summer holidays closed (and plan ended)");
  assert.deepEqual(keys("2027-08-16"), [], "after validUntil the plan is open");
  assert.equal(P.holidayOn(cal, "2026-10-11").name, "Herbstferien");
  assert.equal(P.planValidUntil(bookings), "2027-07-02");
});

test("per-hall holiday rule: closed by default, open halls keep club slots, school-free days never close", () => {
  const cal = [
    { key: "herbst", kind: "ferien", name: "Herbstferien", from: "2026-09-19", to: "2026-10-11", effect: "school" },
    { key: "frei", kind: "unterrichtsfrei", name: "Unterrichtsfrei", from: "2026-11-23", to: "2026-11-23", effect: "school" },
  ];
  const raw = [{ ...sb("ganz", "08:00", "16:00"), category: "Schule" }, sb("a", "18:00", "20:00")];
  const cats = (hall, d) => P.bookingsOn(P.prepare(raw, [hall]), cal, P.parseDate(d), [hall]).list.map(b => b.category);
  assert.deepEqual(cats(moos, "2026-10-05"), [P.CLOSED], "default: closed during holidays");
  assert.deepEqual(cats({ ...moos, holidays: "open" }, "2026-10-05"), ["Verein/Stiftung"], "open: clubs continue");
  assert.deepEqual(cats(moos, "2026-11-23"), ["Verein/Stiftung"], "school-free day: no school, hall open");
});
