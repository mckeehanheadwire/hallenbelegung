// Admin page — plain JS. Every action calls the same tools the admin MCP server offers to LLMs.
import { DAYS, CATEGORIES, WHOLE, prepare, dayBookings, seasonKind, currentSeason, toMin, toTime, hallUnits, hallSpaces, findSpace, wholeSpace, validateFacility, slug, parseDate, isoDate, weekdayOf, dayStats, bookingsOn, holidayOn } from "./plan.js";
import { planGrid, legend, esc, CATEGORY_CLASS, shortCat, unitSpan, freeBlocks, VIEWS, defaultView, viewColumns, calendarToolbar, monthGrid } from "./planview.js";

const $ = sel => document.querySelector(sel);
const content = $("#content");
let me = null, challenge = null, halls = [];

async function api(path, body) {
  const r = await fetch(`/admin/api${path}`, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "/login/verify") { showLogin(); throw new Error("Bitte neu anmelden."); }
  if (!r.ok) throw new Error(data.error || `Fehler ${r.status}`);
  return data;
}
const tool = (name, args = {}) => api(`/tools/${name}`, args);

function toast(msg, error = false) {
  const el = document.createElement("div");
  el.className = "toast" + (error ? " toast-error" : "");
  el.setAttribute("role", "status");
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 5000);
}
async function run(fn) {
  try { await fn(); } catch (e) { toast(e.message, true); }
}

/* ---------- login ---------- */

function showLogin() {
  me = null;
  $("#login").hidden = false; content.hidden = true;
  $("#admin-nav").hidden = true; $("#who").hidden = true;
}
$("#login-start").addEventListener("submit", e => {
  e.preventDefault();
  run(async () => {
    $("#login-error").textContent = "";
    const r = await api("/login/start", { email: new FormData(e.target).get("email") }).catch(err => { $("#login-error").textContent = err.message; throw err; });
    challenge = r.challenge;
    $("#login-verify").hidden = false;
    const code = $("#login-verify [name=code]");
    $("#login-start").hidden = true;
    $("#code-notice").innerHTML = r.delivery === "screen" ? `
      <div class="notice">
        <p>In der fertigen Version erhalten Sie jetzt eine E-Mail mit einem Anmeldecode an <strong>${esc(r.email)}</strong>.</p>
      </div>
      <div class="notice warn">
        <p><strong>Prototyp – keine Produktivversion.</strong> Diese Testversion verschickt keine E-Mails, und das Backend
        ist noch nicht gehärtet. Ihr Code (10 Minuten gültig):</p>
        <p class="code">${esc(r.code)}</p>
      </div>`
      : `<p class="notice">Wir haben einen Anmeldecode an <strong>${esc(r.email)}</strong> gesendet. Er ist 10 Minuten gültig.</p>`;
    if (r.delivery === "screen") code.value = r.code;
    code.focus();
  });
});
$("#login-verify").addEventListener("submit", e => {
  e.preventDefault();
  run(async () => {
    await api("/login/verify", { challenge, code: new FormData(e.target).get("code") }).catch(err => { $("#login-error").textContent = err.message; throw err; });
    $("#login-verify").hidden = true; $("#login-verify").reset(); $("#login-start").hidden = false;
    await start();
  });
});
// After logging out, go to the public overview.
$("#logout").addEventListener("click", () => run(async () => { await api("/logout", {}); location.assign("/#/"); }));

/* ---------- tabs ---------- */

const TABS = { anfragen: renderRequests, entwuerfe: renderDrafts, belegungen: renderBookings, anlagen: renderFacilities, ki: renderAi };
function currentTab() { const t = location.hash.slice(1); return TABS[t] ? t : "anfragen"; }
async function show() {
  if (!me) return;
  const t = currentTab();
  document.querySelectorAll("[data-tab]").forEach(a => a.setAttribute("aria-current", String(a.dataset.tab === t)));
  content.innerHTML = `<p class="muted">Lade …</p>`;
  await run(TABS[t]);
  refreshDraftCount();
}
addEventListener("hashchange", show);

async function refreshDraftCount() {
  const r = await tool("list_pending_changes").catch(() => null);
  $("#draft-count").textContent = r && r.total ? r.total : "";
}

