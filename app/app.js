// Hallenbelegung Muri-Gümligen — plain JS, no dependencies.
import * as P from "./plan.js";
import { planGrid, legend, esc, CATEGORY_CLASS, shortCat, unitSpan, freeBlocks, VIEWS, defaultView, viewColumns, calendarToolbar, monthGrid } from "./planview.js";
import { t, lang, locale, dayName, dayShort, catName, applyStatic, langSwitcher } from "./i18n.js";
const { DAYS, toMin, toTime, currentSeason } = P;
const CFG = window.HALLEN_CONFIG;
const view = document.getElementById("view");
const view_ = view;
let halls = [], bookings = [], calendar = [], clubs = [];

function hours(min) { return (min / 60).toLocaleString(locale, { maximumFractionDigits: 1 }); }

async function api(path) {
  // Optional collection prefix (test environments sharing one WREN account).
  const r = await fetch(`${CFG.dataBase}/${CFG.prefix || ""}${path.slice(1)}`);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

async function load() {
  const [h, b, c, v] = await Promise.all([api("/halls?limit=200"), api("/bookings?limit=200"),
    api("/calendar?limit=200").catch(() => ({ items: [] })), api("/clubs?limit=200").catch(() => ({ items: [] }))]);
  halls = h.items.map(i => i.data).sort(P.byOrder);
  bookings = P.prepare(b.items.map(i => i.data), halls);
  calendar = c.items.map(i => i.data);
  clubs = v.items.map(i => i.data).sort((a, x) => a.name.localeCompare(x.name, "de"));
}

// The plan logic lives in plan.js (shared with the Worker); these bind it to the loaded data.
const dayBookings = (hallKey, day, season) => P.dayBookings(bookings, hallKey, day, season);
const hallStats = (hallKey, season) => P.hallStats(bookings, halls.find(h => h.key === hallKey), season);

/* ---------- views ---------- */

function renderHome() {
  const season = currentSeason();
  view.innerHTML = `
    <section class="intro">
      <h1>${t("home.title")}</h1>
      <p>${t("home.intro")}</p>
      <a class="button" href="#/frei">${t("home.cta")}</a>
    </section>
    <section class="cards">
      ${halls.map(h => {
        const s = hallStats(h.key, season);
        const pct = Math.round(s.pct * 100);
        return `<a class="card" href="#/halle/${h.key}">
          <h2>${esc(h.name)}</h2>
          <p class="muted">${h.size ? esc(h.size) : "&nbsp;"}</p>
          <div class="meter" role="img" aria-label="${esc(t("stat.occupancyAria", { pct }))}"><span style="width:${s.pct * 100}%"></span></div>
          <dl>
            <div><dt>${t("stat.occupancy")}</dt><dd>${pct}%</dd></div>
            <div><dt>${t("stat.evening")}</dt><dd>${hours(s.eveFree)} h</dd></div>
            <div><dt>${t("stat.weekend")}</dt><dd>${s.weekendClosed ? t("stat.closed") : hours(s.weekendFree) + " h"}</dd></div>
          </dl>
        </a>`;
      }).join("")}
    </section>`;
}

// Hall calendar: day / week / month view of the weekly plan projected onto real dates.
// URL: #/halle/<key>?ansicht=tag|woche|monat&datum=YYYY-MM-DD; the season follows the date.
function renderHall(key, params) {
  const h = halls.find(x => x.key === key);
  if (!h) return renderNotFound();
  const view = VIEWS.includes(params.get("ansicht")) ? params.get("ansicht") : defaultView();
  const date = P.parseDate(params.get("datum"));
  const href = (v, d) => `#/halle/${key}?ansicht=${v}&datum=${P.isoDate(d)}`;
  const s = hallStats(key, currentSeason(date));

  let body;
  // Bookings that really take place on a date (validity, school holidays).
  const on = d => P.bookingsOn(bookings, calendar, d, [h]);
  const validUntil = P.planValidUntil(bookings);
  const isOpen = d => validUntil && P.isoDate(d) > validUntil;
  if (view === "monat") {
    body = `${monthGrid(date, d => {
      const { list, holiday } = on(d);
      return { ...P.dayStats(list, h, P.weekdayOf(d), currentSeason(d)), holiday, open: isOpen(d) };
    }, href)}
      <p class="muted small">${t("cal.monthHint")}</p>`;
  } else {
    const cols = viewColumns(view, date, href, d => P.holidayOn(calendar, P.isoDate(d)));
    const items = cols.flatMap(c => {
      const day = P.weekdayOf(c.date), season = currentSeason(c.date);
      const { list } = on(c.date);
      return [
        ...P.dayBookings(list, key, day, season).map(b => ({
          col: c.key, start: b.start, end: b.end, ...unitSpan(h, b.units), cls: CATEGORY_CLASS[b.category] || "other",
          // Club names are only in the public data when the club/admin chose to show them.
          label: b.holder || b.note || shortCat(b.category), sub: b.spaceName || (b.holder ? shortCat(b.category) : ""),
          title: `${dayName(day)} ${b.from}–${b.to}: ${catName(b.category)}${b.holder ? " · " + b.holder : ""}${b.spaceName ? " · " + b.spaceName : ""}${b.note ? " (" + b.note + ")" : ""}`,
        })),
        ...freeBlocks(list, h, day, season).map(w => ({
          col: c.key, start: w.start, end: w.end, u0: w.u0, span: w.span, cls: "free", tag: "button", label: t("free"),
          title: t("free.request", { day: dayName(day), from: toTime(w.start), to: toTime(w.end) }),
          attrs: `data-req="${esc(JSON.stringify({ hallKey: h.key, day, date: c.key, from: toTime(w.start), to: toTime(w.end), units: w.units }))}"`,
        })),
      ];
    });
    body = `<p class="muted small">${t("hall.clickFree")}${view === "woche" ? `<span class="swipe">${t("hall.swipe")}</span>` : ""}</p>
      ${planGrid(h, items, cols)}`;
  }

  view_.innerHTML = `
    <h1>${esc(h.name)} <small class="muted">${esc(h.size || "")}</small></h1>
    <p class="muted">${t("hall.summary", { pct: Math.round(s.pct * 100), booked: hours(s.booked), free: hours(s.free) })}${s.nv ? t("hall.closedHours", { h: hours(s.nv) }) : ""}</p>
    <p class="small">${t(h.holidays === "open" ? "hall.holidaysOpen" : "hall.holidaysClosed")}</p>
    ${P.hallUnits(h).length > 1 ? `<p class="small divisible">${t("hall.divisible", { units: P.hallUnits(h).map(u => esc(u.name)).join(", "), spaces: P.hallSpaces(h).map(sp => esc(sp.name)).join(", ") })}</p>` : ""}
    ${calendarToolbar(view, date, href)}
    ${planNotices(view, date, validUntil, h)}
    ${body}
    ${view === "monat" ? "" : legend()}
    ${hallClubs(h)}`;
  stickyOffsets();
}

/* ---------- clubs: who trains where, and how to reach them ---------- */

// Club data comes from the clubs' own websites (sources and date in each entry), not from the
// Gemeinde's plan – both are shown side by side, the official plan stays authoritative.
const byDayTime = (a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || String(a.from).localeCompare(String(b.from));
const sessionTime = x => `${dayName(x.day)} ${esc(x.from || "")}${x.to ? "–" + esc(x.to) : ""}`;
const fmtDate = iso => (iso ? new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(P.parseDate(iso)) : "");
const extLink = (href, label) => `<a href="${esc(href)}" target="_blank" rel="noopener" class="ext">${label}</a>`;

// Place of a session: the hall calendar on the next matching day, or the place as the club names it.
function placeLink(x) {
  const h = halls.find(y => y.key === x.hallKey);
  if (!h) return esc(x.place || "");
  return `<a href="#/halle/${h.key}?ansicht=tag&datum=${P.isoDate(P.nextDateFor(x.day, currentSeason()))}">${esc(h.name)}</a>`;
}

function hallClubs(h) {
  const rows = clubs.flatMap(c => (c.sessions || []).filter(x => x.hallKey === h.key).map(x => ({ c, x })))
    .sort((a, b) => byDayTime(a.x, b.x));
  if (!rows.length) return "";
  return `<section class="hall-clubs">
    <h2>${t("clubs.inHall")}</h2>
    <p class="muted small">${t("clubs.fromSites")}</p>
    <ul class="sessions">${rows.map(({ c, x }) => `<li><span class="when">${sessionTime(x)}</span>
      <a href="#/vereine?verein=${encodeURIComponent(c.key)}">${esc(c.name)}</a>${x.group ? ` · ${esc(x.group)}` : ""}${x.season ? ` <span class="muted small">(${esc(x.season)})</span>` : ""}</li>`).join("")}</ul>
  </section>`;
}

// #/vereine?halle=<key|->&tag=<Wochentag>&sport=<Sportart>&verein=<key>
function renderClubs(params) {
  const hallFilter = params.get("halle") || "", dayFilter = params.get("tag") || "", sportFilter = params.get("sport") || "";
  const sports = [...new Set(clubs.map(c => c.sport).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
  const filtering = Boolean(hallFilter || dayFilter);
  const matches = x => (!hallFilter || (hallFilter === "-" ? !x.hallKey : x.hallKey === hallFilter)) && (!dayFilter || x.day === dayFilter);
  const list = clubs.filter(c => (!sportFilter || c.sport === sportFilter) && (!filtering || (c.sessions || []).some(matches)));
  const checked = clubs.map(c => c.checkedAt).filter(Boolean).sort().pop();
  const opt = (value, label, current) => `<option value="${esc(value)}"${value === current ? " selected" : ""}>${esc(label)}</option>`;

  view.innerHTML = `
    <h1>${t("clubs.title")}</h1>
    <p>${t("clubs.intro")}</p>
    ${clubs.length ? `<p class="muted small">${t("clubs.disclaimer", { date: fmtDate(checked) })}</p>
    <form class="filters" id="club-filter">
      <label>${t("finder.hall")}
        <select name="halle">${opt("", t("finder.all"), hallFilter)}${halls.map(h => opt(h.key, h.name, hallFilter)).join("")}${opt("-", t("clubs.otherPlaces"), hallFilter)}</select>
      </label>
      <label>${t("col.day")}
        <select name="tag">${opt("", t("finder.all"), dayFilter)}${DAYS.map(d => opt(d, dayName(d), dayFilter)).join("")}</select>
      </label>
      <label>${t("clubs.sport")}
        <select name="sport">${opt("", t("finder.all"), sportFilter)}${sports.map(x => opt(x, x, sportFilter)).join("")}</select>
      </label>
    </form>
    <p class="muted">${t("clubs.count", { n: list.length })}</p>
    <div class="clubs">${list.map(c => clubCard(c, filtering ? matches : null)).join("") || `<p class="muted">${t("clubs.none")}</p>`}</div>`
    : `<p class="muted">${t("clubs.empty")}</p>`}`;

  document.getElementById("club-filter")?.addEventListener("change", e => {
    const q = new URLSearchParams([...new FormData(e.currentTarget)].filter(([, v]) => v));
    location.hash = `#/vereine${[...q].length ? "?" + q : ""}`;
  });
  const focus = params.get("verein") && document.getElementById(`club-${params.get("verein")}`);
  if (focus) requestAnimationFrame(() => { focus.classList.add("focus"); focus.scrollIntoView({ block: "start" }); });
}

function clubCard(c, matches) {
  const sessions = (c.sessions || []).slice().sort(byDayTime);
  const contact = [
    c.website && extLink(c.website, t("clubs.website")),
    c.contactUrl && c.contactUrl !== c.website && extLink(c.contactUrl, t("clubs.contact")),
    c.contactEmail && `<a href="mailto:${esc(c.contactEmail)}">${esc(c.contactEmail)}</a>`,
    c.gemeindeUrl && extLink(c.gemeindeUrl, t("clubs.gemeinde")),
  ].filter(Boolean);
  const hosts = [...new Set((c.sources || []).map(u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } }).filter(Boolean))];
  return `<article class="club" id="club-${esc(c.key)}">
    <h2>${esc(c.name)}</h2>
    ${c.sport ? `<p class="sport">${esc(c.sport)}</p>` : ""}
    ${c.summary ? `<p>${esc(c.summary)}</p>` : ""}
    ${sessions.length ? `<table class="results compact">
      <thead><tr><th>${t("col.time")}</th><th>${t("clubs.group")}</th><th>${t("clubs.place")}</th></tr></thead>
      <tbody>${sessions.map(x => `<tr${matches && matches(x) ? ` class="hit"` : ""}>
        <td data-label="${esc(t("col.time"))}">${sessionTime(x)}</td>
        <td data-label="${esc(t("clubs.group"))}">${esc(x.group || "")}${x.season ? ` <span class="muted small">(${esc(x.season)})</span>` : ""}${x.note ? `<br><span class="muted small">${esc(x.note)}</span>` : ""}</td>
        <td data-label="${esc(t("clubs.place"))}">${placeLink(x)}</td>
      </tr>`).join("")}</tbody>
    </table>` : `<p class="muted small">${t("clubs.noTimes")}</p>`}
    <p class="contact"><strong>${t("clubs.reach")}</strong> ${contact.join(" · ") || "–"}</p>
    ${hosts.length ? `<p class="muted small">${t("clubs.source")} ${hosts.map(esc).join(", ")}${c.checkedAt ? ` · ${fmtDate(c.checkedAt)}` : ""}</p>` : ""}
  </article>`;
}


// Hints above the calendar: holidays in the shown period, dates beyond the current plan.
function planNotices(view, date, validUntil, hall) {
  const days = view === "tag" ? [date] : view === "woche" ? [0, 1, 2, 3, 4, 5, 6].map(i => P.addDays(P.mondayOf(date), i))
    : Array.from({ length: 31 }, (_, i) => P.addDays(new Date(date.getFullYear(), date.getMonth(), 1), i)).filter(d => d.getMonth() === date.getMonth());
  const hols = [...new Map(days.map(d => P.holidayOn(calendar, P.isoDate(d))).filter(Boolean).map(x => [x.key, x])).values()];
  const fmt = iso => new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(P.parseDate(iso));
  const out = hols.map(x => `<p class="notice small">${t(P.closedOn(hall, x) ? "cal.holidayClosed" : x.kind === "ferien" ? "cal.holiday" : "cal.schoolFree", { name: esc(x.name), from: fmt(x.from), to: fmt(x.to || x.from) })}</p>`);
  if (validUntil && days.some(d => P.isoDate(d) > validUntil)) out.push(`<p class="notice warn small">${t("cal.planOpen", { date: fmt(validUntil) })}</p>`);
  return out.join("");
}

// Sticky calendar headers sit right below the sticky toolbar; its height depends on the layout.
function stickyOffsets() {
  const bar = view_.querySelector(".caltools");
  if (bar) view_.style.setProperty("--calbar", `${bar.offsetHeight}px`);
}
addEventListener("resize", stickyOffsets);

function renderFinder(params) {
  const p = Object.fromEntries(params);
  const days = p.tage ? p.tage.split(",") : DAYS.slice();
  const from = p.ab || "17:00", minLen = Number(p.min || 60), season = p.saison || currentSeason();
  const hallFilter = p.halle || "";
  const results = P.findFreeSlots(halls, bookings, { days, from, minLen, hallKey: hallFilter, season });

  view.innerHTML = `
    <h1>${t("finder.title")}</h1>
    <form class="filters" id="finder">
      <fieldset><legend>${t("finder.days")}</legend>
        ${DAYS.map((d, i) => `<label class="chip"><input type="checkbox" name="tag" value="${d}" ${days.includes(d) ? "checked" : ""}>${dayShort(i)}</label>`).join("")}
      </fieldset>
      <label>${t("finder.from")} <input type="time" name="ab" value="${esc(from)}" step="1800" min="07:00" max="22:00"></label>
      <label>${t("finder.min")}
        <select name="min">${[30, 60, 90, 120, 180].map(m => `<option value="${m}" ${m === minLen ? "selected" : ""}>${hours(m)} h</option>`).join("")}</select>
      </label>
      <label>${t("finder.hall")}
        <select name="halle"><option value="">${t("finder.all")}</option>${halls.map(h => `<option value="${h.key}" ${h.key === hallFilter ? "selected" : ""}>${esc(h.name)}</option>`).join("")}</select>
      </label>
      <label>${t("hall.season")}
        <select name="saison"><option value="summer" ${season === "summer" ? "selected" : ""}>${t("season.summer")}</option><option value="winter" ${season === "winter" ? "selected" : ""}>${t("season.winter")}</option></select>
      </label>
    </form>
    <p class="muted">${t("finder.count", { n: results.length })}</p>
    <table class="results">
      <thead><tr><th>${t("col.day")}</th><th>${t("col.time")}</th><th>${t("col.duration")}</th><th>${t("col.hall")}</th><th></th></tr></thead>
      <tbody>${results.map(r => `<tr>
        <td data-label="Tag">${dayName(r.day)}</td><td data-label="Zeit">${toTime(r.start)}–${toTime(r.end)}</td><td data-label="Dauer">${hours(r.end - r.start)} h</td>
        <td data-label="Halle"><a href="#/halle/${r.hall.key}?ansicht=tag&datum=${P.isoDate(P.nextDateFor(r.day, season))}">${esc(r.hall.name)}</a>${r.whole ? "" : ` · ${esc(r.space.name)}`} <span class="muted small">${esc(r.hall.size || "")}</span></td>
        <td class="act"><button class="small" data-req="${esc(JSON.stringify({ hallKey: r.hall.key, day: r.day, from: toTime(r.start), to: toTime(r.end), units: r.space.units, min: minLen }))}">${t("btn.request")}</button></td>
      </tr>`).join("") || `<tr><td colspan="5" class="muted">${t("finder.none")}</td></tr>`}</tbody>
    </table>`;

  document.getElementById("finder").addEventListener("change", e => {
    const f = new FormData(e.currentTarget);
    const q = new URLSearchParams({ tage: f.getAll("tag").join(","), ab: f.get("ab"), min: f.get("min"), halle: f.get("halle"), saison: f.get("saison") });
    location.hash = `#/frei?${q}`;
  });
}

function renderTips() {
  const link = `<a href="https://www.swissolympic.ch/verbaende/foerderung-unterstuetzung/F-rderung-Breitensport/Sporthallen-effizient-nutzen" target="_blank" rel="noopener">${t("tips.link")}</a>`;
  view.innerHTML = `
    <h1>${t("tips.title")}</h1>
    <p>${t("tips.source", { link })}</p>
    <div class="tips">${[1, 2, 3, 4, 5].map(i => `<article><h2>${t(`tip${i}.t`)}</h2><p>${t(`tip${i}.d`)}</p></article>`).join("")}</div>`;
}

function renderNotFound() { view.innerHTML = `<h1>${t("notfound")}</h1><p><a href="#/">${t("notfound.back")}</a></p>`; }

/* ---------- request dialog ---------- */

const dialog = document.getElementById("request");
let pending = null;
document.addEventListener("click", e => {
  const btn = e.target.closest("[data-req]");
  if (!btn) return;
  pending = JSON.parse(btn.dataset.req);
  const hall = halls.find(h => h.key === pending.hallKey);
  pending.hall = hall.name;
  const when = pending.date ? new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(P.parseDate(pending.date)) : dayName(pending.day);
  document.getElementById("req-slot").textContent = t("req.slot", { hall: pending.hall, day: when, from: pending.from, to: pending.to });
  // Subdivided halls: offer the bookable spaces that fit into the free units, largest first.
  const spaces = P.hallSpaces(hall).filter(s => s.units.every(u => pending.units.includes(u))).sort((a, b) => b.units.length - a.units.length);
  const spaceSel = form.elements.space;
  spaceSel.innerHTML = spaces.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join("");
  spaceSel.closest("label").hidden = P.hallSpaces(hall).length < 2;
  // Start anywhere in the free window, leaving room for at least one half hour.
  const from = form.elements.from;
  from.min = pending.from;
  from.max = toTime(toMin(pending.to) - P.STEP);
  from.value = pending.from;
  // Default length: the search's minimum, or a 90-minute training from the calendar.
  durationOptions(pending.min || 90);
  status.textContent = "";
  dialog.showModal();
});
const form = document.getElementById("request-form");
const status = document.getElementById("req-status");
// Durations in half-hour steps that fit between the chosen start and the end of the free window.
function durationOptions(preferred) {
  const sel = form.elements.duration;
  const start = /^\d\d:\d\d$/.test(form.elements.from.value) ? toMin(form.elements.from.value) : NaN;
  const max = toMin(pending.to) - start;
  const opts = [];
  for (let m = P.STEP; m <= max; m += P.STEP) opts.push(m);
  const pick = opts.includes(preferred) ? preferred : opts.filter(m => m <= preferred).pop() || opts[0];
  sel.innerHTML = opts.map(m => `<option value="${m}" ${m === pick ? "selected" : ""}>${hours(m)} h (${toTime(start)}–${toTime(start + m)})</option>`).join("");
}
form.elements.from.addEventListener("change", () => durationOptions(Number(form.elements.duration.value) || pending.min || 90));
form.addEventListener("submit", async e => {
  if (e.submitter?.value !== "send") return;  // "Abbrechen" closes the dialog normally
  e.preventDefault();
  const f = new FormData(form);
  const minutes = Number(f.get("duration"));
  if (!minutes) { status.textContent = t("req.noTime"); return; }
  const payload = {
    hall: pending.hall, space: f.get("space") || undefined, day: pending.day, date: pending.date, from: f.get("from"), to: toTime(toMin(f.get("from")) + minutes),
    club: f.get("club"), contact: f.get("contact"), email: f.get("email"),
    team: f.get("team"), kind: f.get("kind"), people: Number(f.get("people")) || null,
    share: f.get("share") === "on", show_name: f.get("show_name") === "on", note: f.get("note"), website: f.get("website"),
    lang,
  };
  const send = document.getElementById("req-send");
  send.disabled = true;
  status.textContent = t("req.sending");
  try {
    const r = await fetch(`${CFG.apiBase}/requests`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.error || `${r.status}`);
    status.textContent = "";
    dialog.close();
    form.reset();
    toast(t("req.thanks", { hall: payload.hall, day: dayName(payload.day), from: payload.from, to: payload.to }));
  } catch (err) {
    status.textContent = t("req.failed", { msg: err.message });
  } finally {
    send.disabled = false;
  }
});

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 6000);
}

