/* Race calls: a hand-edited file, and the only way a seat becomes "called".
 *
 * DESIGN.md §8: "called" means *somebody else called it* and the file says
 * who. This project does not call races, so nothing here looks at a vote
 * count. `calls.json` sits at the data root beside `overrides.json`, is read
 * on its own 30-second poll, and every call it holds is shown with its `by`
 * and `at` -- an entry without both is refused, not shown unattributed.
 *
 *   {"calls": {
 *     "2026-sen-ga":      {"party": "dem", "winner": "Jon Ossoff",
 *                          "by": "AP", "at": "2026-11-04T03:12:00Z"},
 *     "2026-house-pa-07": {"party": "rep", "by": "AP", "at": "2026-11-04T05:40:00Z"},
 *     "2026-sen-ne":      {"party": "ind", "caucus": "dem", "by": "AP",
 *                          "at": "2026-11-04T04:01:00Z", "active": false}
 *   }}
 *
 * Missing is normal (no calls yet). Malformed -- a half-typed edit -- keeps
 * the last good set and reports the error, the same rule as overrides.json.
 * `active: false`, or deleting the entry, retracts the call on the next poll.
 * Contract in docs/schema.md §7.
 */

const PARTIES = new Set(["dem", "rep", "ind", "lib", "grn", "other"]);

/** Check one entry. Returns { call } or { error }. */
export function validateCall(raceId, c) {
  if (!c || typeof c !== "object") return { error: "not an object" };
  if (!PARTIES.has(c.party)) return { error: `party "${c.party}" is not one of ${[...PARTIES].join(", ")}` };
  if (!c.by || typeof c.by !== "string" || !c.by.trim()) return { error: "no `by`: every call needs an attribution" };
  if (!c.at || Number.isNaN(Date.parse(c.at))) return { error: "no `at`, or not a date" };
  if (c.caucus != null && c.caucus !== "dem" && c.caucus !== "rep") {
    return { error: `caucus "${c.caucus}" is not dem or rep` };
  }
  return {
    call: {
      race_id: raceId, party: c.party, caucus: c.caucus || null,
      winner: c.winner || null, by: c.by.trim(), at: c.at, note: c.note || null,
    },
  };
}

export function createCalls({ base = ".", interval = 30000, onChange = null } = {}) {
  let calls = new Map();           // race_id -> validated call
  let rejected = [];               // [{ race_id, error }]
  let error = null;                // the file itself would not parse
  let etag = null;
  let lastOk = null;
  let timer = null;

  function ingest(doc) {
    const next = new Map();
    const bad = [];
    for (const [id, c] of Object.entries((doc && doc.calls) || {})) {
      if (c && c.active === false) continue;
      const v = validateCall(id, c);
      if (v.call) next.set(id, v.call);
      else bad.push({ race_id: id, error: v.error });
    }
    const changed = JSON.stringify([...calls]) !== JSON.stringify([...next]) ||
      JSON.stringify(rejected) !== JSON.stringify(bad);
    calls = next;
    rejected = bad;
    return changed;
  }

  async function tick() {
    let changed = false;
    try {
      const headers = etag ? { "If-None-Match": etag } : {};
      const r = await fetch(`${base}/calls.json`, { headers, cache: "no-store" });
      if (r.status === 404) {
        changed = calls.size > 0 || rejected.length > 0 || error != null;
        calls = new Map(); rejected = []; etag = null;
      } else if (r.status !== 304) {
        if (!r.ok) throw new Error(`calls.json: ${r.status}`);
        const text = await r.text();
        const doc = JSON.parse(text);
        etag = r.headers.get("ETag");
        changed = ingest(doc) || error != null;
      }
      error = null;
      lastOk = Date.now();
    } catch (e) {
      // Keep the last good set: a typo must not un-call the night's races.
      const msg = String(e.message || e);
      changed = msg !== error;
      error = msg;
      etag = null;
    }
    if (changed && onChange) onChange(api);
    return api;
  }

  const api = {
    tick,
    start() {
      if (!timer) { tick(); timer = setInterval(tick, interval); }
      return api;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      return api;
    },
    /** The call for a race, or null. Never derived from votes. */
    get(raceId) { return calls.get(raceId) || null; },
    all() { return [...calls.values()]; },
    /** Replace the set directly -- the harness and tests use this. */
    load(doc) { ingest(doc); error = null; if (onChange) onChange(api); return api; },
    status() {
      return { count: calls.size, rejected: [...rejected], error, lastOk };
    },
  };
  return api;
}