/* ---------- requests ---------- */

async function renderRequests() {
  const status = new URLSearchParams(location.search).get("status") ?? "neu";
  const r = await tool("list_requests", status ? { status } : {});
  content.innerHTML = `
    <h1>Anfragen</h1>
    <div class="seg" role="group" aria-label="Status">
      ${[["neu", "Offen"], ["genehmigt", "Genehmigt"], ["abgelehnt", "Abgelehnt"], ["", "Alle"]].map(([v, l]) =>
        `<a href="?status=${v}#anfragen" aria-current="${v === status}">${l}</a>`).join("")}
    </div>
    ${r.requests.length ? "" : `<p class="muted">Keine Anfragen.</p>`}
    <div class="req-list">${r.requests.map(q => `
      <article class="req" data-id="${esc(q.id)}">
        <header>
          <h2>${esc(q.club)} <span class="status s-${esc(q.status)}">${esc(q.status)}</span></h2>
          <p><strong>${esc(q.hall)}</strong> · ${esc(q.day)} ${esc(q.from)}–${esc(q.to)}</p>
        </header>
        <dl class="meta">
          <div><dt>Kontakt</dt><dd>${esc(q.contact)} · <a href="mailto:${esc(q.email)}">${esc(q.email)}</a></dd></div>
          <div><dt>Team</dt><dd>${esc(q.team || "–")} · ${q.people ? esc(q.people) + " Pers." : "–"} · ${esc(q.kind || "")}</dd></div>
          <div><dt>Co-Training</dt><dd>${q.share ? "ja" : "nein"}</dd></div>
          <div><dt>Name öffentlich</dt><dd>${q.showName ? "ja, vom Verein freigegeben" : "nein (Verein hat nicht zugestimmt)"}</dd></div>
          ${q.note ? `<div><dt>Bemerkung</dt><dd>${esc(q.note)}</dd></div>` : ""}
          ${q.date ? `<div><dt>Gewünscht ab</dt><dd>${new Date(q.date + "T00:00").toLocaleDateString("de-CH", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</dd></div>` : ""}
          <div><dt>Eingang</dt><dd>${new Date(q.submittedAt).toLocaleString("de-CH")} via ${esc(q.via || "web")} · Sprache ${esc((q.lang || "de").toUpperCase())}</dd></div>
          ${q.decisionNote ? `<div><dt>Entscheid</dt><dd>${esc(q.decisionNote)} (${esc(q.decidedBy || "")})</dd></div>` : ""}
          ${q.bookingKey ? `<div><dt>Belegung</dt><dd><code>${esc(q.bookingKey)}</code></dd></div>` : ""}
        </dl>
        ${q.status === "neu" ? `
        <form class="decide">
          <div class="row">
            <label>Kategorie <select name="category">${CATEGORIES.map(c => `<option ${c === "Verein/Stiftung" ? "selected" : ""}>${c}</option>`).join("")}</select></label>
            <label>Saison <select name="season"><option value="ganzjährig">ganzjährig</option><option value="summer">Sommer</option><option value="winter">Winter</option></select></label>
            <label>Von <input type="time" name="from" step="1800" value="${esc(q.from)}"></label>
            <label>Bis <input type="time" name="to" step="1800" value="${esc(q.to)}"></label>
          </div>
          <label>Notiz / Begründung <input name="note" maxlength="500"></label>
          <label class="check"><input type="checkbox" name="show_holder" ${q.showName ? "checked" : "data-noconsent"}> Vereinsname im öffentlichen Plan anzeigen${q.showName ? "" : ` <span class="muted small">(nicht freigegeben)</span>`}</label>
          <label class="check"><input type="checkbox" name="force"> Trotz Überschneidung speichern</label>
          <div class="actions">
            <button value="reject" class="ghost">Ablehnen</button>
            <button value="approve">Genehmigen (Entwurf)</button>
          </div>
        </form>` : ""}
      </article>`).join("")}
    </div>`;
  content.querySelectorAll("form.decide").forEach(f => f.addEventListener("submit", e => {
    e.preventDefault();
    const id = f.closest(".req").dataset.id, d = new FormData(f);
    run(async () => {
      if (e.submitter.value === "reject") {
        if (!d.get("note")) throw new Error("Bitte eine Begründung angeben.");
        await tool("reject_request", { id, reason: d.get("note") });
        toast("Anfrage abgelehnt.");
      } else {
        // Publishing a name the club did not release needs a second, deliberate click.
        const box = f.querySelector("[name=show_holder]");
        if (box.checked && box.hasAttribute("data-noconsent") && !f.dataset.confirmed) {
          f.dataset.confirmed = "1";
          throw new Error("Der Verein hat der Anzeige seines Namens nicht zugestimmt. Nochmals «Genehmigen» klicken, um ihn trotzdem zu zeigen.");
        }
        const r = await tool("approve_request", { id, category: d.get("category"), season: d.get("season"), from: d.get("from"), to: d.get("to"), note: d.get("note"), show_holder: d.get("show_holder") === "on", force: d.get("force") === "on" });
        toast(`Genehmigt – Entwurf ${r.booking.key} erstellt. Unter «Entwürfe» veröffentlichen.`);
      }
      await show();
    });
  }));
}

