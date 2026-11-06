/* The seat model behind Boards and Battle for Control.
 *
 * Every seat in the three chambers, what it was, and what it is now, built
 * from the race registry, the results in the store, the holdover table and
 * calls.json -- never hand-typed (DESIGN.md §2.3, §8).
 *
 * A seat on the 2026 ballot moves through one state machine:
 *
 *   undecided -> leading(party) -> called(party)
 *
 * "leading" is read off the race's statewide votes, with the reporting share
 * beside it. "called" comes only from calls.json, which names who called it;
 * a 99-1 count with everything in is still only "leading" until somebody's
 * call is entered. Nothing in this file infers a call from a number.
 *
 * The simulation (apps/battle.js) is a set of picks laid over this at tally
 * time. Picks are never written anywhere in here, a call always beats a
 * pick, and the tally keeps simulated seats in their own bucket so they can
 * be drawn differently.
 */

import { createCalls } from "./calls.js";
import { getJSON as fetchJSON } from "../core/fetch.js";

const FIPS = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT",
  "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL",
  "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD",
  "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE",
  "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND",
  "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
  "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV",
  "55": "WI", "56": "WY",
};

export const STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts",
  MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

export const CHAMBERS = ["senate", "house", "governor"];
/* State legislatures the wall counts, district by district: one race per
 * chamber (2026-statehouse-pa), each district a unit with its own candidates
 * (adapters/pa_leg.py, adapters/wv_leg.py), and who holds each seat in
 * holdovers_2026.json's `legislatures` block (scripts/legislature_wiki.py,
 * scripts/legislature_wv.py). A chamber whose seats up are not simply all,
 * even or odd lists them there (`up`, West Virginia's Senate: one seat a
 * district plus two unexpired terms, each with its own race id). */
export const LEG_CHAMBERS = ["pa-house", "pa-senate", "wv-house", "wv-senate"];
export const ALL_CHAMBERS = [...CHAMBERS, ...LEG_CHAMBERS];
const pad = (n, w) => String(n).padStart(w, "0");
const LEG = {
  "pa-house": { state: "PA", key: "house", race: "statehouse", title: "PA House", unit: (n) => `PA-${pad(n, 3)}`,
                waitWhy: "Pennsylvania publishes nothing until the first district has votes",
                verifyAt: "palegis.us", job: "pa_leg" },
  "pa-senate": { state: "PA", key: "senate", race: "statesenate", title: "PA Senate", unit: (n) => `PA-S${pad(n, 2)}`,
                 waitWhy: "Pennsylvania publishes nothing until the first district has votes",
                 verifyAt: "palegis.us", job: "pa_leg" },
  "wv-house": { state: "WV", key: "house", race: "statehouse", title: "WV House", unit: (n) => `WV-${pad(n, 3)}`,
                waitWhy: "no West Virginia legislature file yet (the wv_leg job reads the Secretary of State's Clarity file)",
                verifyAt: "wvlegislature.gov", job: "wv_leg" },
  "wv-senate": { state: "WV", key: "senate", race: "statesenate", title: "WV Senate", unit: (n) => `WV-S${pad(n, 2)}`,
                 waitWhy: "no West Virginia legislature file yet (the wv_leg job reads the Secretary of State's Clarity file)",
                 verifyAt: "wvlegislature.gov", job: "wv_leg" },
};
/** The legislature chambers of each state, in order: { PA: ["pa-house", "pa-senate"], WV: [...] }. */
export const LEG_STATES = LEG_CHAMBERS.reduce((o, c) => ((o[LEG[c].state] ||= []).push(c), o), {});
export const legState = (chamber) => (LEG[chamber] ? LEG[chamber].state : null);
export const CHAMBER_TITLES = { senate: "Senate", house: "House", governor: "Governors",
  ...Object.fromEntries(LEG_CHAMBERS.map((c) => [c, LEG[c].title])) };
const CYCLE = "2026";
const PRES_KEY = "pres-2024";
const HOUSE_KEY = "house-2024";

