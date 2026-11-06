/* The Updates panel: a running log of new numbers, newest first.
 *
 * Every poll hands the shell the races whose files changed (poller.js
 * onUpdate). For each, this keeps a snapshot -- votes counted, share in,
 * who leads and by how much -- and logs the difference from the last one:
 * "+12,345 votes · 34% in · Casey (D) +2.1". A change of leader is marked.
 * A race's first sighting after the page loads is its baseline, not an
 * update, so a reload does not log 540 races; instead the panel opens on the
 * races that moved most recently by the manifest's own `updated` stamps.
 *
 * Only the live cycle's races are logged: a 2024 file being re-read is not
 * news. In memory only; a reload starts the log again.
 *
 * A second tab lists the race calls (calls.json, through seats.calls),
 * newest first, each with who called it. The pre-election "Unopposed"
 * entries are counted, not listed. Calls that arrive after the page opened
 * add to the button's count and are marked new.
 */
import { stateName } from "../data/states.js";

const CYCLE = "2026";
const MAX = 300;
const OFFICE = { sen: "Senate", gov: "Governor", sos: "Secretary of State", statehouse: "State House", statesenate: "State Senate" };
const LETTER = { dem: "D", rep: "R" };
const RID = /^(\d{4})-(sen|gov|sos|house|statehouse|statesenate)-([a-z]{2})(?:-(.+))?$/;

const TAB_KEY = "mw.updates.tab";
const HINTS = {
  numbers: "New numbers since this page opened, newest first. Click one to open its state.",
  calls: "Race calls, newest first, with who made each one. Click one to open its state.",
};