/* ---------- drafts / publish ---------- */

async function renderDrafts() {
  const [r, c] = await Promise.all([tool("list_pending_changes"), tool("find_conflicts")]);
  content.innerHTML = `
    <h1>Entwürfe</h1>
    <p>Änderungen von Admins und vom KI-Assistenten sind erst nach dem Veröffentlichen öffentlich sichtbar.
       Veröffentlicht wird der ganze Plan in einem Schritt.</p>
    ${c.total ? `<p class="notice warn">${c.total} Überschneidung(en) im Plan: ${c.conflicts.slice(0, 5).map(x => `${esc(x.a.key)} ↔ ${esc(x.b.key)}`).join(", ")}${c.total > 5 ? " …" : ""}</p>` : ""}
    ${r.total ? `
      <table class="results">
        <thead><tr><th>Art</th><th>Belegung</th><th>Änderung</th><th>Von</th></tr></thead>
        <tbody>${r.changes.map(x => { const item = x[x.kind]; const fmtV = v => typeof v === "object" && v ? JSON.stringify(v) : v ?? "–"; return `<tr>
          <td data-label="Art"><span class="status s-${esc(x.type)}">${esc(x.type)}</span></td>
          <td data-label="Belegung">${x.kind === "club"
            ? `<strong>Verein</strong> ${esc(item.name)}<br><span class="muted small">${esc(item.sport || "")} · ${(item.sessions || []).length} Trainingszeit(en) · Quelle: Vereinswebsite</span>`
            : x.kind === "calendar"
            ? `<strong>Kalender</strong> ${esc(item.name)}<br><span class="muted small">${esc(item.from)} – ${esc(item.to || item.from)} · ${item.effect === "closed" ? "Hallen geschlossen" : "Schulbelegung entfällt"}</span>`
            : x.kind === "facility"
            ? `<strong>Anlage</strong> ${esc(item.name)}<br><span class="muted small">${esc(item.size || "")}${item.units.length ? " · Teile " + esc(item.units.map(u => u.key).join("+")) : ""}</span>`
            : `${esc(item.hall)}${item.spaceName ? " · " + esc(item.spaceName) : ""} · ${esc(item.day)} ${esc(item.from)}–${esc(item.to)}<br><span class="muted small">${esc(item.category)}${item.holder ? " · " + esc(item.holder) : ""}</span>`}</td>
          <td data-label="Änderung" class="small">${x.before ? x.changedFields.map(f => `${esc(f)}: ${esc(fmtV(x.before[f]))} → ${esc(fmtV(item[f]))}`).join("<br>") : "neu"}</td>
          <td data-label="Von" class="small">${esc(x.changedBy || "")}<br>${x.changedAt ? new Date(x.changedAt).toLocaleString("de-CH") : ""}</td>
        </tr>`; }).join("")}</tbody>
      </table>
      <p><button id="publish">${r.total} Änderung(en) veröffentlichen</button></p>`
    : `<p class="muted">Keine unveröffentlichten Änderungen.</p>`}`;
  $("#publish")?.addEventListener("click", e => run(async () => {
    e.target.disabled = true;
    const p = await api("/publish", {});
    toast(`Veröffentlicht (${p.promoted} Belegungen). Die öffentliche Seite zeigt den neuen Stand in ca. einer Minute.`);
    await show();
  }));
}

