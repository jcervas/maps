/* Boards: the three counters (DESIGN.md §2.3), and the state legislatures
 * the wall counts under them, a row per state (data/seats.js LEG_STATES).
 *
 * Above them, when polls close (data/reference/poll_close_2026.json): one
 * column per closing time in Eastern time, each state's races, and a
 * countdown to the next close. `?pollclock=2026-11-03T19:45-05:00` in the
 * page URL starts that clock at another time, for rehearsal.
 *
 * Senate, House and governors, each showing seats not up, seats defended,
 * called, leading, net gain and undecided, with the bar. Every number comes
 * from data/seats.js -- registry, results, holdovers, calls.json -- and none
 * is typed here.
 *
 *   const app = createBoardsApp({ el, seats, onSelect });
 *   app.render();            // after a poll, or when the app is shown
 *
 * Clicking a count lists the races in it; clicking a race (in the list or
 * as a tile) selects it and calls onSelect(raceId), which the shell uses to
 * send the map there. A hidden `el` skips rendering; call render() on show.
 */

import { CHAMBERS, LEG_CHAMBERS, LEG_STATES, CHAMBER_TITLES, STATE_NAMES } from "../data/seats.js";
import { ensureStyles, esc, seatBar, seatStatusText, plainText, fmtMargin, stateLabel, caveats, PARTY_SHORT } from "./seatbar.js";

const TITLES = CHAMBER_TITLES;
const isLeg = (c) => LEG_CHAMBERS.includes(c);
const CATS = {
  called: "Called", leading: "Leading", defending: "Defending", flips: "Pickups",
  undecided: "Undecided", reporting: "Reporting votes", all: "All seats up",
};

