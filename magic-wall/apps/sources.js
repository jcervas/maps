/* The Sources panel: every feed the poller runs, and how each is doing.
 *
 * Opened from the status badge or the O key. Reads manifest.json, where
 * scripts/poll.py mirrors each job's health (set_source_status): the entries
 * that carry an `interval` are exactly the poller's current jobs, since it
 * prunes the rest. Grouped by what needs attention first -- stopped, failing,
 * waiting, working, not started -- with the reason for each. The fallbacks
 * (the Times and AP, one job per state each) are summarized, not listed.
 * Refreshed every 30 seconds while open.
 */
import { getJSON } from "../core/fetch.js";
import { stateName } from "../data/states.js";

const FALLBACK = /^(nyt|ap)_/;
const LABEL = { nj_live: "county sites", wi_live: "county sites", ms_live: "Madison County",
                tx_harris: "Harris County", tx_harris_whole: "Harris County (whole)",
                pa_leg: "legislature", ny_live: "live page", nm_live: "live page",
                ct_live: "live page", vt_live: "live page" };

export function createSources({ panel, button, base = ".", onState = null }) {
  let timer = null;

  function stateOf(v) {
    if (v.stopped) return "stopped";
    if (v.consecutive_failures) return "failing";
    if (v.waiting) return "waiting";
    if (v.last_ok) return "ok";
    if (v.last_error) return "failing";
    return "pending";
  }

  const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const time = (iso) => iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "";

  /* The reason in a reader's words: the poller's own text, trimmed of the
   * Python exception names. */
  function why(v, s) {
    if (s === "ok") return `checked ${time(v.last_ok)}${v.last_change ? ` · last new numbers ${time(v.last_change)}` : ""}`;
    if (s === "pending") return "not started yet";
    const t = String((s === "waiting" ? v.waiting : v.last_error) || "")
      .replace(/^[A-Za-z]+Error: /, "").replace(/\(?(?:urllib\.error\.)?HTTPError: /g, "").replace(/\s+/g, " ");
    const refused = /\b403\b/.test(t) ? " (refused by the site; not routed around)" : "";
    return esc(t.slice(0, 140)) + refused;
  }

  const GROUPS = [
    ["stopped", "Stopped", "after three failures; retried only when the poller restarts"],
    ["failing", "Failing", "retrying"],
    ["waiting", "Waiting", "the state has not posted its 2026 results yet"],
    ["ok", "Working", "read successfully; most hold zeros until counting starts"],
    ["pending", "Not started", "scheduled to start later"],
  ];

  async function render() {
    const body = panel.querySelector(".srclist");
    let m;
    try {
      m = await getJSON(`${base}/manifest.json`, { cache: "no-store" });
    } catch (e) {
      body.innerHTML = `<p class="hint">Could not read manifest.json (${esc(e.message)}).</p>`;
      return;
    }
    const jobs = Object.entries(m.sources || {}).filter(([, v]) => v && typeof v === "object" && "interval" in v);
    const fall = jobs.filter(([k]) => FALLBACK.test(k));
    const own = jobs.filter(([k]) => !FALLBACK.test(k));
    const by = {};
    for (const [k, v] of own) (by[stateOf(v)] = by[stateOf(v)] || []).push([k, v]);
    const hb = m.poller && m.poller.heartbeat;
    const age = hb ? (Date.now() - Date.parse(hb)) / 60000 : null;
    let html = `<p class="hint">${own.length} state and county sources, ${fall.length} fallback jobs. ` +
      (m.published ? `A published copy, refreshed every ${Math.round((m.published.every || 3600) / 60)} minutes; this one is from ${time(m.published.at)}.`
        : age == null ? "No poller heartbeat." : age > 5
        ? `<b style="color:var(--bad)">Poller silent for ${Math.round(age)} min.</b>`
        : `Poller running, last heartbeat ${time(hb)}.`) + `</p>`;
    for (const [key, title, note] of GROUPS) {
      const rows = (by[key] || []).sort((a, b) => (a[1].state || "").localeCompare(b[1].state || "") || a[0].localeCompare(b[0]));
      if (!rows.length) continue;
      html += `<h3 class="src-${key}">${title} · ${rows.length}</h3><p class="hint">${note}</p><ul>` +
        rows.map(([k, v]) => `<li data-state="${esc(v.state)}"><b>${esc(v.state)}</b>
          <span class="src">${esc(stateName(v.state))}${LABEL[v.adapter] ? ` · ${esc(LABEL[v.adapter])}` : ""}</span>
          <span class="why">${why(v, key)}</span></li>`).join("") + `</ul>`;
    }
    if (fall.length) {
      const n = {};
      for (const [, v] of fall) { const s = stateOf(v); n[s] = (n[s] || 0) + 1; }
      html += `<h3>Fallbacks · ${fall.length}</h3><p class="hint">The New York Times and AP, one job per state each: ` +
        Object.entries(n).map(([s, c]) => `${c} ${({ ok: "working", pending: "not started", waiting: "waiting", failing: "failing", stopped: "stopped" })[s] || s}`).join(", ") +
        `. They fill a race only where our own source has no votes, or is partial.</p>`;
    }
    body.innerHTML = html;
  }

  function sync() {
    const open = !panel.hidden;
    if (button) button.setAttribute("aria-expanded", String(open));
  }

  function toggle(force) {
    const open = force != null ? force : panel.hidden;
    panel.hidden = !open;
    clearInterval(timer);
    timer = null;
    if (open) {
      render();
      timer = setInterval(render, 30000);
    }
    sync();
  }

  panel.addEventListener("click", (ev) => {
    const li = ev.target.closest("li[data-state]");
    if (li && onState) onState(li.dataset.state);
  });
  sync();
  return { toggle, get open() { return !panel.hidden; } };
}
