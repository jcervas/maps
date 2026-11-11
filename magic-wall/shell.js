/* The shell: boot the store, start a source, wire the control rail.
 *
 * The shell owns "which app is on the wall", the presenter's tools that sit
 * over every app (telestration, presets, the keyboard map, the broadcast
 * type scale and palette), and the staleness badge. Apps register here with
 * { el, render }; every mounted app re-renders when the poller brings new
 * numbers, whether or not it is the one on screen, so switching to it never
 * shows a stale frame.
 */
import { createStore } from "./data/store.js";
import { getJSON } from "./core/fetch.js";
import { createPoller } from "./data/poller.js";
import { createReplay } from "./data/replay.js";
import { freshness } from "./data/freshness.js";
import { createPresets } from "./data/presets.js";
import { createMapApp } from "./apps/map.js";
import { createTableApp } from "./apps/table.js";
import { createTelestrator } from "./apps/telestrate.js";
import { createUpdates } from "./apps/updates.js";
import { createSources } from "./apps/sources.js";
import { setTheme, setScale, themeKey } from "./core/theme.js";
import { STATE_NAMES } from "./data/states.js";

const BUILD = "2026-11-10w";
const CYCLE = "2024";
const CYCLES = ["2026", "2025", "2024", "2022", "2020"];
const BASELINES = ["pres-2024", "pres-2020"];
const APPS = ["map", "table", "boards", "battle", "calls"];
const THEMES = ["light", "dark", "studio"];
const SCALES = [1, 1.5, 2];

const el = (id) => document.getElementById(id);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ?data=replay/rehearsal points the live machinery (registry, manifest,
// results, overrides) at a sandbox root -- the pipeline replay writes there.
// Geography and baselines always come from the site root.
const DATA = (() => {
  const d = new URLSearchParams(location.search).get("data");
  return d && /^[\w\-/]+$/.test(d) && !d.includes("..") ? d.replace(/\/$/, "") : ".";
})();

async function json(url) {
  return getJSON(`${url}?v=${BUILD}`, { cache: "no-store" });
}

/* Display preferences survive a reload on this machine. localStorage can be
 * missing or throw; then the wall just starts at 1x in the OS's palette. */
const PREFS = "magic-wall.display.v1";
function readPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS)) || {}; } catch (_) { return {}; }
}
function writePrefs(p) {
  try { localStorage.setItem(PREFS, JSON.stringify({ ...readPrefs(), ...p })); } catch (_) { /* fine */ }
}

let lastStatus = null;
let badgeContext = null;           // () => ({ store, raceId }), set in main()

// Fallback sources a results file can name in source.provider.
const PROVIDERS = {
  nyt: { short: "NYT", long: "Numbers from the New York Times's results file (fallback: no state feed has this race)" },
  ap: { short: "AP", long: "Numbers from the Associated Press's results file (fallback: no state feed has this race)" },
  harris: { short: "Harris County only", long: "Harris County's own count: one county, about a sixth of Texas (partial)" },
};

function setStatus(s) {
  if (s) lastStatus = s;
  const badge = el("status");
  if (!badge || !lastStatus) return;
  s = lastStatus;
  if (s.source === "live" && badgeContext) {
    // The age of the number in focus and of the check behind it, not of the
    // wall's own last fetch -- see data/freshness.js.
    const f = freshness({ wall: s, ...badgeContext() });
    // A rehearsal is never green, but a rehearsal that has broken still
    // goes red: the point of rehearsing is to see that happen.
    badge.dataset.level = DATA === "." || f.level === "bad" ? f.level : "warn";
    // A race filled from a fallback (adapters/nyt.py, ap.py, tx_harris.py)
    // says so where the freshness does: those are not the state's own numbers.
    const ctx = badgeContext();
    const res = ctx.raceId && ctx.store.results ? ctx.store.results(ctx.raceId) : null;
    const via = PROVIDERS[res && res.source && res.source.provider] || null;
    badge.textContent = (DATA === "." ? "" : `REHEARSAL (${DATA}) · `) + (via ? `via ${via.short} · ` : "") + f.text;
    badge.title = (via ? `${via.long}\n` : "") + f.title + "\nClick for every source and its status (O).";
    return;
  }
  badge.dataset.level = s.level;
  badge.textContent = `${s.source}${s.progress != null ? ` · ${Math.round(s.progress * 100)}%` : ""}`;
}

/* LIVE and a countdown to the next poll closing, from
 * data/reference/poll_close_2026.json (each state's last close, and the
 * first close of a state split across time zones, in UTC). Shown from 6 am
 * Eastern on election day until 12 hours after the last polls close; "LIVE"
 * on the real data root, "REHEARSAL" on a sandbox. For a few minutes after
 * each closing it says which states just closed. */
