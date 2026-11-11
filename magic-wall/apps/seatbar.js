/* Shared pieces of the Boards and Battle apps: the seat bar, the seat tile,
 * and their styles.
 *
 * DOM rather than canvas: a few hundred rectangles, all clickable, all text,
 * and CSS custom properties work directly, so the party colors follow the
 * theme tokens in wall.css without going through core/theme.js. The styles
 * are injected once from here so neither app needs an edit to wall.css.
 *
 * Simulated seats are hatched everywhere they appear -- bar, tile, legend --
 * so a simulation on screen can never be read as a result.
 */

export const PARTY_NAME = { dem: "Democrats", rep: "Republicans", other: "Other" };
export const PARTY_SHORT = { dem: "D", rep: "R", other: "I", ind: "I", lib: "L", grn: "G" };

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** HTML from seatStatusText as plain text, for a title attribute (which esc()s it again). */
export function plainText(html) {
  return String(html).replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => (
    { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[e]));
}

export function fmtMargin(m) {
  if (m == null || Number.isNaN(m)) return "—";
  if (Math.abs(m) < 0.05) return "even";
  return `${m > 0 ? "D" : "R"}+${Math.abs(m).toFixed(1)}`;
}

export function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) +
    (Date.now() - d.getTime() > 20 * 3600e3
      ? ` ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "");
}

/** What a partial file covers: "Harris County only", from the file itself;
 * else "2026 General Election (2 counties)" -> "only 2 counties"; else
 * "only some counties". */
function coverage(s) {
  if (s.partialNote) return s.partialNote;
  const m = /\(([^)]*count[^)]*)\)/i.exec((s.live && s.live.coverage) || "");
  return `only ${m ? m[1] : "some counties"}`;
}

/** Extra tile classes and tooltip text for seats whose leader needs a caveat. */
export function caveats(s) {
  const cls = [];
  const notes = [];
  if (s.partial) { cls.push("partial"); notes.push(`PARTIAL COUNT: ${coverage(s)} in the file, not the whole ${s.chamber === "house" ? "district" : "state"}`); }
  if (s.firstRound) { cls.push("firstround"); notes.push("open first round: runoff if nobody passes 50%"); }
  // A leading seat's status line already says it (seatStatusText).
  return { cls, title: notes.length && s.status !== "leading" ? ` — ${notes.join(" — ")}` : "" };
}

/** One line saying what a seat is doing, with its attribution. */
export function seatStatusText(s) {
  if (s.status === "called") {
    const who = s.call.winner ? `${esc(s.call.winner)} ` : "";
    // scripts/call_unopposed.py: no time to report, and the note says whose list had one name.
    if (s.call.by === "Unopposed") {
      return `${who}<b>${PARTY_SHORT[s.call.party] || s.call.party}</b> · unopposed${s.call.note ? ` <span class="hint">(${esc(s.call.note)})</span>` : ""}`;
    }
    return `${who}<b>${PARTY_SHORT[s.call.party] || s.call.party}</b> · called by ${esc(s.call.by)}, ${esc(fmtTime(s.call.at))}`;
  }
  const rep = s.live && s.live.reporting != null
    ? `${s.live.reporting.toFixed(s.live.reporting < 10 ? 1 : 0)}% ${s.live.reportingKind}` : "reporting n/a";
  if (s.status === "leading") {
    const l = s.live.leader;
    const share = s.firstRound && l.share != null ? ` with ${(100 * l.share).toFixed(0)}%` : "";
    return `${esc(l.name)}${l.incumbent ? " (i)" : ""} (${PARTY_SHORT[l.party] || l.party}) leads${share} by ${l.lead.toLocaleString("en-US")} · ${rep}` +
      (s.firstRound ? " · <b>first round: runoff if nobody passes 50%</b>" : "") +
      (s.partial ? ` · <b>PARTIAL COUNT</b>: ${esc(coverage(s))} in the file, not the whole ${s.chamber === "house" ? "district" : "state"}` : "");
  }
  if (s.live) return `no votes yet · ${rep}`;
  // A legislative district: its chamber's file appears with the first votes.
  if (s.unitId) return `${s.incumbent ? `${esc(s.incumbent)} (${PARTY_SHORT[s.held] || "?"}) holds it · ` : ""}feed waiting: no numbers until the first district reports`;
  const none = s.inRegistry ? "no results file yet" : "no live feed";
  return s.ballot && s.ballot.length ? `${none} · on the ballot: ${ballotText(s.ballot)}` : none;
}

/** "Mike Collins (R), Jon Ossoff (i) (D)": the two parties first, then the rest,
 * at most two more by name. */
export function ballotText(list) {
  const rank = (c) => (c.party === "dem" || c.party === "rep" ? 0 : 1);
  const sorted = [...list].sort((a, b) => rank(a) - rank(b));
  const show = sorted.filter((c, i) => rank(c) === 0 || i < sorted.filter((x) => rank(x) === 0).length + 2);
  const more = sorted.length - show.length;
  return show.map((c) => `${esc(c.name)}${c.incumbent ? " (i)" : ""} (${PARTY_SHORT[c.party] || esc(c.label || "?")})`).join(", ") +
    (more > 0 ? `, +${more} more` : "");
}

/**
 * The bar: Democrats from the left, Republicans from the right, undecided
 * in the middle. Segments, outside in: not up, called, simulated (hatched),
 * leading (tint).
 */
export function seatBar(t, { sim = false } = {}) {
  const pct = (n) => `${(100 * n / t.seats).toFixed(3)}%`;
  const seg = (cls, n, title) => n > 0
    ? `<div class="sb-seg ${cls}" style="width:${pct(n)}" title="${esc(title)}: ${n}"></div>` : "";
  const side = (p) => [
    seg(`${p} notup`, t.notUp[p], `${PARTY_NAME[p]}, not up`),
    seg(`${p} called`, t.called[p], `${PARTY_NAME[p]}, called`),
    sim ? seg(`${p} sim`, t.sim[p], `${PARTY_NAME[p]}, SIMULATED`) : "",
    seg(`${p} leading`, t.leading[p], `${PARTY_NAME[p]}, leading`),
  ];
  const otherN = t.notUp.other + t.called.other + t.leading.other;
  return `<div class="sb-bar" role="img" aria-label="${esc(barLabel(t, sim))}">
    ${side("dem").join("")}
    <div class="sb-mid"></div>
    ${seg("other", otherN, "Other or independent")}
    ${side("rep").reverse().join("")}
    ${t.control ? `<div class="sb-mark" style="left:50%"></div>` : ""}
  </div>`;
}

function barLabel(t, sim) {
  const k = sim ? "projected" : "secured";
  return `Democrats ${t.dem[k]}, Republicans ${t.rep[k]}, of ${t.seats}`;
}

/* A live control bar for one chamber, small enough to sit on the map:
 * secured seats (not up + called) each side, the bar, the majority mark, and
 * what is still leading or undecided. Live counts only -- Battle's
 * simulated picks never reach it.
 *
 *   const strip = createControlStrip({ el, seats });
 *   strip.show("senate");     // or "house", "governor", "pa-house", "wv-senate", ...
 *   strip.show(null);         // hide it
 *
 * It redraws itself on every seats change. `titles` names the chamber
 * ({ senate: "Senate", ... }; data/seats.js CHAMBER_TITLES). */
export function createControlStrip({ el, seats, titles = {} }) {
  ensureStyles();
  el.classList.add("mw-ctlstrip");
  let chamber = null;
  let render = function () {
    const list = chamber ? seats.seats(chamber) : [];
    el.hidden = !list.length;
    if (el.hidden) { el.innerHTML = ""; return; }
    const t = seats.tally(chamber);
    const need = t.control
      ? (t.need.dem !== t.need.rep ? `D ${t.need.dem} · R ${t.need.rep} for control` : `${t.majority} for control`)
      : `${t.seats_up} up`;
    // No call source (the PA and WV legislatures): each side's seats by
    // current leader, labeled so (data/seats.js tally byLeader).
    const by = t.byLeader;
    const side = (p) => {
      const lead = by ? (t.notUp[p] ? `<span class="cs-lead">${t.notUp[p]} not up</span>` : "")
        : t.leading[p] ? `<span class="cs-lead">+${t.leading[p]} leading</span>` : "";
      return `<div class="cs-side ${p}"><b>${by ? t[p].ahead : t[p].secured}</b>${lead}</div>`;
    };
    const ctl = t.controller ? `<span class="cs-ctl ${t.controller.party}">${PARTY_SHORT[t.controller.party]} control</span>`
      : t.leads ? `<span class="cs-ctl ${t.leads.party} leads" title="A majority by current leader; no race has been called">${PARTY_SHORT[t.leads.party]} leads</span>` : "";
    const other = t.notUp.other + t.called.other + t.leading.other;
    const byNote = by ? `<span class="cs-by" title="No AP or state race calls for this chamber: each district counts for the candidate ahead now">By current leader — no race calls</span> · ` : "";
    const pv = popularParts(seats.popularVote ? seats.popularVote(chamber) : null, chamber);
    el.innerHTML = `
      ${pv.row}
      <div class="cs-top">${side("dem")}
        <div class="cs-mid"><b>${esc(titles[chamber] || chamber)}</b> ${ctl}<span>${need}</span></div>
        ${side("rep")}</div>
      ${seatBar(t)}
      <div class="cs-foot">${byNote}${t.reportingAny} of ${t.seats_up} reporting${other ? ` · ${other} other` : ""}${pv.foot}</div>`;
  };
  /* The popular-vote line at the widest of its three spellings that fits
   * on one line (full counts, then 65.6M, then without "Popular vote"). */
  function fitPopular() {
    const pv = el.querySelector(".cs-pv");
    if (!pv || !pv.clientWidth) return;
    for (let i = 0; i < 3; i++) {
      pv.dataset.fit = i;
      if (pv.scrollWidth <= pv.clientWidth + 1) break;
    }
  }
  const draw = render;
  render = function () { draw(); fitPopular(); };
  if (typeof ResizeObserver === "function") {
    let lastW = 0;
    new ResizeObserver(() => { if (el.clientWidth !== lastW) { lastW = el.clientWidth; fitPopular(); } }).observe(el);
  }
  seats.onChange(() => render());
  return {
    show(c) { chamber = c || null; render(); },
    render,
    get chamber() { return chamber; },
  };
}

/** 65,617,913 -> "65.6M"; 2,709,535 -> "2.71M"; 312,400 -> "312K". */
function abbrev(n) {
  if (n >= 1e7) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  return n.toLocaleString("en-US");
}

/* The strip's popular vote (data/seats.js popularVote), the user,
 * November 11: "have the popular vote totals above the seat share, left and
 * right aligned, and do not have the 'Popular vote' text or the 'D' or 'R'".
 * A row over the seat numbers: the Democratic total at the left, the
 * Republican at the right, each in its color with its two-party share. Three
 * spellings, the widest that fits (fitPopular): 65,624,868 · 56.9%, then
 * 65.6M · 56.9%, then 65.6M. "Other" votes (2% or more of the total) and
 * the seats without both parties go to the footer. */
function popularParts(pv, chamber) {
  if (!pv || pv.dem + pv.rep <= 0) return { row: "", foot: "" };
  const two = pv.dem + pv.rep;
  const total = two + pv.other;
  const pct = (n) => `${(100 * n / two).toFixed(1)}%`;
  const full = (n) => n.toLocaleString("en-US");
  const showOther = pv.other / total >= 0.02;
  const unit = chamber === "governor" || chamber === "senate" ? "race" : "seat";
  const side = (p) => `<span class="${p}"><span class="v0">${full(pv[p])}<i> · ${pct(pv[p])}</i></span>` +
    `<span class="v1">${abbrev(pv[p])}<i> · ${pct(pv[p])}</i></span><span class="v2">${abbrev(pv[p])}</span></span>`;
  const label = `Popular vote: Democrats ${full(pv.dem)} (${pct(pv.dem)} of the two-party vote), ` +
    `Republicans ${full(pv.rep)} (${pct(pv.rep)})` + (showOther ? `, other ${full(pv.other)}` : "");
  const row = `<div class="cs-pv" data-fit="0" role="img" aria-label="${esc(label)}" ` +
    `title="Popular vote and two-party share: every candidate of each party summed over the ${pv.seats} ${unit}s with votes this year">` +
    `${side("dem")}${side("rep")}</div>`;
  const foot = (showOther ? ` · <span title="Votes for candidates of neither party">Other ${abbrev(pv.other)} votes</span>` : "") +
    (pv.oneSided ? ` · <span title="Races with votes for only one of the two parties (unopposed by the other, or two candidates of one party) add to one side's popular vote and none to the other's">` +
      `${pv.oneSided} ${unit}${pv.oneSided > 1 ? "s" : ""} uncontested by one party</span>` : "");
  return { row, foot };
}

/** The state label in a House tile group, flagged when the state redrew. */
export function stateLabel(st, seatsInState) {
  const r = seatsInState.some((s) => s.redrawn);
  return r ? `<span class="redrawn" title="${esc(st)} redrew its House map for 2026: each tile is the 2026 race, but its held party and baseline come from the 2024 district with that number">${esc(st)}*</span>`
    : `<span>${esc(st)}</span>`;
}

let styled = false;
export function ensureStyles() {
  if (styled || document.getElementById("mw-seat-apps")) { styled = true; return; }
  styled = true;
  const s = document.createElement("style");
  s.id = "mw-seat-apps";
  s.textContent = CSS;
  document.head.append(s);
}

const CSS = `
.mw-seats { overflow: auto; padding: 14px 16px 22px; background: var(--paper); color: var(--ink);
  font-variant-numeric: tabular-nums; --hatch-w: 5px; }
.mw-seats * { box-sizing: border-box; }
.mw-seats h2 { margin: 0; font-size: 18px; letter-spacing: -0.01em; }
.mw-seats h2.mw-subhead { margin-top: 18px; }
.mw-seats .hint, .mw-seats .foot { color: var(--ink-soft); font-size: 12px; }
.mw-seats button { min-height: 34px; }
.mw-cards { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); margin-top: 10px; }
.mw-card { border: 1px solid var(--rule); border-radius: 6px; background: var(--panel); padding: 12px 14px; min-width: 0; }
.mw-card.active { border-color: var(--ink-soft); }
.mw-card header { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.mw-card h3 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; }
.mw-card .rule { font-size: 11px; color: var(--ink-soft); text-align: right; }
.mw-big { display: flex; justify-content: space-between; align-items: flex-end; margin: 6px 0 6px; }
.mw-big .n { font-size: 44px; font-weight: 700; line-height: 1; letter-spacing: -0.02em; }
.mw-big .dem .n { color: var(--dem); }
.mw-big .rep .n { color: var(--rep); text-align: right; }
.mw-big .rep { text-align: right; }
.mw-big .sub { font-size: 12px; color: var(--ink-soft); }
.mw-big .ctl { align-self: center; font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.05em; padding: 3px 7px; border-radius: 3px; color: var(--paper); }
.mw-big .ctl.dem { background: var(--dem); } .mw-big .ctl.rep { background: var(--rep); }
.mw-big .ctl.simulated { background: transparent; color: var(--ink); border: 1px dashed var(--ink-soft); }