/* ---------- navigation (mirrors the menu of muri-guemligen.ch) ---------- */

const MURI = "https://www.muri-guemligen.ch";
// [label, link]; a link starting with "#/" is a page of this app, an array is a submenu.
function menuTree() {
  const app = [
    [t("side.overview"), "#/"],
    ...halls.map(h => [h.name.replace(/^Sporthalle /, ""), `#/halle/${h.key}`]),
    [t("side.free"), "#/frei"],
    [t("side.clubs"), "#/vereine"],
    [t("side.tips"), "#/tipps"],
  ];
  const sport = [
    [t("m.pool"), "/freizeit/sport/hallenbad-melchenbuehl.html/200"],
    [t("m.tennis"), "/freizeit/sport/oeffentlicher-tennisplatz.html/201"],
    [t("m.shooting"), "/freizeit/sport/schuetzenhaus.html/202"],
    [t("m.halls"), app],
    [t("m.fuellerich"), "/freizeit/sport/sportzentrum-fuellerich.html/204"],
    [t("m.reservation"), "/freizeit/sport/reservationsanfrage.html/285"],
  ];
  const freizeit = [
    [t("m.aarebad"), "/freizeit/aarebad.html/192"],
    [t("m.ferry"), "/freizeit/faehre.html/122"],
    [t("m.culture"), "/freizeit/kultur.html/291"],
    [t("m.sport"), sport],
    [t("m.events"), "/freizeit/veranstaltungen.html/13"],
    [t("m.venues"), "/freizeit/veranstaltungslokalitaeten.html/206"],
    [t("m.clubs"), "/freizeit/vereine.html/59"],
  ];
  return { freizeit, main: [
    [t("m.news"), "/aktuelles-portraet/aktuelles.html/18"],
    [t("m.politics"), "/politik-verwaltung/politik.html/24"],
    [t("m.living"), "/wohnen-arbeiten/abfallentsorgung.html/112"],
    [t("m.education"), "/bildung-soziales/kinderbetreuung.html/172"],
    [t("m.leisure"), freizeit],
  ] };
}

