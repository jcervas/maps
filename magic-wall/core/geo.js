/* Loading geometry, and dissolving it.
 *
 * Extracted from jcervas.github.io/maps/redrawn-districts-2026
 * (loadBasemap, loadDistricts, buildStateOutlines, measure).
 */

import { getJSON } from "./fetch.js";

/** Fetch a TopoJSON file and hand back { objectName: features[] }. Retried
 *  on a dropped connection (core/fetch.js). */
export async function loadTopo(url) {
  const topo = await getJSON(url);
  const out = { __topo: topo };
  for (const name of Object.keys(topo.objects)) {
    out[name] = topojson.feature(topo, topo.objects[name]).features;
  }
  return out;
}

/* The same, parsed off the main thread: { objectName: features[] }, no
 * __topo. For files too big to parse while the wall is on air -- California's
 * precincts are 21 MB, about five seconds of frozen map on the main thread
 * and under one in a worker, with the map running meanwhile. One worker, made
 * on first use from the page's own TopoJSON script; without one (no Worker,
 * no script tag) this falls back to loadTopo. */
let worker = null, seq = 0;
const waiting = new Map();

function topoWorker() {
  if (worker !== null) return worker;
  worker = false;
  const lib = typeof document !== "undefined" && document.querySelector('script[src*="topojson"]');
  if (!lib || typeof Worker === "undefined") return worker;
  try {
    const code = `importScripts(${JSON.stringify(lib.src)});
onmessage = async (e) => {
  const { id, url } = e.data;
  try {
    // The same retries as core/fetch.js: a dropped connection, a 5xx or a 429.
    let topo = null;
    for (let i = 0; topo === null; i++) {
      try {
        const r = await fetch(url);
        if (r.ok) topo = await r.json();
        else if ((r.status < 500 && r.status !== 429) || i >= 3) throw Object.assign(new Error(url + ": " + r.status), { final: true });
      } catch (err) {
        if (err.final || i >= 3) throw err;
      }
      if (topo === null) await new Promise((res) => setTimeout(res, [500, 1500, 4000][i]));
    }
    const out = {};
    for (const name of Object.keys(topo.objects)) out[name] = topojson.feature(topo, topo.objects[name]).features;
    postMessage({ id, out });
  } catch (err) { postMessage({ id, error: String(err && err.message || err) }); }
};`;
    worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    worker.onmessage = (e) => {
      const p = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (p) e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.out);
    };
  } catch (_) {
    worker = false;
  }
  return worker;
}

export function loadTopoOffThread(url) {
  const w = topoWorker();
  if (!w) return loadTopo(url);
  const id = ++seq;
  // The worker resolves the URL against its own blob: URL, so send it whole.
  const abs = new URL(url, location.href).href;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.postMessage({ id, url: abs });
  });
}

/*
 * Dissolve features into one shape per value of `prop`. Done at load time
 * because topojson.merge works on the topology, which is gone a moment later.
 * Fifty merges over 3,143 counties cost about 15 ms, which buys state
 * outlines that land exactly on the county edges rather than nearly on them
 * -- two files drawn from different Census releases do not agree, and at
 * national zoom that disagreement is a visible double line.
 */
export function dissolveBy(topo, objectName, prop) {
  const obj = topo.__topo.objects[objectName];
  const groups = {};
  for (const g of obj.geometries || []) {
    const key = g.properties && g.properties[prop];
    if (key) (groups[key] = groups[key] || []).push(g);
  }
  const out = {};
  for (const key of Object.keys(groups)) {
    out[key] = {
      type: "Feature",
      properties: { [prop]: key, id: key, name: key, tier: "state" },
      geometry: topojson.merge(topo.__topo, groups[key]),
    };
  }
  return out;
}

/** Spherical area in km², cached on the feature. Used for density fades. */
const EARTH_KM2 = 6371 * 6371;
export function measure(features) {
  for (const f of features) {
    if (f.__areaKm2 === undefined) f.__areaKm2 = d3.geoArea(f) * EARTH_KM2;
  }
  return features;
}

/** Index features by a property, for joining results to geometry. */
export function indexBy(features, prop = "id") {
  const m = new Map();
  for (const f of features) {
    const k = f.properties && f.properties[prop];
    if (k != null) m.set(String(k), f);
  }
  return m;
}