/* ---------- bookings ---------- */

// Admin calendar: same day / week / month views as the public plan, but on the draft state,
// with drafts and cancellations marked and every block clickable.
async function renderBookings() {
  if (!halls.length) halls = (await tool("list_halls")).halls;
  const q = new URLSearchParams(location.search);
  const hall = halls.find(h => h.key === q.get("halle")) || halls[0];
  const view = VIEWS.includes(q.get("ansicht")) ? q.get("ansicht") : defaultView();
  const date = parseDate(q.get("datum"));
  const href = (v, d, hk = hall.key) => `?halle=${hk}&ansicht=${v}&datum=${isoDate(d)}#belegungen`;
  const [r, pending, cal] = await Promise.all([tool("list_bookings", { hall: hall.key }), tool("list_pending_changes"), tool("list_holidays")]);
  const calendar = cal.entries;
  const drafts = new Map(pending.changes.map(c => [c.key, c.type]));
  const active = prepare(r.bookings, [hall]);
  const byKey = new Map(r.bookings.map(b => [b.key, b]));

  let body;
  if (view === "monat") {
    body = monthGrid(date, d => {
      const { list, holiday } = bookingsOn(active, calendar, d, [hall]);
      return { ...dayStats(list, hall, weekdayOf(d), currentSeason(d)), holiday, open: cal.planValidUntil && isoDate(d) > cal.planValidUntil };
    }, href);
  } else {
    const cols = viewColumns(view, date, href, d => holidayOn(calendar, isoDate(d)));
    const items = cols.flatMap(c => {
      const day = weekdayOf(c.date), season = currentSeason(c.date);
      const { list } = bookingsOn(active, calendar, c.date, [hall]);
      const inSeason = b => seasonKind(b.season) === "all" || seasonKind(b.season) === season;
      const cancelled = r.bookings.filter(b => b.status === "storniert" && b.day === day && inSeason(b))
        .map(b => ({ ...b, start: toMin(b.from), end: toMin(b.to), units: (findSpace(hall, b.space) || wholeSpace(hall)).units }));
      return [
        ...dayBookings(list, hall.key, day, season).map(b => ({
          col: c.key, start: b.start, end: b.end, ...unitSpan(hall, b.units), tag: b.key.startsWith("closed-") ? "div" : "button",
          cls: `${CATEGORY_CLASS[b.category] || "other"}${drafts.has(b.key) ? " draft" : ""}`,
          label: (drafts.has(b.key) ? "✎ " : "") + (b.holder ? (b.holderPublic ? "👁 " : "") + b.holder : shortCat(b.category)), sub: b.spaceName || (b.holder ? shortCat(b.category) : b.note || ""),
          title: `${day} ${b.from}–${b.to}: ${b.category}${b.holder ? " · " + b.holder : ""}${drafts.has(b.key) ? " (Entwurf)" : ""} – bearbeiten`,
          attrs: `data-edit="${esc(b.key)}"`,
        })),
        ...cancelled.map(b => ({
          col: c.key, start: b.start, end: b.end, ...unitSpan(hall, b.units), tag: "button", cls: `cancelled-blk${drafts.has(b.key) ? " draft" : ""}`,
          label: "storniert", sub: b.holder || shortCat(b.category),
          title: `${day} ${b.from}–${b.to}: storniert${drafts.has(b.key) ? " (Entwurf)" : ""}`, attrs: `data-edit="${esc(b.key)}"`,
        })),
        ...freeBlocks(list, hall, day, season).map(w => ({
          col: c.key, start: w.start, end: w.end, u0: w.u0, span: w.span, tag: "button", cls: "free", label: "+",
          title: `${day} ${toTime(w.start)}–${toTime(w.end)} frei – Belegung erfassen`,
          attrs: `data-new="${esc(JSON.stringify({ day, from: toTime(w.start), to: toTime(Math.min(w.start + 90, w.end)), max: toTime(w.end), units: w.units }))}"`,
        })),
      ];
    });
    body = planGrid(hall, items, cols);
  }

  content.innerHTML = `
    <h1>Belegungen</h1>
    <form class="filters" id="bk-filter">
      <label>Halle <select name="halle">${halls.map(h => `<option value="${h.key}" ${h.key === hall.key ? "selected" : ""}>${esc(h.name)}</option>`).join("")}</select></label>
    </form>
    ${calendarToolbar(view, date, href)}
    ${cal.planValidUntil ? `<p class="muted small">Belegungsplan gültig bis ${new Date(cal.planValidUntil + "T00:00").toLocaleDateString("de-CH")}. Schulferien: Schulbelegungen entfallen.</p>` : ""}
    <p class="muted small">${view === "monat" ? "Tag anklicken für die Tagesansicht." : "Belegung anklicken zum Bearbeiten, freies Feld anklicken für eine neue Belegung. Die Fixbelegung gilt wöchentlich; Änderungen betreffen alle Wochen der Saison."}
      ${drafts.size ? `<a href="#entwuerfe">${drafts.size} Entwurf/Entwürfe veröffentlichen →</a>` : ""}</p>
    ${hallUnits(hall).length > 1 ? `<p class="small">Teilbereiche: ${hallUnits(hall).map(u => `<strong>${esc(u.key)}</strong> ${esc(u.name)}`).join(" · ")}</p>` : ""}
    ${body}
    ${view === "monat" ? "" : legend([["draft", "Entwurf (noch nicht veröffentlicht)"], ["cancelled-blk", "storniert"]])}`;
  const bar = content.querySelector(".caltools");
  if (bar) content.style.setProperty("--calbar", `${bar.offsetHeight}px`);

  $("#bk-filter").addEventListener("change", e => {
    location.assign(href(view, date, new FormData(e.currentTarget).get("halle")));
  });
  content.querySelectorAll("[data-edit]").forEach(el => el.addEventListener("click", () => editBooking(byKey.get(el.dataset.edit), drafts.get(el.dataset.edit), null, hall)));
  content.querySelectorAll("[data-new]").forEach(el => el.addEventListener("click", () => editBooking(null, null, JSON.parse(el.dataset.new), hall)));
}

