// Calendar views shared by the public plan and the admin calendar: day and week grids
// (days × 07:00–22:30, one sub-column per unit of a subdivided hall) and a month overview.
import { DAYS, OPEN, CLOSE, STEP, toTime, hallUnits, freeWindows, addDays, mondayOf, isoDate, isoWeek } from "./plan.js";
import { t, locale, dayShort, catShort } from "./i18n.js";

export const CATEGORY_CLASS = {
  "Schule": "schule",
  "Private Schule": "privschule",
  "Schule extern": "privschule",
  "Verein/Stiftung": "verein",
  "Private Gruppe": "privat",
  "Reinigung": "reinigung",
  "nicht verfügbar": "nv",
};
// Compact, translated category labels for the narrow day columns.
export const shortCat = catShort;

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// Unit index range covered by a booking/space within its hall.
export function unitSpan(hall, units) {
  const keys = hallUnits(hall).map(u => u.key);
  const idx = (units || keys).map(u => keys.indexOf(u)).filter(i => i >= 0);
  if (!idx.length) return { u0: 0, span: keys.length };
  return { u0: Math.min(...idx), span: Math.max(...idx) - Math.min(...idx) + 1 };
}

// Free windows of one day per unit; adjacent units free for exactly the same time are merged.
export function freeBlocks(bookings, hall, day, season) {
  const units = hallUnits(hall).map(u => u.key);
  if (units.length === 1) return freeWindows(bookings, hall.key, day, season).map(w => ({ ...w, u0: 0, span: 1, units }));
  const per = units.map(u => freeWindows(bookings, hall.key, day, season, [u]));
  const out = [];
  per.forEach((wins, i) => wins.forEach(w => {
    const prev = out.find(o => o.start === w.start && o.end === w.end && o.u0 + o.span === i);
    if (prev) { prev.span++; prev.units.push(units[i]); }
    else out.push({ ...w, u0: i, span: 1, units: [units[i]] });
  }));
  return out;
}

// Time grid for the given columns. cols: [{ key, label, today, href }] — one per day; items carry
// `col` (column key), start/end minutes, u0/span (units), label, sub, cls, attrs, tag, title.
export function planGrid(hall, items, cols) {
  const units = hallUnits(hall), n = units.length;
  const head = n > 1 ? 2 : 1;
  const row = m => (m - OPEN) / STEP + 1 + head;
  const rows = (CLOSE - OPEN) / STEP;
  const ticks = [];
  for (let m = OPEN; m < CLOSE; m += 60) ticks.push(`<div class="tick" style="grid-row:${row(m)}">${toTime(m)}</div>`);
  const col = (ci, u) => 2 + ci * n + u;
  const index = new Map(cols.map((c, i) => [c.key, i]));
  return `<div class="plan-scroll"><div class="plan${n > 1 ? " split" : ""}${cols.length === 1 ? " single" : ""}" style="grid-template-columns: 3.2rem repeat(${cols.length * n}, minmax(0, 1fr)); grid-template-rows: ${head > 1 ? "auto " : ""}auto repeat(${rows}, ${cols.length === 1 ? "1.5rem" : "1.1rem"}); --units: ${n}; --days: ${cols.length}">
    <div class="corner" style="grid-row: 1 / ${head + 1}"></div>
    ${cols.map((c, i) => `<div class="dayhead${c.today ? " today" : ""}${c.holiday ? " holiday" : ""}" style="grid-row:1;grid-column:${col(i, 0)} / span ${n}">${c.href ? `<a href="${c.href}">${c.label}</a>` : c.label}</div>`).join("")}
    ${n > 1 ? cols.map((_, i) => units.map((u, k) => `<div class="unithead" style="grid-row:2;grid-column:${col(i, k)}" title="${esc(u.name)}">${esc(cols.length === 1 ? u.name : u.key)}</div>`).join("")).join("") : ""}
    ${ticks.join("")}
    ${items.filter(it => index.has(it.col)).map(it => {
      const tag = it.tag || "div";
      return `<${tag} class="blk ${it.cls}${it.u0 ? " notfirst" : ""}" style="grid-column:${col(index.get(it.col), it.u0 || 0)} / span ${it.span || n};grid-row:${row(it.start)} / ${row(it.end)}"
        title="${esc(it.title)}" ${it.attrs || ""}><span>${esc(it.label)}</span>${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ""}<span class="t">${toTime(it.start)}–${toTime(it.end)}</span></${tag}>`;
    }).join("")}
  </div></div>`;
}

export function legend(extra = []) {
  const items = [...["schule", "privschule", "verein", "privat", "reinigung", "nv", "free"].map(c => [c, t(`legend.${c}`)]), ...extra];
  return `<ul class="legend">${items.map(([c, l]) => `<li><span class="sw ${c}"></span>${l}</li>`).join("")}</ul>`;
}

