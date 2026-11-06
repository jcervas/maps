/* Replay: the same interface as the poller, fed from archived snapshots.
 *
 * Every bug worth finding lives in the first ninety minutes of returns, and
 * replay is the only way to see those ninety minutes more than once. A corpus
 * is a directory of numbered snapshots plus an index:
 *
 *   replay/<race_id>/index.json   { race_id, synthetic, snapshots: [{ t, file }] }
 *   replay/<race_id>/000.json     a results file, exactly as a harvest writes it
 *
 * `t` is minutes from the first snapshot. The player multiplies by `speed`,
 * so a six-hour night runs in six minutes at 60x.
 *
 * scripts/make_replay_corpus.py builds a corpus. Where it has to invent an
 * arrival order -- a canvass file carries no timestamps -- it marks the
 * corpus `synthetic: true` and the wall says so in the badge. A synthetic
 * corpus tests the plumbing; it is not evidence about how a state reports.
 */

export function createReplay({ store, base = ".", raceIds = [], speed = 60,
                               onUpdate = null, onStatus = null }) {
  const corpora = new Map();      // race_id -> { index, loaded: Map(i -> data) }
  let timer = null;
  let running = false;
  let startedAt = null;
  let cursor = new Map();         // race_id -> next snapshot index
  let synthetic = false;

  async function load(raceId) {
    const r = await fetch(`${base}/replay/${raceId}/index.json`, { cache: "no-store" });
    if (!r.ok) throw new Error(`replay index for ${raceId}: ${r.status}`);
    const index = await r.json();
    if (index.synthetic) synthetic = true;
    corpora.set(raceId, { index, loaded: new Map() });
    cursor.set(raceId, 0);
  }

  async function snapshot(raceId, i) {
    const c = corpora.get(raceId);
    if (c.loaded.has(i)) return c.loaded.get(i);
    const entry = c.index.snapshots[i];
    const r = await fetch(`${base}/replay/${raceId}/${entry.file}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`replay ${raceId}/${entry.file}: ${r.status}`);
    const data = await r.json();
    c.loaded.set(i, data);
    return data;
  }

  async function tick() {
    const elapsedMin = ((Date.now() - startedAt) / 60000) * speed;
    const advanced = [];
    for (const [raceId, c] of corpora) {
      let i = cursor.get(raceId);
      let use = -1;
      while (i < c.index.snapshots.length && c.index.snapshots[i].t <= elapsedMin) {
        use = i;
        i += 1;
      }
      if (use >= 0) {
        store.setResults(raceId, await snapshot(raceId, use));
        cursor.set(raceId, i);
        advanced.push(raceId);
      }
    }
    if (advanced.length && onUpdate) onUpdate(advanced, null);
    if (onStatus) onStatus(api.status());
    if ([...corpora].every(([id, c]) => cursor.get(id) >= c.index.snapshots.length)) {
      stop();
      if (onStatus) onStatus(api.status());
    }
  }

  async function start() {
    if (running) return api;
    for (const id of raceIds) if (!corpora.has(id)) await load(id);
    running = true;
    startedAt = Date.now();
    await tick();
    timer = setInterval(tick, 1000);
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
    get speed() { return speed; },
    set speed(v) { speed = v; },
    status() {
      const total = [...corpora.values()]
        .reduce((n, c) => n + c.index.snapshots.length, 0);
      const at = [...cursor.values()].reduce((n, v) => n + v, 0);
      return {
        level: synthetic ? "warn" : "ok",
        source: synthetic ? "replay (synthetic)" : "replay",
        ageMs: 0, failures: 0, running,
        progress: total ? at / total : 0,
      };
    },
  };
  return api;
}