async function startPollClock() {
  const box = el("pollClock"), text = el("pollText"), pill = el("pollLive");
  if (!box) return;
  let pc;
  try { pc = await fetch("data/reference/poll_close_2026.json", { cache: "no-store" }).then((r) => r.json()); }
  catch (_) { return; }                         // no table, no clock
  // close time -> states closing then; a split state's first close is "(part)".
  const at = new Map();
  for (const [st, v] of Object.entries(pc.states || {})) {
    if (v.first) (at.get(v.first) || at.set(v.first, []).get(v.first)).push(`${st} (part)`);
    (at.get(v.close) || at.set(v.close, []).get(v.close)).push(st);
  }
  const closes = [...at.keys()].sort().map((t) => ({ t: Date.parse(t), states: at.get(t).sort() }));
  if (!closes.length) return;
  const day = Date.parse(`${pc.election}T11:00:00Z`);          // 6 am EST
  const end = closes[closes.length - 1].t + 12 * 3600e3;
  const JUST = 5 * 60e3;                                       // "just closed" for five minutes
  pill.textContent = DATA === "." ? "LIVE" : "REHEARSAL";
  pill.dataset.kind = DATA === "." ? "live" : "rehearsal";
  const clock = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
  };
  const list = (states) => (states.length <= 4 ? states.join(", ") : `${states.length} states`);
  const tick = () => {
    const now = Date.now();
    if (now < day || now > end) { box.hidden = true; return; }
    box.hidden = false;
    const i = closes.findIndex((c) => c.t > now);
    const last = [...closes].reverse().find((c) => c.t <= now);
    if (last && now - last.t < JUST) {
      text.textContent = `Polls just closed: ${list(last.states)}`;
      box.title = `Polls closed at ${new Date(last.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: ${last.states.join(", ")}`;
    } else if (i < 0) {
      text.textContent = "All polls closed";
      box.title = "The last polls (Alaska's Aleutians) have closed.";
    } else {
      const c = closes[i];
      text.textContent = `${i === 0 ? "First" : "Next"} polls close in ${clock(c.t - now)}`;
      box.title = `${new Date(c.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: ${c.states.join(", ")}` +
        (closes[i + 1] ? `\nThen ${new Date(closes[i + 1].t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: ${closes[i + 1].states.join(", ")}` : "");
    }
  };
  tick();
  setInterval(tick, 1000);
}

function fillBaselineSelect(status) {
  const sel = el("baseline");
  const opts = status.baselineOptions || [];
  const cur = sel.value;
  sel.innerHTML = "";
  for (const o of opts) {
    const n = document.createElement("option");
    n.value = o.key;
    // A tier mismatch is shown rather than hidden: "no county baseline for a
    // town" is a fact about the data worth seeing.
    n.textContent = o.ok ? o.label : `${o.label} (different tier)`;
    sel.append(n);
  }
  sel.value = status.baselineKey || cur || (opts[0] && opts[0].key) || "";
  // The comparison shows only as Swing or Turnout. Where neither can be
  // drawn right now (a race compared with itself) the menu stays usable --
  // picking another election is the way out -- and its tooltip says why.
  const cmp = (status.variables || []).filter((v) => v.key === "swing" || v.key === "turnout");
  const usable = !cmp.length || cmp.some((v) => v.available);
  sel.title = usable ? "Colors the map by Swing against this election"
    : ((cmp[0] && cmp[0].title) || "Nothing to compare with here");
}

// How a race's office reads in the Race menu: "PA State House 2024".
const RACE_OFFICE = { president: "President", senate: "Senate", governor: "Governor",
                      "secretary-of-state": "Secretary of State",
                      house: "House", "state-house": "State House", "state-senate": "State Senate" };

function fillRaceSelect(store, status) {
  const sel = el("race");
  const races = status.races || [];
  sel.innerHTML = "";
  if (!races.length) {
    sel.innerHTML = `<option value="">${status.districts && status.raceModeLabel
      ? `${status.raceModeLabel} · by district`
      : status.focus ? "no results harvested" : "baseline"}</option>`;
    sel.disabled = true;
    // Nothing to choose (the national view's "baseline", a state with no
    // file): the menu is not shown at all rather than shown empty.
    sel.closest(".field").hidden = true;
  } else {
    sel.disabled = false;
    // No race picked means the national mode's own file is drawn (President
    // 2024 is a baseline, not a results file), and the selector says so
    // rather than showing the first race as if it were on screen.
    if (!status.raceId && status.raceModeLabel) {
      const o = document.createElement("option");
      o.value = "";
      // A district mode draws each seat's own results file: not a baseline.
      o.textContent = status.districts
        ? `${status.raceModeLabel} · by district`
        : `baseline: ${(status.subject && store.baselineLabel(status.subject)) || status.raceModeLabel}`;
      sel.append(o);
    }
    for (const r of races) {
      const o = document.createElement("option");
      o.value = r.race_id;
      // Several cycles are loaded, so the year is part of the name; and a
      // state can hold two Senate races in one year, so the special says so.
      // House races differ only by district, which is the tail of the id.
      const dist = r.office === "house" ? (r.race_id.match(/-(\d+|al)$/) || [])[1] : null;
      const where = dist ? `${r.state}-${dist.toUpperCase()}` : r.state;
      o.textContent = `${where} ${RACE_OFFICE[r.office] || r.office} ${r.race_id.slice(0, 4)}${r.special ? " (special)" : ""}`;
      sel.append(o);
    }
    sel.value = status.raceId || (status.raceModeLabel ? "" : races[0].race_id);
    // One option, the one already on screen: nothing to choose either.
    sel.closest(".field").hidden = sel.options.length < 2;
  }
  fillVariables(status);
}

/* The color variables come from the map (status().variables), with whether
 * each can be drawn here and why not -- swing needs a baseline at the same
 * tier, turnout a baseline at all. Buttons are rebuilt only when the list
 * itself changes, so a press is never lost to a re-render. */
function fillVariables(status) {
  const seg = el("vars");
  const vars = status.variables ||
    [{ key: "margin", label: "Margin", available: true },
     { key: "swing", label: "Swing", available: !!status.swingAvailable }];
  const sig = vars.map((v) => v.key).join(",");
  if (seg.dataset.sig !== sig) {
    seg.dataset.sig = sig;
    seg.innerHTML = "";
    for (const v of vars) {
      const b = document.createElement("button");
      b.dataset.var = v.key;
      b.textContent = v.label;
      seg.append(b);
    }
  }
  for (const v of vars) {
    const b = seg.querySelector(`[data-var="${v.key}"]`);
    b.disabled = !v.available;
    b.title = v.title || "";
    b.setAttribute("aria-pressed", String(status.variable === v.key));
  }
}

/* National race modes: this year's elections as buttons, every earlier
 * one in a single Past results menu, newest year first (the user's call,
 * November 10, 2026; it was an office-then-year menu bar). A button's
 * tooltip says how far along its count is ("0 of 35 reporting · 19 staged,
 * 16 waiting"), because "Senate 2026" on a map that is mostly grey needs to
 * say why. An office no mode belongs to is simply not there. */