/* ---------- day / week / month navigation ---------- */

export const VIEWS = ["tag", "woche", "monat"];
const fmt = (d, o) => new Intl.DateTimeFormat(locale, o).format(d);
const sameDay = (a, b) => isoDate(a) === isoDate(b);

// Phones get the day view by default, larger screens the week view.
export const defaultView = () => (matchMedia("(max-width: 700px)").matches ? "tag" : "woche");

// Columns of the time grid for a day or week view.
// holidayOf(date) -> holiday entry or null; its name is shown in the day header.
export function viewColumns(view, date, href, holidayOf = () => null) {
  const today = new Date();
  const days = view === "tag" ? [date] : [0, 1, 2, 3, 4, 5, 6].map(i => addDays(mondayOf(date), i));
  return days.map(d => {
    const hol = holidayOf(d);
    return {
      key: isoDate(d), date: d, today: sameDay(d, today), holiday: hol,
      label: (view === "tag" ? esc(fmt(d, { weekday: "long", day: "numeric", month: "long" }))
        : `${dayShort((d.getDay() + 6) % 7)} <span class="dnum">${fmt(d, { day: "numeric", month: "numeric" })}</span>`)
        + (hol ? `<span class="hol" title="${esc(hol.name)}">${esc(hol.name)}</span>` : ""),
      href: view === "tag" ? "" : href("tag", d),
    };
  });
}

export function viewTitle(view, date) {
  if (view === "tag") return fmt(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (view === "monat") return fmt(date, { month: "long", year: "numeric" });
  const mo = mondayOf(date), su = addDays(mo, 6);
  return `${t("cal.week")} ${isoWeek(date)} · ${fmt(mo, { day: "numeric", month: "short" })} – ${fmt(su, { day: "numeric", month: "short", year: "numeric" })}`;
}

export function shiftDate(view, date, dir) {
  if (view === "tag") return addDays(date, dir);
  if (view === "woche") return addDays(date, 7 * dir);
  return new Date(date.getFullYear(), date.getMonth() + dir, 1);
}

// href(view, date) builds the link for a view/date.
export function calendarToolbar(view, date, href) {
  return `<div class="caltools">
    <div class="seg" role="group" aria-label="${t("cal.view")}">
      ${VIEWS.map(v => `<a href="${href(v, date)}" aria-current="${v === view}">${t(`cal.${v}`)}</a>`).join("")}
    </div>
    <div class="calnav">
      <a class="navbtn" href="${href(view, shiftDate(view, date, -1))}" aria-label="${t("cal.prev")}">‹</a>
      <a class="navbtn today-btn" href="${href(view, new Date())}">${t("cal.today")}</a>
      <a class="navbtn" href="${href(view, shiftDate(view, date, 1))}" aria-label="${t("cal.next")}">›</a>
      <strong class="caltitle">${esc(viewTitle(view, date))}</strong>
    </div>
  </div>`;
}

// Month overview: one cell per date with an occupancy bar and free evening hours.
// stats(date) -> { pct, eveFree (minutes), closed, holiday, open }; href(view, date) links a day to its day view.
export function monthGrid(date, stats, href) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const start = mondayOf(first), today = new Date();
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const days = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(start, w * 7 + i));
    if (w > 3 && days[0].getMonth() !== date.getMonth()) break;
    weeks.push(days);
  }
  const hrs = m => (m / 60).toLocaleString(locale, { maximumFractionDigits: 1 });
  return `<div class="month">
    ${DAYS.map((_, i) => `<div class="mhead">${dayShort(i)}</div>`).join("")}
    ${weeks.flat().map(d => {
      const s = stats(d), out = d.getMonth() !== date.getMonth();
      const pct = Math.round(s.pct * 100);
      return `<a class="mday${out ? " out" : ""}${sameDay(d, today) ? " today" : ""}${s.closed ? " closed" : ""}${s.holiday ? " holiday" : ""}${s.open ? " planopen" : ""}" href="${href("tag", d)}"
          title="${esc(fmt(d, { weekday: "long", day: "numeric", month: "long" }))}${s.holiday ? " · " + esc(s.holiday.name) : ""} · ${s.closed ? t("stat.closed") : `${t("stat.occupancy")} ${pct}%`}">
        <span class="mnum">${d.getDate()}</span>${s.holiday ? `<span class="mhol">${esc(s.holiday.name)}</span>` : ""}
        ${s.closed ? `<span class="mfree muted">${t("stat.closed")}</span>` : `
        <span class="mbar" aria-hidden="true"><span style="width:${pct}%"></span></span>
        <span class="mfree">${s.eveFree ? t("cal.eveFree", { h: hrs(s.eveFree) }) : `<span class="muted">${t("cal.eveFull")}</span>`}</span>`}
      </a>`;
    }).join("")}
  </div>`;
}
