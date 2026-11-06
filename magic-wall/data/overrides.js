/* The manual override: a hand-edited file that wins over any feed.
 *
 * DESIGN.md §10: "for the night a state's site goes down and the numbers are
 * on a TV in the corner." One file at the site root, `overrides.json`, read
 * by every wall on the same poll as the manifest -- so a second laptop
 * pointed at the same URL shows the same override, and nothing about the
 * harvester has to be running for it to work.
 *
 *   {"races": {
 *     "2026-sen-nc": {
 *       "active": true,
 *       "source": "NCSBE results page, read by hand",   // shown on the wall
 *       "entered_by": "JC",
 *       "as_of": "2026-11-04T02:42:00Z",                // the age the badge shows
 *       "statewide": {"reporting_pct": 62, "votes": {"roy-cooper": 1234567,
 *                                                    "michael-whatley": 1200001}},
 *       "units": {"37183": {"votes": {"roy-cooper": 310000,
 *                                     "michael-whatley": 150000},
 *                           "reporting_pct": 80}},
 *       "candidates": [{"id": "roy-cooper", "name": "Roy Cooper", "party": "dem"}],
 *       "status": {"state": "called", "party": "dem", "called_by": "AP"}
 *     }}}
 *
 * Rules, all of them about not inventing anything:
 *
 *   * Whatever an entry gives replaces the feed's value for that thing, and
 *     nothing else. Units it does not list keep the feed's numbers.
 *   * Units are keyed by geography id (FIPS / town GEOID) or by the feed's
 *     unit name. A key matching neither is added as an unmapped unit, kept
 *     in totals and listed in the table, like any other unmapped unit.
 *   * Statewide votes given are used as given. If an entry gives units but
 *     no statewide votes, statewide is re-summed from the units -- the same
 *     arithmetic harvest.py does -- so map and total cannot disagree.
 *   * Candidate ids are the slugs harvest.py writes (registry candidates).
 *     `candidates` is only needed for a race the registry lacks, or for a
 *     candidate the feed has not listed.
 *   * `active: false`, or deleting the entry, hands the race back to its feed
 *     on the next poll.
 *
 * The result is marked `override: "race"` (statewide numbers or status
 * replaced, or no feed at all) or `override: "units"` (some units patched,
 * the feed still in charge of the rest); the badge, readout and table say so.
 */

const OFFICES = { sen: "senate", sensp: "senate", gov: "governor", pres: "president" };

function sumUnits(units) {
  const out = {};
  for (const u of units) {
    for (const [cid, v] of Object.entries(u.votes || {})) {
      out[cid] = (out[cid] || 0) + (Number(v) || 0);
    }
  }
  return out;
}

export function applyOverride(raceId, base, o) {
  const data = base ? JSON.parse(JSON.stringify(base)) : {
    race_id: raceId, updated: null, final: false,
    status: { state: "undecided", party: null, called_by: null },
    statewide: { reporting_pct: null, precincts: null, expected_votes: null, votes: {} },
    units: [],
  };
  data.units = data.units || [];

  if (o.units) {
    const byKey = new Map();
    for (const u of data.units) {
      if (u.id != null) byKey.set(String(u.id), u);
      if (u.name) byKey.set(String(u.name).toLowerCase(), u);
    }
    for (const [key, ov] of Object.entries(o.units)) {
      let u = byKey.get(String(key)) || byKey.get(String(key).toLowerCase());
      if (!u) {
        const isId = /^\d{5,10}$/.test(key);
        u = { id: isId ? key : null, name: ov.name || key, reporting_pct: null, votes: {} };
        data.units.push(u);
      }
      if (ov.votes) u.votes = { ...ov.votes };
      if ("reporting_pct" in ov) u.reporting_pct = ov.reporting_pct;
      u.override = true;
    }
  }

  data.statewide = { ...(data.statewide || {}) };
  if (o.statewide) {
    // Hand-entered votes replace the feed's count, so the feed's progress
    // fields describe a different count. Keep them only if restated
    // (rehearsal: PA showed "41 of 9,066 precincts" under an override).
    if (o.statewide.votes) {
      data.statewide.reporting_pct = null;
      data.statewide.precincts = null;
      data.statewide.expected_votes = null;
    }
    for (const [k, v] of Object.entries(o.statewide)) data.statewide[k] = v;
  }
  if (o.units && !(o.statewide && o.statewide.votes)) {
    data.statewide.votes = sumUnits(data.units);
  }
  if (o.status) data.status = { ...data.status, ...o.status };
  if ("final" in o) data.final = o.final;

  // An entry that replaces the statewide numbers (or has no feed under it)
  // owns the race, and its age is the override's. One that only patches some
  // units leaves the feed in charge of the rest: the feed's clock and source
  // stay, and the patched units say so.
  const whole = !base || !!o.statewide || !!o.status;
  data.override = whole ? "race" : "units";
  data.override_units = o.units ? Object.keys(o.units).length : 0;
  data.override_source = { source: o.source || "manual", entered_by: o.entered_by || null,
                           as_of: o.as_of || null };
  if (whole) {
    data.updated = o.as_of || data.updated;
    data.feed_source = base ? base.source || null : null;
    data.source = { adapter: "override", ...data.override_source };
  } else if (o.as_of && (!data.updated || o.as_of > data.updated)) {
    data.updated = o.as_of;
  }
  return data;
}

/** A registry entry for a race only the override file knows about. */
export function raceFromOverride(raceId, o) {
  const parts = raceId.split("-");
  return {
    race_id: raceId,
    office: o.office || OFFICES[parts[1]] || parts[1],
    // <cycle>-<office>-<state>[-special]
    state: (o.state || parts[2] || "").toUpperCase(),
    special: parts[3] === "special",
    unit_tier: o.unit_tier || "county",
    candidates: o.candidates || [],
    generated_by: "overrides.json",
  };
}

/** Candidates an override names that the registry entry lacks. */
export function mergeCandidates(race, o) {
  if (!race || !o || !o.candidates) return;
  const have = new Set((race.candidates || []).map((c) => c.id));
  for (const c of o.candidates) {
    if (!have.has(c.id)) (race.candidates = race.candidates || []).push(c);
  }
}
