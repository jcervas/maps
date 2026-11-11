/* The results store, and the arithmetic every view needs.
 *
 * Holds the registry (what races exist), results (what has been counted) and
 * baselines (what to compare against), and nothing about how any of it is
 * drawn. Contracts in docs/schema.md.
 *
 * The vote math lives here rather than in a view because it is the part that
 * is easy to get subtly wrong -- two-party denominators, missing data versus
 * zero, unmapped units -- and it should be wrong in at most one place.
 */

import { applyOverride, raceFromOverride, mergeCandidates } from "./overrides.js";

const PARTY_NAMES = { dem: "Democratic", rep: "Republican", other: "Other" };
// Lines in a results file that are not a person who could lead a county:
// lumped write-ins, scattering, blank and void ballots, "all others". A named
// write-in candidate ("adam-paul-write-in") is a person and stays a contender.
const NOT_A_CONTENDER = /^(write-?ins?(-.*)?|scatter.*|blank.*|void.*|none-of.*|(all-)?others?)$/i;
// States whose candidates are never pooled by party: Alaska's top-four
// primary sends two or three of one party to a ranked-choice general, so
// Sullivan and Heikes are two contenders, not one Republican line (the
// Senate race read R+1.1 with Peltola ahead; November 10). Louisiana's
// House races are open first rounds, four to ten candidates on one ballot
// (data/reference/holdovers_2026.json first_round_runoff): LA-05 read
// R+26 with Moore, a Democrat, first (November 11).
const EACH_ALONE = new Set(["AK", "LA"]);

/* A person's name as surname and given names, for matching a ballot's
 * spelling against a seat holder's: the first of a ticket ("JOSH SHAPIRO /
 * DAVIS, AUSTIN"), "Last, First" turned round, accents, quotes, hyphens and
 * suffixes dropped ('Henry C. "Hank" Johnson, Jr.' -> johnson; henry c hank). */
const SUFFIX = /^(jr|sr|ii|iii|iv|v)$/;
const PARTICLE = /^(de|del|della|la|las|los|le|van|von|der|den|da|das|do|dos|du|di|st|ten|ter)$/;
function personParts(name) {
  let n = String(name || "").split(/\s*\/\s*|\s+(?:and|&)\s+/i)[0].replace(/\((?:i|inc|incumbent)\.?\)/gi, " ");
  const parts = n.split(",");
  if (parts.length > 1) {
    const rest = parts.slice(1).join(" ").trim();
    const words = rest.toLowerCase().replace(/\./g, "").split(/\s+/).filter(Boolean);
    n = words.every((w) => SUFFIX.test(w)) ? parts[0] : `${rest} ${parts[0]}`;
  }
  const w = n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z\s]/g, " ").split(/\s+/).filter((x) => x && !SUFFIX.test(x));
  if (!w.length) return null;
  // A surname's particles belong to it: "Carlos De La Cruz" is De La Cruz,
  // given Carlos. Split on the last word alone, "de" and "la" were given
  // names, and he matched Monica De La Cruz (TX-15) as an incumbent through
  // them (TX-35, November 10).
  let i = w.length - 1;
  while (i > 1 && PARTICLE.test(w[i - 1])) i -= 1;
  return { last: w.slice(i).join(" "), given: w.slice(0, i) };
}