.sb-bar { position: relative; display: flex; height: 26px; border-radius: 3px; overflow: hidden;
  background: var(--nodata); }
.sb-seg { height: 100%; flex: none; }
.sb-mid { flex: 1; }
.sb-seg.dem.notup { background: color-mix(in srgb, var(--dem) 72%, var(--paper)); }
.sb-seg.rep.notup { background: color-mix(in srgb, var(--rep) 72%, var(--paper)); }
.sb-seg.dem.called { background: var(--dem); }
.sb-seg.rep.called { background: var(--rep); }
.sb-seg.dem.leading { background: color-mix(in srgb, var(--dem) 32%, var(--paper)); }
.sb-seg.rep.leading { background: color-mix(in srgb, var(--rep) 32%, var(--paper)); }
.sb-seg.other { background: color-mix(in srgb, var(--ink-soft) 70%, var(--paper)); }
.sb-seg.dem.sim, .mw-tile.sim.dem, .mw-key .sim.dem { background: repeating-linear-gradient(135deg,
  var(--dem) 0 var(--hatch-w), color-mix(in srgb, var(--dem) 22%, var(--paper)) var(--hatch-w) calc(2 * var(--hatch-w))); }
.sb-seg.rep.sim, .mw-tile.sim.rep, .mw-key .sim.rep { background: repeating-linear-gradient(135deg,
  var(--rep) 0 var(--hatch-w), color-mix(in srgb, var(--rep) 22%, var(--paper)) var(--hatch-w) calc(2 * var(--hatch-w))); }
