/* Battle for Control (DESIGN.md §2.4).
 *
 * Tap a seat to set it D, R, or back to live; the counters move. Rules:
 *
 *   * An overlay, never a mutation. Picks live here and in localStorage, are
 *     handed to seats.tally() at draw time, and are never written to the
 *     store, results or calls. A call always beats a pick: a picked seat that
 *     is later called counts as called, and the pick is listed as superseded.
 *   * Simulated seats are hatched -- bar, tile and key -- and the app carries
 *     a SIMULATION banner, so nothing here can be read as a result on camera.
 *   * Scenarios are named, saved, reloaded and deleted; "Clear all" is one tap.
 *     Pre-built: uniform swing of ±N points on the baselines, "No change"
 *     (every seat stays with the party holding it), "2024 vote, 2026 maps",
 *     and "Cook ratings" (data/ratings.js), which
 *     sets every rated Senate, governor and House seat (the House on the 2026
 *     districts, redrawn states included) and leaves the Toss-ups live -- so
 *     the night starts from expectations and only the real contests are left
 *     to tap. "Blank" starts from nothing.
 *
 *   const app = createBattleApp({ el, seats, onSelect });
 *   app.render();
 *
 * Baselines, per seat (data/seats.js): House from baselines/house-2024.json;
 * Senate and governor from the latest prior result for that seat the wall
 * has loaded, else the state's 2024 presidential result, labeled as a proxy.
 */

import { CHAMBERS, LEG_CHAMBERS, LEG_STATES, legState, ALL_CHAMBERS, CHAMBER_TITLES, STATE_NAMES } from "../data/seats.js";
import { ensureStyles, esc, seatBar, seatStatusText, plainText, fmtMargin, stateLabel, caveats, PARTY_SHORT } from "./seatbar.js";
import { RATINGS, HOUSE_LISTED, HOUSE_PVI, pviParty, parseRating, ratingFor, legLabel, ratingSource,
         LEG_RATINGS } from "../data/ratings.js";

const STORE_KEY = "magicwall.battle.v1";
const TITLES = CHAMBER_TITLES;
const isLeg = (c) => LEG_CHAMBERS.includes(c);
// Squares with a district number (the House and the PA chambers), not state tiles.
const isDistrict = (c) => c === "house" || isLeg(c);
const NEXT = { undefined: "dem", dem: "rep", rep: undefined };
// How far down the Cook scale the preset fills: "Lean" fills Solid, Likely
// and Lean; "Solid" fills only the safe seats.
const DEPTH = { Solid: ["Solid"], Likely: ["Solid", "Likely"], Lean: ["Solid", "Likely", "Lean"] };
const SHORT_RATING = { Solid: "Sol", Likely: "Lik", Lean: "Lean", "Toss-up": "Toss" };

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v === "object") {
      return { working: v.working || { picks: {}, name: null }, saved: v.saved || {} };
    }
  } catch (e) { /* private window, blocked storage, a bad edit: start clean */ }
  return { working: { picks: {}, name: null }, saved: {} };
}

function persist(state) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ working: state.working, saved: state.saved }));
    return true;
  } catch (e) {
    return false;
  }
}

