/* The only thing that polls: the manifest, then whatever changed.
 *
 * Contract in docs/schema.md §3. The wall fetches manifest.json on an
 * interval, compares each race's `updated` stamp with what the store already
 * has, and refetches only the races that moved. ETags on everything.
 *
 * Staleness is a first-class output, not an afterthought: `status()` reports
 * the age of the newest successful fetch and whether a source has stopped
 * answering, because a stuck number presented confidently is the only
 * unrecoverable failure mode on air.
 */

const STALE_WARN_MS = 5 * 60 * 1000;
const STALE_BAD_MS = 15 * 60 * 1000;
const MAX_FAILURES = 3;

/* Promise.allSettled over job thunks, at most `limit` running at once. A
 * first load wants every race file in the manifest (about 530), and firing
 * them together reset connections on the laptop's Python server -- and would
 * push them through a tunnel all at once for every viewer. */
async function settleLimited(jobs, limit) {
  const out = new Array(jobs.length);
  let next = 0;
  async function lane() {
    while (next < jobs.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await jobs[i]() };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, lane));
  return out;
}

export function createPoller({ store, base = ".", interval = 30000,
                               watch = null, onUpdate = null, onStatus = null }) {
  const etags = new Map();
  const seen = new Map();          // race_id -> last `updated` we ingested
  let timer = null;
  let lastOk = null;
  let failures = 0;
  let manifest = null;
  let running = false;
  let overrideError = null;

  async function get(url, { optional = false } = {}) {
    const headers = {};
    const tag = etags.get(url);
    if (tag) headers["If-None-Match"] = tag;
    const r = await fetch(url, { headers, cache: "no-store" });
    if (r.status === 304) return null;
    if (optional && r.status === 404) return { races: {} };
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    const et = r.headers.get("ETag");
    if (et) etags.set(url, et);
    return r.json();
  }

  function wanted(raceId) {
    return !watch || watch.includes(raceId);
  }

  async function tick() {
    try {
      const m = await get(`${base}/manifest.json`);
      if (m) manifest = m;
      if (manifest) {
        const jobs = [];
        for (const [raceId, meta] of Object.entries(manifest.races || {})) {
          if (!wanted(raceId)) continue;
          if (seen.get(raceId) === meta.updated && store.hasResults(raceId)) continue;
          jobs.push(() =>
            get(`${base}/results/${raceId}.json`).then((data) => {
              if (!data) return null;
              store.setResults(raceId, data);
              seen.set(raceId, meta.updated);
              return raceId;
            })
          );
        }
        const done = (await settleLimited(jobs, 12))
          .filter((x) => x.status === "fulfilled" && x.value)
          .map((x) => x.value);
        // The override file rides the same poll. Missing is normal (no
        // overrides tonight). Malformed -- a half-typed edit -- keeps the last
        // good overrides and says so in the badge, rather than counting as a
        // poll failure: three typos must not stop the live feed.
        try {
          const ov = await get(`${base}/overrides.json`, { optional: true });
          if (ov) done.push(...store.setOverrides(ov.races || {}));
          overrideError = null;
        } catch (e) {
          overrideError = String(e.message || e);
        }
        if (done.length && onUpdate) onUpdate([...new Set(done)], manifest);
      }
      lastOk = Date.now();
      failures = 0;
    } catch (e) {
      failures += 1;
      // A hard stop rather than retrying into the ground. The badge says so;
      // the operator decides whether to resume.
      if (failures >= MAX_FAILURES) stop();
    }
    if (onStatus) onStatus(api.status());
  }

  function start() {
    if (running) return api;
    running = true;
    tick();
    timer = setInterval(tick, interval);
    return api;
  }

  function stop() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
    return api;
  }

  const api = {
    start, stop, tick,
    get manifest() { return manifest; },
    status() {
      const age = lastOk == null ? null : Date.now() - lastOk;
      let level = "ok";
      if (!running && failures >= MAX_FAILURES) level = "bad";
      else if (age == null) level = "unknown";
      else if (age > STALE_BAD_MS) level = "bad";
      else if (age > STALE_WARN_MS) level = "warn";
      return { level, ageMs: age, failures, running, source: "live",
               manifest, overrideError };
    },
  };
  return api;
}