// One dialog for creating and editing bookings; every save is a draft version.
function editBooking(b, draftType, fresh, hall) {
  const isNew = !b;
  const spaces = hallSpaces(hall);
  // New bookings: default to the largest space that fits into the clicked free units.
  const fitting = isNew ? spaces.filter(sp => sp.units.every(u => fresh.units.includes(u))).sort((x, y) => y.units.length - x.units.length) : spaces;
  const curSpace = isNew ? fitting[0]?.key : (findSpace(hall, b.space) || wholeSpace(hall)).key;
  const v = b || { day: fresh.day, from: fresh.from, to: fresh.to, category: "Verein/Stiftung", holder: "", note: "", season: "ganzjährig" };
  const dlg = document.createElement("dialog");
  dlg.className = "bk-dialog";
  dlg.innerHTML = `
    <form method="dialog">
      <h2>${isNew ? "Neue Belegung" : "Belegung bearbeiten"}</h2>
      <p class="slot-summary">${esc(hall.name)}${isNew ? ` · frei bis ${esc(fresh.max)}` : ` · <code>${esc(b.key)}</code>`}
        ${draftType ? `<span class="status s-${esc(draftType)}">Entwurf: ${esc(draftType)}</span>` : ""}
        ${b?.status === "storniert" ? `<span class="status s-storniert">storniert</span>` : ""}</p>
      ${spaces.length > 1 ? `<label>Fläche <select name="space">${spaces.map(sp => `<option value="${esc(sp.key)}" ${sp.key === curSpace ? "selected" : ""}>${esc(sp.name)} (${sp.units.join("+")})</option>`).join("")}</select></label>` : ""}
      <div class="times">
        <label>Tag <select name="day">${DAYS.map(d => `<option ${d === v.day ? "selected" : ""}>${d}</option>`).join("")}</select></label>
        <label>Kategorie <select name="category">${CATEGORIES.map(c => `<option ${c === v.category ? "selected" : ""}>${c}</option>`).join("")}</select></label>
        <label>Von <input type="time" name="from" step="1800" value="${esc(v.from)}" required></label>
        <label>Bis <input type="time" name="to" step="1800" value="${esc(v.to)}" required></label>
      </div>
      ${isNew ? `<label>Saison <select name="season"><option value="ganzjährig">ganzjährig</option><option value="summer">nur Sommer</option><option value="winter">nur Winter</option></select></label>`
              : `<p class="muted small">Saison: ${esc(v.season)}</p>`}
      <label>Nutzer (Verein / Gruppe) <input name="holder" value="${esc(v.holder || "")}"></label>
      <label class="check"><input type="checkbox" name="show_holder" ${v.holderPublic ? "checked" : ""}> Name im öffentlichen Plan anzeigen</label>
      <label>Notiz <input name="note" value="${esc(v.note || "")}" maxlength="500"></label>
      <label class="check"><input type="checkbox" name="force"> Überschneidung erlauben</label>
      ${!isNew && b.status !== "storniert" ? `<details class="cancel-box"><summary>Stornieren …</summary>
        <label>Grund <input name="reason"></label>
        <button value="cancel" class="ghost">Belegung stornieren</button></details>` : ""}
      <p class="error small" role="alert"></p>
      <div class="actions">
        <button value="close" formnovalidate class="ghost">Abbrechen</button>
        <button value="save">${isNew ? "Als Entwurf speichern" : "Änderung speichern (Entwurf)"}</button>
      </div>
    </form>`;
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  const form = dlg.querySelector("form"), err = dlg.querySelector(".error");
  form.addEventListener("submit", e => {
    const action = e.submitter?.value;
    if (action === "close") return;
    e.preventDefault();
    const f = new FormData(form);
    run(async () => {
      try {
        if (action === "cancel") {
          if (!f.get("reason")) throw new Error("Bitte einen Grund angeben.");
          await tool("cancel_booking", { key: b.key, reason: f.get("reason") });
          toast("Storniert (Entwurf).");
        } else if (isNew) {
          const r = await tool("create_booking", { hall: hall.key, space: f.get("space") || undefined, day: f.get("day"), from: f.get("from"), to: f.get("to"), category: f.get("category"), holder: f.get("holder"), show_holder: f.get("show_holder") === "on", note: f.get("note"), season: f.get("season"), force: f.get("force") === "on" });
          toast(`Entwurf ${r.booking.key} gespeichert.`);
        } else {
          await tool("update_booking", { key: b.key, space: f.get("space") || undefined, day: f.get("day"), from: f.get("from"), to: f.get("to"), category: f.get("category"), holder: f.get("holder"), show_holder: f.get("show_holder") === "on", note: f.get("note"), force: f.get("force") === "on" });
          toast("Änderung als Entwurf gespeichert.");
        }
      } catch (e2) { err.textContent = e2.message; throw e2; }
      dlg.close();
      await show();
    });
  });
  dlg.showModal();
}

