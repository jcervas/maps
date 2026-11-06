import { getJSON } from "../core/fetch.js";
/* Preset views: a saved geography + race + variable + zoom, on keys 1-9.
 *
 * Two sources, merged by slot. `presets.json` at the site root is the
 * producer's file -- hand-edited before the night, read on every boot and
 * never written by the wall. Views saved at the wall (shift + a digit, or the
 * Save button) go to localStorage and win over the file for that slot, so a
 * view made on the night survives a reload but can always be dropped back to
 * the file's by forgetting it. localStorage can be missing or throw (a
 * private window, blocked site data); the wall then just has the file's.
 *
 * A preset is
 *   { slot, name, app, focus, race, variable, baseline, center: [lon, lat], zoom,
 *     split: null | { raceMode, variable, baseline, race } }
 * `center` and `zoom` are geographic, not a pixel transform: the projection
 * is refitted to whatever screen the wall is on, so a view saved on a laptop
 * has to land on the same place on a 4K wall.
 */
const KEY = "magic-wall.presets.v1";
const SLOTS = 9;

function readLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? v : {};
  } catch (_) {
    return {};
  }
}

function writeLocal(map) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
    return true;
  } catch (_) {
    return false;
  }
}

function clean(p, slot) {
  if (!p || typeof p !== "object") return null;
  const n = Number(slot != null ? slot : p.slot);
  if (!(n >= 1 && n <= SLOTS)) return null;
  return {
    slot: n,
    name: String(p.name || `View ${n}`).slice(0, 60),
    app: ["map", "table", "boards", "battle"].includes(p.app) ? p.app : "map",
    focus: typeof p.focus === "string" && /^[A-Z]{2}$/.test(p.focus) ? p.focus : null,
    race: typeof p.race === "string" ? p.race : null,
    national: typeof p.national === "string" ? p.national : null,
    variable: typeof p.variable === "string" ? p.variable : "margin",
    baseline: typeof p.baseline === "string" ? p.baseline : null,
    center: Array.isArray(p.center) && p.center.length === 2 && p.center.every(Number.isFinite)
      ? p.center : null,
    zoom: Number.isFinite(p.zoom) && p.zoom > 0 ? p.zoom : 1,
    // The right panel of a split screen, or null for one map.
    split: p.split && typeof p.split === "object" ? {
      raceMode: typeof p.split.raceMode === "string" ? p.split.raceMode : undefined,
      variable: typeof p.split.variable === "string" ? p.split.variable : undefined,
      baseline: typeof p.split.baseline === "string" ? p.split.baseline : undefined,
      race: typeof p.split.race === "string" ? p.split.race : null,
    } : null,
  };
}

export function createPresets({ url = "presets.json", build = "" } = {}) {
  let file = {};                 // slot -> preset, from presets.json
  let local = readLocal();       // slot -> preset, saved at the wall

  async function load() {
    try {
      // No file is not an error: the wall works without presets.
      const j = (await getJSON(`${url}?v=${build}`, { cache: "no-store" }, { optional: true })) || { presets: [] };
      file = {};
      for (const p of j.presets || []) {
        const c = clean(p);
        if (c) file[c.slot] = c;
      }
    } catch (e) {
      console.warn("presets.json:", e.message);
      file = {};
    }
    return list();
  }

  function get(slot) {
    const l = clean(local[slot], slot);
    return l ? { ...l, origin: "saved" } : file[slot] ? { ...file[slot], origin: "file" } : null;
  }

  function list() {
    const out = [];
    for (let i = 1; i <= SLOTS; i++) {
      const p = get(i);
      if (p) out.push(p);
    }
    return out;
  }

  function save(slot, preset) {
    const c = clean(preset, slot);
    if (!c) return false;
    local = readLocal();
    local[slot] = c;
    return writeLocal(local);
  }

  function forget(slot) {
    local = readLocal();
    delete local[slot];
    return writeLocal(local);
  }

  function freeSlot() {
    for (let i = 1; i <= SLOTS; i++) if (!get(i)) return i;
    return null;
  }

  /** Everything as one presets.json, for the producer to paste into the file. */
  function exportJSON() {
    return JSON.stringify({ presets: list().map(({ origin, ...p }) => p) }, null, 2);
  }

  return { load, get, list, save, forget, freeSlot, exportJSON, SLOTS };
}
