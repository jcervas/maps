/* The only thing that polls: the manifest, then whatever changed.
 *
 * Contract in docs/schema.md §3. The wall fetches manifest.json on an
 * interval, compares each race's `updated` stamp with what the store already
 * has, and refetches only the races that moved. ETags on everything.
 *
 * Only the races something has asked for are loaded (the user, November 26:
 * "Can things load as needed instead?"). A view reads a race from the store;
 * a race the manifest lists but the store does not have yet asks for its
 * group -- the race id's first two parts, "2026-house" for 2026-house-pa-07
 * -- and the whole group loads at once: one file from results/bundles/ on a
 * published copy (maps/build/magic-wall/publish.sh), one file a race where
 * there are no bundles. From then on the group's races are polled like any
 * other, one by one as their stamps move.
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
 * group with no bundle (the wall's own server) is one file a race -- 434 for
 * the House -- and firing them together reset connections on the laptop's
 * Python server. */
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
                               watch = null, onUpdate = null, onStatus = null, onManifest = null }) {
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

  /* ------------------------------------------------ groups, as asked for */

  const groupMemo = new Map();
  function groupOf(raceId) {
    let g = groupMemo.get(raceId);
    if (g === undefined) { g = raceId.split("-", 2).join("-"); groupMemo.set(raceId, g); }
    return g;
  }
  const asked = new Set();         // groups asked for: loaded, or in `queued`
  const queued = new Set();        // asked for and not loaded yet
  let inTick = false;
  let drainTimer = null;
  // Ticks and group loads take turns, so a group never loads twice at once.
  let chain = Promise.resolve();
  const serial = (fn) => (chain = chain.then(fn, fn));

  function want(raceId) {
    if (!manifest || !(manifest.races || {})[raceId] || !wanted(raceId)) return;
    const g = groupOf(raceId);
    if (asked.has(g)) return;
    asked.add(g);
    queued.add(g);
    if (onStatus) onStatus(api.status());
    // Inside a tick the tick loads it; otherwise soon, once whatever is
    // drawing has asked for everything it wants.
    if (inTick || drainTimer) return;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      serial(async () => {
        const done = await drain();
        if (done.length && onUpdate) onUpdate(done, manifest);
        if (onStatus) onStatus(api.status());
      });
    }, 0);
  }
  store.onMiss && store.onMiss(want);

  /* A published copy has results/bundles/<group>.json, { races: { race_id:
   * results file } }, built with its manifest; the wall's own server has
   * none. The first 404, before any bundle has loaded, means none here. */
  let bundles = true;
  let bundleSeen = false;
  async function fetchRace(raceId) {
    const meta = (manifest.races || {})[raceId];
    const data = await get(`${base}/results/${raceId}.json`);
    if (!data) return null;
    store.setResults(raceId, data);
    seen.set(raceId, meta ? meta.updated : data.updated);
    return raceId;
  }
  async function loadGroup(g) {
    const ids = Object.keys(manifest.races || {}).filter((id) => groupOf(id) === g && wanted(id));
    const done = [];
    if (bundles) {
      try {
        const r = await fetch(`${base}/results/bundles/${g}.json`, { cache: "no-store" });
        if (r.status === 404 && !bundleSeen) bundles = false;
        else if (r.ok) {
          bundleSeen = true;
          const b = await r.json();
          for (const [raceId, data] of Object.entries((b && b.races) || {})) {
            if (!data || !wanted(raceId) || !(manifest.races || {})[raceId]) continue;
            store.setResults(raceId, data);
            // The manifest's stamp: a group's bundle is built with the
            // manifest beside it (a file's own `updated` is when it was
            // harvested, which for a past race is not the manifest's).
            seen.set(raceId, manifest.races[raceId].updated);
            done.push(raceId);
          }
        }
      } catch (_) { /* the races one by one, below */ }
    }
    const jobs = ids.filter((id) => seen.get(id) !== manifest.races[id].updated || !seen.has(id))
      .map((id) => () => fetchRace(id));
    for (const x of await settleLimited(jobs, 12)) {
      if (x.status === "fulfilled" && x.value) done.push(x.value);
    }
    return done;
  }
  async function drain() {
    const done = [];
    while (queued.size && manifest) {
      const g = queued.values().next().value;
      done.push(...await loadGroup(g));
      queued.delete(g);
    }
    return done;
  }

  async function tick() {
    try {
      const m = await get(`${base}/manifest.json`);
      const first = !manifest && m;
      if (m) {
        manifest = m;
        if (store.setListed) store.setListed(Object.keys(m.races || {}));
      }
      if (manifest) {
        // The first manifest: let the views draw once, so they ask for what
        // they show, and load that before this poll counts as in -- the map
        // stays on "Loading" until then rather than drawing every race as
        // awaiting votes.
        if (first && onManifest) {
          inTick = true;
          try { onManifest(manifest); } catch (_) { /* a view's error is not the poll's */ }
          inTick = false;
        }
        const done = await drain();
        // Then the races already loaded whose stamps moved, and races new
        // to a group that is loaded.
        const jobs = [];
        for (const [raceId, meta] of Object.entries(manifest.races || {})) {
          if (!wanted(raceId) || !asked.has(groupOf(raceId)) || queued.has(groupOf(raceId))) continue;
          if (seen.has(raceId) && seen.get(raceId) === meta.updated) continue;
          jobs.push(() => fetchRace(raceId));
        }
        done.push(...(await settleLimited(jobs, 12))
          .filter((x) => x.status === "fulfilled" && x.value)
          .map((x) => x.value));
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
      inTick = false;
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
    serial(tick);
    timer = setInterval(() => serial(tick), interval);
    return api;
  }

  function stop() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
    return api;
  }

  const api = {
    start, stop, want,
    tick: () => serial(tick),
    get manifest() { return manifest; },
    /** Groups asked for and loaded, and those still loading. */
    groups() { return { loaded: [...asked].filter((g) => !queued.has(g)), loading: [...queued] }; },
    status() {
      const age = lastOk == null ? null : Date.now() - lastOk;
      let level = "ok";
      if (!running && failures >= MAX_FAILURES) level = "bad";
      else if (age == null) level = "unknown";
      else if (age > STALE_BAD_MS) level = "bad";
      else if (age > STALE_WARN_MS) level = "warn";
      return { level, ageMs: age, failures, running, source: "live",
               manifest, overrideError, loading: queued.size };
    },
  };
  return api;
}