/* ---------- facilities ---------- */

async function renderFacilities() {
  halls = (await tool("list_halls")).halls;
  const edit = new URLSearchParams(location.search).get("anlage");
  const cur = edit === "neu" ? { name: "", size: "", type: "Sporthalle", address: "", units: [], spaces: [] } : halls.find(h => h.key === edit);
  content.innerHTML = `
    <h1>Anlagen</h1>
    <div class="cards">${halls.map(h => `
      <article class="card">
        <h2>${esc(h.name)}</h2>
        <p class="muted">${esc(h.type || "Sporthalle")}${h.size ? " · " + esc(h.size) : ""}</p>
        <p class="small">Schulferien: ${h.holidays === "open" ? "Vereine/Private dürfen nutzen" : "<strong>geschlossen</strong>"}</p>
        ${h.units.length ? `<p class="small">Teilbar: ${h.units.map(u => esc(u.key)).join(" | ")}<br>Buchbar: ${h.spaces.map(sp => esc(sp.name)).join(", ")}</p>` : `<p class="small muted">nicht unterteilt</p>`}
        <a class="button small" href="?anlage=${esc(h.key)}#anlagen">Bearbeiten</a>
      </article>`).join("")}
      <a class="card add" href="?anlage=neu#anlagen"><h2>+ Neue Anlage</h2><p class="muted">Halle, Bad oder Raum erfassen</p></a>
    </div>
    ${cur ? facilityForm(cur, edit === "neu") : ""}`;
  if (cur) bindFacilityForm(cur, edit === "neu");
}