export function createStore() {
  const totalsMemo = new WeakMap();   // votes object -> Map(race -> { dem, rep, other })
  const results = new Map();     // race_id -> { data, units: Map(unit_id -> unit) }
  const feed = new Map();        // race_id -> results file as harvested
  let overrides = {};            // race_id -> active override entry
  const baselines = new Map();   // key -> { data, units: Map }
  let registry = null;
  let byState = new Map();
  // race_id -> race. The map asks for a race once per county per frame, and
  // a miss (a baseline key such as "pres-2024" is not a race) scanned every
  // race in the registry.
  let byId = new Map();
  // "house GA" -> seat holders' names as parts (data/reference/incumbents_2026.json).
  let holders = new Map();
  // race_id -> AP's incumbents on that ballot, as parts (an empty list: none).
  let apFlags = new Map();
  const incMemo = new Map();

  function indexUnits(data) {
    const m = new Map();
    for (const u of data.units || []) {
      // id === null is a real unit with no geography -- a county-level
      // absentee batch, an Alaska house district. It stays in the totals and
      // is listed in tables; it just cannot be drawn.
      if (u.id != null) m.set(String(u.id), u);
      // A count that also covers other polygons (a Maine town reporting with
      // a township the Census draws apart) is drawn on each of them; the
      // unit's own id is never displaced.
      for (const extra of u.also || []) if (!m.has(String(extra))) m.set(String(extra), u);
    }
    return m;
  }

  function rebuild(id) {
    const o = overrides[id];
    const base = feed.get(id) || null;
    const data = o ? applyOverride(id, base, o) : base;
    if (data) results.set(id, { data, units: indexUnits(data) });
    else results.delete(id);
  }

  /** Same person: same surname, and a given name in common, or a bare
   *  initial ("S. Guthrie") agreeing with the other's first name. Two full
   *  first names that merely share a letter do not match: Trever Nehls is
   *  not his twin Troy, and Daniel Sullivan Jr. is not Dan S. Sullivan. */
  function samePerson(c, h) {
    if (!c || !h || h.last !== c.last) return false;
    if (!c.given.length || !h.given.length) return true;
    if (c.given.some((g) => g.length > 1 && h.given.includes(g))) return true;
    return (c.given[0].length === 1 || h.given[0].length === 1) && c.given[0][0] === h.given[0][0];
  }

  /** Whether a candidate is the seat's holder. AP's own flag where AP
   *  reports the race (incumbents_2026.json `candidates`, from
   *  scripts/ap_incumbents.py); elsewhere -- the legislatures -- a name match
   *  against the seat holders of the same office and state. */
  function isIncumbent(race, name) {
    if (!race || !name) return false;
    const key = `${race.race_id}|${name}`;
    let v = incMemo.get(key);
    if (v == null) {
      const c = personParts(name);
      const flagged = apFlags.get(race.race_id);
      const list = flagged || holders.get(`${race.office} ${race.state}`) || [];
      v = !!c && list.some((h) => samePerson(c, h));
      incMemo.set(key, v);
    }
    return v;
  }

  const api = {
    /** Seat holders before the election, { races: { "house GA": [names] } }. */
    setIncumbents(json) {
      holders = new Map(Object.entries((json && json.races) || {})
        .map(([k, names]) => [k, names.map(personParts).filter(Boolean)]));
      apFlags = new Map(Object.entries((json && json.candidates) || {})
        .map(([k, names]) => [k, names.map(personParts).filter(Boolean)]));
      incMemo.clear();
    },
    isIncumbent,
    setRegistry(reg) {
      registry = reg;
      // A race the registry has never heard of can still be on the wall: the
      // override file may carry it, for a state with no adapter at all.
      const known = new Set((reg.races || []).map((r) => r.race_id));
      for (const [id, o] of Object.entries(overrides)) {
        if (!known.has(id)) (registry.races = registry.races || []).push(raceFromOverride(id, o));
        else mergeCandidates(registry.races.find((r) => r.race_id === id), o);
      }
      byState = new Map();
      byId = new Map();
      for (const r of registry.races || []) {
        byId.set(r.race_id, r);
        if (!byState.has(r.state)) byState.set(r.state, []);
        byState.get(r.state).push(r);
      }
      return api;
    },
    get registry() { return registry; },
    race(id) {
      return byId.get(id) || null;
    },
    racesIn(state) { return byState.get(state) || []; },
    states() { return [...byState.keys()].sort(); },

    /* What the feed said. What the wall shows is this with any active
     * override laid over it -- kept apart so that handing a race back to its
     * feed (active: false) restores the feed's numbers, not the override's. */
    setResults(id, data) {
      feed.set(id, data);
      rebuild(id);
      return api;
    },
    /** Replace the override set. Returns the race ids whose numbers moved. */
    setOverrides(map) {
      const next = {};
      for (const [id, o] of Object.entries(map || {})) {
        if (o && o.active !== false) next[id] = o;
      }
      const touched = new Set([...Object.keys(overrides), ...Object.keys(next)]);
      const before = overrides;
      overrides = next;
      const moved = [];
      for (const id of touched) {
        if (JSON.stringify(before[id]) === JSON.stringify(next[id])) continue;
        rebuild(id);
        moved.push(id);
      }
      if (moved.length && registry) api.setRegistry(registry);
      return moved;
    },
    override(id) { return overrides[id] || null; },
    results(id) {
      const r = results.get(id);
      return r ? r.data : null;
    },
    unit(raceId, unitId) {
      const r = results.get(raceId);
      return r ? r.units.get(String(unitId)) || null : null;
    },
    hasResults(id) { return results.has(id); },
    loadedRaces() { return [...results.keys()]; },

    setBaseline(key, data) {
      baselines.set(key, { data, units: indexUnits(data) });
      return api;
    },
    /* A baseline is either a baseline file or another race. The second is
     * what the wall is actually for -- "how does this run against the
     * governor's race two years ago" is the same question as "against 2020",
     * and duplicating a results file into baselines/ to ask it would mean two
     * copies of one number. */
    baseline(key) {
      const b = baselines.get(key);
      if (b) return b.data;
      const r = results.get(key);
      return r ? r.data : null;
    },
    baselineUnit(key, unitId) {
      const b = baselines.get(key);
      if (b) return b.units.get(String(unitId)) || null;
      const r = results.get(key);
      return r ? r.units.get(String(unitId)) || null : null;
    },
    baselineLabel(key) {
      const b = baselines.get(key);
      if (b) return b.data.label || key;
      const race = api.race(key);
      if (race) {
        const office = { "state-house": "State House", "state-senate": "State Senate" }[race.office] || race.office;
        return `${race.state} ${office} ${key.slice(0, 4)}`;
      }
      return key;
    },
    /** The tier a baseline is keyed on, whichever kind it is. */
    baselineTier(key) {
      const b = baselines.get(key);
      if (b) return b.data.unit_tier || "county";
      const race = api.race(key);
      return race ? (race.unit_tier || "county") : null;
    },
    baselineKeys() { return [...baselines.keys()]; },

    /* ----------------------------------------------------------- the math */

    /** Candidate-keyed votes folded to party totals via the registry. */
    partyTotals(votes, race) {
      if (!votes) return { dem: 0, rep: 0, other: 0 };
      // The map asks for every shape on every frame; a results file's vote
      // objects are replaced, not edited, when new numbers arrive, so the
      // sums are kept per votes object and race (about 80 MB of garbage per
      // drill out of a state, November 10). Read-only to callers.
      let byRace = totalsMemo.get(votes);
      if (!byRace) totalsMemo.set(votes, byRace = new Map());
      const hit = byRace.get(race || null);
      if (hit) return hit;
      const out = { dem: 0, rep: 0, other: 0 };
      if (byRace.size > 8) byRace.clear();       // a caller making new race objects each time
      byRace.set(race || null, out);
      const party = new Map();
      for (const c of (race && race.candidates) || []) party.set(c.id, c.party);
      for (const [cid, v] of Object.entries(votes)) {
        // A baseline file is already party-keyed; a results file is keyed by
        // candidate. Both arrive here, so both are handled.
        const p = cid === "dem" || cid === "rep" || cid === "other"
          ? cid : (party.get(cid) || "other");
        out[p === "dem" || p === "rep" ? p : "other"] += Number(v) || 0;
      }
      return out;
    },

    /** Democratic share of the two-party vote, or null where nobody voted. */
    twoPartyDemShare(totals) {
      const d = totals.dem || 0, r = totals.rep || 0;
      return (d + r) > 0 ? d / (d + r) : null;
    },

    /** Two-party margin in percentage points, positive Democratic. */
    marginPts(share) {
      return share == null ? null : (share - 0.5) * 200;
    },

    /**
     * Who is ahead, and by how much, among the two leading contenders.
     *
     * The Democratic and Republican lines are one contender each (a party's
     * candidates summed, as partyTotals does); every other *named* candidate
     * is a contender of their own. So Maine's 2024 Senate race is King
     * against Kouzounas, not Kouzounas against Costello, and Nebraska's
     * 2026 Senate race -- no Democrat on the ballot -- is Ricketts against
     * Osborn. In Alaska and Louisiana (EACH_ALONE) every named candidate is a contender of
     * their own, party or not. In a race where the top two are a Democrat and a Republican,
     * which is nearly every race, this is exactly the old two-party margin.
     * A baseline file's party-keyed "other" is a remainder of many
     * candidates, never a contender, and neither is a write-in line.
     *
     * Returns { leader, second, pts, lead } -- `pts` is the leader's margin
     * over the runner-up in points of the two's combined vote, always >= 0;
     * `lead` is the same in votes; leader/second are { key, party, name,
     * votes } -- or null where nobody has a vote.
     */
    topTwo(votes, race) {
      if (!votes) return null;
      const byId = new Map(((race && race.candidates) || []).map((c) => [c.id, c]));
      const alone = !!race && EACH_ALONE.has(race.state);
      const sums = new Map();
      const add = (key, party, name, v) => {
        const e = sums.get(key) || { key, party, name, votes: 0 };
        e.votes += v;
        sums.set(key, e);
      };
      for (const [cid, raw] of Object.entries(votes)) {
        const v = Number(raw) || 0;
        const c = byId.get(cid);
        const p = cid === "dem" || cid === "rep" || cid === "other" ? cid : (c ? c.party : "other");
        if ((p === "dem" || p === "rep") && alone && c && !NOT_A_CONTENDER.test(cid)) add(cid, p, c.name, v);
        else if (p === "dem" || p === "rep") add(p, p, null, v);
        else if (c && !NOT_A_CONTENDER.test(cid)) add(cid, p || "other", c.name, v);
        // A baseline file has party keys only, everyone else summed as
        // "other". Where no Democrat ran (NV-02 in 2024: Amodei against Greg
        // Kidd, an independent) that sum is the runner-up, not nothing: left
        // out, the seat read R+100.
        else if (cid === "other" && !c) add("other", "other", null, v);
      }
      const [a, b] = [...sums.values()].sort((x, y) => y.votes - x.votes);
      if (!a || a.votes <= 0) return null;
      const bv = b ? b.votes : 0;
      return { leader: a, second: b || null, pts: (100 * (a.votes - bv)) / (a.votes + bv),
               lead: a.votes - bv };
    },

    totalVotes(totals) {
      return (totals.dem || 0) + (totals.rep || 0) + (totals.other || 0);
    },

    /**
     * Swing against a baseline, positive toward the Democrats, in **margin
     * points** -- the same units as marginPts, which is why the factor is 200
     * and not 100.
     *
     * Both conventions are in use and they differ by a factor of two: a
     * county whose Democratic share falls 4.7 points has a margin 9.3 points
     * worse. Mixing them is the readout showing "R+17.4" next to "R+4.7" for
     * the same shift, which is how this was caught. One convention, stated
     * here, and the readout labels it.
     *
     * Computed, never stored -- the baseline is a dropdown, not a constant.
     */
    swingPts(raceId, unitId, baselineKey) {
      const race = api.race(raceId);
      // Either end can be a baseline file: "2024 against 2020" is a swing map
      // with no live race in it, and baselineUnit() resolves both kinds.
      const now = api.baselineUnit(raceId, unitId);
      const was = api.baselineUnit(baselineKey, unitId);
      if (!now || !was) return null;
      // The baseline needs its own candidate-to-party map when it is a race;
      // a baseline file is already party-keyed and race() returns null for it.
      const baseRace = api.race(baselineKey);
      const a = api.twoPartyDemShare(api.partyTotals(now.votes, race));
      const b = api.twoPartyDemShare(api.partyTotals(was.votes, baseRace));
      return (a == null || b == null) ? null : (a - b) * 200;
    },

    /* ------------------------------------------------- readout and totals */

    /**
     * One row per candidate, largest first, with the registry's names. A
     * baseline file has no candidates, so its party keys come back as rows
     * named by `names` (a baseline label table the caller holds) or by party.
     * Shares are of all votes, not two-party: the readout shows what a
     * candidate got, and only the margin is two-party.
     */
    candidateRows(votes, race, names = null) {
      const byId = new Map(((race && race.candidates) || []).map((c) => [c.id, c]));
      const rows = [];
      let total = 0;
      for (const [cid, v] of Object.entries(votes || {})) {
        const n = Number(v) || 0;
        total += n;
        const c = byId.get(cid);
        const party = c ? c.party : (cid === "dem" || cid === "rep" ? cid : "other");
        rows.push({
          id: cid, votes: n, party,
          // AP-style "Austin Scott (I)": the mark is the incumbent flag, not the name.
          name: c ? String(c.name).replace(/\s*\((?:I|i)\)\s*$/, "") : (names && names[cid]) || PARTY_NAMES[cid] || cid,
          incumbent: !!(c && (c.incumbent || isIncumbent(race, c.name))),
        });
      }
      // The literal "other" bucket goes last whatever its size: it is a
      // remainder, not a candidate.
      rows.sort((a, b) => (a.id === "other") - (b.id === "other") || b.votes - a.votes);
      for (const r of rows) r.share = total > 0 ? r.votes / total : null;
      return rows;
    },

    /**
     * Percent reporting for a unit or a statewide block, or null where the
     * file does not say. A certified file (final: true) with votes in it is
     * complete even though its reporting fields are null -- that is what
     * certified means -- but a final file of zeros is a staged race, and
     * stays null rather than reading as 100% of nothing.
     */
    reportingPct(block, data) {
      if (!block) return null;
      if (block.reporting_pct != null) return Number(block.reporting_pct);
      const p = block.precincts;
      if (Array.isArray(p) && p[1] > 0 && p[0] != null) return (100 * p[0]) / p[1];
      const votes = Object.values(block.votes || {}).reduce((a, b) => a + (Number(b) || 0), 0);
      if (data && data.final && votes > 0) return 100;
      return null;
    },

    /** Which kind of number reportingPct() is, for the label beside it. */
    reportingBasis(block, data) {
      if (!block) return null;
      if (data && data.statewide && data.statewide.expected_votes != null) return "expected vote";
      // The fallbacks' reporting figure (the Times, AP) is their estimate of
      // the expected vote in (eevp), not precincts, though the file carries
      // no expected_votes.
      if (data && data.source && (data.source.provider === "nyt" || data.source.provider === "ap") &&
          block.reporting_pct != null) {
        return "expected vote";
      }
      if (block.reporting_pct != null || Array.isArray(block.precincts)) return "precincts";
      return data && data.final ? "certified" : null;
    },

    /**
     * A baseline file summed to states. `stateOf(unitId)` is the caller's,
     * because the store knows ids and not geography. Cached per key: the
     * files do not change while the page is open.
     */
    baselineStateTotals(key, stateOf) {
      const b = baselines.get(key);
      if (!b) return null;
      if (!b.byState) {
        b.byState = new Map();
        for (const u of b.data.units || []) {
          const st = u.id == null ? null : stateOf(String(u.id));
          if (!st) continue;
          const t = b.byState.get(st) || { dem: 0, rep: 0, other: 0 };
          const p = api.partyTotals(u.votes, null);
          t.dem += p.dem; t.rep += p.rep; t.other += p.other;
          b.byState.set(st, t);
        }
      }
      return b.byState;
    },

    /** The races for one office and cycle in a state, the regular seat first. */
    racesFor(state, office, cycle) {
      return api.racesIn(state)
        .filter((r) => r.office === office && r.race_id.startsWith(`${cycle}-`))
        .sort((a, b) => (!!a.special - !!b.special) || a.race_id.localeCompare(b.race_id));
    },
  };
  return api;
}