function menuList(items, depth = 0) {
  return `<ul class="lvl${depth}">${items.map(([label, link]) => {
    if (Array.isArray(link)) {
      // The branch that contains this app is always expanded.
      return `<li class="open"><span class="branch">${esc(label)}</span>${menuList(link, depth + 1)}</li>`;
    }
    const internal = link.startsWith("#/");
    const href = internal ? link : MURI + link;
    return `<li><a href="${href}"${internal ? ` data-route="${link.slice(2)}"` : ` class="ext"`}>${esc(label)}</a></li>`;
  }).join("")}</ul>`;
}

function renderNav() {
  const { main, freizeit } = menuTree();
  document.getElementById("sidenav-tree").innerHTML = menuList(freizeit);
  document.getElementById("drawer").innerHTML = menuList(main);
}

const burger = document.getElementById("burger");
function setMenu(open) {
  document.body.classList.toggle("menu-open", open);
  burger.setAttribute("aria-expanded", String(open));
  burger.querySelector(".label").textContent = open ? t("menu.close") : t("menu");
}
burger.addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open")));
addEventListener("keydown", e => { if (e.key === "Escape") setMenu(false); });

function route() {
  const [path, query] = location.hash.slice(1).split("?");
  const parts = (path || "/").split("/").filter(Boolean);
  const top = !parts[0] || parts[0] === "halle" ? "home" : parts[0];
  const current = parts[0] === "halle" ? `halle/${parts[1]}` : (parts[0] || "");
  document.querySelectorAll("[data-nav]").forEach(a => a.setAttribute("aria-current", String(a.dataset.nav === top)));
  document.querySelectorAll("[data-route]").forEach(a => a.toggleAttribute("aria-current", a.dataset.route === current));
  document.querySelectorAll(".langs a").forEach(a => { a.href = `?lang=${a.hreflang}${location.hash}`; });
  setMenu(false);
  if (!parts.length) renderHome();
  else if (parts[0] === "halle") renderHall(parts[1], new URLSearchParams(query));
  else if (parts[0] === "frei") renderFinder(new URLSearchParams(query));
  else if (parts[0] === "vereine") renderClubs(new URLSearchParams(query));
  else if (parts[0] === "tipps") renderTips();
  else renderNotFound();
  window.scrollTo(0, 0);
}

// Static texts and the language switch first, so the shell is translated before the data arrives.
applyStatic();
document.getElementById("lang-slot").innerHTML = langSwitcher();
const footLink = l => `<a href="https://www.swissolympic.ch/verbaende/foerderung-unterstuetzung/F-rderung-Breitensport/Sporthallen-effizient-nutzen" target="_blank" rel="noopener">${t(l)}</a>`;
document.getElementById("footer-p1").innerHTML = t("footer.p1", { link: footLink("footer.link1") });

load().then(() => { renderNav(); addEventListener("hashchange", route); route(); })
  .catch(err => { view.innerHTML = `<h1>${t("nodata")}</h1><p class="muted">${esc(err.message)}</p>`; });