const OFFICES = [["president", "President"], ["senate", "U.S. Senate"], ["house", "House"],
                 ["governor", "Governor"], ["secretary-of-state", "Sec. of State"], ["state-senate", "State Senate"],
                 ["state-house", "State House"]];

function modeSummary(m) {
  return (m.statewide || m.districts) && m.total && m.summary ? m.summary
    : m.statewide && (m.states || m.noFeed)
      ? `${m.reporting || 0} of ${m.states || 0}${m.noFeed ? ` (+${m.noFeed} no feed)` : ""}`
      : "";
}

function fillNational(status) {
  const modes = status.raceModes || [];
  el("nationalField").hidden = !modes.length;
  el("nationalPick").hidden = !modes.length;
  if (!modes.length) return;
  const seg = el("national");
  const past = el("pastSel");
  const pick = el("nationalSel");
  const sig = modes.map((m) => `${m.key}:${m.office}:${modeSummary(m)}`).join(",");
  if (seg.dataset.sig !== sig) {
    seg.dataset.sig = sig;
    const known = OFFICES.map(([k]) => k);
    const offices = [...OFFICES, ...[...new Set(modes.map((m) => m.office))]
      .filter((o) => o && !known.includes(o)).map((o) => [o, o[0].toUpperCase() + o.slice(1)])];
    const label = (m) => (offices.find(([o]) => o === m.office) || [null, m.label])[1];
    const order = (m) => offices.findIndex(([o]) => o === m.office);
    const now = String(Math.max(...modes.map((m) => Number(m.cycle) || 0)));
    const live = modes.filter((m) => String(m.cycle) === now).sort((x, y) => order(x) - order(y));
    const years = [...new Set(modes.map((m) => String(m.cycle)).filter((y) => y !== now))]
      .sort((x, y) => y.localeCompare(x));
    seg.innerHTML = live.map((m) => {
      const sum = modeSummary(m);
      return `<button data-mode="${m.key}" aria-pressed="false"${sum ? ` title="${label(m)} ${now}: ${sum}"` : ""}>${label(m)}</button>`;
    }).join("");
    el("nationalYear").textContent = now;
    past.innerHTML = `<option value="">Past results</option>` + years.map((y) =>
      `<optgroup label="${y}">${modes.filter((m) => String(m.cycle) === y)
        .sort((x, z) => order(x) - order(z))
        .map((m) => `<option value="${m.key}">${label(m)} ${y}</option>`).join("")}</optgroup>`).join("");
    pick.innerHTML = [now, ...years].map((y) =>
      `<optgroup label="${y}">${modes.filter((m) => String(m.cycle) === y)
        .sort((x, z) => order(x) - order(z))
        .map((m) => `<option value="${m.key}">${label(m)} ${y}</option>`).join("")}</optgroup>`).join("");
  }
  for (const b of seg.querySelectorAll("[data-mode]")) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === status.raceMode));
  }
  // An earlier election on screen shows in the menu, marked as the choice;
  // this year's leaves it reading "Past results".
  const isPast = [...past.options].some((o) => o.value && o.value === status.raceMode);
  past.value = isPast ? status.raceMode : "";
  past.classList.toggle("current", isPast);
  pick.value = status.raceMode || "";
}

function pressed(selector, match) {
  for (const b of $$(selector)) b.setAttribute("aria-pressed", String(match(b)));
}

