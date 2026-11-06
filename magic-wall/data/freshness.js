/* How old is the number on the wall, and is anything still checking it?
 *
 * The badge used to show the age of the wall's own last manifest fetch,
 * which stays green at "3s ago" with the harvester dead for an hour -- the
 * wall was alive, the data was not. Three clocks matter, and this reads all
 * of them from what scripts/poll.py writes into manifest.json:
 *
 *   wall      the browser reaching the site at all (poller.js)
 *   poller    manifest.poller.heartbeat -- is anything harvesting?
 *   source    manifest.sources[...] for the race in focus: when it was last
 *             checked, whether it is failing, waiting or stopped
 *
 * plus the data's own age, `updated` in the results file, which poll.py
 * moves only when the upstream bytes change.
 *
 * Thresholds follow DESIGN.md §10: over five minutes the badge changes, over
 * fifteen it is loud -- applied to "when was this last checked", since a
 * dead check is the failure nobody sees. The data's own age is always shown
 * and turns the badge amber once a race is counting and has not moved in
 * fifteen minutes; on a slow night that is true, and worth knowing.
 */

const MIN = 60 * 1000;
const WARN = 5 * MIN;
const BAD = 15 * MIN;
const RANK = { ok: 0, override: 1, unknown: 1, warn: 2, bad: 3 };

export function ago(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

const age = (iso, now) => (iso ? now - Date.parse(iso) : null);

/** The manifest.sources entry poll.py keeps for the job behind a results file. */
export function sourceFor(manifest, race, data) {
  if (!manifest || !manifest.sources || !race || !data || !data.source) return null;
  const key = String(data.source.key ?? "");
  let best = null;
  for (const [name, s] of Object.entries(manifest.sources)) {
    const st = (s.state || name.split(":")[0]).toUpperCase();
    if (st !== race.state) continue;
    const k = s.key ?? name.split(":").slice(1).join(":");
    if (k !== key && s.resolved_key !== key) continue;
    // Prefer the poller's own entry (it has an interval) over the line a
    // one-shot harvest leaves for the same key.
    if (!best || (s.interval && !best.interval)) best = { name, ...s };
  }
  return best;
}

export function freshness({ store, wall, raceId, now = Date.now() }) {
  const manifest = wall && wall.manifest;
  let level = "ok";
  const bits = [];
  const why = [];
  const raise = (l) => { if (RANK[l] > RANK[level]) level = l; };

  if (!wall || wall.ageMs == null) return { level: "unknown", text: "no data yet", title: "" };
  if (wall.level === "bad") { raise("bad"); why.push("the wall cannot reach the site"); }
  else if (wall.level === "warn") { raise("warn"); why.push(`site last reached ${ago(wall.ageMs)} ago`); }

  // A published copy (maps/build/magic-wall/publish.sh) is refreshed on a
  // schedule, not polled live: its heartbeat is as old as the copy, so the
  // copy's own age is the clock that matters.
  const pub = manifest && manifest.published;
  const hb = pub ? null : manifest && manifest.poller ? age(manifest.poller.heartbeat, now) : null;
  if (pub) {
    const pa = age(pub.at, now);
    why.push(`published copy, refreshed every ${Math.round((pub.every || 3600) / 60)} min; this one ${ago(pa)} old`);
    if (pa > 3 * (pub.every || 3600) * 1000) { raise("warn"); bits.push("copy out of date"); }
  }
  if (hb != null) {
    why.push(`poller heartbeat ${ago(hb)} ago`);
    if (hb > BAD) { raise("bad"); bits.push("poller stopped?"); }
    else if (hb > 3 * MIN) { raise("warn"); bits.push("poller quiet"); }
  }
  if (wall.overrideError) { raise("warn"); why.push(`overrides.json unreadable: ${wall.overrideError}`); }

  const race = raceId ? store.race(raceId) : null;
  const data = raceId ? store.results(raceId) : null;

  if (!race || !data) {
    // National view: how many polled sources are healthy.
    const polled = Object.values((manifest && manifest.sources) || {}).filter((s) => s.interval);
    const sick = polled.filter((s) => s.stopped || s.consecutive_failures > 0);
    if (polled.length) {
      bits.unshift(`${polled.length - sick.length}/${polled.length} sources ok`);
      if (polled.some((s) => s.stopped)) raise("bad");
      else if (sick.length) raise("warn");
      for (const s of sick) why.push(`${s.state} ${s.key}: ${s.stopped ? "stopped" : `failing ${s.consecutive_failures}/3`}`);
    } else {
      bits.unshift(`live · ${ago(wall.ageMs)}`);
    }
    return { level, text: bits.join(" · "), title: why.join("\n") };
  }

  const dataAge = age(data.updated, now);
  const votes = Object.values((data.statewide || {}).votes || {}).reduce((a, b) => a + (Number(b) || 0), 0);

  if (data.override === "units") {
    raise("override");
    const o = data.override_source || {};
    why.push(`${data.override_units} unit(s) hand-entered from ${o.source || "?"}, as of ${o.as_of || "?"}`);
  }
  if (data.override === "race") {
    raise("override");
    const src = data.source || {};
    bits.unshift(`${race.state} OVERRIDE · ${ago(dataAge)}`);
    why.unshift(`hand-entered from ${src.source || "?"}${src.entered_by ? ` by ${src.entered_by}` : ""}, as of ${data.updated || "?"}`);
    if (dataAge != null && dataAge > BAD) raise("warn");
    return { level, text: bits.join(" · "), title: why.join("\n") };
  }

  bits.unshift(`${race.state} · data ${ago(dataAge)}`
    + (data.override === "units" ? ` · ${data.override_units} OVERRIDDEN` : ""));
  why.unshift(`results last changed ${data.updated || "?"}`);
  if (votes > 0 && !data.final && dataAge != null && dataAge > BAD) {
    raise("warn");
    why.push("counting, and no change upstream in 15 minutes");
  }

  const src = sourceFor(manifest, race, data);
  if (src) {
    const checked = age(src.last_ok, now);
    if (src.stopped) { raise("bad"); bits.push("STOPPED"); why.push(`${src.name}: stopped after 3 failures`); }
    else if (src.consecutive_failures > 0) { raise("warn"); bits.push(`failing ${src.consecutive_failures}/3`); }
    else if (src.waiting) { bits.push("waiting"); why.push(`${src.name}: ${src.waiting}`); }
    if (checked != null) {
      bits.push(`checked ${ago(checked)}`);
      const allow = Math.max(WARN, 3 * (src.interval || 60) * 1000);
      if (checked > Math.max(BAD, allow)) raise("bad");
      else if (checked > allow) raise("warn");
    }
    if (src.in_flight_since) {
      const f = age(src.in_flight_since, now);
      if (f > 2 * MIN) { raise("warn"); why.push(`fetch in progress for ${ago(f)}`); }
    }
  } else {
    why.push("no poller entry for this source -- harvested by hand, not being checked");
    if (votes > 0 && !data.final) raise("warn");
  }
  return { level, text: bits.join(" · "), title: why.join("\n") };
}