export function createBattleApp({ el, seats, onSelect = null }) {
  ensureStyles();
  el.classList.add("mw-seats", "mw-battle");
  const state = { ...load(), chamber: "senate", last: null, message: null,
                  swing: 2, cookDepth: "Lean", storageOk: true };

  /* ------------------------------------------------------- scenarios */

  /** Who a seat goes to with no baseline: the party that holds it. */
  function fallback(s) {
    return s.held === "dem" || s.held === "rep" ? s.held : null;
  }

  // `redrawn`: whether the scenario speaks to the 2026 districts. The swing
  // does not (2024 margins say nothing about a new district); Cook's House
  // ratings, "2024 vote, 2026 maps" (through the 2026 PVI) and "No change"
  // (the seat's holder) do.
  function build(fn, { redrawn = false } = {}) {
    const picks = {};
    for (const c of ALL_CHAMBERS) {
      for (const s of seats.seats(c)) {
        if (s.status === "called") continue;     // live data wins
        if (s.redrawn && !redrawn) continue;
        const p = fn(s);
        if (p === "dem" || p === "rep") picks[s.id] = p;
      }
    }
    return picks;
  }

  const PREBUILT = {
    swing(n) {
      const label = n === 0 ? "no swing" : `${n > 0 ? "D" : "R"}+${Math.abs(n)}`;
      return {
        name: `Uniform swing ${label} on baselines`,
        picks: build((s) => {
          const b = seats.baseline(s);
          if (!b || b.margin == null) return fallback(s);
          const m = b.margin + n;
          return m > 0 ? "dem" : (m < 0 ? "rep" : fallback(s));
        }),
      };
    },
    cook(depth) {
      const keep = DEPTH[depth] || DEPTH.Lean;
      return {
        name: `Cook ratings (${keep.join(", ")})`,
        picks: build((s) => {
          const r = parseRating(ratingFor(s));
          return r && r.party && keep.includes(r.strength) ? r.party : null;
        }, { redrawn: true }),
      };
    },
    // Every seat stays with the party that holds it: the House as elected in
    // 2024 (220 R, 215 D), the Senate and governors as they sit today.
    nochange() {
      return {
        name: "No change",
        picks: build((s) => (s.held === "dem" || s.held === "rep" ? s.held : null), { redrawn: true }),
      };
    },
    // Not the 2024 result: the 2024 vote played out on the 2026 maps.
    repeat() {
      return {
        name: "2024 vote, 2026 maps",
        // A redrawn district's 2024 House result is another district's, so
        // it goes the way its 2026 PVI leans (the 2020 and 2024 presidential
        // vote on the new lines).
        picks: build((s) => {
          if (s.redrawn) return pviParty(HOUSE_PVI[s.label]);
          const b = isDistrict(s.chamber) ? seats.baseline(s) : seats.pres2024(s.state);
          return b ? b.winner : fallback(s);
        }, { redrawn: true }),
      };
    },
  };

  function setWorking(picks, name, from = null) {
    state.working = { picks, name, from, at: new Date().toISOString() };
    state.storageOk = persist(state);
    render();
  }

  /* ----------------------------------------------------------- render */

  function counter(chamber) {
    const t = seats.tally(chamber, state.working.picks);
    const ctl = t.controller
      ? `<div class="ctl ${t.controller.how === "simulated" ? "simulated" : t.controller.party}">${
          PARTY_SHORT[t.controller.party]} control${t.controller.how === "simulated" ? " · sim" : ""}</div>`
      : "<div></div>";
    const rest = t.leading.dem + t.leading.rep + t.leading.other + t.undecided;
    const tb = t.tiebreak ? ` · VP tiebreak ${PARTY_SHORT[t.tiebreak.party]}`
      : (t.tiebreakNote ? ` · Lt. Gov. ${PARTY_SHORT[t.tiebreakNote.party]} breaks procedural ties only` : "");
    return `<section class="mw-card ${state.chamber === chamber ? "active" : ""}" data-tab="${chamber}">
      <header><h3>${TITLES[chamber]}</h3>
        <div class="rule">${t.control ? `${t.need.dem === t.need.rep ? t.majority : `D ${t.need.dem} · R ${t.need.rep}`} for control${tb}` : `${t.seats} states`}</div></header>
      <div class="mw-big">
        <div class="dem"><div class="n">${t.dem.projected}</div><div class="sub">${t.sim.dem} simulated</div></div>
        ${ctl}
        <div class="rep"><div class="n">${t.rep.projected}</div><div class="sub">${t.sim.rep} simulated</div></div>
      </div>
      ${seatBar(t, { sim: true })}
      <div class="mw-und">${rest} not set${t.leading.dem + t.leading.rep ? ` (${t.leading.dem} D / ${t.leading.rep} R leading live)` : ""}
        · flips D ${t.simFlips.dem + t.gained.dem}, R ${t.simFlips.rep + t.gained.rep}
        ${t.superseded.length ? ` · <b>${t.superseded.length} pick${t.superseded.length > 1 ? "s" : ""} overridden by calls</b>` : ""}</div>
    </section>`;
  }

  function tile(s) {
    const pick = state.working.picks[s.id];
    const called = s.status === "called";
    const showPick = pick && !called;
    const cls = ["mw-tile", isDistrict(s.chamber) ? "house" : ""];
    if (called) cls.push("called", s.party, "locked");
    else if (showPick) cls.push("sim", pick);
    else if (s.status === "leading") cls.push("leading", s.party);
    if (state.last === s.id) cls.push("sel");
    if (s.redrawn) cls.push("redrawn");
    if (s.rawParty === "ind" && (called || s.status === "leading")) cls.push("ind");
    cls.push(...caveats(s).cls);
    const b = isDistrict(s.chamber) ? null : seats.baseline(s);
    const rating = ratingFor(s);
    const pr = parseRating(rating);
    const tag = called ? "✓" : (state.working.from === "cook" && pr
      ? `${SHORT_RATING[pr.strength]}${pr.party ? ` ${PARTY_SHORT[pr.party]}` : ""}`
      : (b ? fmtMargin(b.margin) : ""));
    const what = called ? `CALLED: ${plainText(seatStatusText(s))}`
      : showPick ? `SIMULATED ${PARTY_SHORT[pick]}` : plainText(seatStatusText(s));
    const bl = isDistrict(s.chamber) ? seats.baseline(s) : b;
    const title = `${s.label}${s.special ? " (special)" : ""} — held ${PARTY_SHORT[s.held] || "?"} — ${what}` +
      (rating ? ` — ${ratingSource(s)}: ${legLabel(s) || rating}` : "") +
      (bl ? ` — baseline ${fmtMargin(bl.margin)} (${bl.label}${bl.proxy ? ", proxy" : ""})` : " — no baseline") +
      (s.redrawn ? ` — REDRAWN for 2026: held and baseline are the 2024 lines; the swing preset leaves it unset; Cook and "2024 vote, 2026 maps" use the 2026 district (2026 PVI ${HOUSE_PVI[s.label] || "?"})` : "") +
      caveats(s).title;
    return `<button class="${cls.join(" ")}" data-seat="${esc(s.id)}" title="${esc(title)}" aria-label="${esc(title)}">
      ${esc(isDistrict(s.chamber) ? (s.district === "AL" ? "AL" : String(Number(s.district)) + (isLeg(s.chamber) && s.special ? "u" : "")) : s.short)}${tag ? `<small>${esc(tag)}</small>` : ""}</button>`;
  }

  function grid() {
    const list = seats.seats(state.chamber);
    if (isLeg(state.chamber)) return `<div class="mw-tilewrap"><div class="mw-tiles">${list.map(tile).join("")}</div></div>`;
    if (state.chamber !== "house") return `<div class="mw-tilewrap"><div class="mw-tiles statewide">${list.map(tile).join("")}</div></div>`;
    const by = new Map();
    for (const s of list) { if (!by.has(s.state)) by.set(s.state, []); by.get(s.state).push(s); }
    return `<div class="mw-tilewrap"><div class="mw-tiles">${[...by].map(([st, ss]) =>
      `<div class="mw-state">${stateLabel(st, ss)}${ss.map(tile).join("")}</div>`).join("")}</div></div>`;
  }

  function lastLine() {
    if (!state.last) return `<p class="mw-note">Tap a seat: once for D, twice for R, a third time to hand it back to live. Called seats are locked.</p>`;
    const s = seats.seat(state.last);
    if (!s) return "";
    const pick = state.working.picks[s.id];
    const b = seats.baseline(s);
    return `<p class="mw-note"><b>${esc(isDistrict(s.chamber) ? s.label : STATE_NAMES[s.state] || s.state)}</b>${s.incumbent ? ` ${esc(s.incumbent)}` : ""}
      ${s.special ? "(special) " : ""}${s.redrawn ? `<span class="mw-redrawn-tag">redrawn for 2026</span> ` : ""}· held ${PARTY_SHORT[s.held] || "?"}${s.redrawn ? " (2024 lines)" : ""} ·
      ${s.status === "called" ? seatStatusText(s) : (pick ? `<b>simulated ${PARTY_SHORT[pick]}</b> · live: ${seatStatusText(s)}` : `live: ${seatStatusText(s)}`)}
      · baseline ${b ? `${fmtMargin(b.margin)} (${esc(b.label)}${b.proxy ? ", proxy for this seat" : ""})` : "none"}
      ${ratingFor(s) ? `· ${ratingSource(s)}: <b>${esc(legLabel(s) || ratingFor(s))}</b>` : ""}
      ${onSelect ? ` <button data-act="map">Show on map</button>` : ""}</p>`;
  }

  /** "220 R, 215 D": who holds the chamber's seats now. */
  function heldLine(chamber) {
    const n = { dem: 0, rep: 0 };
    for (const s of seats.seats(chamber)) if (n[s.held] != null) n[s.held]++;
    return `${n.rep} R, ${n.dem} D`;
  }

  /** What the redrawn maps are worth: their seats' 2024 holders against the
   * way the new districts lean, as "a net 9 seats to R". */
  function redistrictShift() {
    let net = 0;   // + toward R
    for (const s of seats.seats("house")) {
      if (!s.redrawn) continue;
      const now = pviParty(HOUSE_PVI[s.label]);
      net += (now === "rep") - (s.held === "rep");
    }
    return net === 0 ? "no seats on net" : `a net ${Math.abs(net)} seat${Math.abs(net) > 1 ? "s" : ""} to ${net > 0 ? "R" : "D"}`;
  }

  function toolbar() {
    const names = Object.keys(state.saved).sort();
    const opts = names.map((n) => `<option value="${esc(n)}" ${state.working.name === n ? "selected" : ""}>${esc(n)}</option>`).join("");
    return `<div class="mw-toolbar">
      <div class="grp"><label>Start from</label>
        <button data-act="cook" title="Cook Political Report: Senate ${RATINGS.as_of.senate}, governors ${RATINGS.as_of.governor}, House ${RATINGS.as_of.house} (2026 districts); PA and WV legislatures from StateNavigate (PA ${LEG_RATINGS.as_of_state.PA}, WV ${LEG_RATINGS.as_of_state.WV}). Toss-ups stay live.">Cook ratings</button>
        <select id="mwCookDepth" title="How far down the Cook scale to fill">
          ${Object.keys(DEPTH).reverse().map((d) => `<option value="${d}" ${state.cookDepth === d ? "selected" : ""}>${DEPTH[d].join(" + ")}</option>`).join("")}
        </select>
        <button data-act="blank" title="Every seat back to live">Blank</button></div>
      <div class="grp"><label>Rest of the ${TITLES[state.chamber]}</label>
        <button data-act="rest" data-party="dem" title="Every ${TITLES[state.chamber]} seat not yet set or called goes D; seats already set stay as they are">to D</button>
        <button data-act="rest" data-party="rep" title="Every ${TITLES[state.chamber]} seat not yet set or called goes R; seats already set stay as they are">to R</button></div>
      <div class="grp"><label for="mwSwing">Swing</label>
        <input id="mwSwing" type="number" min="-30" max="30" step="0.5" value="${state.swing}" title="Points of margin; positive toward D">
        <button data-act="swing" data-sign="1">D+</button><button data-act="swing" data-sign="-1">R+</button></div>
      <button data-act="nochange" title="Every seat stays with the party that holds it now: the House as elected in 2024 (${heldLine("house")}), the Senate and governors as they sit today">No change</button>
      <button data-act="repeat" title="What if 2026 votes like 2024, on the new maps? House: each district's 2024 House winner; in the redrawn states (${[...seats.redrawn].sort().join(", ")}), the way the new district leans (2026 Cook PVI), which moves ${redistrictShift()}. Senate and governors: the state's 2024 presidential winner, not the seat's own last result.">2024 vote, 2026 maps</button>
      <div class="grp"><label for="mwSaved">Saved</label>
        <select id="mwSaved"><option value="">—</option>${opts}</select>
        <button data-act="load">Load</button><button data-act="delete">Delete</button></div>
      <div class="grp"><input id="mwName" type="text" placeholder="Name this scenario" value="${esc(state.working.name || "")}"
        style="font:inherit;min-height:34px;padding:4px 8px;border:1px solid var(--rule);border-radius:4px;background:var(--paper);color:var(--ink);width:200px">
        <button data-act="save">Save</button></div>
    </div>`;
  }

  function render() {
    if (el.hidden || !el.isConnected) return;
    const y = el.scrollTop;
    const nPicks = Object.keys(state.working.picks).length;
    const superseded = [];
    for (const c of ALL_CHAMBERS) superseded.push(...seats.tally(c, state.working.picks).superseded);
    // Tabs: the three federal chambers, then each state legislature that has
    // seats, a gap before each state's pair. The count cards follow the tab:
    // the three federal ones, or that state's pair.
    const legOn = LEG_CHAMBERS.filter((c) => seats.seats(c).length);
    const cardSet = isLeg(state.chamber) ? LEG_STATES[legState(state.chamber)] : CHAMBERS;
    const firstOfState = new Set(Object.values(LEG_STATES).map((cs) => cs.find((c) => legOn.includes(c))));
    const msg = state.message ? `<span class="hint">${esc(state.message)}</span>` : "";
    el.innerHTML = `
      <div class="mw-simbanner">
        <span class="tag">Simulation · not results</span>
        <span><b>${esc(state.working.name || "Unsaved scenario")}</b> · ${nPicks} seat${nPicks === 1 ? "" : "s"} set by hand or scenario · hatched seats are simulated</span>
        <span style="flex:1"></span>${msg}
        <button class="primary" data-act="clear">Clear all</button>
      </div>
      ${toolbar()}
      ${state.storageOk ? "" : `<p class="mw-note" style="color:var(--warn)">This browser is not saving scenarios (storage blocked); they last until reload.</p>`}
      <div class="mw-tabs">${[...CHAMBERS, ...legOn].map((c) =>
        `<button data-tab="${c}" aria-pressed="${state.chamber === c}"${firstOfState.has(c) ? ' style="margin-left:12px;border-radius:4px 0 0 4px"' : ""}>${TITLES[c]}</button>`).join("")}</div>
      <div class="mw-cards">${cardSet.map(counter).join("")}</div>
      ${lastLine()}
      ${grid()}
      ${superseded.length ? `<p class="mw-note">Overridden by calls (live wins): ${superseded.map(esc).join(", ")}</p>` : ""}
      <div class="mw-key"><span><i class="sim dem"></i><i class="sim rep"></i>simulated</span>
        <span><i class="called dem"></i>called (locked)</span><span><i class="leading dem"></i>leading, not set</span>
        <span><i class="und"></i>undecided</span>
        ${seats.seats(state.chamber).some((s) => s.partial) ? `<span><i class="partial"></i>partial count: some counties only</span>` : ""}
        ${state.chamber === "house" && seats.seats("house").some((s) => s.firstRound) ? `<span><i class="firstround"></i>open first round: runoff below 50%</span>` : ""}
        ${seats.redrawn.size ? `<span><i class="redrawn"></i>House redrawn for 2026 (${[...seats.redrawn].sort().join(", ")}): "2024 vote, 2026 maps" uses their 2026 PVI; the swing leaves them unset</span>` : ""}
        <span>Tile figure: ${state.working.from === "cook" ? "Cook rating (Sol, Lik, Lean, Toss)" : "baseline margin"}. No baseline: seat goes to its holder.
        Cook ratings: Senate ${esc(RATINGS.as_of.senate)}, governors ${esc(RATINGS.as_of.governor)}, House ${esc(RATINGS.as_of.house)} on the 2026 districts (${HOUSE_LISTED.size} read from the competitive list; the rest, safe with every forecaster, are Solid for their 2026 PVI party).
        PA and WV legislatures: StateNavigate forecast, PA ${esc(LEG_RATINGS.as_of_state.PA)}, WV ${esc(LEG_RATINGS.as_of_state.WV)} (Very Likely counts as Likely; Tilt as Toss-up).</span></div>`;
    fit();
    el.scrollTop = y;
  }

  /** Grow the tiles until the board fills the height it is given: the
   * section's own height on the wall, the window below it in the harness.
   * Bigger tiles only ever make the grid taller (more rows, taller rows),
   * so a binary search on the size finds the largest that still fits; when
   * even the smallest does not, the section scrolls as before. */
  function fit() {
    const wrap = el.querySelector(".mw-tilewrap");
    if (!wrap || el.hidden || !el.offsetParent) return;
    const house = isDistrict(state.chamber);
    // On the wall the section has a height of its own (its stage area); in
    // the harness it grows with its content, so the window is the limit.
    // Tell them apart by whether the height moves when the grid is taken out.
    const full = el.clientHeight;
    wrap.style.display = "none";
    const fixed = el.clientHeight === full;
    wrap.style.display = "";
    const box = fixed ? full : window.innerHeight - Math.max(0, el.getBoundingClientRect().top);
    const fits = (px) => { wrap.style.setProperty("--fit", `${px}px`); return el.scrollHeight <= box + 1; };
    wrap.classList.add("fit");
    wrap.classList.remove("numbered");
    let lo = house ? 13 : 48, hi = house ? 96 : 420;
    if (!fits(lo)) return;
    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid; else hi = mid;
    }
    fits(Math.floor(lo));
    // A House square shows its district number once it is big enough to read.
    wrap.classList.toggle("numbered", house && Math.floor(lo) >= 18);
  }
  let fitQueued = false;
  new ResizeObserver(() => {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => { fitQueued = false; fit(); });
  }).observe(el);

  function flash(m) {
    state.message = m;
    render();
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { state.message = null; render(); }, 4000);
  }

  /* ----------------------------------------------------------- events */

  el.addEventListener("click", (ev) => {
    const tab = ev.target.closest("[data-tab]");
    const seatEl = ev.target.closest("[data-seat]");
    const act = ev.target.closest("[data-act]");
    if (seatEl) {
      const s = seats.seat(seatEl.dataset.seat);
      if (!s) return;
      state.last = s.id;
      if (s.status === "called") { flash(`${s.label} is called (${s.call.by}); live data wins`); return; }
      const picks = { ...state.working.picks };
      const next = NEXT[picks[s.id]];
      if (next) picks[s.id] = next; else delete picks[s.id];
      setWorking(picks, state.working.name, state.working.from);
      return;
    }
    if (act) {
      const a = act.dataset.act;
      const swing = Number(el.querySelector("#mwSwing").value);
      state.cookDepth = el.querySelector("#mwCookDepth").value || state.cookDepth;
      if (Number.isFinite(swing)) state.swing = swing;
      if (a === "clear" || a === "blank") { setWorking({}, null); flash("Cleared: every seat is back to live"); }
      else if (a === "cook") {
        const s = PREBUILT.cook(state.cookDepth);
        setWorking(s.picks, s.name, "cook");
        flash("Cook ratings set for Senate, governors and House, StateNavigate for the PA and WV legislatures; Toss-ups are left to you");
      }
      else if (a === "rest") {
        // Only the seats still open in this tab; every pick already made stays.
        const party = act.dataset.party;
        const picks = { ...state.working.picks };
        let n = 0;
        for (const s of seats.seats(state.chamber)) {
          if (s.status === "called" || picks[s.id]) continue;
          picks[s.id] = party; n++;
        }
        const step = `rest of the ${TITLES[state.chamber]} to ${PARTY_SHORT[party]}`;
        setWorking(picks, state.working.name ? `${state.working.name} + ${step}` : step, state.working.from);
        flash(n ? `${n} open ${TITLES[state.chamber]} seat${n > 1 ? "s" : ""} set ${PARTY_SHORT[party]}` : `No open ${TITLES[state.chamber]} seats left`);
      } else if (a === "swing") {
        const s = PREBUILT.swing(Math.abs(state.swing) * Number(act.dataset.sign));
        setWorking(s.picks, s.name, "swing");
      } else if (a === "nochange") {
        const s = PREBUILT.nochange();
        setWorking(s.picks, s.name, "nochange");
      } else if (a === "repeat") {
        const s = PREBUILT.repeat();
        setWorking(s.picks, s.name, "repeat");
      } else if (a === "save") {
        const name = (el.querySelector("#mwName").value || "").trim();
        if (!name) { flash("Give the scenario a name first"); return; }
        state.saved[name] = { picks: { ...state.working.picks }, saved_at: new Date().toISOString(),
                              from: state.working.from || null };
        setWorking(state.working.picks, name, state.working.from);
        flash(`Saved “${name}”`);
      } else if (a === "load") {
        const name = el.querySelector("#mwSaved").value;
        const s = state.saved[name];
        if (s) setWorking({ ...s.picks }, name, s.from);
      } else if (a === "delete") {
        const name = el.querySelector("#mwSaved").value;
        if (!name || !state.saved[name]) return;
        delete state.saved[name];
        setWorking(state.working.picks, state.working.name === name ? null : state.working.name, state.working.from);
        flash(`Deleted “${name}”`);
      } else if (a === "map") {
        const s = state.last && seats.seat(state.last);
        if (s && onSelect) onSelect(s.raceId, s);
      }
      return;
    }
    if (tab) { state.chamber = tab.dataset.tab; render(); }
  });

  seats.onChange(() => render());

  return {
    render,
    /** The current picks, for a caller that wants to show them elsewhere. */
    picks() { return { ...state.working.picks }; },
    clear() { setWorking({}, null); },
  };
}