function facilityForm(f, isNew) {
  const units = f.units.map(u => u.key).join(", ");
  return `
    <form class="facility" id="fac-form">
      <h2 class="section">${isNew ? "Neue Anlage" : `${esc(f.name)} bearbeiten`}</h2>
      <div class="row">
        <label>Name <input name="name" value="${esc(f.name)}" required placeholder="Sporthalle …"></label>
        <label>Typ <input name="type" value="${esc(f.type || "Sporthalle")}" list="fac-types"></label>
        <label>Grösse <input name="size" value="${esc(f.size || "")}" placeholder="27 x 45 m"></label>
        <label>Adresse <input name="address" value="${esc(f.address || "")}"></label>
        <label>Reihenfolge <input name="order" type="number" value="${esc(f.order ?? "")}" placeholder="100"></label>
        <label>Nutzung in den Schulferien
          <select name="holidays">
            <option value="closed" ${f.holidays !== "open" ? "selected" : ""}>Halle geschlossen</option>
            <option value="open" ${f.holidays === "open" ? "selected" : ""}>Vereine und Private dürfen nutzen</option>
          </select></label>
      </div>
      <datalist id="fac-types"><option>Sporthalle</option><option>Dreifachhalle</option><option>Lehrschwimmbecken</option><option>Mehrzweckraum</option><option>Aussenanlage</option></datalist>
      <label>Teilbereiche (von links nach rechts, durch Komma getrennt; leer = nicht unterteilt)
        <input name="units" value="${esc(units)}" placeholder="A, B, C"></label>
      <fieldset class="spaces" id="fac-spaces">
        <legend>Buchbare Flächen</legend>
        <p class="muted small">Jede Fläche besteht aus nebeneinanderliegenden Teilbereichen. Eine Fläche muss die ganze Anlage umfassen.
          Beispiel Dreifachhalle: Ganze Halle (A+B+C), 2/3 (A+B), 1/3 (A), 1/3 (B), 1/3 (C).</p>
        <div id="space-rows"></div>
        <button type="button" class="ghost small" id="add-space">+ Fläche</button>
        <button type="button" class="ghost small" id="std-spaces">Standard: Ganze Anlage + je Teil</button>
      </fieldset>
      <p class="error small" id="fac-error" role="alert"></p>
      <div class="actions">
        <a class="button ghost-link" href="?#anlagen">Abbrechen</a>
        <button>${isNew ? "Anlage erfassen (Entwurf)" : "Änderungen speichern (Entwurf)"}</button>
      </div>
    </form>`;
}