.sb-seg + .sb-seg { box-shadow: inset 1px 0 0 var(--panel); }
.sb-mark { position: absolute; top: -2px; bottom: -2px; width: 2px; margin-left: -1px; background: var(--ink); }

/* The map's control bar (createControlStrip). */
.mw-ctlstrip { background: var(--panel); color: var(--ink);
  border: 1px solid var(--rule); border-radius: 6px; padding: 6px 10px 5px; min-width: 260px;
  font-variant-numeric: tabular-nums; box-sizing: border-box; }
.mw-ctlstrip[hidden] { display: none; }
.mw-ctlstrip .cs-top { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
.mw-ctlstrip .cs-side b { font-size: 26px; line-height: 1; font-weight: 700; letter-spacing: -0.02em; }
.mw-ctlstrip .cs-side.dem b { color: var(--dem); } .mw-ctlstrip .cs-side.rep b { color: var(--rep); }
.mw-ctlstrip .cs-side.rep { text-align: right; }
.mw-ctlstrip .cs-lead { display: block; font-size: 10px; color: var(--ink-soft); }
.mw-ctlstrip .cs-mid { text-align: center; font-size: 11px; color: var(--ink-soft); line-height: 1.3; }
.mw-ctlstrip .cs-mid b { display: block; color: var(--ink); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
.mw-ctlstrip .cs-ctl { display: inline-block; margin: 1px 0 2px; padding: 1px 6px; border-radius: 3px; font-size: 10px;
  font-weight: 700; text-transform: uppercase; color: var(--paper); }
.mw-ctlstrip .cs-ctl.dem { background: var(--dem); } .mw-ctlstrip .cs-ctl.rep { background: var(--rep); }
.mw-ctlstrip .cs-mid span:last-child { display: block; }
.mw-ctlstrip .sb-bar { height: 14px; }
.mw-ctlstrip .cs-ctl.leads, .mw-big .ctl.leads { background: transparent; border: 1px solid currentColor; }
.mw-ctlstrip .cs-ctl.leads.dem, .mw-big .ctl.leads.dem { color: var(--dem); }
.mw-ctlstrip .cs-ctl.leads.rep, .mw-big .ctl.leads.rep { color: var(--rep); }
.mw-ctlstrip .cs-by { font-weight: 600; color: var(--ink); }
.mw-ctlstrip .cs-pv { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 1px;
  font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; font-variant-numeric: tabular-nums; }
.mw-ctlstrip .cs-pv .dem { color: var(--dem); } .mw-ctlstrip .cs-pv .rep { color: var(--rep); }
.mw-ctlstrip .cs-pv i { font-style: normal; font-weight: 400; font-size: 10px; color: var(--ink-soft); }
.mw-ctlstrip .cs-pv .v0, .mw-ctlstrip .cs-pv .v1, .mw-ctlstrip .cs-pv .v2 { display: none; }
.mw-ctlstrip .cs-pv[data-fit="0"] .v0, .mw-ctlstrip .cs-pv[data-fit="1"] .v1, .mw-ctlstrip .cs-pv[data-fit="2"] .v2 { display: inline; }
.mw-ctlstrip .cs-foot { margin-top: 3px; font-size: 10px; color: var(--ink-soft); text-align: center; }

.mw-rows { display: grid; grid-template-columns: 1fr auto auto; gap: 1px 14px; margin: 10px 0 4px; font-size: 13px; }
.mw-rows .h { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-soft); }
.mw-rows .d { color: var(--dem); font-weight: 600; text-align: right; }
.mw-rows .r { color: var(--rep); font-weight: 600; text-align: right; }
.mw-rows button.cat, .mw-und button.cat { all: unset; cursor: pointer; color: var(--ink); border-bottom: 1px dotted var(--ink-soft); }
.mw-seats button.cat[aria-pressed="true"] { font-weight: 700; border-bottom-style: solid; }
.mw-und { font-size: 12px; color: var(--ink-soft); margin-top: 4px; }
.mw-warn { font-size: 11px; color: var(--warn); margin-top: 6px; }
.mw-warn li { margin: 1px 0; }
.mw-warn ul { margin: 0; padding-left: 16px; }

.mw-tiles { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 10px; }
.mw-tile { all: unset; box-sizing: border-box; cursor: pointer; min-width: 34px; height: 30px; min-height: 0; padding: 2px 3px;
  border-radius: 3px; font-size: 11px; font-weight: 600; line-height: 1.05; text-align: center;
  display: flex; flex-direction: column; justify-content: center;
  background: var(--paper); color: var(--ink); border: 1px solid var(--rule); }
.mw-tile small { font-size: 9px; font-weight: 400; opacity: 0.85; }
.mw-tile.house { min-width: 0; min-height: 0; width: 13px; height: 13px; padding: 0; border-radius: 2px; font-size: 0; }
.mw-tile.house small { display: none; }
.mw-tile.called.dem { background: var(--dem); color: #fff; border-color: var(--dem); }
.mw-tile.called.rep { background: var(--rep); color: #fff; border-color: var(--rep); }
.mw-tile.called.other { background: var(--ink-soft); color: var(--paper); }
.mw-tile.leading.dem { background: color-mix(in srgb, var(--dem) 30%, var(--paper)); border-color: var(--dem); }
.mw-tile.leading.rep { background: color-mix(in srgb, var(--rep) 30%, var(--paper)); border-color: var(--rep); }
.mw-tile.leading.other { background: color-mix(in srgb, var(--ink-soft) 30%, var(--paper)); }
.mw-tile.sim { color: var(--ink); text-shadow: 0 0 3px var(--paper), 0 0 2px var(--paper); border-style: dashed; }
.mw-tile.sim.dem { border-color: var(--dem); } .mw-tile.sim.rep { border-color: var(--rep); }
.mw-tile.flip { box-shadow: inset 0 0 0 2px var(--accent); }
.mw-tile.sel { outline: 2px solid var(--accent); outline-offset: 1px; }
.mw-tile.locked { cursor: not-allowed; }
/* Redrawn for 2026: a corner notch, so it reads on a 13px House square and
   does not fight the dashed border (simulated) or inset ring (flip). */
.mw-tile.redrawn { position: relative; }
.mw-tile.redrawn::after { content: ""; position: absolute; top: -1px; right: -1px; width: 0; height: 0;
  border-style: solid; border-width: 0 7px 7px 0; border-color: transparent var(--warn) transparent transparent; }
.mw-state > span.redrawn { color: var(--warn); font-weight: 700; }
/* Partial count (IL): a leader from some counties only -- dotted and faded
   so it never reads as the district's leader. */
.mw-tile.leading.partial { border-style: dotted; border-width: 2px; opacity: 0.55; }
/* Open first round (LA): a notch in the lower-left corner. */
.mw-tile.firstround { position: relative; }
.mw-tile.firstround::before { content: ""; position: absolute; bottom: -1px; left: -1px; width: 0; height: 0;
  border-style: solid; border-width: 7px 0 0 7px; border-color: transparent transparent transparent var(--ink); }
.mw-key i.partial { background: color-mix(in srgb, var(--dem) 30%, var(--paper)); border: 2px dotted var(--dem); opacity: 0.55; }
.mw-key i.firstround { background: linear-gradient(45deg, var(--ink) 0 5px, var(--nodata) 5px); }
.mw-key i.redrawn { background: linear-gradient(225deg, var(--warn) 0 5px, var(--nodata) 5px); }
.mw-redrawn-tag { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--warn); border: 1px solid var(--warn); border-radius: 3px; padding: 0 4px; }
.mw-tile:focus-visible { outline: 2px solid var(--accent); }
.mw-state { display: flex; gap: 3px; align-items: center; flex-wrap: wrap; margin-right: 6px; }
.mw-state > span { font-size: 9px; color: var(--ink-soft); width: 16px; }

/* Tiles scale with the width they are given (cqi = 1% of .mw-tilewrap):
   Battle's full-width grid gets wall-sized state tiles, a Boards card a
   little more than the minimum. */
.mw-tilewrap { container-type: inline-size; }

/* Boards' House grid: 435 chiclets, sized from the card's width (--cs). */
.mw-chiclets { margin-top: 14px; container-type: inline-size; }
.mw-chiclets .grid { --cs: clamp(17px, 1.6cqi, 36px); display: flex; flex-wrap: wrap; align-items: flex-start;
  gap: clamp(8px, 0.9cqi, 18px) clamp(10px, 1.1cqi, 22px); margin-top: 10px; }
.mw-cst { display: flex; flex-direction: column; gap: 3px; }
.mw-cst > span { font-size: clamp(10px, 0.8cqi, 15px); font-weight: 700; color: var(--ink-soft); width: auto; }
.mw-cst > span.redrawn { color: var(--warn); }
.mw-cst .t { display: grid; gap: 2px; grid-template-columns: repeat(var(--cols), var(--cs)); }
.mw-chiclets .mw-tile { width: var(--cs); height: var(--cs); min-width: 0; min-height: 0; padding: 0;
  font-size: calc(var(--cs) * 0.42); font-weight: 600; border-radius: 3px; }
/* Feed states, in the map's words and close to its marks: Feed waiting is
   dotted; Override only is solid nodata; No live feed is a lighter grey.
   "Awaiting votes" stays a plain tile here -- the map hatches it, but in
   these apps hatching means simulated (Battle). */
.mw-tile.feed-waiting:not(.leading):not(.called) { background: transparent; color: var(--ink-soft);
  border: 1px dotted var(--ink-soft); }
.mw-tile.feed-certified:not(.leading):not(.called) { background: var(--nodata); color: var(--ink); border-color: var(--nodata); }
.mw-tile.feed-none:not(.leading):not(.called) { background: color-mix(in srgb, var(--nodata) 45%, var(--paper));
  color: var(--ink-soft); border-color: transparent; }
.mw-tile.leading.ind { background: color-mix(in srgb, var(--ind) 30%, var(--paper)); border-color: var(--ind); }
.mw-tile.called.ind { background: var(--ind); color: #fff; border-color: var(--ind); }
.mw-key i.novotes { background: var(--paper); border: 1px solid var(--rule); }
.mw-key i.waiting { background: transparent; border: 1px dotted var(--ink-soft); }
.mw-key i.certified { background: var(--nodata); }
.mw-key i.none { background: color-mix(in srgb, var(--nodata) 45%, var(--paper)); }
.mw-key i.leading.ind { background: color-mix(in srgb, var(--ind) 30%, var(--paper)); border: 1px solid var(--ind); }
.mw-key .leading.rep { background: color-mix(in srgb, var(--rep) 32%, var(--paper)); }
.mw-key .called.rep { background: var(--rep); }
.mw-tiles.statewide { display: grid; gap: clamp(3px, 0.4cqi, 8px);
  grid-template-columns: repeat(auto-fill, minmax(clamp(48px, 7cqi, 150px), 1fr)); }
.mw-tiles.statewide .mw-tile { width: auto; height: auto; min-height: 30px; aspect-ratio: 3 / 2;
  font-size: clamp(11px, 1.7cqi, 28px); border-radius: clamp(3px, 0.3cqi, 6px); }
.mw-tiles.statewide .mw-tile small { font-size: clamp(9px, 1cqi, 16px); margin-top: 0.15em; }
.mw-tiles .mw-tile.house { width: clamp(13px, 1.05cqi, 22px); height: clamp(13px, 1.05cqi, 22px); }
.mw-tilewrap .mw-state > span { font-size: clamp(9px, 0.6cqi, 12px); width: clamp(16px, 1.3cqi, 24px); }
/* Battle sizes its tiles to fill the board's height (--fit, set by fit() in
   apps/battle.js): the side of a House square, the narrowest statewide tile. */
.mw-tilewrap.fit .mw-tiles .mw-tile.house { width: var(--fit); height: var(--fit); border-radius: calc(var(--fit) * 0.12); }
.mw-tilewrap.fit.numbered .mw-tiles .mw-tile.house { font-size: calc(var(--fit) * 0.46); font-weight: 600;
  line-height: 1; justify-content: center; align-items: center; font-variant-numeric: tabular-nums; }
.mw-tilewrap.fit .mw-tiles:not(.statewide) { gap: calc(var(--fit) * 0.18); }
.mw-tilewrap.fit .mw-state { gap: calc(var(--fit) * 0.18); margin-right: calc(var(--fit) * 0.45); }
.mw-tilewrap.fit .mw-state > span { font-size: calc(var(--fit) * 0.6); width: calc(var(--fit) * 1.5); }
.mw-tilewrap.fit .mw-tiles.statewide { grid-template-columns: repeat(auto-fill, minmax(var(--fit), 1fr)); }
.mw-tilewrap.fit .mw-tiles.statewide .mw-tile { font-size: calc(var(--fit) * 0.2); }
.mw-tilewrap.fit .mw-tiles.statewide .mw-tile small { font-size: calc(var(--fit) * 0.12); }

.mw-list { margin-top: 14px; border-top: 1px solid var(--rule); padding-top: 10px; }
.mw-list table { border-collapse: collapse; width: 100%; font-size: 13px; }
.mw-list td, .mw-list th { padding: 5px 8px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
.mw-list th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-soft); font-weight: 600; }
.mw-list tr.go { cursor: pointer; }
.mw-list tr.go:hover td { background: var(--accent-soft); }
.mw-list tr.sel td { background: var(--accent-soft); font-weight: 600; }
.mw-chip { display: inline-block; min-width: 18px; text-align: center; font-size: 10px; font-weight: 700; padding: 1px 4px;
  border-radius: 3px; color: #fff; }
.mw-chip.dem { background: var(--dem); } .mw-chip.rep { background: var(--rep); } .mw-chip.other { background: var(--ink-soft); }
.mw-chip.none { background: transparent; color: var(--ink-soft); border: 1px solid var(--rule); }

.mw-key { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11px; color: var(--ink-soft); margin-top: 8px; }

/* Boards: when polls close, one column per closing time. */
.mw-polls { margin-top: 10px; }
.mw-polls.done { padding-block: 8px; }
.mw-polls .pgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; margin-top: 8px; }
.mw-polls .pcol { border-top: 3px solid var(--rule); padding-top: 4px; min-width: 0; }
.mw-polls .pcol.next { border-top-color: var(--accent); }
.mw-polls .pcol.past { opacity: 0.5; }
.mw-polls .pt { font-size: 16px; font-weight: 700; }
.mw-polls .pt span { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-soft); }
.mw-polls .ps { font-size: 11px; color: var(--ink-soft); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mw-polls .pchips { display: flex; flex-wrap: wrap; gap: 3px; }
.mw-polls button.pc { min-height: 26px; padding: 2px 5px; border: 1px solid var(--rule); border-radius: 3px;
  background: var(--paper); color: var(--ink-soft); font: inherit; font-size: 12px; cursor: pointer; line-height: 1.1; }
.mw-polls button.pc.key { color: var(--ink); border-color: var(--ink-soft); }
.mw-polls button.pc b { font-weight: 700; }
.mw-polls button.pc small { margin-left: 2px; font-size: 9px; font-weight: 700; color: var(--accent); vertical-align: super; }
.mw-polls button.pc.part { border-style: dashed; }
.mw-polls button.pc:hover { border-color: var(--ink); }
.mw-polls .mw-key i.pcpart { display: inline-block; width: 14px; height: 10px; border: 1px dashed var(--ink-soft); margin-right: 4px; vertical-align: -1px; }
.mw-key i { display: inline-block; width: 14px; height: 10px; border-radius: 2px; vertical-align: -1px; margin-right: 4px; }
.mw-key .notup.dem { background: color-mix(in srgb, var(--dem) 72%, var(--paper)); }
.mw-key .called.dem { background: var(--dem); }
.mw-key .leading.dem { background: color-mix(in srgb, var(--dem) 32%, var(--paper)); }
.mw-key .und { background: var(--nodata); }

.mw-simbanner { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 12px; border-radius: 6px;
  border: 2px dashed var(--warn); color: var(--ink); background: color-mix(in srgb, var(--warn) 10%, var(--paper)); }
.mw-simbanner .tag { font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--warn); }
.mw-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin-top: 10px; }
.mw-toolbar .grp { display: flex; align-items: center; gap: 6px; }
.mw-toolbar label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-soft); }
.mw-toolbar input[type=number] { width: 64px; font: inherit; min-height: 34px; padding: 4px 6px; color: var(--ink);
  background: var(--paper); border: 1px solid var(--rule); border-radius: 4px; }
.mw-toolbar button.primary { background: var(--accent); color: var(--paper); border-color: var(--accent); font-weight: 600; }
.mw-tabs { display: flex; gap: 0; margin-top: 12px; }
.mw-tabs button { border-radius: 0; }
.mw-tabs button:first-child { border-radius: 4px 0 0 4px; }
.mw-tabs button:last-child { border-radius: 0 4px 4px 0; }
.mw-tabs button + button { border-left: 0; }
.mw-tabs button[aria-pressed="true"] { background: var(--accent); color: var(--paper); border-color: var(--accent); }
.mw-note { font-size: 12px; color: var(--ink-soft); margin: 6px 0 0; }
.mw-note b { color: var(--ink); }
`;