/** dem | rep | other: the three ways a seat can count on a board. */
export function bucket(party, caucus) {
  if (party === "dem" || party === "rep") return party;
  if (caucus === "dem" || caucus === "rep") return caucus;
  return "other";
}

const zero = () => ({ dem: 0, rep: 0, other: 0 });

export function houseSeatId(state, district) {
  const d = district === "AL" || district === 0 ? "al" : String(district).padStart(2, "0");
  return `${CYCLE}-house-${state.toLowerCase()}-${d}`;
}

// Fallback providers whose file is the race's whole count.
const FULL_COUNT = new Set(["nyt", "ap"]);

export function createSeats({ store, base = ".", root = ".", interval = 30000,
                              version = "" } = {}) {
  const listeners = [];
  let holdovers = null;
  let house = null;              // house-2024 baseline, by "ST-NN"
  let houseError = null;
  let presByState = null;        // state -> { dem, rep, other }
  let expected = new Map();      // race_id -> registry/expected_2026.json row
  let ballot = new Map();        // race_id -> [{name, party, label}], registry/candidates_2026.json
  let pollClose = null;          // data/reference/poll_close_2026.json
  const calls = createCalls({ base, interval, onChange: () => emit() });

  function emit() { for (const fn of listeners) fn(api); }

  async function getJSON(url) {
    return fetchJSON(`${url}${version ? `?v=${version}` : ""}`, { cache: "no-store" });
  }

  /* ---------------------------------------------------------- baselines */

  function houseUnits() {
    // Whoever loads house-2024 first -- the map's baseline list or this
    // file -- the store copy wins so the two can never disagree.
    const fromStore = store.baseline && store.baseline(HOUSE_KEY);
    const data = fromStore || house;
    if (!data) return null;
    const m = new Map();
    for (const u of data.units || []) if (u.id != null) m.set(normDistrict(u.id), u);
    return m;
  }

  function normDistrict(id) {
    const m = /^([A-Za-z]{2})-?(\d+|AL)$/i.exec(String(id));
    if (!m) return String(id).toUpperCase();
    const n = m[2].toUpperCase();
    return `${m[1].toUpperCase()}-${n === "AL" || n === "00" || n === "0" ? "AL" : n.padStart(2, "0")}`;
  }

  function presState(st) {
    // The state's own results file first: it is the certified statewide
    // total. The county baseline is summed only where it covers the whole
    // state -- Alaska's has 3 of its 40 rows joined, and summing those
    // printed "D+10" for a state Trump won by 13.
    const id = `2024-pres-${st.toLowerCase()}`;
    const r = store.results(id);
    if (r && r.statewide) {
      const p = store.partyTotals(r.statewide.votes, store.race(id));
      if (p.dem + p.rep > 0) return { totals: p, label: "2024 president" };
    }
    const b = store.baseline(PRES_KEY);
    if (!presByState) {
      presByState = new Map();
      for (const u of (b && b.units) || []) {
        const s = FIPS[String(u.id).slice(0, 2)];
        if (!s) continue;
        const t = presByState.get(s) || zero();
        const p = store.partyTotals(u.votes, null);
        t.dem += p.dem; t.rep += p.rep; t.other += p.other;
        presByState.set(s, t);
      }
    }
    const partial = new Set(Object.keys((b && b.unmatched && b.unmatched.by_state_fips) || {})
      .map((f) => FIPS[f]));
    const t = presByState.get(st);
    if (t && t.dem + t.rep > 0 && !partial.has(st)) {
      return { totals: t, label: "2024 president (county sum)" };
    }
    return null;
  }

  function raceMargin(id) {
    const r = store.results(id);
    if (!r || !r.statewide) return null;
    const t = store.partyTotals(r.statewide.votes, store.race(id));
    if (t.dem + t.rep <= 0) return null;
    return { margin: store.marginPts(store.twoPartyDemShare(t)), label: store.baselineLabel(id), key: id };
  }

  /** The latest prior statewide result for this seat, else 2024 president. */
  function seatBaseline(seat) {
    if (LEG[seat.chamber]) {
      // The district's own 2024 race (the House; the Senate's even seats
      // were last elected in 2022, which is not loaded).
      const id = `2024-${LEG[seat.chamber].race}-${seat.state.toLowerCase()}`;
      const res = store.results(id);
      const u = res && (res.units || []).find((x) => x.id === seat.unitId);
      if (!u) return null;
      const t = store.partyTotals(u.votes, store.race(id));
      if (t.dem + t.rep <= 0) return null;
      const label = `2024 ${CHAMBER_TITLES[seat.chamber]}${t.dem && t.rep ? "" : " (uncontested)"}`;
      return { margin: store.marginPts(store.twoPartyDemShare(t)), label, key: id,
               winner: t.dem > t.rep ? "dem" : "rep" };
    }
    if (seat.chamber === "house") {
      const u = seat._houseUnit;
      if (!u) return null;
      const t = store.partyTotals(u.votes, null);
      const old = seat.redrawn ? ", old lines" : "";
      // An unopposed seat (FL-20, OK-03 in 2024) prints no votes; the
      // baseline file carries `winner` for it, read before the votes.
      if (u.winner === "dem" || u.winner === "rep") {
        if (t.dem + t.rep <= 0) {
          return { margin: u.winner === "dem" ? 100 : -100, label: `2024 House (unopposed)${old}`,
                   key: HOUSE_KEY, winner: u.winner, redrawn: !!seat.redrawn };
        }
      }
      if (t.dem + t.rep <= 0) return null;
      return { margin: store.marginPts(store.twoPartyDemShare(t)), label: `2024 House${old}`, key: HOUSE_KEY,
               winner: t.dem > t.rep ? "dem" : "rep", redrawn: !!seat.redrawn };
    }
    const st = seat.state.toLowerCase();
    const tries = seat.chamber === "senate"
      ? (seat.seat_class === 3
          ? [`2022-sen-${st}`]                                 // class 3: Rubio's, Vance's seats
          : [`2024-sen-${st}-special`, `2022-sen-${st}-special`, `2020-sen-${st}`])
      : [`2024-gov-${st}`, `2022-gov-${st}`];
    for (const id of tries) {
      const m = raceMargin(id);
      if (m) return { ...m, winner: m.margin > 0 ? "dem" : "rep", proxy: false };
    }
    return pres2024(seat.state, true);
  }

  function pres2024(st, proxy) {
    const p = presState(st);
    if (!p) return null;
    const margin = store.marginPts(store.twoPartyDemShare(p.totals));
    return { margin, label: p.label, key: PRES_KEY, winner: margin > 0 ? "dem" : "rep", proxy };
  }

  /* ----------------------------------------------------- the seat list */

  function registryRace(office, st) {
    const races = (store.registry && store.registry.races) || [];
    return races.find((r) => r.office === office && r.state === st &&
                             String(r.race_id).startsWith(`${CYCLE}-`)) || null;
  }

  /** Who is ahead in a race, from its statewide votes -- or, given a unit,
   * in that unit (a legislative district of a chamber-wide race). Never a call. */
  function liveState(raceId, unitId = null) {
    const res0 = store.results(raceId);
    if (!res0 || !res0.statewide) return null;
    const res = !unitId ? res0 : { ...res0, statewide: ((res0.units || []).find((u) => u.id === unitId)) ||
                                   { votes: {}, reporting_pct: null } };
    const race = store.race(raceId);
    const party = new Map();
    const name = new Map();
    for (const c of (race && race.candidates) || []) { party.set(c.id, c.party); name.set(c.id, c.name); }
    let total = 0, best = null, second = null;
    for (const [cid, v] of Object.entries(res.statewide.votes || {})) {
      const n = Number(v) || 0;
      total += n;
      if (cid === "other") continue;
      if (!best || n > best.votes) { second = best; best = { id: cid, votes: n }; }
      else if (!second || n > second.votes) second = { id: cid, votes: n };
    }
    const sw = res.statewide;
    const out = {
      reporting: sw.reporting_pct != null ? Number(sw.reporting_pct) : null,
      reportingKind: sw.expected_votes != null ? "expected vote" : "precincts",
      votes: total,
      updated: res.updated || null,
      // What the file covers, e.g. "2026 General Election (2 counties)".
      coverage: (res.source && res.source.election_name) || null,
      override: res.override || null,
      leader: null,
    };
    if (!best || best.votes <= 0 || (second && second.votes === best.votes)) return out;
    const p = party.get(best.id) || "other";
    out.leader = {
      id: best.id, name: String(name.get(best.id) || best.id).replace(/\s*\((?:I|i)\)\s*$/, ""), party: p,
      incumbent: !!(store.isIncumbent && store.isIncumbent(race, name.get(best.id))),
      votes: best.votes, share: total ? best.votes / total : null,
      lead: best.votes - (second ? second.votes : 0),
      // Over the runner-up, whoever that is (store.topTwo); signed D+/R-,
      // and positive for anyone else ahead.
      marginPts: (() => {
        const top = store.topTwo(sw.votes, race);
        return !top ? null : top.leader.party === "rep" ? -top.pts : top.pts;
      })(),
    };
    return out;
  }

  function finish(seat) {
    const call = calls.get(seat.raceId) || (seat.raceId !== seat.id ? calls.get(seat.id) : null);
    const live = seat.raceId ? liveState(seat.raceId) : null;
    seat.live = live;
    seat.call = call;
    if (call) {
      seat.status = "called";
      seat.party = bucket(call.party, call.caucus);
      seat.rawParty = call.party;
    } else if (live && live.leader) {
      seat.status = "leading";
      seat.party = bucket(live.leader.party, null);
      seat.rawParty = live.leader.party;
    } else {
      seat.status = "undecided";
      seat.party = null;
      seat.rawParty = null;
    }
    seat.flip = seat.party && seat.held ? seat.party !== seat.held : false;
    // Where its numbers come from (registry/expected_2026.json, which
    // scripts/expected.py writes): "live" once a results file is in the
    // store; else "waiting" (a job is set up, no file yet), "certified"
    // (only certified results, entered as an override) or "none". The map's
    // House 2026 key uses the same four: Feed waiting, Override only, No
    // live feed.
    const exp = expected.get(seat.raceId) || expected.get(seat.id) || null;
    seat.feed = store.results(seat.raceId) ? "live"
      : (!exp || exp.feed === "staged" || exp.feed === "waiting" ? "waiting"
        : (exp.feed === "certified-only" ? "certified" : "none"));
    seat.feedWhy = (exp && exp.why) || null;
    // Who is on the ballot (Wikipedia's lists, scripts/candidates_wiki.py),
    // for a seat with no results file to name them. Once a file arrives its
    // own candidates speak for the race.
    seat.ballot = seat.feed === "live" ? null : ballot.get(seat.raceId) || null;
    if (seat.ballot && store.isIncumbent) {
      const like = { race_id: seat.raceId, office: seat.chamber, state: seat.state };
      seat.ballot = seat.ballot.map((c) => ({ ...c, incumbent: store.isIncumbent(like, c.name) }));
    }
    // The race's file counts only some of its counties (IL: the collar
    // counties' own results), so its leader is not the race's -- until the
    // New York Times or AP fallback takes the race over (adapters/nyt.py,
    // adapters/ap.py), whose file is the whole count. A file can also say so itself
    // (adapters/tx_harris.py: source.partial, source.coverage "Harris County
    // only") until the state feed or the Times replaces it. Read on every
    // call: a race changes source during the night.
    const res = store.results(seat.raceId);
    const src = (res && res.source) || {};
    seat.partial = (!!(exp && exp.partial) && !FULL_COUNT.has(src.provider)) || src.partial === true;
    seat.partialNote = src.partial === true ? src.coverage || null : null;
    return seat;
  }

  function statewideSeats(office) {
    const chamber = office;
    return (holdovers.up || [])
      .filter((u) => u.office === office)
      .map((u) => {
        const race = registryRace(office, u.state);
        const id = `${CYCLE}-${office === "senate" ? "sen" : "gov"}-${u.state.toLowerCase()}`;
        return finish({
          id, chamber, state: u.state, district: null,
          label: STATE_NAMES[u.state] || u.state, short: u.state,
          raceId: race ? race.race_id : id,
          inRegistry: !!race,
          held: bucket(u.held, null),
          incumbent: u.incumbent, incumbentStatus: u.incumbent_status,
          special: !!u.special,
          seat_class: /class-3/.test(u.seat || "") ? 3 : (/class-2/.test(u.seat || "") ? 2 : null),
          check: u.check || null,
        });
      })
      .sort((a, b) => a.state.localeCompare(b.state));
  }

  /** States whose 2026 House map is not the 2024 one (holdovers file). */
  function redrawnStates() {
    const r = holdovers.house && holdovers.house.redrawn_for_2026;
    return new Set(((r && r.states) || []).map((x) => String(x).toUpperCase()));
  }

  /** States whose House races are open first rounds with a runoff. */
  function runoffStates() {
    const r = holdovers.house && holdovers.house.first_round_runoff;
    return new Set(((r && r.states) || []).map((x) => String(x).toUpperCase()));
  }

  function houseSeats() {
    const units = houseUnits();
    const redrawn = redrawnStates();
    const runoff = runoffStates();
    const out = [];
    const appt = (holdovers.house && holdovers.house.apportionment) || {};
    for (const st of Object.keys(appt).sort()) {
      const n = appt[st];
      for (let d = 1; d <= n; d++) {
        const dist = n === 1 ? "AL" : String(d).padStart(2, "0");
        const key = `${st}-${dist}`;
        const id = houseSeatId(st, n === 1 ? "AL" : d);
        const race = (store.race && store.race(id)) ||
          (store.race && n === 1 ? store.race(`${CYCLE}-house-${st.toLowerCase()}-00`) : null);
        const u = units ? units.get(key) || null : null;
        let held = null;
        if (u && u.winner) {
          held = bucket(u.winner, null);
        } else if (u) {
          const t = store.partyTotals(u.votes, null);
          // A district with nobody on one side is still held by the other.
          held = t.dem === t.rep ? null : (t.dem > t.rep ? "dem" : "rep");
          if (t.other > Math.max(t.dem, t.rep)) held = "other";
        }
        const seat = {
          id, chamber: "house", state: st, district: dist,
          label: key, short: n === 1 ? `${st}` : `${st}${d}`,
          raceId: race ? race.race_id : id, inRegistry: !!race,
          held, special: false, _houseUnit: u,
          // The 2026 district with this number is not the 2024 one: "held",
          // the baseline and any flip are measured against the old lines.
          redrawn: redrawn.has(st),
          // An open first round (LA): the leader may be headed to a runoff.
          firstRound: runoff.has(st),
        };
        out.push(finish(seat));
      }
    }
    return out;
  }

  /* One seat per district of a state legislature chamber. The chamber is
   * one race; a district's leader is its unit's leader, and a call is keyed
   * by the seat (calls.json "2026-statehouse-pa:PA-001"). */
  function legSeats(chamber) {
    const L = LEG[chamber];
    const info = legInfo(chamber);
    if (!info) return [];
    const chamberRace = `${CYCLE}-${L.race}-${L.state.toLowerCase()}`;
    // The seats on the ballot: listed (West Virginia's Senate), or every,
    // every even or every odd district.
    const up = info.up_2026 === "listed"
      ? (info.up || []).map((u) => ({ n: u.district, key: u.seat, unitId: u.unit, raceId: u.race_id || chamberRace,
                                       unexpired: /:unexpired$/.test(u.seat) }))
      : Array.from({ length: info.seats }, (_, i) => i + 1)
          .filter((n) => info.up_2026 === "even" ? !(n % 2) : info.up_2026 === "odd" ? n % 2 : true)
          .map((n) => ({ n, key: L.unit(n), unitId: L.unit(n), raceId: chamberRace, unexpired: false }));
    const out = [];
    for (const { n, key, unitId, raceId, unexpired } of up) {
      const res = store.results(raceId);
      const m = (info.members || {})[key] || {};
      const seat = {
        id: `${raceId}:${unitId}`, chamber, state: L.state, district: String(n),
        label: `${L.title} ${n}${unexpired ? " (unexpired term)" : ""}`, short: unexpired ? `${n}u` : String(n),
        raceId, unitId,
        inRegistry: !!store.race(raceId), held: m.party === "dem" || m.party === "rep" ? m.party : null,
        incumbent: m.name || null, special: unexpired, redrawn: false, firstRound: false, partial: false,
      };
      const call = calls.get(seat.id);
      const live = res ? liveState(raceId, unitId) : null;
      seat.live = live;
      seat.call = call;
      if (call) {
        seat.status = "called"; seat.party = bucket(call.party, call.caucus); seat.rawParty = call.party;
      } else if (live && live.leader) {
        seat.status = "leading"; seat.party = bucket(live.leader.party, null); seat.rawParty = live.leader.party;
      } else {
        seat.status = "undecided"; seat.party = null; seat.rawParty = null;
      }
      seat.flip = seat.party && seat.held ? seat.party !== seat.held : false;
      seat.feed = res ? "live" : "waiting";
      seat.feedWhy = res ? null : L.waitWhy;
      seat.ballot = null;
      out.push(seat);
    }
    return out;
  }

  /* ------------------------------------------------------------- tally */

  function legInfo(chamber) {
    const L = LEG[chamber];
    const block = L && holdovers.legislatures && holdovers.legislatures[L.state];
    return block ? { ...block[L.key], verified: block.verified, source: block.source } : null;
  }

  function rules(chamber) {
    if (LEG[chamber]) {
      const h = legInfo(chamber) || {};
      const seats = h.seats || 0;
      const majority = h.majority || Math.floor(seats / 2) + 1;
      // PA's lieutenant governor breaks ties on procedure, not passage, so
      // a 25-25 Senate is counted as nobody's.
      return { seats, majority, need: { dem: majority, rep: majority }, tiebreak: null, control: true,
               tiebreakNote: h.tiebreak || null };
    }
    const h = holdovers[chamber] || {};
    const seats = h.seats || { senate: 100, house: 435, governor: 50 }[chamber];
    const majority = h.majority || Math.floor(seats / 2) + 1;
    const need = { dem: majority, rep: majority };
    let tiebreak = null;
    if (chamber === "senate" && h.vice_president && h.vice_president.breaks_ties) {
      const vp = bucket(h.vice_president.party, null);
      if (vp === "dem" || vp === "rep") {
        need[vp] = seats / 2;
        tiebreak = { party: vp, name: h.vice_president.name };
      }
    }
    return { seats, majority, need, tiebreak, control: chamber !== "governor" };
  }

  function notUp(chamber) {
    const out = zero();
    if (LEG[chamber]) {
      const h = legInfo(chamber);
      for (const p of ["dem", "rep"]) out[p] = (h && h.holdovers && h.holdovers[p]) || 0;
      return out;
    }
    if (chamber === "house") return out;
    for (const h of (holdovers[chamber] && holdovers[chamber].holdovers) || []) {
      out[bucket(h.party, h.caucus)] += 1;
    }
    return out;
  }

  /** Things wrong with the inputs that a viewer should never have to find. */
  function warnings(chamber, seatList) {
    const w = [];
    const h = holdovers[chamber] || {};
    const r = rules(chamber);
    if (LEG[chamber]) {
      const L = legInfo(chamber);
      if (!L) w.push(`no ${CHAMBER_TITLES[chamber]} membership in holdovers_2026.json (scripts/${LEG[chamber].state === "PA" ? "legislature_wiki" : "legislature_wv"}.py)`);
      else {
        const nu = notUp(chamber);
        const total = nu.dem + nu.rep + seatList.length;
        if (total !== r.seats) w.push(`${nu.dem + nu.rep} not up + ${seatList.length} up = ${total}, not ${r.seats}`);
        if (L.verified === false) w.push(`${CHAMBER_TITLES[chamber]} membership (as of ${L.as_of}) not yet verified against ${LEG[chamber].verifyAt}`);
        const empty = seatList.filter((s) => !s.held).map((s) => s.label);
        if (empty.length) w.push(`no holder on file for ${empty.join(", ")} (vacant?)`);
      }
      if (!store.results(`${CYCLE}-${LEG[chamber].race}-${LEG[chamber].state.toLowerCase()}`)) {
        w.push(`no 2026 results yet: ${LEG[chamber].waitWhy} (the ${LEG[chamber].job} job is polling)`);
      }
    } else if (chamber !== "house") {
      const hold = (h.holdovers || []).length;
      if (hold + seatList.length !== r.seats) {
        w.push(`${hold} holdovers + ${seatList.length} seats up = ${hold + seatList.length}, not ${r.seats}`);
      }
      const nu = notUp(chamber);
      for (const p of ["dem", "rep"]) {
        if (h.totals && h.totals[p] != null && h.totals[p] !== nu[p]) {
          w.push(`holdover rows give ${p} ${nu[p]}; the file's totals say ${h.totals[p]}`);
        }
      }
      if (h.verified === false || holdovers.verified === false ||
          (h.holdovers || []).some((x) => x.verified === false)) {
        w.push("holdover table not yet verified (data/reference/holdovers_2026.json)");
      }
      const office = chamber;
      const known = new Set(seatList.map((s) => s.raceId));
      for (const race of (store.registry && store.registry.races) || []) {
        if (race.office === office && String(race.race_id).startsWith(`${CYCLE}-`) && !known.has(race.race_id)) {
          w.push(`${race.race_id} is in the registry but not in the seats-up list`);
        }
      }
      for (const s of seatList) if (s.check) w.push(`${s.label}: ${s.check}`);
      for (const s of seatList) {
        if (s.partial && s.status === "leading") {
          w.push(`${s.label} leading on a partial count: ${s.partialNote || "only some counties are in the file"}`);
        }
      }
    } else {
      if (houseError || !houseUnits()) {
        w.push(`no district baseline (${HOUSE_KEY}): 'held' is the 2024 national total only`);
      }
      if (seatList.length !== r.seats) w.push(`${seatList.length} districts, not ${r.seats}`);
      const redrawn = [...redrawnStates()].sort();
      if (redrawn.length) {
        const n = seatList.filter((s) => s.redrawn).length;
        w.push(`${n} districts in ${redrawn.join(", ")} were redrawn for 2026: their "held", ` +
               "baseline and flips are against the 2024 lines");
      }
      const partial = seatList.filter((s) => s.partial && s.status === "leading");
      if (partial.length) {
        w.push(`${partial.length} district${partial.length > 1 ? "s" : ""} leading on a partial count ` +
               `(${partial.map((s) => s.label).join(", ")}): only some counties are in the file`);
      }
      const r1 = seatList.filter((s) => s.firstRound && s.status === "leading");
      if (r1.length) {
        w.push(`${[...new Set(r1.map((s) => s.state))].join(", ")}: ${r1.length} leader${r1.length > 1 ? "s" : ""} ` +
               "in an open first round; a runoff follows if nobody passes 50%");
      }
    }
    for (const bad of calls.status().rejected) {
      if (seatList.some((s) => s.raceId === bad.race_id || s.id === bad.race_id)) {
        w.push(`calls.json ${bad.race_id} ignored: ${bad.error}`);
      }
    }
    return w;
  }

  /**
   * Count a chamber. `picks` (seat id -> "dem" | "rep") is the simulation;
   * omit it for the live board. A pick on a seat that has since been called
   * is not counted and is reported in `superseded` -- live data wins.
   */
  function tally(chamber, picks = null) {
    const list = api.seats(chamber);
    const r = rules(chamber);
    const t = {
      chamber, ...r,
      notUp: notUp(chamber), defending: zero(), called: zero(), leading: zero(),
      sim: zero(), gained: zero(), lost: zero(), simFlips: zero(),
      undecided: 0, reportingAny: 0, superseded: [], seats_up: list.length,
      warnings: warnings(chamber, list),
    };
    for (const s of list) {
      if (s.held) t.defending[s.held] += 1;
      if (s.live && s.live.votes > 0) t.reportingAny += 1;
      const pick = picks ? picks[s.id] : null;
      if (s.status === "called") {
        t.called[s.party] += 1;
        if (s.held && s.party !== s.held) { t.gained[s.party] += 1; t.lost[s.held] += 1; }
        if (pick) t.superseded.push(s.id);
      } else if (pick === "dem" || pick === "rep") {
        t.sim[pick] += 1;
        if (s.held && pick !== s.held) t.simFlips[pick] += 1;
      } else if (s.status === "leading") {
        t.leading[s.party] += 1;
      } else {
        t.undecided += 1;
      }
    }
    if (chamber === "house" && !houseUnits() && holdovers.house && holdovers.house.held_2024) {
      t.defending = { ...zero(), ...holdovers.house.held_2024 };
      delete t.defending.verified; delete t.defending.note;
    }
    for (const p of ["dem", "rep", "other"]) {
      t[p] = {
        secured: t.notUp[p] + t.called[p],
        projected: t.notUp[p] + t.called[p] + t.sim[p],
        withLeaders: t.notUp[p] + t.called[p] + t.leading[p],
        net: t.gained[p] - t.lost[p],
      };
    }
    t.controller = null;
    if (r.control) {
      for (const p of ["dem", "rep"]) {
        if (t[p].secured >= r.need[p]) t.controller = { party: p, how: "secured" };
      }
      if (!t.controller && picks) {
        for (const p of ["dem", "rep"]) {
          if (t[p].projected >= r.need[p]) t.controller = { party: p, how: "simulated" };
        }
      }
    }
    return t;
  }

  const api = {
    calls,
    async load() {
      holdovers = await getJSON(`${root}/data/reference/holdovers_2026.json`);
      try {
        const e = await getJSON(`${root}/registry/expected_2026.json`);
        expected = new Map((e.races || []).map((r) => [r.race_id, r]));
      } catch (err) { expected = new Map(); }   // no flags, nothing else lost
      try {
        const c = await getJSON(`${root}/registry/candidates_2026.json`);
        ballot = new Map(Object.entries(c.races || {}));
      } catch (err) { ballot = new Map(); }     // seats without a feed just don't list names
      try { pollClose = await getJSON(`${root}/data/reference/poll_close_2026.json`); }
      catch (err) { pollClose = null; }         // Boards just leaves out the poll-closing strip
      if (!(store.baseline && store.baseline(HOUSE_KEY))) {
        try { house = await getJSON(`${root}/baselines/${HOUSE_KEY}.json`); houseError = null; }
        catch (e) { house = null; houseError = String(e.message || e); }
      }
      presByState = null;
      return api;
    },
    start() { calls.start(); return api; },
    stop() { calls.stop(); return api; },
    onChange(fn) { listeners.push(fn); return api; },
    /** Baselines changed underneath (a new store baseline was loaded). */
    invalidate() { presByState = null; emit(); return api; },
    get holdovers() { return holdovers; },
    /** Poll-closing times by state, { states: { PA: { close, first?, note? } } }, or null. */
    get pollClose() { return pollClose; },
    get houseBaseline() { return !!houseUnits(); },
    get redrawn() { return holdovers ? redrawnStates() : new Set(); },
    rules,
    seats(chamber) {
      if (!holdovers) return [];
      if (LEG[chamber]) return legSeats(chamber);
      return chamber === "house" ? houseSeats() : statewideSeats(chamber);
    },
    /** The call on a race or a legislature seat ("2026-statehouse-pa:PA-001"), or null. */
    call(id) { return calls.get(id); },
    seat(id) {
      for (const c of ALL_CHAMBERS) {
        const s = api.seats(c).find((x) => x.id === id || x.raceId === id);
        if (s) return s;
      }
      return null;
    },
    baseline: seatBaseline,
    pres2024: (st) => pres2024(st, false),
    tally,
  };
  return api;
}