function bindFacilityForm(f, isNew) {
  const form = $("#fac-form"), rows = $("#space-rows"), err = $("#fac-error");
  const unitKeys = () => form.elements.units.value.split(",").map(x => x.trim()).filter(Boolean);
  let spaces = f.spaces.map(sp => ({ ...sp }));
  const read = () => [...rows.querySelectorAll(".space-row")].map(r => ({
    key: r.dataset.key || "", name: r.querySelector("[name=sname]").value.trim(),
    units: [...r.querySelectorAll("input[type=checkbox]:checked")].map(c => c.value),
  }));
  const draw = () => {
    const keys = unitKeys();
    rows.innerHTML = keys.length < 2 ? `<p class="muted small">Ohne mindestens zwei Teilbereiche ist die Anlage nur als Ganzes buchbar.</p>` :
      spaces.map((sp, i) => `<div class="space-row" data-key="${esc(sp.key)}">
        <input name="sname" value="${esc(sp.name)}" placeholder="Name, z. B. 1/3 A" aria-label="Name der Fläche">
        <span class="unit-checks">${keys.map(k => `<label class="chip"><input type="checkbox" value="${esc(k)}" ${sp.units.includes(k) ? "checked" : ""}>${esc(k)}</label>`).join("")}</span>
        <button type="button" class="ghost small" data-del="${i}" aria-label="Fläche entfernen">✕</button>
      </div>`).join("");
    rows.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => { spaces = read(); spaces.splice(Number(b.dataset.del), 1); draw(); }));
  };
  draw();
  form.elements.units.addEventListener("change", () => { spaces = read(); draw(); });
  $("#add-space").addEventListener("click", () => { spaces = read(); spaces.push({ key: "", name: "", units: [] }); draw(); });
  $("#std-spaces").addEventListener("click", () => {
    const keys = unitKeys();
    spaces = [{ key: WHOLE, name: "Ganze Anlage", units: keys }, ...keys.map(k => ({ key: slug(k), name: `Teil ${k}`, units: [k] }))];
    draw();
  });
  form.addEventListener("submit", e => {
    e.preventDefault();
    const keys = unitKeys();
    const f2 = new FormData(form);
    const payload = {
      name: f2.get("name"), type: f2.get("type"), size: f2.get("size"), address: f2.get("address"),
      ...(f2.get("order") !== "" ? { order: Number(f2.get("order")) } : {}),
      holidays: f2.get("holidays"),
      units: keys.length > 1 ? keys.map(k => ({ key: k, name: f.units.find(u => u.key === k)?.name || `Teil ${k}` })) : [],
      spaces: keys.length > 1 ? read().map(sp => ({ ...sp, key: sp.key || slug(sp.name) })) : [],
    };
    const problem = validateFacility(payload);
    if (problem) { err.textContent = problem; return; }
    run(async () => {
      try {
        const r = isNew ? await tool("create_facility", payload) : await tool("update_facility", { key: f.key, ...payload });
        toast(`${r.facility.name} als Entwurf gespeichert – unter «Entwürfe» veröffentlichen.`);
      } catch (e2) { err.textContent = e2.message; throw e2; }
      halls = [];
      history.replaceState(null, "", "?#anlagen");
      await show();
    });
  });
}

/* ---------- AI access ---------- */

async function renderAi() {
  content.innerHTML = `
    <h1>KI-Zugang</h1>
    <p>Ein KI-Assistent (z. B. Claude) kann über MCP als Admin arbeiten: Anfragen prüfen, genehmigen oder ablehnen,
       Belegungen erfassen und Überschneidungen finden. Alle Änderungen landen als Entwürfe – veröffentlicht wird hier.</p>
    <h2 class="section">Admin-MCP-Server</h2>
    <p><code>${esc(me.mcp.url)}</code></p>
    <p>Authentifizierung: Header <code>Authorization: Bearer &lt;Token&gt;</code>.
      ${me.mcp.tokenConfigured ? `<button class="small ghost" id="show-token">Token anzeigen</button>` : `<strong>Kein Token konfiguriert.</strong>`}</p>
    <pre class="token" id="token" hidden></pre>
    <h2 class="section">Claude Code</h2>
    <pre>claude mcp add --transport http hallen-admin ${esc(me.mcp.url)} \\
  --header "Authorization: Bearer &lt;Token&gt;"</pre>
    <h2 class="section">Öffentlicher MCP-Server (ohne Login)</h2>
    <p><code>${esc(location.origin)}/mcp</code> – Wochenpläne, freie Zeiten, Anfragen stellen. Beschreibung: <a href="/llms.txt">llms.txt</a></p>
    <h2 class="section">Beispiel-Aufträge</h2>
    <ul>
      <li>«Geh alle offenen Anfragen durch. Genehmige, was frei ist, und schlag bei Konflikten Alternativen vor.»</li>
      <li>«Welche Hallen sind dienstags nach 20 Uhr noch frei?»</li>
      <li>«Gibt es Überschneidungen im Plan? Fasse die Entwürfe für mich zusammen.»</li>
    </ul>`;
  $("#show-token")?.addEventListener("click", () => run(async () => {
    const r = await api("/mcp-token");
    $("#token").textContent = r.token;
    $("#token").hidden = false;
  }));
}

/* ---------- start ---------- */

async function start() {
  try { me = await api("/me"); } catch { return showLogin(); }
  $("#login").hidden = true; content.hidden = false;
  $("#admin-nav").hidden = false; $("#who").hidden = false;
  $("#who-email").textContent = me.email;
  await show();
}
start();