async function main() {
  const params = new URLSearchParams(location.search);
  const store = createStore();
  // Seat holders, so the candidate tables can mark an incumbent
  // (scripts/incumbents.py). Without it the tables are as before.
  json("data/reference/incumbents_2026.json")
    .then((j) => { store.setIncumbents(j); if (window.wall) window.wall.renderAll(); })
    .catch(() => {});

  /* ------------------------------------------------- display preferences */

  const prefs = readPrefs();
  function applyTheme(key) {
    setTheme(THEMES.includes(key) ? key : null);
    pressed("#themes button", (b) => b.dataset.themeKey === themeKey());
  }
  function applyScale(s) {
    const v = setScale(s);
    pressed("#scales button", (b) => Number(b.dataset.scale) === v);
    if (ink) ink.setWidth(5 * v);
    return v;
  }
  let ink = null;
  applyTheme(prefs.theme);
  applyScale(prefs.scale || 1);

  // Every cycle the harvester has written, and the national baselines they
  // are read against. A registry that does not exist yet is not an error:
  // 2026 appeared the moment Ohio's live feed was harvested, and the shell
  // should pick it up without being edited again.
  async function loadRegistry() {
    const regs = await Promise.all(
      CYCLES.map((c) => json(`${DATA}/registry/races_${c}.json`).catch(() => ({ races: [] }))));
    return { cycle: CYCLE, races: regs.flatMap((r) => r.races || []) };
  }
  const bases = await Promise.all(BASELINES.map((k) => json(`baselines/${k}.json`)));
  const registry = await loadRegistry();
  store.setRegistry(registry);
  BASELINES.forEach((k, i) => store.setBaseline(k, bases[i]));

  /* ----------------------------------------------------------- the apps */

  // id -> { el, render } once mounted. Boards and Battle mount when their
  // modules are wired; until then their buttons show a placeholder.
  const apps = {};
  let current = "map";
  let table = null;
  let lastFocus = null;
  let side = "left";               // the split panel the rail controls, see fillRail
  let mapReady = false;
  let hashApplying = true;         // until the link the page opened on is applied
  // The badge from the manifest as soon as it is in, rather than "starting"
  // until the poller's first pass has read every results file (about six
  // seconds on the public copy). The poller's own status replaces this one
  // at the end of that pass.
  badgeContext = () => ({ store, raceId: mapReady ? app.status().raceId : null });
  if (!params.get("replay")) {
    getJSON(`${DATA}/manifest.json?t=${Date.now()}`, { cache: "no-store" })
      .then((manifest) => {
        if (manifest && !lastStatus) {
          setStatus({ level: "ok", ageMs: 0, failures: 0, running: true, source: "live", manifest });
        }
      })
      .catch(() => {});
  }
  const focusWaiters = [];

  const app = createMapApp({
    stage: el("stage"),
    canvas: el("map"),
    readout: el("readoutBody"),
    store,
    onState: (status) => {
      el("back").hidden = !status.focus;
      el("where").textContent = status.focus || "United States";
      fillRail(status);
      // A variable that stops making sense where the wall has gone (turnout in
      // a state with no same-tier baseline) falls back to margin rather than
      // putting a grey map on air -- in either panel.
      const panes = [[app, status]];
      if (status.split && status.split.on && app.pane) panes.push([app.pane("right"), status.split]);
      for (const [pane, st] of panes) {
        const v = (st.variables || []).find((x) => x.key === st.variable);
        if (pane && v && !v.available && st.variable !== "margin") {
          pane.setVariable("margin");
          return;             // setVariable reports back through onState
        }
      }
      // A mark around a county that has just moved is worse than no mark.
      if (status.focus !== lastFocus && ink) ink.clear();
      lastFocus = status.focus;
      if (table) table.render();
      while (focusWaiters.length) focusWaiters.shift()();
      setStatus();
      writeHash(status);
    },
  });
  await app.load({ base: "." });
  mapReady = true;

  /* The opening view, on every load: the 2026 House on the map (its 2026
   * lines; the cartogram until the user moved the default to the map on the
   * evening of November 3), filled with the Cook ratings until the polls
   * start closing (7 pm ET, the first returns), then the margin. If the wall
   * is still on that opening view at 7, it switches by itself; once anyone
   * has moved off it, it is left alone. The user's call, November 3, 2026. */
  const RETURNS_AT = Date.parse("2026-11-04T00:00:00Z");   // 7 pm EST, November 3
  const opening = () => (Date.now() < RETURNS_AT ? "rating" : "margin");
  app.setRaceMode("house-2026");       // ignored if the mode is not offered
  if (app.setShapes) app.setShapes("lines");
  app.setVariable(opening());
  if (Date.now() < RETURNS_AT) {
    setTimeout(() => {
      const s = app.status();
      if (!s.focus && s.raceMode === "house-2026" && s.variable === "rating") app.setVariable("margin");
    }, RETURNS_AT - Date.now());
  }
  apps.map = { el: el("stage"), render: () => app.refresh() };
  startPollClock();

  /* Links to a view, for sharing (the user, November 10): #nc opens North
   * Carolina, #nc-05 (or #nc-5, #nc-al) that district as if it had been
   * tapped. The address bar follows the wall (replaceState, so moving about
   * adds no history), so it is always a link to what is on screen; a pasted
   * or edited hash, or Back to one, moves the wall. Anything else after the
   * # is dropped and the wall goes to the nation. The district half needs
   * the map's pinDistrict and status().district. */
  function parseHash(h) {
    let raw = String(h || "").replace(/^#/, "");
    try { raw = decodeURIComponent(raw); } catch (_) { return null; }
    const m = /^([a-z]{2})(?:-(\d{1,2}|al))?$/i.exec(raw.trim());
    if (!m || !STATE_NAMES[m[1].toUpperCase()]) return null;
    const st = m[1].toUpperCase();
    const d = m[2] && (/^al$/i.test(m[2]) ? "AL" : m[2].padStart(2, "0"));
    return { st, cd: d ? `${st}-${d}` : null };
  }
  function hashFor(st) {
    if (!st.focus) return "";
    const pre = `${st.focus}-`;
    const d = st.district && String(st.district).startsWith(pre) ? String(st.district).slice(pre.length) : null;
    return `#${st.focus.toLowerCase()}${d ? `-${d.toLowerCase()}` : ""}`;
  }
  function setHash(h) {
    if (h === location.hash || (!h && !location.hash)) return;
    history.replaceState(history.state, "", `${location.pathname}${location.search}${h}`);
  }
  function writeHash(st) {
    if (!mapReady || hashApplying) return;
    setHash(hashFor(st));
  }
  /** Until the map's status passes the test or ms go by: onState fires for
   *  data and menus too, so one report is not the move arriving. */
  async function waitUntil(test, ms = 6000) {
    const end = Date.now() + ms;
    while (!test(app.status()) && Date.now() < end) {
      await Promise.race([waitForFocus(), new Promise((r) => setTimeout(r, 200))]);
    }
    return test(app.status());
  }
  let hashRun = 0;
  async function applyHash() {
    const run = ++hashRun;
    const want = parseHash(location.hash);
    hashApplying = true;
    // Someone has taken the wall elsewhere meanwhile: their view wins.
    const elsewhere = (st) => !!(want && st.focus && st.focus !== want.st);
    try {
      if (!want) {
        if (app.status().focus) { app.unfocus(); await waitUntil((st) => !st.focus); }
        return;
      }
      setView("map");
      // A district is a House seat: its link opens on the House whatever the
      // wall was showing. A state's keeps the election on screen.
      if (want.cd && app.status().raceMode !== "house-2026") app.setRaceMode("house-2026");
      if (app.status().focus !== want.st) {
        // State to state goes by way of the nation, as a reader's taps do:
        // the map does not morph from one state straight to another.
        if (app.status().focus) {
          app.unfocus();
          await waitUntil((st) => !st.focus);
          if (run !== hashRun) return;
        }
        app.focusState(want.st);
        // Asked before the state is on screen, the map holds the district
        // and pins it when it lands there (apps/map.js pinDistrict).
        if (want.cd && app.pinDistrict) app.pinDistrict(want.cd);
        // On a fresh load the map lands only once the first results are in
        // (ten seconds and more on a slow line), so a long wait.
        await waitUntil((st) => st.focus === want.st || elsewhere(st), 30000);
        if (run !== hashRun || app.status().focus !== want.st) return;
        if (want.cd) await waitUntil((st) => st.district === want.cd || elsewhere(st), 1500);
      }
      if (run !== hashRun || !app.pinDistrict) return;
      // In the state already: pin the district asked for (false, and the
      // state alone, for a seat that is not there), or go back to the whole
      // state from one.
      if ((app.status().district || null) !== want.cd) {
        if (app.pinDistrict(want.cd) && want.cd) await waitUntil((st) => st.district === want.cd, 3000);
      }
    } finally {
      if (run === hashRun) {
        hashApplying = false;
        writeHash(app.status());      // a bad district, or a state with no map, says so
      }
    }
  }
  // Back and Forward across entries the wall has rewritten with
  // replaceState can fire popstate without hashchange, so both; a second
  // call for the same move supersedes the first (hashRun).
  window.addEventListener("hashchange", () => applyHash());
  window.addEventListener("popstate", () => applyHash());
  // A backstop: whatever moved the wall, the address bar catches up within a
  // second. A click into a district left Safari's at #nc (November 10) where
  // Chrome's followed; one comparison a second costs nothing.
  setInterval(() => { if (mapReady && !hashApplying) writeHash(app.status()); }, 1000);
  if (location.hash) applyHash();
  else hashApplying = false;

  // The district list reads the seat list, which loads below with the boards;
  // until then (or if it fails) the table says so.
  table = createTableApp({ el: el("table"), store, context: () => app.status(),
                           seats: () => { try { return seats; } catch (_) { return null; } } });
  table.render();
  apps.table = { el: el("table"), render: () => table.render() };

  function setView(next) {
    if (!APPS.includes(next)) return;
    if (next !== current && ink) ink.clear();
    current = next;
    for (const node of $$(".app")) node.hidden = node.dataset.app !== next;
    document.body.classList.remove(...APPS.map((a) => `app-${a}`));
    document.body.classList.add(`app-${next}`);
    pressed("#apps button", (b) => b.dataset.app === next);
    if (apps[next] && apps[next].render) apps[next].render();
  }
  for (const b of $$("#apps button")) b.addEventListener("click", () => setView(b.dataset.app));

  /** Every mounted app, on screen or not, less any that render themselves. */
  function renderAll(skip = []) {
    for (const [id, a] of Object.entries(apps)) {
      if (skip.includes(id)) continue;
      try { if (a.render) a.render(); } catch (e) { console.error(e); }
    }
  }

  /* ------------------------------------------------- boards and battle */

  // Imported dynamically and mounted inside a try: a broken board must cost
  // the wall its boards, never its map.
  let seats = null;
  async function goToRace(raceId) {
    const race = store.race(raceId);
    // A seat with no registry entry (no feed yet: Alaska Senate, say) still
    // names its state in its id -- sen, gov and house alike -- so the map
    // can at least go there.
    const st = race ? race.state : ((/^\d{4}-[a-z]+-([a-z]{2})(?:-|$)/.exec(raceId || "") || [])[1] || "").toUpperCase();
    if (!st) return;
    setView("map");
    if (app.status().focus !== st) {
      const wait = waitForFocus();
      app.focusState(st);
      await wait;
    }
    if (race && store.hasResults(raceId) && app.status().raceId !== raceId) app.setRace(raceId);
  }
  try {
    const [{ createSeats }, { createBoardsApp }, { createBattleApp }] = await Promise.all([
      import(`./data/seats.js?v=${BUILD}`), import(`./apps/boards.js?v=${BUILD}`),
      import(`./apps/battle.js?v=${BUILD}`)]);
    // calls.json sits at the data root (a rehearsal sandbox has its own);
    // holdovers and the House baseline always come from the site root.
    seats = createSeats({ store, base: DATA, root: ".", version: BUILD });
    await seats.load();
    seats.start();
    if (current === "table") table.render();
    for (const [id, make] of [["boards", createBoardsApp], ["battle", createBattleApp]]) {
      const node = el(id);
      node.innerHTML = "";
      mount(id, make({ el: node, seats, onSelect: (raceId) => goToRace(raceId) }));
    }
    // The Calls tab writes through scripts/serve.py, which accepts a call
    // only on the wall's own machine; anywhere else the tab stays hidden.
    const writable = await fetch("/api/calls", { cache: "no-store" })
      .then((r) => r.ok && r.json()).then((j) => !!(j && j.writable)).catch(() => false);
    if (writable) {
      const { createCallsApp } = await import(`./apps/calls.js?v=${BUILD}`);
      mount("calls", createCallsApp({ el: el("calls"), seats, store, data: DATA,
                                      onSelect: (raceId) => goToRace(raceId) }));
      document.querySelector('#apps [data-app="calls"]').hidden = false;
    }
  } catch (e) {
    console.error("boards:", e);
    for (const id of ["boards", "battle"]) {
      el(id).innerHTML = `<p>Not available in this build: ${e.message}</p>`;
    }
  }

  /* -------------------------------------------------------- telestration */

  ink = createTelestrator({
    canvas: el("ink"),
    onChange: (t) => {
      document.body.classList.toggle("drawing", t.on);
      el("drawBtn").setAttribute("aria-pressed", String(t.on));
      el("pens").hidden = !t.on;
      pressed(".pen", (b) => Number(b.dataset.pen) === t.color);
      el("undoBtn").disabled = !t.count;
      el("clearBtn").disabled = !t.count;
    },
  });
  ink.setWidth(5 * (Number(prefs.scale) || 1));
  el("drawBtn").addEventListener("click", () => ink.toggle());
  for (const b of $$(".pen")) b.addEventListener("click", () => ink.setColor(Number(b.dataset.pen)));
  el("undoBtn").addEventListener("click", () => ink.undo());
  el("clearBtn").addEventListener("click", () => ink.clear());
  ink.setOn(false);

  /* ------------------------------------------------------------- sources */

  // A race first harvested after this page loaded -- Georgia's id is not
  // published until the night, Washington's file not until 8 pm Pacific --
  // is in the manifest but not in the registry read at boot. Re-read the
  // registry when that happens instead of needing a reload on air.
  // So is a candidate first counted after load: a fallback (AP, the Times)
  // or a later feed can name someone the registry read at boot did not have,
  // and until it is re-read that candidate has no name and no party (IN-03's
  // "marlin-stutzman", drawn grey with a D+100 margin). At most every 20 s,
  // so a result that always carries an unregistered key cannot spin it.
  let registryReadAt = 0;
  const unregistered = (id) => {
    const race = store.race(id), res = store.results(id);
    if (!race || !res || !res.statewide) return false;
    const known = new Set((race.candidates || []).map((c) => c.id));
    return Object.keys(res.statewide.votes || {}).some((k) => !known.has(k));
  };
  async function onData(ids, manifest) {
    if ((ids || []).some((id) => !store.race(id))
        || (Date.now() - registryReadAt > 20000 && (ids || []).some(unregistered))) {
      registryReadAt = Date.now();
      store.setRegistry(await loadRegistry());
    }
    updates.record(ids, manifest);
    // A newly loaded result can be a baseline too. invalidate() re-renders
    // Boards and Battle through seats.onChange, so they are not drawn twice.
    if (seats) seats.invalidate();
    renderAll(seats ? ["boards", "battle"] : []);
    fillRail(app.status());
  }

  // Latest updates (N): a log of new numbers. Clicking an entry opens its
  // state on the map, in that race's mode.
  const MODE_OF = { sen: "senate", gov: "governor", sos: "secretary-of-state", house: "house", statehouse: "state-house", statesenate: "state-senate" };
  const updates = createUpdates({
    store, panel: el("updates"), button: el("updatesBtn"),
    calls: () => (seats ? seats.calls : null),
    onPick: (id) => {
      const m = /^(\d{4})-(sen|gov|sos|house|statehouse|statesenate)-([a-z]{2})/.exec(id);
      if (!m) return;
      setView("map");
      if (app.setRaceMode) app.setRaceMode(`${MODE_OF[m[2]]}-${m[1]}`);
      app.focusState(m[3].toUpperCase());
      updates.toggle(false);
    },
  });
  el("updatesBtn").addEventListener("click", () => updates.toggle());
  // The Calls tab: read once now as the baseline, then on every calls.json change.
  if (seats) { updates.syncCalls(); seats.onChange(() => updates.syncCalls()); }

  // Sources (O, or a click on the status badge): every feed and what it is
  // doing. A row opens its state on the map.
  const sources = createSources({
    panel: el("sources"), button: el("status"), base: DATA,
    onState: (st) => { setView("map"); app.focusState(st); sources.toggle(false); },
  });
  el("status").tabIndex = 0;
  el("status").addEventListener("click", () => sources.toggle());
  el("status").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { sources.toggle(); ev.preventDefault(); }
  });
  el("sourcesClose").addEventListener("click", () => sources.toggle(false));
  el("updatesClose").addEventListener("click", () => updates.toggle(false));
  // Replay plays only the races it has a corpus for (replay/index.json);
  // live polls everything in the manifest.
  const replayIds = params.get("replay")
    ? await json("replay/index.json").then((x) => x.races).catch(() => [])
    : null;
  const source = params.get("replay")
    ? createReplay({ store, raceIds: replayIds, speed: Number(params.get("speed") || 60),
                     onUpdate: onData, onStatus: setStatus })
    : createPoller({ store, base: DATA, watch: null, onUpdate: onData, onStatus: setStatus });
  source.start();
  setInterval(() => setStatus(), 5000);   // ages tick even when nothing moves

  /* ---------------------------------------------------------------- rail */

  /* Split screen: the race, color and comparison controls act on one panel
   * at a time, chosen by the Left | Right toggle that appears with the
   * split. Focus, pan and zoom are shared by the map itself. */
  function splitOn(st) { return !!(st.split && st.split.on); }
  function onRight(st) { return side === "right" && splitOn(st) && !!app.pane; }
  /** The panel the rail is pointed at. */
  function ctl() { return onRight(app.status()) ? app.pane("right") : app; }
  /** That panel's status, with the national fields the right panel shares. */
  function railStatus(st) { return onRight(st) ? { ...st, ...st.split } : st; }
  function fillRail(st) {
    if (!mapReady) return;         // onState can fire inside createMapApp's load
    const on = splitOn(st);
    if (!on) side = "left";
    const rs = railStatus(st);
    fillRaceSelect(store, rs);
    fillBaselineSelect(rs);
    fillNational(rs);
    el("splitBtn").hidden = !app.setSplit;
    el("splitBtn").setAttribute("aria-pressed", String(on));
    el("paneSeg").hidden = !on;
    pressed("#paneSeg button", (b) => b.dataset.side === side);
  }
  function setSide(next) {
    if (!splitOn(app.status())) return;
    side = next;
    fillRail(app.status());
  }
  function toggleSplit(force) {
    if (!app.setSplit) return;
    const on = force != null ? force : !splitOn(app.status());
    app.setSplit(on);
    if (!on) side = "left";
    fillRail(app.status());
  }
  el("splitBtn").addEventListener("click", () => toggleSplit());
  for (const b of $$("#paneSeg button")) b.addEventListener("click", () => setSide(b.dataset.side));

  // One level at a time, as a tap on the background: zoomed into a district,
  // back to the whole state; at the whole state, out to the nation.
  // From a pinned district, Esc is a tap on the background: the whole state,
  // every district drawn, its list in the aside (the user, November 10: it
  // used to zoom out with that one district still alone on the map).
  function home() {
    const st = app.status();
    if (st.district && app.pinDistrict) app.pinDistrict(null);
    else if (st.focus && app.view.transform.k <= 1.05) app.unfocus();
    else app.view.animateTo(d3.zoomIdentity);
  }
  function setVariable(v) {
    const b = document.querySelector(`#vars [data-var="${v}"]`);
    if (!b || b.disabled || b.hidden) return false;
    ctl().setVariable(v);
    fillVariables(railStatus(app.status()));
    return true;
  }

  el("back").addEventListener("click", () => app.unfocus());
  el("nationalSel").addEventListener("change", (ev) => {
    const pane = ctl();
    if (pane.setRaceMode) pane.setRaceMode(ev.target.value);
    if (table) table.render();
    ev.target.blur();
  });
  el("race").addEventListener("change", (ev) => {
    ctl().setRace(ev.target.value);
    if (table) table.render();
    ev.target.blur();             // so the keyboard map reaches the wall again
  });
  // Delegated: the buttons are rebuilt from the map's list of variables.
  // Folded, the group shows only the variable in use; a tap on it opens the
  // rest to its right, and a pick (or a tap anywhere else) folds it again.
  // The user's call: seven buttons always showing was a row of noise.
  const varsSeg = el("vars");
  function foldVars(open) {
    varsSeg.classList.toggle("open", open);
    const cur = varsSeg.querySelector('[aria-pressed="true"]');
    if (cur) cur.setAttribute("aria-expanded", String(open));
  }
  varsSeg.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-var]");
    if (!b) return;
    ev.stopPropagation();
    if (!varsSeg.classList.contains("open")) {
      foldVars(true);
      return;
    }
    if (b.getAttribute("aria-pressed") !== "true") setVariable(b.dataset.var);
    foldVars(false);
  });
  document.addEventListener("click", (ev) => {
    if (varsSeg.classList.contains("open") && !varsSeg.contains(ev.target)) foldVars(false);
  });
  document.addEventListener("keydown", (ev) => {
    // Consumed, so the rail's own Escape does not also go back to the nation.
    if (ev.key === "Escape" && varsSeg.classList.contains("open")) { foldVars(false); ev.preventDefault(); }
  });
  // This year's buttons and the Past results menu (fillNational) pick a
  // race mode for the panel the rail controls.
  function pickMode(key, from) {
    const pane = ctl();
    if (key && pane.setRaceMode) pane.setRaceMode(key);
    if (table) table.render();
    if (from) from.blur();          // so the keyboard map reaches the wall again
  }
  el("national").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-mode]");
    if (b) pickMode(b.dataset.mode, b);
  });
  el("pastSel").addEventListener("change", (ev) => pickMode(ev.target.value, ev.target));
  el("baseline").addEventListener("change", (ev) => {
    ctl().setBaseline(ev.target.value);
    // Picking a comparison is asking to see it: under Margin or Lead the
    // map would not change at all, which read as "Compare to is broken".
    const now = railStatus(app.status()).variable;
    if (now !== "swing" && now !== "turnout") setVariable("swing");
    if (table) table.render();
    ev.target.blur();
  });

  for (const b of $$("#themes button")) {
    b.addEventListener("click", () => {
      applyTheme(b.dataset.themeKey);
      writePrefs({ theme: b.dataset.themeKey });
      renderAll();
    });
  }
  for (const b of $$("#scales button")) {
    b.addEventListener("click", () => {
      writePrefs({ scale: applyScale(b.dataset.scale) });
      renderAll();
    });
  }
  el("build").textContent = BUILD;

  // Display menu: open on its button, shut on a click anywhere else or Esc.
  function setDisplay(open) {
    el("displayPop").hidden = !open;
    el("displayBtn").setAttribute("aria-expanded", String(open));
  }
  el("displayBtn").addEventListener("click", () => setDisplay(el("displayPop").hidden));
  document.addEventListener("pointerdown", (ev) => {
    if (!el("displayPop").hidden && !ev.target.closest(".display-menu")) setDisplay(false);
  });

  // Phone width: the secondary rows fold behind More (wall.css), so the map
  // gets most of the screen. Open or shut is remembered with the display
  // preferences.
  function setMore(open) {
    document.body.classList.toggle("more-open", open);
    el("moreBtn").setAttribute("aria-expanded", String(open));
    el("moreBtn").textContent = open ? "Less" : "More";
  }
  setMore(!!prefs.more);
  el("moreBtn").addEventListener("click", () => {
    const open = !document.body.classList.contains("more-open");
    setMore(open);
    writePrefs({ more: open });
  });

  /* ------------------------------------------------------------- presets */

  const presets = createPresets({ url: "presets.json", build: BUILD });

  // No menu of views on the rail any more (the user's call: clutter); they
  // are recalled with 1-9 and saved with shift + 1-9.
  function currentView() {
    const st = app.status();
    const frame = app.view.geoFrame();
    const race = st.raceId ? store.race(st.raceId) : null;
    const where = st.focus || "Nation";
    return {
      name: `${where} · ${race ? `${race.office} ${st.raceId.slice(0, 4)}` : (st.raceModeLabel || "baseline")}${st.variable !== "margin" ? ` · ${st.variable}` : ""}`,
      app: current, focus: st.focus, race: st.raceId, variable: st.variable,
      baseline: st.baselineKey,
      national: st.raceMode || null,
      split: splitOn(st)
        ? { raceMode: st.split.raceMode, variable: st.split.variable,
            baseline: st.split.baselineKey, race: st.split.raceId || null }
        : null,
      // An unzoomed view is saved as "fit", so it fits whatever screen
      // recalls it rather than pinning a centre.
      center: frame.zoom > 1.01 ? frame.center : null,
      zoom: frame.zoom > 1.01 ? Math.round(frame.zoom * 1000) / 1000 : 1,
    };
  }

  function waitForFocus() {
    return new Promise((res) => {
      focusWaiters.push(res);
      setTimeout(res, 5000);   // a state with no geography never calls back
    });
  }

  async function applyPreset(slot) {
    const p = presets.get(slot);
    if (!p) return;
    setView(p.app);
    if ((p.focus || null) !== (app.status().focus || null)) {
      const wait = waitForFocus();
      if (p.focus) app.focusState(p.focus); else app.unfocus();
      await wait;
    }
    if (p.national && app.setRaceMode && p.national !== app.status().raceMode) {
      app.setRaceMode(p.national);
    }
    if (p.race && store.hasResults(p.race) && p.race !== app.status().raceId) app.setRace(p.race);
    if (p.baseline && p.baseline !== app.status().baselineKey &&
        (app.status().baselineOptions || []).some((o) => o.key === p.baseline)) {
      app.setBaseline(p.baseline);
    }
    if (p.variable && p.variable !== app.status().variable &&
        (app.status().variables || []).some((x) => x.key === p.variable && x.available)) {
      app.setVariable(p.variable);
    }
    // The right panel, or no right panel: a preset says which.
    if (app.setSplit) {
      if (p.split) {
        app.setSplit({ raceMode: p.split.raceMode, variable: p.split.variable,
                       baseline: p.split.baseline });
        const right = app.pane && app.pane("right");
        if (right && p.split.race && store.hasResults(p.split.race)) right.setRace(p.split.race);
      } else if (splitOn(app.status())) {
        app.setSplit(false);
      }
      fillRail(app.status());
    }
    // After the drill's own crossfade, so the zoom starts from the fitted state.
    setTimeout(() => {
      const t = p.center ? app.view.transformFor(p.center, p.zoom) : null;
      app.view.animateTo(t || d3.zoomIdentity);
    }, 220);
    if (table) table.render();
  }

  function savePreset(slot) {
    const n = slot || presets.freeSlot() || 9;
    presets.save(n, currentView());
    flash(`Saved to ${n}`);
  }

  el("presetExport").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(presets.exportJSON());
      flash("Copied");
    } catch (_) {
      console.log(presets.exportJSON());
      flash("Printed to console");
    }
  });
  await presets.load();

  // A word on the tools row for a second and a half, rather than a toast
  // that covers the map.
  let flashTimer = null;
  function flash(text) {
    const b = el("flash");
    b.textContent = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { b.textContent = ""; }, 1500);
  }

  /* ------------------------------------------------------------ keyboard */

  function toggleKeys(force) {
    const open = force != null ? force : el("keys").hidden;
    el("keys").hidden = !open;
    el("keysBtn").setAttribute("aria-pressed", String(open));
  }
  el("keysBtn").addEventListener("click", () => toggleKeys());
  el("keysClose").addEventListener("click", () => toggleKeys(false));

  document.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented || ev.altKey) return;
    const t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) return;
    if (t && t.tagName === "SELECT" && ev.key !== "Escape") return;
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "z") {
      if (ink.count) { ink.undo(); ev.preventDefault(); }
      return;
    }
    if (ev.metaKey || ev.ctrlKey) return;
    // Shift + digit arrives as "!", "@" ... on most layouts; the code does not.
    const digit = /^Digit([1-9])$/.exec(ev.code) || /^Numpad([1-9])$/.exec(ev.code);
    if (digit) {
      if (ev.shiftKey) savePreset(Number(digit[1])); else applyPreset(Number(digit[1]));
      ev.preventDefault();
      return;
    }
    const k = ev.key;
    const act = {
      m: () => setView("map"),
      t: () => setView("table"),
      b: () => setView("boards"),
      c: () => setView("battle"),
      k: () => { if (apps.calls) setView("calls"); },
      d: () => ink.toggle(),
      u: () => ink.undo(),
      x: () => ink.clear(),
      s: () => toggleSplit(),
      "[": () => setSide("left"),
      "]": () => setSide("right"),
      l: () => {
        const next = THEMES[(THEMES.indexOf(themeKey()) + 1) % THEMES.length];
        applyTheme(next); writePrefs({ theme: next }); renderAll();
      },
      "+": () => { writePrefs({ scale: applyScale(SCALES[Math.min(2, SCALES.indexOf(Number(readPrefs().scale || 1)) + 1)]) }); renderAll(); },
      "=": () => act["+"](),
      "-": () => { writePrefs({ scale: applyScale(SCALES[Math.max(0, SCALES.indexOf(Number(readPrefs().scale || 1)) - 1)]) }); renderAll(); },
      "?": () => toggleKeys(),
      n: () => updates.toggle(),
      o: () => sources.toggle(),
      Escape: () => {
        // One thing at a time, the most transient first.
        if (!el("displayPop").hidden) setDisplay(false);
        else if (updates.open) updates.toggle(false);
        else if (sources.open) sources.toggle(false);
        else if (!el("keys").hidden) toggleKeys(false);
        else if (ink.on) ink.setOn(false);
        else home();
      },
    }[k.length === 1 ? k.toLowerCase() : k];
    if (act) { act(); ev.preventDefault(); }
  });

  fillRail(app.status());

  // For the parallel apps to mount into without editing the shell's
  // internals, and for poking at in the console.
  function mount(id, instance) {
    if (!APPS.includes(id) || !instance) return;
    const node = document.querySelector(`.app[data-app="${id}"]`);
    node.classList.remove("placeholder");
    apps[id] = { el: node, render: () => instance.render && instance.render() };
    if (current === id) apps[id].render();
  }
  window.wall = { store, app, source, table, ink, presets, seats, mount, setView, applyPreset, renderAll, updates };
  // The map's Seats button needs the boards' seats, which exist only now;
  // handed over, the map redraws its buttons and offers it from the start.
  if (seats && app.useSeats) app.useSeats(seats);
}

main().catch((e) => {
  const r = el("readoutBody");
  if (r) r.innerHTML = `<div class="hint">Failed to start: ${e.message}</div>`;
  throw e;
});