export function createBoardsApp({ el, seats, onSelect = null }) {
  ensureStyles();
  el.classList.add("mw-seats", "mw-boards");
  let pick = { chamber: "senate", cat: null, party: null };
  let selected = null;

  function inCat(s, cat, party) {
    switch (cat) {
      case "called": return s.status === "called" && (!party || s.party === party);
      case "leading": return s.status === "leading" && (!party || s.party === party);
      case "defending": return s.held === party;
      case "flips": return s.status === "called" && s.flip && (!party || s.party === party);
      case "undecided": return s.status === "undecided";
      case "reporting": return !!(s.live && s.live.votes > 0);
      default: return true;
    }
  }

  function n(v) { return v ? String(v) : "<span class=hint>0</span>"; }
  function signed(v) { return v > 0 ? `+${v}` : (v < 0 ? `&minus;${-v}` : "0"); }

  function catButton(chamber, cat, party, label) {
    const on = pick.chamber === chamber && pick.cat === cat && pick.party === party;
    return `<button class="cat" data-chamber="${chamber}" data-cat="${cat}" data-party="${party || ""}"
      aria-pressed="${on}">${label}</button>`;
  }

  function ruleText(t) {
    if (t.chamber === "senate") {
      const tb = t.tiebreak ? ` · VP ${esc(t.tiebreak.name)} breaks a 50–50 tie (${PARTY_SHORT[t.tiebreak.party]})` : "";
      return `${t.majority} for control${tb}`;
    }
    if (t.chamber === "house") return `${t.majority} for control · all ${t.seats} up`;
    if (isLeg(t.chamber)) {
      const tb = t.tiebreakNote ? ` · Lt. Gov. ${esc(t.tiebreakNote.name)} (${PARTY_SHORT[t.tiebreakNote.party]}) breaks procedural ties only` : "";
      return t.seats_up === t.seats ? `${t.majority} for control · all ${t.seats} up`
        : `${t.majority} for control · ${t.seats_up} of ${t.seats} up${tb}`;
    }
    return `${t.seats} states · ${t.seats_up} up`;
  }

  function card(chamber) {
    const t = seats.tally(chamber);
    const list = seats.seats(chamber);
    const ctl = t.controller
      ? `<div class="ctl ${t.controller.party}">${PARTY_SHORT[t.controller.party]} control</div>` : "<div></div>";
    const lead = (p) => t.leading[p] ? `+${t.leading[p]} leading` : "&nbsp;";
    const rows = (cat, label, f) => `
      <div>${catButton(chamber, cat, null, label)}</div>
      <div class="d">${catButton(chamber, cat, "dem", f("dem"))}</div>
      <div class="r">${catButton(chamber, cat, "rep", f("rep"))}</div>`;
    const tiles = chamber === "house" || isLeg(chamber) ? "" : list.map((s) => tile(s)).join("");
    const leg = isLeg(chamber);
    return `<section class="mw-card ${pick.chamber === chamber ? "active" : ""}" data-chamber="${chamber}">
      <header><h3>${TITLES[chamber]}</h3><div class="rule">${ruleText(t)}</div></header>
      <div class="mw-big">
        <div class="dem"><div class="n">${t.dem.secured}</div><div class="sub">${lead("dem")}</div></div>
        ${ctl}
        <div class="rep"><div class="n">${t.rep.secured}</div><div class="sub">${lead("rep")}</div></div>
      </div>
      ${seatBar(t)}
      <div class="mw-rows">
        <div class="h"></div><div class="h" style="text-align:right">Dem</div><div class="h" style="text-align:right">Rep</div>
        ${chamber === "house" || (leg && !(t.notUp.dem + t.notUp.rep)) ? "" : `<div>Not up</div><div class="d">${n(t.notUp.dem)}</div><div class="r">${n(t.notUp.rep)}</div>`}
        ${rows("defending", chamber === "house" ? "Held after 2024" : (leg ? "Held now" : "Defending"), (p) => n(t.defending[p]))}
        ${rows("called", "Called", (p) => n(t.called[p]))}
        ${rows("leading", "Leading", (p) => n(t.leading[p]))}
        ${rows("flips", "Net gain", (p) => signed(t[p].net))}
      </div>
      <div class="mw-und">
        ${catButton(chamber, "undecided", null, `${t.undecided} undecided`)}
        · ${catButton(chamber, "reporting", null, `${t.reportingAny} of ${t.seats_up} reporting votes`)}
        ${t.notUp.other + t.called.other + t.leading.other
          ? ` · ${t.notUp.other + t.called.other + t.leading.other} other/independent` : ""}
      </div>
      ${chamber === "house"
        ? `<p class="mw-note">Every district, by state, is in the grid below.</p>`
        : leg ? legGrid(list)
        : `<div class="mw-tilewrap"><div class="mw-tiles statewide">${tiles}</div></div>`}
      ${t.warnings.length ? `<div class="mw-warn"><ul>${t.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
    </section>`;
  }

  function tileClass(s) {
    return [
      "mw-tile", s.chamber === "house" ? "house" : "", s.status, s.party || "",
      s.flip && s.status === "called" ? "flip" : "", selected === s.id ? "sel" : "",
      s.redrawn ? "redrawn" : "", ...caveats(s).cls,
      s.rawParty === "ind" && s.status !== "undecided" ? "ind" : "",
    ].join(" ");
  }

  function tile(s) {
    const sub = s.status === "called" ? "✓" : (s.status === "leading" && s.live.reporting != null
      ? `${Math.round(s.live.reporting)}%` : "");
    const title = `${s.label}${s.special ? " (special)" : ""} — held ${PARTY_SHORT[s.held] || "?"}: ${plainText(seatStatusText(s))}` +
      (s.redrawn ? " — REDRAWN for 2026: held and baseline are the 2024 lines" : "") + caveats(s).title;
    return `<button class="${tileClass(s)}" data-seat="${esc(s.id)}" title="${esc(title)}">
      ${esc(s.short)}${sub ? `<small>${sub}</small>` : ""}</button>`;
  }

  /* A legislative chamber's districts up this year, numbered, in rows. */
  function legGrid(list) {
    if (!list.length) return "";
    const cols = Math.min(list.length, Math.ceil(Math.sqrt(list.length * 2.2)));
    return `<div class="mw-chiclets"><div class="grid"><div class="mw-cst">
      <div class="t" style="--cols:${cols}">${list.map(chiclet).join("")}</div></div></div></div>`;
  }

  /* The 435 chiclets: one tile per 2026 district, grouped by state, each
   * state a small block so a big delegation (CA 52, TX 38) stays readable. */
  // Same words as the map's House 2026 key.
  const FEED_TEXT = { live: "", waiting: "feed waiting", certified: "override only (certified results, after the night)", none: "no live feed" };

  function chiclet(s) {
    // An unexpired-term seat shares its district's number: "3u".
    const num = s.district === "AL" ? "AL" : String(Number(s.district)) + (isLeg(s.chamber) && s.special ? "u" : "");
    const cls = [tileClass(s), `feed-${s.feed}`];
    if (s.feed === "live" && !(s.live && s.live.votes > 0) && s.status === "undecided") cls.push("novotes");
    const feed = s.feed !== "live" ? ` — ${FEED_TEXT[s.feed]}${s.feedWhy ? ` (${s.feedWhy})` : ""}` : "";
    const who = isLeg(s.chamber) ? `held ${PARTY_SHORT[s.held] || "?"}${s.incumbent ? ` (${s.incumbent})` : ""}`
      : `held ${PARTY_SHORT[s.held] || "?"} after 2024`;
    const title = `${s.label} — ${who}: ${plainText(seatStatusText(s))}` +
      feed + (s.redrawn ? " — REDRAWN for 2026: held is the 2024 lines" : "") + caveats(s).title;
    return `<button class="${cls.join(" ")}" data-seat="${esc(s.id)}" title="${esc(title)}" aria-label="${esc(title)}">${num}</button>`;
  }

  function chiclets() {
    const list = seats.seats("house");
    if (!list.length) return "";
    const by = new Map();
    for (const s of list) { if (!by.has(s.state)) by.set(s.state, []); by.get(s.state).push(s); }
    const count = (f) => list.filter(f).length;
    const reporting = count((s) => s.live && s.live.votes > 0);
    const waiting = count((s) => s.feed === "waiting");
    const nofeed = count((s) => s.feed === "certified" || s.feed === "none");
    const nofeedStates = [...new Set(list.filter((s) => s.feed === "certified" || s.feed === "none").map((s) => s.state))];
    const blocks = [...by].map(([st, ss]) => {
      const n = ss.length;
      const cols = n <= 4 ? n : Math.ceil(Math.sqrt(n * 1.5));
      return `<div class="mw-cst" title="${esc(STATE_NAMES[st] || st)}">${stateLabel(st, ss)}
        <div class="t" style="--cols:${cols}">${ss.map(chiclet).join("")}</div></div>`;
    }).join("");
    return `<section class="mw-card mw-chiclets">
      <header><h3>House 2026 · every district</h3>
        <div class="rule">${reporting} of ${list.length} reporting votes · ${waiting} feed waiting · ${nofeed} no live feed${
          nofeedStates.length ? ` (${nofeedStates.join(", ")})` : ""}</div></header>
      <div class="grid">${blocks}</div>
      <div class="mw-key"><span><i class="called dem"></i><i class="called rep"></i>called</span>
        <span><i class="leading dem"></i><i class="leading rep"></i>leading</span>
        ${list.some((s) => s.rawParty === "ind") ? `<span><i class="leading ind"></i>independent</span>` : ""}
        <span><i class="novotes"></i>awaiting votes</span>
        <span><i class="waiting"></i>feed waiting</span>
        ${list.some((s) => s.feed === "certified") ? `<span><i class="certified"></i>override only (certified results)</span>` : ""}
        ${list.some((s) => s.feed === "none") ? `<span><i class="none"></i>no live feed</span>` : ""}
        ${keyCaveats()}
        ${seats.redrawn.size ? `<span><i class="redrawn"></i>redrawn for 2026 (${[...seats.redrawn].sort().join(", ")}*)</span>` : ""}
        <span>Tap a district to send the map there.</span></div>
    </section>`;
  }

  /* ------------------------------------------------- when polls close */

  const ET_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short",
    hour: "numeric", minute: "2-digit" });
  // "7:30 pm", "8 pm"; with the day, "Tue 6 pm".
  function etTime(ms, day = false) {
    const p = Object.fromEntries(ET_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const t = `${p.hour}${p.minute === "00" ? "" : `:${p.minute}`} ${(p.dayPeriod || "").toLowerCase()}`;
    return day ? `${p.weekday} ${t}` : t;
  }
  function until(ms) {
    const m = Math.ceil(ms / 60000);
    if (m >= 1440) return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
    if (m >= 60) return `${Math.floor(m / 60)} h ${m % 60} min`;
    return `${m} min`;
  }
  // A rehearsal clock: ?pollclock=<ISO time> starts there and runs on.
  const clockShift = (() => {
    try {
      const q = new URLSearchParams(location.search).get("pollclock");
      const at = q ? Date.parse(q) : NaN;
      return Number.isFinite(at) ? at - Date.now() : 0;
    } catch (e) { return 0; }
  })();
  const now = () => Date.now() + clockShift;

  /* Races up in each state: { PA: { senate: [...], governor: [...], house: [...] } }. */
  function racesByState() {
    const by = {};
    for (const c of CHAMBERS) {
      for (const s of seats.seats(c)) {
        const st = (by[s.state] ||= { senate: [], governor: [], house: [] });
        st[c].push(s);
      }
    }
    return by;
  }

  function raceLine(r) {
    if (!r) return "no federal or governor race";
    return [r.senate.length && `Senate${r.senate.length > 1 ? ` (${r.senate.length})` : ""}`,
      r.governor.length && "governor", r.house.length && `${r.house.length} House`].filter(Boolean).join(", ");
  }

  function polls() {
    const pc = seats.pollClose;
    if (!pc || !pc.states) return "";
    const t0 = now();
    const races = racesByState();
    const slots = new Map();   // ms -> { all: [st], part: [st] }
    const slot = (iso) => {
      const ms = Date.parse(iso);
      if (!slots.has(ms)) slots.set(ms, { all: [], part: [] });
      return slots.get(ms);
    };
    for (const [st, p] of Object.entries(pc.states)) {
      slot(p.close).all.push(st);
      if (p.first) slot(p.first).part.push(st);
    }
    const times = [...slots.keys()].sort((a, b) => a - b);
    const last = times[times.length - 1];
    const next = times.find((ms) => ms > t0);
    const unverified = pc.verified ? "" : ` · <span style="color:var(--warn)" title="${esc(pc.source || "")}">times not yet checked</span>`;

    if (next == null) {
      return `<section class="mw-card mw-polls done"><header><h3>Polls close</h3>
        <div class="rule">All polls closed at ${etTime(last)} ET${unverified}</div></header></section>`;
    }
    const nx = slots.get(next);
    const day = t0 < times[0] - 12 * 3600e3;
    const status = t0 < times[0]
      ? `First polls close ${etTime(times[0], day)} ET, in ${until(times[0] - t0)}`
      : `Now ${etTime(t0)} ET · next: ${etTime(next)}, in ${until(next - t0)} · ${nx.all.length} state${nx.all.length === 1 ? "" : "s"}`;

    const chip = (st, part) => {
      const p = pc.states[st], r = races[st];
      const done = Date.parse(p.close) <= t0;
      const started = p.first && Date.parse(p.first) <= t0;
      const marks = r ? `${r.senate.length ? "S" : ""}${r.governor.length ? "G" : ""}` : "";
      const when = p.first
        ? `first polls close ${etTime(Date.parse(p.first))} ET, last ${etTime(Date.parse(p.close))} ET (${p.note || "split state"})`
        : `polls close ${etTime(Date.parse(p.close))} ET`;
      const title = `${STATE_NAMES[st] || st}: ${when}. Up: ${raceLine(r)}.${part ? " Only part of the state closes here." : ""}`;
      const cls = ["pc", part ? "part" : "", done ? "closed" : (started ? "partclosed" : ""), marks ? "key" : ""].join(" ");
      return `<button class="${cls}" data-pstate="${st}" title="${esc(title)}" aria-label="${esc(title)}"><b>${st}</b>${
        marks ? `<small>${marks}</small>` : ""}</button>`;
    };
    const cols = times.map((ms) => {
      const s = slots.get(ms);
      const all = s.all.sort(), part = s.part.sort();
      const count = (c) => all.reduce((n, st) => n + ((races[st] || {})[c] || []).length, 0);
      const sums = [count("senate") && `${count("senate")} Sen`, count("governor") && `${count("governor")} Gov`,
        count("house") && `${count("house")} House`].filter(Boolean).join(" · ");
      const state = ms <= t0 ? "past" : (ms === next ? "next" : "");
      return `<div class="pcol ${state}">
        <div class="pt">${etTime(ms)}${state === "past" ? ` <span>closed</span>` : ""}</div>
        <div class="ps" title="${esc(sums)}">${sums || "&nbsp;"}</div>
        <div class="pchips">${all.map((st) => chip(st, false)).join("")}${part.map((st) => chip(st, true)).join("")}</div>
      </div>`;
    }).join("");
    return `<section class="mw-card mw-polls">
      <header><h3>Polls close · Eastern time</h3><div class="rule">${status}${unverified}</div></header>
      <div class="pgrid">${cols}</div>
      <div class="mw-key"><span><b>S</b> Senate race · <b>G</b> governor race</span>
        <span><i class="pcpart"></i>part of a state split across time zones</span>
        <span>Counts are races whose last polls close then. Tap a state to send the map there.</span></div>
    </section>`;
  }

  function listPanel() {
    if (!pick.cat) {
      return `<div class="mw-list"><div class="hint">Tap a count or a seat to list races. Tapping a race sends the map there.</div></div>`;
    }
    const all = seats.seats(pick.chamber);
    const rows = all.filter((s) => inCat(s, pick.cat, pick.party));
    const partyLabel = pick.party ? ` · ${PARTY_SHORT[pick.party]}` : "";
    const body = rows.length ? rows.map((s) => {
      const b = seats.baseline(s);
      return `<tr class="go ${selected === s.id ? "sel" : ""}" data-seat="${esc(s.id)}">
        <td>${esc(s.chamber === "house" || isLeg(s.chamber) ? s.label : (STATE_NAMES[s.state] || s.state))}${s.incumbent ? ` <span class=hint>${esc(s.incumbent)}</span>` : ""}${s.special ? " <span class=hint>(special)</span>" : ""}${s.redrawn ? ` <span class="mw-redrawn-tag" title="Redrawn for 2026: held and last result are the 2024 lines">redrawn</span>` : ""}</td>
        <td><span class="mw-chip ${s.held || "none"}">${PARTY_SHORT[s.held] || "?"}</span></td>
        <td>${s.party ? `<span class="mw-chip ${s.party}">${PARTY_SHORT[s.rawParty] || "?"}</span> ` : ""}${seatStatusText(s)}</td>
        <td class="hint">${b ? `${fmtMargin(b.margin)} <span title="${esc(b.label)}">${esc(b.label)}</span>` : "—"}</td>
      </tr>`;
    }).join("") : `<tr><td colspan="4" class="hint">None.</td></tr>`;
    return `<div class="mw-list">
      <h2>${TITLES[pick.chamber]} · ${CATS[pick.cat]}${partyLabel} <span class="hint">(${rows.length})</span></h2>
      <table><thead><tr><th>Seat</th><th>Held</th><th>Now</th><th>Last result</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }

  function header() {
    const cs = seats.calls.status();
    const callLine = cs.error
      ? `<span style="color:var(--bad)">calls.json unreadable (${esc(cs.error)}); showing the last good set of ${cs.count}</span>`
      : `${cs.count} call${cs.count === 1 ? "" : "s"} in calls.json`;
    return `<div><h2>Boards</h2>
      <div class="hint">Called seats come only from calls.json, each with who called it and when; nothing here calls a race from the count. ${callLine}.</div></div>`;
  }

  function key() {
    return `<div class="mw-key">
      <span><i class="notup dem"></i>not up</span><span><i class="called dem"></i>called</span>
      <span><i class="leading dem"></i>leading</span><span><i class="und"></i>undecided</span>
      ${seats.redrawn.size ? `<span><i class="redrawn"></i>redrawn for 2026 (${[...seats.redrawn].sort().join(", ")}): held and last result are the old lines</span>` : ""}
      ${keyCaveats()}
      <span>House “held” = 2024 winner of the same-numbered district</span></div>`;
  }

  function keyCaveats() {
    const hs = seats.seats("house");
    const ps = CHAMBERS.flatMap((c) => seats.seats(c)).filter((s) => s.partial);
    return (ps.length ? `<span><i class="partial"></i>partial count (${[...new Set(ps.map((s) => s.state))].join(", ")}): some counties only</span>` : "") +
      (hs.some((s) => s.firstRound) ? `<span><i class="firstround"></i>open first round (${[...new Set(hs.filter((s) => s.firstRound).map((s) => s.state))].join(", ")}): runoff below 50%</span>` : "");
  }

  function render() {
    if (el.hidden || !el.isConnected) return;
    const y = el.scrollTop;
    const legRow = Object.entries(LEG_STATES).filter(([, cs]) => cs.some((c) => seats.seats(c).length))
      .map(([st, cs]) => `<h2 class="mw-subhead">${STATE_NAMES[st] || st} legislature</h2><div class="mw-cards">${cs.map(card).join("")}</div>`).join("");
    el.innerHTML = `${header()}${polls()}<div class="mw-cards">${CHAMBERS.map(card).join("")}</div>${key()}${legRow}${chiclets()}${listPanel()}`;
    el.scrollTop = y;
  }

  function selectSeat(id, notify) {
    const s = seats.seat(id);
    if (!s) return;
    selected = s.id;
    // Keep the open list if the seat is in it; otherwise list its own kind
    // (all of a statewide chamber; the seat's status for the 435).
    if (pick.chamber !== s.chamber || !pick.cat || !inCat(s, pick.cat, pick.party)) {
      pick = s.chamber !== "house" && !isLeg(s.chamber) ? { chamber: s.chamber, cat: "all", party: null }
        : { chamber: s.chamber, cat: s.status, party: s.status === "undecided" ? null : s.party };
    }
    render();
    if (notify && onSelect) onSelect(s.raceId, s);
  }

  el.addEventListener("click", (ev) => {
    const cat = ev.target.closest("button.cat");
    if (cat) {
      const next = { chamber: cat.dataset.chamber, cat: cat.dataset.cat, party: cat.dataset.party || null };
      const same = next.chamber === pick.chamber && next.cat === pick.cat && next.party === pick.party;
      pick = same ? { chamber: next.chamber, cat: null, party: null } : next;
      render();
      return;
    }
    const pst = ev.target.closest("[data-pstate]");
    if (pst) {
      const r = racesByState()[pst.dataset.pstate];
      const s = r && (r.senate[0] || r.governor[0] || r.house[0]);
      if (s) selectSeat(s.id, true);
      return;
    }
    const t = ev.target.closest("[data-seat]");
    if (t) selectSeat(t.dataset.seat, true);
  });

  seats.onChange(() => render());
  let lastPolls = "";
  setInterval(() => {
    const old = el.querySelector(".mw-polls");
    if (!old || el.hidden || !el.isConnected) return;
    const html = polls();
    if (html !== lastPolls) { lastPolls = html; old.outerHTML = html; }
  }, 20000);

  return {
    render,
    /** Highlight a race chosen elsewhere (the map), without calling back. */
    select(raceId) { selectSeat(raceId, false); },
  };
}