export function createUpdates({ store, panel, button, onPick = null, calls = () => null }) {
  const last = new Map();          // race_id -> snapshot
  const log = [];                  // newest first
  let manifest = null;
  let unseen = 0;
  let tab = "numbers";
  try { if (localStorage.getItem(TAB_KEY) === "calls") tab = "calls"; } catch (_) { /* no storage */ }
  let callsSeen = null;            // "race_id|at" keys present at first read: the baseline
  const fresh = new Set();         // keys that arrived after it

  function label(id) {
    // A legislative seat's call is keyed by the seat: "2026-statehouse-pa:PA-001".
    const [race, seat] = String(id).split(":");
    if (seat) {
      const n = /^[A-Z]{2}-S?0*(\d+)$/.exec(seat);
      return `${label(race)} ${n ? `District ${n[1]}` : seat}`;
    }
    const m = RID.exec(id);
    if (!m) return id;
    const st = m[3].toUpperCase();
    if (m[2] === "house") return `${st}-${/^(al|00)$/.test(m[4] || "") ? "AL" : m[4]} House`;
    return `${stateName(st)} ${OFFICE[m[2]]}${m[4] === "special" ? " (special)" : ""}`;
  }

  function snapshot(id) {
    const data = store.results(id);
    if (!data) return null;
    const race = store.race(id);
    const sw = data.statewide || {};
    let votes = sw.votes;
    if (!votes) {
      votes = {};
      for (const u of data.units || []) for (const [k, v] of Object.entries(u.votes || {})) votes[k] = (votes[k] || 0) + (Number(v) || 0);
    }
    const total = Object.values(votes).reduce((a, b) => a + (Number(b) || 0), 0);
    const leg = /-(statehouse|statesenate)-/.test(id);
    // A legislature is a chamber of districts: who leads it is a seat count,
    // which the boards keep; here, how many districts have numbers.
    const districts = leg ? (data.units || []).filter((u) => Object.values(u.votes || {}).some((v) => Number(v) > 0)).length : null;
    const top = !leg && total > 0 ? store.topTwo(votes, race) : null;
    let who = null;
    if (top) {
      const row = store.candidateRows(votes, race).find((r) => r.party === top.leader.party);
      who = { party: top.leader.party, name: top.leader.name || (row && row.name) || top.leader.key, pts: top.pts };
    }
    return { total, reporting: store.reportingPct(sw, data), who, districts, units: (data.units || []).length,
             provider: (data.source && data.source.provider) || null };
  }

  function surname(name) {
    const n = String(name || "").split(/\s+(?:and|&)\s+|\s*\/\s*/)[0];
    if (n.includes(",")) return n.split(",")[0].trim();
    const w = n.trim().split(/\s+/).filter((x) => !/^(jr|sr|ii|iii|iv)\.?$/i.test(x));
    const last = w[w.length - 1] || n;
    // Some feeds print names in capitals ("BROOKS"): read as a name, not a shout.
    return last === last.toUpperCase() ? last.toLowerCase().replace(/(^|[-' ])\p{L}/gu, (c) => c.toUpperCase()) : last;
  }

  /** The races whose files changed on this poll. */
  function record(ids, m) {
    if (m) manifest = m;
    const now = new Date();
    let added = 0;
    for (const id of ids || []) {
      if (!id.startsWith(`${CYCLE}-`)) continue;
      const s = snapshot(id);
      if (!s) continue;
      const p = last.get(id);
      last.set(id, s);
      if (!p) continue;                                     // first sighting: the baseline
      if (s.total === p.total && s.reporting === p.reporting) continue;
      const flip = !!(p.who && s.who && p.who.party !== s.who.party);
      log.unshift({ t: now, id, s, dv: s.total - p.total, first: p.total === 0 && s.total > 0, flip });
      added += 1;
    }
    if (log.length > MAX) log.length = MAX;
    if (added) {
      if (panel.hidden) unseen += added;
      sync();
      if (!panel.hidden) render();
    }
  }

  const fmt = (n) => Number(n || 0).toLocaleString("en-US");
  const time = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function line(s) {
    const parts = [];
    if (s.districts != null) parts.push(`${s.districts} of ${s.units} districts with votes`);
    else if (s.reporting != null) parts.push(`${Math.round(s.reporting)}% in`);
    if (s.who) {
      const side = LETTER[s.who.party] ? ` (${LETTER[s.who.party]})` : "";
      parts.push(`${esc(surname(s.who.name))}${side} +${s.who.pts.toFixed(1)}`);
    }
    return parts.join(" · ");
  }

  function row(e) {
    const what = e.first ? "<b>first votes</b>" : e.dv > 0 ? `+${fmt(e.dv)} votes` : e.dv < 0 ? `${fmt(e.dv)} votes (revised)` : "reporting updated";
    return `<li data-race="${esc(e.id)}"${e.flip ? ' class="flip"' : ""}>
      <span class="when">${time(e.t)}</span>
      <span class="race">${esc(label(e.id))}${e.flip ? ' <span class="tag">lead change</span>' : ""}</span>
      <span class="what">${what} · ${fmt(e.s.total)} total${e.s.provider ? ` · ${esc(e.s.provider.toUpperCase())}` : ""}</span>
      <span class="now">${line(e.s)}</span></li>`;
  }

  /** Before any update this session: the races that moved most recently. */
  function recent() {
    const races = (manifest && manifest.races) || {};
    return Object.entries(races)
      .filter(([id]) => id.startsWith(`${CYCLE}-`))
      .map(([id, r]) => ({ id, at: r.updated, s: last.get(id) || snapshot(id) }))
      .filter((x) => x.s && x.s.total > 0)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 25);
  }

  const callKey = (c) => `${c.race_id}|${c.at}`;

  function callList() {
    const api = calls();
    return api ? api.all() : [];
  }

  /** calls.json changed (seats.onChange): count the new ones. */
  function syncCalls() {
    const all = callList();
    if (!calls()) return;
    if (callsSeen == null) {
      callsSeen = new Set(all.map(callKey));
    } else {
      let added = 0;
      for (const c of all) {
        const k = callKey(c);
        if (callsSeen.has(k)) continue;
        callsSeen.add(k);
        if (c.by !== "Unopposed") { fresh.add(k); added += 1; }
      }
      if (added && panel.hidden) unseen += added;
      if (added) sync();
    }
    if (!panel.hidden && tab === "calls") render();
  }

  function callRow(c) {
    const isNew = fresh.has(callKey(c));
    const side = LETTER[c.party] ? ` (${LETTER[c.party]})` : c.party ? ` (${esc(c.party)})` : "";
    const PARTY_NAME = { dem: "Democrat", rep: "Republican", ind: "Independent", lib: "Libertarian", grn: "Green" };
    const who = c.winner ? `${esc(c.winner)}${side}` : esc(PARTY_NAME[c.party] || "Other candidate");
    return `<li data-race="${esc(c.race_id)}" class="call call-${esc(c.party)}${isNew ? " new" : ""}">
      <span class="when">${time(new Date(c.at))}</span>
      <span class="race">${esc(label(c.race_id))}${isNew ? ' <span class="tag">new</span>' : ""}</span>
      <span class="what"><b>${who}</b> wins</span>
      <span class="now">Called by ${esc(c.by)}</span></li>`;
  }

  function renderCalls(list) {
    const all = callList();
    if (!calls()) {
      list.innerHTML = `<li class="note">Calls are not available in this build.</li>`;
      return;
    }
    const shown = all.filter((c) => c.by !== "Unopposed").sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const unopposed = all.length - shown.length;
    const by = {};
    for (const c of shown) by[c.by] = (by[c.by] || 0) + 1;
    const head = shown.length
      ? `<li class="note">${shown.length} call${shown.length === 1 ? "" : "s"} (${Object.entries(by).map(([k, n]) => `${esc(k)} ${n}`).join(", ")})` +
        `${unopposed ? `; ${unopposed} unopposed seats not listed` : ""}.</li>`
      : `<li class="note">No races called yet${unopposed ? ` (${unopposed} unopposed seats not listed)` : ""}. Calls appear here as they are entered.</li>`;
    list.innerHTML = head + shown.map(callRow).join("");
  }

  function setTab(t) {
    tab = t;
    try { localStorage.setItem(TAB_KEY, t); } catch (_) { /* no storage */ }
    for (const b of panel.querySelectorAll(".updtabs [data-tab]")) b.setAttribute("aria-pressed", String(b.dataset.tab === t));
    const hint = panel.querySelector("#updHint");
    if (hint) hint.textContent = HINTS[t];
    render();
  }

  function render() {
    const list = panel.querySelector(".updlist");
    if (tab === "calls") { renderCalls(list); return; }
    if (log.length) {
      list.innerHTML = log.map(row).join("");
    } else {
      const r = recent();
      list.innerHTML = r.length
        ? `<li class="note">No new numbers since this page opened. Latest counts:</li>` +
          r.map((x) => `<li data-race="${esc(x.id)}"><span class="when">${x.at ? time(new Date(x.at)) : ""}</span>
            <span class="race">${esc(label(x.id))}</span>
            <span class="what">${fmt(x.s.total)} votes${x.s.provider ? ` · ${esc(x.s.provider.toUpperCase())}` : ""}</span>
            <span class="now">${line(x.s)}</span></li>`).join("")
        : `<li class="note">No ${CYCLE} race has counted a vote yet. New numbers appear here as they arrive.</li>`;
    }
  }

  function sync() {
    button.textContent = unseen ? `Updates · ${unseen}` : "Updates";
    button.setAttribute("aria-pressed", String(!panel.hidden));
  }

  function toggle(force) {
    const open = force != null ? force : panel.hidden;
    panel.hidden = !open;
    if (open) { unseen = 0; render(); }
    sync();
  }

  panel.addEventListener("click", (ev) => {
    const t = ev.target.closest(".updtabs [data-tab]");
    if (t) { setTab(t.dataset.tab); return; }
    const li = ev.target.closest("li[data-race]");
    if (li && onPick) onPick(li.dataset.race.split(":")[0]);
  });
  setTab(tab);
  sync();
  return { record, toggle, syncCalls, setTab, get tab() { return tab; }, get open() { return !panel.hidden; } };
}
