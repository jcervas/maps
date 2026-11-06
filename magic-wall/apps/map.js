/* The map app: national races, drill into a state, read a race.
 *
 * What P0 wires together. The view knows nothing about elections and the
 * store knows nothing about drawing; this is the piece that joins them, and
 * it is the one that should be read to understand how a new app would be
 * written.
 */
import { createView } from "../core/view.js";
import { loadTopo, loadTopoOffThread, dissolveBy, indexBy } from "../core/geo.js";
import { getJSON } from "../core/fetch.js";
import { stateProjection, fitProjection } from "../core/projection.js";
import { innerPoint } from "../core/geom.js";
import { layoutLabels, drawLabels, relaxLabels } from "../core/labels.js";
import { theme, onThemeChange } from "../core/theme.js";
import { ago } from "../data/freshness.js";
import { stateName } from "../data/states.js";
import { ballotText, createControlStrip, ensureStyles } from "./seatbar.js";
import { CHAMBER_TITLES, ALL_CHAMBERS } from "../data/seats.js";
import { ratingFor, legLabel, ratingSource, parseRating, RATINGS, LEG_RATINGS } from "../data/ratings.js";

// Canvas text follows the broadcast type scale (theme().scale: 1, 1.5, 2):
// 12 px is a laptop size and unreadable on a wall seen from across a room.
const FONT = (weight, px) =>
  `${weight} ${Math.round(px * (theme().scale || 1))}px "Libre Franklin", Helvetica, Arial, sans-serif`;

// Margin and swing both get the diverging ramp, at different clamps: a county
// margin runs to ±100 and is unreadable clamped there, while a swing of 15
// points is enormous. Clamping is a claim about what counts as a lot, so the
// numbers are here rather than buried in a scale.
const MARGIN_CLAMP = 40;
const SWING_CLAMP = 15;
// Raw lead is votes, so what counts as a lot depends on what is being
// colored: 100,000 votes is Philadelphia's whole margin and a fraction of
// California's. The ramp is square-root, so a county lead of a few hundred
// stays pale and the places the votes come from are the ones that are dark.
const LEAD_CLAMP_UNIT = 100000;
const LEAD_CLAMP_STATE = 1000000;
// Turnout against a baseline: a midterm runs 60-75% of a presidential year,
// a presidential year runs close to 100%. Clamped a little above parity so
// that the interesting range is not squashed into the bottom of the ramp.
const TURNOUT_CLAMP = 1.2;
// Partisan colors are classes with round breaks a viewer can read off the
// key -- a county is "R+10 to 20", not some fraction of the way along a
// blend. White is an exact tie and nothing else: R+0.3 is still a Republican
// lead and is drawn light red. So four breaks make five classes a side, one
// more than the four colors a side in --ramp-steps (wall.css); the extra
// class is made in between them (partisanClasses). The clamps above are only
// for a theme without steps, which falls back to the blend.
const BREAKS = {
  margin: [5, 10, 20, 30],
  swing: [2, 5, 10, 15],
  leadUnit: [1000, 5000, 25000, 100000],
  leadState: [10000, 50000, 250000, 1000000],
};

/* The color variables, in rail order. `seq` ones are not partisan and must
 * not use the red-blue ramp: a county 90% reported is not "very blue". */
export const VARIABLES = [
  { key: "margin", label: "Margin" },
  { key: "lead", label: "Raw lead" },
  { key: "reporting", label: "Reporting", seq: true },
  { key: "swing", label: "Swing" },
  { key: "turnout", label: "Turnout", seq: true },
  // Against the pre-election ratings (data/ratings.js), 2026 races only.
  { key: "rating", label: "Rating" },
  { key: "vsrating", label: "vs. Rating" },
];

/* Who the party keys of a baseline file were. Baseline files carry votes by
 * party and no candidates (docs/schema.md §5), and "Democratic 48.3%" on a
 * presidential map is a worse readout than the name. */
const BASELINE_NAMES = {
  "pres-2024": { dem: "Kamala Harris", rep: "Donald Trump" },
  "pres-2020": { dem: "Joe Biden", rep: "Donald Trump" },
};

/* National race modes that are drawn from a baseline file at its own tier,
 * rather than state by state from results files. Statewide modes (Senate,
 * governor, per cycle) are generated from the registry in raceModes(), so a
 * cycle that appears in the registry appears in the switcher. */
const FIXED_MODES = [
  { key: "pres-2024", label: "President 2024", baseline: "pres-2024", office: "president", cycle: "2024" },
  { key: "pres-2020", label: "President 2020", baseline: "pres-2020", office: "president", cycle: "2020" },
  { key: "house-2024", label: "House 2024", baseline: "house-2024", office: "house", cycle: "2024" },
  // Live, district by district: each district is colored from its own
  // results file (2026-house-pa-07), drawn on the 2024 shapes it borrows
  // from house-2024. States that drew new lines for 2026 are not drawn as
  // districts at all -- see redrawn.
  { key: "house-2026", label: "House 2026", geometry: "house-2024", office: "house", cycle: "2026",
    districts: true },
];
// Secretary of State (race key "sos", 2026-sos-<st>): a statewide race like
// governor, from the same state feeds, in the 26 states that elect one.
const STATEWIDE_OFFICES = ["senate", "governor", "secretary-of-state"];
const OFFICE_RANK = { president: 0, senate: 1, governor: 2, house: 3, "secretary-of-state": 4,
                      "state-house": 5, "state-senate": 6 };
const OFFICE_LABEL = { president: "President", senate: "Senate", governor: "Governor", house: "House",
                       "secretary-of-state": "Secretary of State",
                       "state-house": "State House", "state-senate": "State Senate" };
// A legislature's race is one file whose units are its districts (adapters/
// pa_leg.py): picked inside the state from the Race menu, never a national
// mode or a state's default race, and read out as seats rather than votes.
const LEGISLATURE = new Set(["state-house", "state-senate"]);
// Each map's radio menus (Shapes, Races, Seats) get names of their own: a
// split screen has two maps.
let radioGroups = 0;
// The tiers a district carries a number on, inside a state.
const DISTRICT_TIERS = new Set(["cd", "district", "senate-district"]);

/* Every file the map draws from, fetched once. A split panel is handed the
 * same bundle rather than parsing 1.5 MB of TopoJSON a second time. */
async function loadBundle(base) {
  const [counties, towns, basemap, districts, congress, congress26, house, holdovers, expected, candidates,
         senates] =
    await Promise.all([
    loadTopo(`${base}/geo/counties.topojson`),
    loadTopo(`${base}/geo/towns.topojson`),
    loadTopo(`${base}/geo/nation-states.topojson`),
    // Optional: a missing district file costs Alaska its map, not the wall.
    loadTopo(`${base}/geo/state-house.topojson`).catch(() => ({ districts: [] })),
    // Optional too, and the House mode is offered only when both the
    // districts and their baseline arrived.
    loadTopo(`${base}/geo/congress.topojson`).catch(() => ({ districts: [] })),
    // The 2026 lines (scripts/build_geo_2026.sh), for House 2026 in the
    // states that redrew. Optional: without it those states are crosshatched.
    loadTopo(`${base}/geo/congress-2026.topojson`).catch(() => ({ districts: [] })),
    getJSON(`${base}/baselines/house-2024.json`, { cache: "no-store" }, { optional: true }).catch(() => null),
    // The 2026 seats up, which the boards keep; only read here, to tell
    // a race with no feed from a state with no race.
    getJSON(`${base}/data/reference/holdovers_2026.json`, { cache: "no-store" }, { optional: true }).catch(() => null),
    // Every 2026 race and whether a feed stands behind it (scripts/expected.py).
    // Optional: without it a race with no file falls back to the seat list.
    getJSON(`${base}/registry/expected_2026.json`, { cache: "no-store" }, { optional: true }).catch(() => null),
    // Who is on the 2026 ballot, read off Wikipedia (scripts/candidates_wiki.py),
    // for a race with no results file yet. Optional.
    getJSON(`${base}/registry/candidates_2026.json`, { cache: "no-store" }, { optional: true }).catch(() => null),
    // State senate districts (Pennsylvania's 50), for a race whose unit_tier
    // is "senate-district". Optional, like the state house file.
    loadTopo(`${base}/geo/state-senate.topojson`).catch(() => ({ districts: [] })),
  ]);
  return { base, counties, towns, basemap, districts, congress, congress26, house, holdovers, expected,
           candidates, senates, carto: loadCarto(base),
           // City and town names (scripts/build_places.py), not waited for:
           // the map labels them inside a state once they land.
           places: getJSON(`${base}/geo/places.json`, {}, { optional: true }).catch(() => null) };
}

/* The equal-size district cartogram (scripts/build_cartogram.py): every
 * district one cell of the same area, so a map of the House is a map of
 * seats. Inside a state the cells are real longitude and latitude, carved
 * from the state's true outline, and drop in for the line files under the
 * state's own projection. national.topojson is the cartogram's own layout,
 * states resized to their seats, in layout pixels written as degrees near
 * 0,0: drawn under a plain equirectangular fitted to it (cartoProj), never
 * the Albers composite. Optional, and not waited for: until it lands, or
 * without it, the map draws lines. */
function loadCarto(base) {
  return Promise.all([
    loadTopo(`${base}/geo/cartogram/national.topojson`),
    loadTopo(`${base}/geo/cartogram/congress.topojson`),
    loadTopo(`${base}/geo/cartogram/congress-2026.topojson`),
    loadTopo(`${base}/geo/cartogram/state-house.topojson`).catch(() => ({ districts: [] })),
    loadTopo(`${base}/geo/cartogram/state-senate.topojson`).catch(() => ({ districts: [] })),
  ]).then(([nat, cd, cd26, house, senate]) => ({ nat, cd, cd26, house, senate }))
    .catch(() => null);
}

/* The same counties and districts at full 1:500,000 detail, for inside a
 * state (scripts/build_geo.sh). The national files are thinned to 15% of
 * their vertices so that all 3,144 counties redraw quickly; inside a state
 * only its own units draw, so they can afford every vertex. Fetched once per
 * bundle, after the wall is up, so the first frame never waits on 11 MB; until
 * it lands a state draws from the national file. */
function loadDetail(b) {
  if (!b.detail) {
    b.detail = Promise.all([
      loadTopo(`${b.base}/geo/detail/counties.topojson`),
      loadTopo(`${b.base}/geo/detail/congress.topojson`).catch(() => null),
      loadTopo(`${b.base}/geo/detail/congress-2026.topojson`).catch(() => null),
    ]).then(([counties, congress, congress26]) => ({ counties, congress, congress26 }))
      .catch(() => null);                     // a missing file costs detail, not the wall
  }
  return b.detail;
}

export function createMapApp({ stage, canvas, readout, store, onState, link = null, seats: seatsIn = null }) {
  let geo = null;                 // { counties, towns, nation, cds }
  let countiesByState = new Map();
  let townsByState = new Map();   // the six New England states
  let districtsByState = new Map(); // state house districts: Alaska's reporting units, Pennsylvania's seats
  let senatesByState = new Map();   // state senate districts (Pennsylvania)
  let cdsByState = new Map();     // congressional districts, when the file exists
  let cds26ByState = new Map();   // the same on 2026 lines, see newLines
  let fine = null;                // the same at full detail, once loaded: see loadDetail
  let carto = null;               // the cartogram, once loaded: see loadCarto
  let unitIndex = new Map();      // every unit id at every tier -> feature
  let stateFeatures = [];
  let focus = null;               // state abbreviation, or null for national
  let raceId = null;              // live race, when one is selected
  let modeKey = "pres-2024";      // national race mode, see raceModes()
  let baselineKey = "pres-2024";  // what swing and turnout compare against
  let baselineAuto = true;        // until someone picks one, see autoBaseline
  let variable = "margin";
  let hovered = null;
  let pressed = null;             // under a finger or a held button, outlined at once
  let moving = 0;                 // when a drill-in or -out morph started, or 0
  let pendingTap = null;          // a tap made during that morph, replayed after it
  let pinned = null;              // a tapped unit stays in the readout
  let legendOn = true;
  let seatsUp = new Map();        // "2026 senate GA" -> seat, from the holdover file
  let redrawn = new Set();        // states with new House lines for 2026, from the same file
  let expected = new Map();       // "2026 senate GA" -> [expected race], registry/expected_<cycle>.json
  let ballots = new Map();        // race id -> [{name, party, label}], registry/candidates_2026.json
  // A legislature race expected on the ballot but not yet harvested, built
  // from its expected row (scripts/expected.py LEGISLATURES), so it can be
  // picked and drawn as waiting before its first file: Pennsylvania's 2026
  // chambers, whose API returns nothing until votes exist.
  let pending = new Map();        // race id -> race-shaped object
  // 2024 presidential results by precinct (The New York Times; see
  // scripts/build_precincts_nyt.sh), per state, fetched on the way into it.
  // A precinct is a few pixels at the size of a state, so they replace the
  // counties only once the map is zoomed in on part of one.
  // Precincts draw whenever the counties on screen hold at most this many --
  // a small state at its full view, a big one once zoomed toward a region --
  // rather than past a fixed zoom: about the most the map holds comfortably
  // (California's 18,539 at once was ~300 MB of shapes).
  const PRECINCT_BUDGET = 8000;
  const precincts = new Map();    // state -> features, or null if the state has none
  let precinctShown = false;
  // On by default; the Precincts button turns them off, remembered per screen.
  let precinctsOn = true;
  try { precinctsOn = localStorage.getItem("mw.precincts") !== "off"; } catch (_) { /* private window */ }
  // What the House and the legislatures are drawn on: the cartogram (the
  // default), the race's own district lines, or, in House 2026, the 2024
  // lines. Remembered per screen. See shapeChoices.
  let shapes = "cartogram";
  try { shapes = localStorage.getItem("mw.shapes") || "cartogram"; } catch (_) { /* private window */ }
  // Cities and towns, biggest first: { byState: st -> [place], byDistrict:
  // "cd24:PA-12" -> [place] }. See adoptPlaces.
  let places = null;

  /** The registry's race, else a pending legislature race. */
  function raceOf(id) {
    return (id && (store.race(id) || pending.get(id))) || null;
  }
  let bundle = null;              // the loaded geometry, shared with a split panel
  let split = null;               // the right-hand panel's map app, in split screen
  let syncing = false;            // a zoom being copied from the other panel
  let titleOn = !!link;           // a split panel names what it shows
  // The card beside the pointer (see updateTip). On by default; the API's
  // setTip turns it off, remembered per screen.
  let tipOn = true;
  try { tipOn = localStorage.getItem("mw.tip") !== "off"; } catch (_) { /* private window */ }

  /* Each map draws into a pane of its own inside the stage, because the view
   * sizes its canvas to whatever it is given to measure: two maps measuring
   * the whole stage would each draw full width, one over the other. One
   * pane at full size is exactly the old layout. */
  const pane = document.createElement("div");
  pane.className = "map-pane";
  pane.style.cssText = "position:absolute;top:0;right:0;bottom:0;left:0;";
  canvas.parentNode.insertBefore(pane, canvas);
  pane.appendChild(canvas);

  const precinctBtn = document.createElement("button");
  precinctBtn.type = "button";
  precinctBtn.hidden = true;
  precinctBtn.title = "2024 presidential results by precinct (The New York Times), drawn when zoomed in";
  precinctBtn.style.cssText = "position:absolute;top:10px;right:10px;z-index:2;font:inherit;font-size:13px;" +
    "padding:6px 10px;border-radius:6px;border:1px solid var(--rule);background:var(--paper);color:var(--ink);cursor:pointer;";
  precinctBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    precinctsOn = !precinctsOn;
    try { localStorage.setItem("mw.precincts", precinctsOn ? "on" : "off"); } catch (_) { /* private window */ }
    changed();
  });
  pane.appendChild(precinctBtn);

  /* The map's own menus, out of Map options so the choice is always in
   * sight (the user's call): Shapes at the top left, Races at the top right
   * beside Map options, Seats in the control bar. Each is a row of radio
   * buttons, not a button that cycles: House 2026 has three shapes, and a
   * reader should see them all and pick one (the user's call). Native
   * radios sharing a name, so the arrow keys move between them; the name
   * is this map's own, since a split screen has two. The top-left column
   * wraps short of what is at the top right (stackButtons). */
  const corner = document.createElement("div");
  corner.style.cssText = "position:absolute;top:10px;left:10px;z-index:2;display:flex;flex-direction:column;" +
    "align-items:flex-start;gap:6px;max-width:calc(100% - 150px);";
  for (const t of ["click", "pointerdown", "mousedown", "wheel"]) {
    corner.addEventListener(t, (ev) => ev.stopPropagation());
  }
  pane.appendChild(corner);
  function radioMenu(label, title, pick, host = corner) {
    const el = document.createElement("div");
    el.hidden = true;
    el.setAttribute("role", "radiogroup");
    el.setAttribute("aria-label", label);
    el.title = title;
    // Shown and hidden by display (syncRadioMenu): an inline display:flex
    // would win over the hidden attribute.
    el.style.cssText = precinctBtn.style.cssText + "position:static;display:none;flex-wrap:wrap;align-items:center;" +
      "gap:4px 10px;cursor:default;box-sizing:border-box;max-width:100%;";
    el.dataset.label = label;
    el.dataset.name = `mw-${label.toLowerCase()}-${++radioGroups}`;
    el.addEventListener("change", (ev) => pick(ev.target.value));
    // A press on a menu is not a press on the map under it.
    for (const t of ["click", "pointerdown", "mousedown", "wheel"]) {
      el.addEventListener(t, (ev) => ev.stopPropagation());
    }
    host.appendChild(el);
    return el;
  }
  /** Fill a corner menu with [value, label] choices, the current one
   *  checked; fewer than two hides it. */
  function syncRadioMenu(el, choices, now) {
    el.hidden = choices.length < 2;
    el.style.display = el.hidden ? "none" : "flex";
    // Under a split panel's title, which is drawn at the same corner.
    corner.style.top = `${titleOn ? 40 * (theme().scale || 1) : 10}px`;
    if (el.hidden) return;
    const want = choices.map(([v, l]) => `${v}=${l}`).join("|");
    if (el.dataset.opts !== want) {
      const head = document.createElement("span");
      head.textContent = el.dataset.label;
      head.style.fontWeight = "600";
      el.replaceChildren(head, ...choices.map(([v, label]) => {
        const l = document.createElement("label");
        l.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;";
        const r = document.createElement("input");
        r.type = "radio";
        r.name = el.dataset.name;
        r.value = v;
        r.style.cssText = "margin:0;accent-color:var(--ink);cursor:pointer;";
        l.append(r, label);
        return l;
      }));
      el.dataset.opts = want;
    }
    for (const r of el.querySelectorAll("input")) r.checked = r.value === now;
  }

  const shapesBtn = radioMenu("Shapes",
    "Draw the districts as an equal-size cartogram (one cell per seat) or on their lines", (v) => {
      if (!shapeChoices().includes(v)) return;
      shapes = v;
      try { localStorage.setItem("mw.shapes", shapes); } catch (_) { /* private window */ }
      hovered = null;
      pinned = null;
      changed();
    });
  /* Rating as fill, or as chiclets: in chiclets the map stays plain and only
   * the races in play -- Lean and Toss-up, and under vs. Rating any upset --
   * carry a small marker in their rating color, so a national House map is
   * fifty markers rather than 435 shaded districts. Remembered per machine. */
  let ratingStyle = "fill";
  try { ratingStyle = localStorage.getItem("mw.ratingStyle") === "chiclet" ? "chiclet" : "fill"; } catch (_) { /* private window */ }
  const ratingBtn = document.createElement("button");
  ratingBtn.type = "button";
  ratingBtn.hidden = true;
  ratingBtn.title = "Rating as filled shapes, or as markers on the races in play only (Lean and Toss-up)";
  ratingBtn.style.cssText = precinctBtn.style.cssText;
  ratingBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    ratingStyle = ratingStyle === "chiclet" ? "fill" : "chiclet";
    try { localStorage.setItem("mw.ratingStyle", ratingStyle); } catch (_) { /* private window */ }
    changed();
  });
  pane.appendChild(ratingBtn);

  /* Called races only: on tonight's Margin and Raw lead maps, every race
   * not yet called is plain land -- the state, district or legislature
   * district and the counties inside it -- so the map shows only what has
   * been decided (calls.json). Flips only, the user's ask (November 3):
   * likewise every race that is not a called flip -- called (calls.json)
   * for a party other than the one holding the seat (data/seats.js
   * seat.flip, the Boards' Pickups). Remembered per machine. */
  const RACE_FILTERS = ["all", "called", "flips"];
  const RACE_FILTER_LABEL = { all: "All", called: "Called", flips: "Flips" };
  let raceFilter = "all";
  try {
    const v = localStorage.getItem("mw.raceFilter");
    raceFilter = RACE_FILTERS.includes(v) ? v : localStorage.getItem("mw.calledOnly") === "on" ? "called" : "all";
  } catch (_) { /* private window */ }
  const calledBtn = radioMenu("Races",
    "Every race, only the races that have been called, or only the seats changing hands", (v) => {
      if (!RACE_FILTERS.includes(v)) return;
      raceFilter = v;
      try { localStorage.setItem("mw.raceFilter", raceFilter); } catch (_) { /* private window */ }
      changed();
    }, pane);
  calledBtn.style.cssText += "position:absolute;top:10px;right:10px;z-index:2;max-width:none;";

  /* The control bar's box (see syncStrip): the live count, then Seats, a
   * row of radio buttons inside the same box (the user's ask), so the
   * choice between the map and the bins sits with the count it repeats.
   * The count is apps/seatbar.js's and redraws itself, so the box is the
   * map's own, styled as the bar (mw-ctlstrip), with the count drawn
   * plain inside it. While the bins are up the count leaves (they carry
   * it) and Seats stays, so a reader can always go back to the map. */
  ensureStyles();
  const stripBox = document.createElement("div");
  stripBox.className = "mw-ctlstrip";
  stripBox.hidden = true;
  for (const t of ["click", "pointerdown", "mousedown", "wheel"]) {
    stripBox.addEventListener(t, (ev) => ev.stopPropagation());
  }
  pane.appendChild(stripBox);
  // Seats: the map, or every seat of the chamber in three bins (see bins).
  const binsBtn = radioMenu("Seats",
    "Fly every seat into Democrat, Toss-up and Republican bins, with counts and the majority marked", (v) => {
      const on = bins.on && !bins.out;
      if (v === "bins" && !on) binsOpen();
      else if (v === "map" && on) binsClose();
    }, stripBox);
  binsBtn.style.cssText += "border:0;border-radius:0;background:none;padding:0;font-size:12px;justify-content:center;";

  /* The map's own controls (Precincts, Style) fold into one
   * button at the top right, the user's ask: four stacked buttons covered
   * the map's corner. A press opens them as a panel over the map, and
   * another press (or Escape) folds them away. Open or folded is remembered
   * per machine. They stay in the map pane rather than the readout, which
   * is rewritten with every hover. */
  const OPT_BTNS = [precinctBtn, ratingBtn];
  const optsBtn = document.createElement("button");
  optsBtn.type = "button";
  optsBtn.hidden = true;
  optsBtn.title = "Precincts and rating style for this map";
  optsBtn.style.cssText = precinctBtn.style.cssText;
  const optsPanel = document.createElement("div");
  optsPanel.className = "map-options";
  optsPanel.hidden = true;
  optsPanel.style.cssText = "position:absolute;right:10px;z-index:3;display:flex;flex-direction:column;" +
    "align-items:flex-end;gap:6px;";
  for (const b of OPT_BTNS) {
    b.style.position = "static";
    optsPanel.appendChild(b);
  }
  pane.append(optsBtn, optsPanel);
  let optsOpen = false;
  try { optsOpen = localStorage.getItem("mw.mapOptions") === "open"; } catch (_) { /* private window */ }
  function setOpts(open) {
    optsOpen = open;
    try { localStorage.setItem("mw.mapOptions", open ? "open" : "closed"); } catch (_) { /* private window */ }
    stackButtons();
  }
  optsBtn.addEventListener("click", (ev) => { ev.stopPropagation(); setOpts(!optsOpen); });
  for (const t of ["click", "pointerdown", "mousedown", "wheel"]) {
    optsBtn.addEventListener(t, (ev) => ev.stopPropagation());
    optsPanel.addEventListener(t, (ev) => ev.stopPropagation());
  }
  for (const el of [optsBtn, optsPanel]) {
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && optsOpen) { setOpts(false); optsBtn.focus(); }
    });
  }

  function syncBinsButton() {
    const spec = binsSpec();
    if (!spec && bins.on) binsReset();
    const on = bins.on && !bins.out;
    syncRadioMenu(binsBtn, spec ? [["map", "Map"], ["bins", "Bins"]] : [], on ? "bins" : "map");
    // Shown or hidden here, outside syncPrecinctButton, so the stack is
    // redone here too.
    stackButtons();
    syncStrip();
  }

  /* The live control bar (apps/seatbar.js createControlStrip, the Boards'
   * own count: seats not up plus calls, leaders beside them), the user's
   * ask: the chamber of the race in view, 2026 only, over the map's
   * bottom-right corner, clear of the legend (bottom left), the buttons
   * (top right) and the docked card (top left). Not for president or
   * secretary of state, which fill no chamber; not for a national
   * legislature view, which is two states' chambers; and not while the
   * seat bins are up, which carry the same count. */
  const stripEl = document.createElement("div");
  stripEl.hidden = true;
  stripBox.prepend(stripEl);
  let strip = null;
  function stripChamber() {
    const r = raceId ? raceOf(raceId) : null;
    const office = r ? r.office : mode().office;
    const cycle = r ? r.race_id.slice(0, 4) : mode().cycle;
    if (cycle !== "2026" || (bins.on && !bins.out)) return null;
    if (office === "senate" || office === "house" || office === "governor") return office;
    if (LEGISLATURE.has(office)) {
      const st = focus || (r && r.state);
      const c = st && `${st.toLowerCase()}-${office === "state-house" ? "house" : "senate"}`;
      return c && CHAMBER_TITLES[c] ? c : null;
    }
    return null;
  }
  function syncStrip() {
    const S = seatsSrc();
    if (!S) return;
    if (!strip) strip = createControlStrip({ el: stripEl, seats: S, titles: CHAMBER_TITLES });
    const c = stripChamber();
    if (c !== strip.chamber) strip.show(c);
    // The count drawn plain: the box is stripBox's.
    stripEl.style.cssText = "border:0;border-radius:0;background:none;padding:0;min-width:0;";
    const W = pane.clientWidth;
    stripBox.hidden = stripEl.hidden && binsBtn.hidden;
    stripBox.style.cssText = "position:absolute;right:10px;bottom:10px;z-index:2;" + (stripEl.hidden ? "min-width:0;"
      : `width:${Math.round(Math.max(260, Math.min(380, W - 270)))}px;`);
    binsBtn.style.borderTop = stripEl.hidden ? "0" : "1px solid var(--rule)";
    binsBtn.style.marginTop = stripEl.hidden ? "0" : "5px";
    binsBtn.style.paddingTop = stripEl.hidden ? "0" : "4px";
  }

  /* The rating legend as a bar, after the Times's Cook graphic, the user's
   * ask: a sliver per rated race from Solid D to Solid R, a box per kind of
   * race to watch (Likely, Lean, Toss-up) as wide as its count, the count a
   * side, and the source. A click on a box or a sliver keeps those races on
   * the map and greys the rest, several kinds at once; a second click, or
   * "Show all", brings them back. In the page rather than on the canvas,
   * because it is a control. It takes the canvas legend's corner (bottom
   * left), clear of the control bar (bottom right). */
  const RATING_CATS = [
    ["dem-2", "Solid D", "dem", 2], ["dem-1", "Likely D", "dem", 1], ["dem-0", "Lean D", "dem", 0],
    ["tossup", "Toss-up", null, null],
    ["rep-0", "Lean R", "rep", 0], ["rep-1", "Likely R", "rep", 1], ["rep-2", "Solid R", "rep", 2]];
  const ratingPick = new Set();          // RATING_CATS keys kept on the map; empty = all
  const ratingBar = document.createElement("div");
  ratingBar.className = "map-ratingbar";
  ratingBar.hidden = true;
  pane.appendChild(ratingBar);
  let barMemo = { feats: null, key: null };
  let barSig = null;
  onThemeChange(() => { barSig = null; barMemo = { feats: null, key: null }; });
  ratingBar.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-cat],[data-clear]");
    if (!el) return;
    if (el.dataset.clear != null) ratingPick.clear();
    else if (ratingPick.has(el.dataset.cat)) ratingPick.delete(el.dataset.cat);
    else ratingPick.add(el.dataset.cat);
    view.render();
  });
  ratingBar.addEventListener("keydown", (ev) => {
    if ((ev.key === "Enter" || ev.key === " ") && ev.target.closest("[data-cat],[data-clear]")) {
      ev.preventDefault();
      ev.target.click();
    }
  });

  /** A cell's RATING_CATS key, or null if unrated. */
  function ratingKey(c) {
    const R = ratingOf(c);
    if (!R) return null;
    return R.parsed.party ? `${R.parsed.party}-${RATING_LEVEL[R.parsed.strength]}` : "tossup";
  }
  /** False for a race the bar's picks leave off the map. */
  function ratingPicked(c) {
    return !ratingPick.size || (variable !== "rating" && variable !== "vsrating") || binsFilling ||
      ratingPick.has(ratingKey(c));
  }
  /** The rated races on this map, as cells: the same set the chiclets mark. */
  function ratedInView() {
    const r = raceOf(raceId);
    const leg = r ? LEGISLATURE.has(r.office) : LEGISLATURE.has(mode().office);
    const out = [];
    if (districtMode() || leg) {
      const L = view.getLayers().find((x) => x.id === "data");
      for (const f of (L && L.features) || []) {
        const t = f.properties.tier;
        if (t !== "state" && t !== "precinct") out.push(cellFor(f));
      }
    } else {
      for (const f of stateFeatures) if (!focus || f.properties.id === focus) out.push(stateCell(f.properties.id));
    }
    return out;
  }

  /* Run with every frame's overlay, so it follows focus, mode and data; the
   * work is skipped unless what it reads has changed. */
  function syncRatingBar() {
    const L = view.getLayers().find((x) => x.id === "data");
    const feats = (L && L.features) || null;
    const on = legendOn && (variable === "rating" || variable === "vsrating") && !variableNote(variable) &&
      binsCover() < 0.5;
    const key = [on, variable, focus, raceId, modeKey, chiclets(), [...ratingPick].join(), pane.clientWidth,
                 stripBox.hidden].join("|");
    if (barMemo.feats === feats && barMemo.key === key) return;
    barMemo = { feats, key };
    const cells = on ? ratedInView() : [];
    const count = Object.fromEntries(RATING_CATS.map((c) => [c[0], 0]));
    let unrated = 0;
    for (const c of cells) {
      const k = ratingKey(c);
      if (k) count[k] += 1;
      else if (!c.noRace && !c.notUp) unrated += 1;
    }
    const total = RATING_CATS.reduce((s, c) => s + count[c[0]], 0);
    // One race (a state's own statewide race) needs no bar: the canvas key
    // takes the corner, and picks made elsewhere would grey it unexplained.
    if (total < 2) {
      ratingBar.hidden = true;
      if (ratingPick.size) { ratingPick.clear(); requestAnimationFrame(() => view.render()); }
      return;
    }
    ratingBar.hidden = false;
    const sig = `${key}|${RATING_CATS.map((c) => count[c[0]])}|${unrated}`;
    if (sig === barSig) return;
    barSig = sig;

    const T = theme();
    const r = raceOf(raceId);
    const office = r ? r.office : mode().office;
    const leg = LEGISLATURE.has(office);
    const asOf = leg ? LEG_RATINGS.as_of : RATINGS.as_of[office];
    const day = asOf ? new Date(`${asOf}T12:00:00`).toLocaleDateString("en-US",
      { month: "long", day: "numeric", year: "numeric" }) : null;
    const color = (c) => c[2] ? ratingShade(c[2], c[3]) : tossupColor();
    const inkOn = (bg) => (d3.lab(bg).l > 62 ? "#000" : "#fff");
    const dim = (k) => ratingPick.size && !ratingPick.has(k);
    const cat = (c, extra) => `data-cat="${c[0]}" role="button" tabindex="0" aria-pressed="${ratingPick.has(c[0])}" ` +
      `title="${c[1]}: ${count[c[0]]}" style="${extra}background:${color(c)};opacity:${dim(c[0]) ? 0.3 : 1};` +
      `cursor:pointer;${ratingPick.has(c[0]) ? `outline:2px solid ${T.ink};outline-offset:-2px;` : ""}"`;

    // The thin bar: a sliver per race where there are few enough to count,
    // one block a rating where there are hundreds (the House).
    const few = total <= 60;
    const slivers = RATING_CATS.filter((c) => count[c[0]]).map((c) => few
      ? Array.from({ length: count[c[0]] }, () => `<span ${cat(c, "flex:1 1 0;")}></span>`).join("")
      : `<span ${cat(c, `flex:${count[c[0]]} 1 0;`)}></span>`).join("");
    const watchCats = RATING_CATS.filter((c) => c[3] !== 2);
    const watch = watchCats.reduce((s, c) => s + count[c[0]], 0);
    const boxes = watchCats.filter((c) => count[c[0]]).map((c) =>
      `<span ${cat(c, `flex:${count[c[0]]} 1 0;min-width:40px;color:${inkOn(color(c))};` +
        "display:flex;flex-direction:column;align-items:center;justify-content:center;padding:3px 2px;" +
        "overflow:hidden;white-space:nowrap;")}><b style="font-size:15px;line-height:1.1">${count[c[0]]}</b>` +
      `<span style="font-size:10px;line-height:1.1">${c[1]}</span></span>`).join("");
    const side = (p) => RATING_CATS.filter((c) => c[2] === p).reduce((s, c) => s + count[c[0]], 0);
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const solid = count["dem-2"] + count["rep-2"];
    const source = leg ? `StateNavigate${day ? `, ${day}` : ""} (Tilt shown as Toss-up).`
      : `Cook Political Report${day ? `, ${day}` : ""}.`;
    // vs. Rating colors the map by who leads against the rating, which the
    // bar does not key: its own swatches follow.
    const swatch = (fill) => fill === "hatch" ? `repeating-linear-gradient(45deg,${T.inkSoft} 0 1px,transparent 1px 4px)`
      : fill === "dots" ? `radial-gradient(${T.inkSoft} 1px,transparent 1.3px) 0 0/4px 4px` : fill;
    const keys = variable === "vsrating" ? ratingLegend(null).keys.map(([lab, fill]) => fill === "text"
      ? `<span style="color:var(--ink-soft)">${esc(lab)}</span>`
      : `<span style="white-space:nowrap"><i style="display:inline-block;width:10px;height:10px;vertical-align:-1px;` +
        `margin-right:3px;border:1px solid var(--baseedge);background:${swatch(fill)}"></i>${esc(lab)}</span>`).join(" ") : "";

    const W = pane.clientWidth;
    const room = stripBox.hidden ? 0 : stripBox.offsetWidth + 20;
    ratingBar.style.cssText = "position:absolute;left:10px;bottom:10px;z-index:2;box-sizing:border-box;" +
      `width:${Math.round(Math.max(220, Math.min(340, W - room - 30)))}px;padding:7px 9px 6px;border-radius:4px;` +
      "background:color-mix(in srgb,var(--paper) 92%,transparent);color:var(--ink);font-size:11px;line-height:1.35;";
    ratingBar.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">` +
        `<b style="letter-spacing:.06em;font-size:10px">${leg ? "STATENAVIGATE RATING" : "COOK POLITICAL REPORT RATING"}</b>` +
        // A span, not a button: the wall's buttons are 44 px touch targets.
        (ratingPick.size ? `<span data-clear role="button" tabindex="0" style="font-size:10px;padding:0 6px;` +
          "border:1px solid var(--ink-soft);border-radius:3px;cursor:pointer;white-space:nowrap\">Show all</span>" : "") +
      `</div>` +
      `<div style="display:flex;justify-content:space-between;font-weight:600;margin-top:3px">` +
        `<span style="color:var(--dem)">Democratic</span><span style="color:var(--rep)">Republican</span></div>` +
      `<div style="display:flex;gap:${few ? 1 : 0}px;height:8px;margin-top:1px">${slivers}</div>` +
      (boxes ? `<div style="display:flex;gap:2px;margin-top:4px;min-height:34px">${boxes}</div>` : "") +
      `<div style="margin-top:4px">${side("dem")} Democratic · ${side("rep")} Republican · ` +
        `${plural(count.tossup, "toss-up", "toss-ups")}</div>` +
      `<div>${plural(watch, "race", "races")} to watch · ${solid} solid` +
        `${unrated ? ` · ${unrated} not rated` : ""}</div>` +
      (keys ? `<div style="margin-top:3px;display:flex;flex-wrap:wrap;gap:2px 8px">${keys}</div>` : "") +
      `<div style="color:var(--ink-soft);margin-top:2px">${source}` +
        `${ratingPick.size ? "" : " Click a rating to show only those races."}</div>`;
  }

  /* On the cartogram every district is the same size, so a filled rating
   * map no longer reads as land: the user asked for the ratings filled
   * there. Chiclets are a lines-only style; the button hides with them. */
  let binsFilling = false;       // binSeats is reading fills: see binSeats
  function chiclets() {
    return ratingStyle === "chiclet" && (variable === "rating" || variable === "vsrating") && !cartoOn() &&
      !binsFilling;
  }

  function syncRatingButton() {
    const on = (variable === "rating" || variable === "vsrating") && !cartoOn();
    ratingBtn.hidden = !on;
    if (!on) return;
    ratingBtn.textContent = ratingStyle === "chiclet" ? "Style: Chiclets" : "Style: Fill";
    ratingBtn.setAttribute("aria-pressed", String(ratingStyle === "chiclet"));
  }

  function syncCalledButton() {
    syncRadioMenu(calledBtn, callsApply() ? RACE_FILTERS.map((v) => [v, RACE_FILTER_LABEL[v]]) : [], raceFilter);
  }

  const SHAPE_LABEL = { cartogram: "Cartogram", lines2024: "2024 lines" };
  function syncShapesButton() {
    const lines = mode().office === "house" && !raceId ? `${mode().cycle} lines` : "District lines";
    syncRadioMenu(shapesBtn, shapeChoices().map((v) => [v, SHAPE_LABEL[v] || lines]), shapesNow());
  }

  /** The options button shows while any of its controls applies; the panel
   *  opens under it, whichever controls are showing. */
  function stackButtons() {
    const any = OPT_BTNS.some((b) => !b.hidden);
    optsBtn.hidden = !any;
    optsPanel.hidden = !any || !optsOpen;
    optsBtn.textContent = optsOpen ? "Map options \u25B4" : "Map options \u25BE";
    optsBtn.setAttribute("aria-expanded", String(optsOpen));
    optsPanel.style.top = `${10 + (optsBtn.offsetHeight || 34) + 6}px`;
    // Races to the left of Map options; Shapes wraps short of both.
    const optsW = optsBtn.hidden ? 0 : optsBtn.offsetWidth + 8;
    calledBtn.style.right = `${10 + optsW}px`;
    corner.style.maxWidth = `calc(100% - ${optsW + (calledBtn.hidden ? 0 : calledBtn.offsetWidth + 8) + 30}px)`;
  }

  /** The button shows inside a state that has precincts; it says what a
   *  press will find, and that they wait for a closer zoom. */
  function syncPrecinctButton() {
    // Shown before the file is fetched (it waits for a close zoom); hidden
    // once a state turns out to have none (precincts: false).
    // The cartogram has no ground under a cell for precincts to sit on.
    const has = !!(focus && precincts.get(focus) !== false && !cartoOn());
    precinctBtn.hidden = !has;
    syncShapesButton();
    syncBinsButton();
    syncRatingButton();
    syncCalledButton();
    stackButtons();
    if (!has) return;
    precinctBtn.textContent = !precinctsOn ? "Precincts: off"
      : !precinctVariable() ? "Precincts: Margin and Raw lead only"
      : precinctShown ? "Precincts: on" : "Precincts: on (zoom in)";
    precinctBtn.setAttribute("aria-pressed", String(precinctsOn));
  }

  const view = createView({
    stage: pane, canvas, pad: 22,
    // A little room to zoom out past the fit, the user's ask, for a corner
    // an overlay still covers.
    scaleExtent: [0.75, 220],
    extentFeatures: () => (focus ? countiesByState.get(focus) : geo && nationalFrame()),
  });
  const nationalProj = view.projection;   // see unfocus
  const cartoProj = d3.geoEquirectangular();   // the cartogram's national layout, see loadCarto

  /* --------------------------------------------------------- race modes */

  function raceModes() {
    const out = [];
    for (const m of FIXED_MODES) {
      // House needs both the district file and its baseline; without them it
      // is not offered rather than offered and empty.
      const ok = store.baseline(m.baseline || m.geometry) &&
        (m.office !== "house" || (geo && geo.cds && geo.cds.length));
      if (!ok) continue;
      out.push(m.districts ? { ...m, statewide: false, ...districtCounts() } : { ...m, statewide: false });
    }
    const seen = new Set();
    // A legislature is a national mode too, so the office bar offers it: the
    // states with a chamber on this wall draw their districts, the rest read
    // no race. Pennsylvania's 2026 chambers count from their expected rows
    // before their first file.
    for (const r of [...((store.registry && store.registry.races) || []), ...pending.values()]) {
      if (!STATEWIDE_OFFICES.includes(r.office) && !LEGISLATURE.has(r.office)) continue;
      const cycle = r.race_id.slice(0, 4);
      const key = `${r.office}-${cycle}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, label: `${OFFICE_LABEL[r.office]} ${cycle}`, office: r.office,
                 cycle, statewide: true });
    }
    // A statewide office expected tonight but not yet harvested anywhere
    // (Secretary of State before the first state stages it) is offered too,
    // its states reading "feed waiting" from their expected rows.
    for (const list of expected.values()) {
      for (const r of list) {
        if (!STATEWIDE_OFFICES.includes(r.office)) continue;
        const cycle = String(r.race_id).slice(0, 4);
        const key = `${r.office}-${cycle}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, label: `${OFFICE_LABEL[r.office]} ${cycle}`, office: r.office, cycle, statewide: true });
      }
    }
    out.sort((a, b) => b.cycle.localeCompare(a.cycle) ||
      OFFICE_RANK[a.office] - OFFICE_RANK[b.office]);
    for (const m of out) {
      if (!m.statewide) continue;
      // How many states it would color, so the switcher can say "3 of 35".
      let states = 0, reporting = 0, nofeed = 0;
      for (const st of store.states()) {
        const r = primaryRace(st, m);
        if (!r) continue;
        states += 1;
        const d = store.results(r.race_id);
        if (d && store.totalVotes(store.partyTotals(statewideVotes(d), r)) > 0) reporting += 1;
      }
      for (const k of seatsUp.keys()) {
        const [cycle, office, st] = k.split(" ");
        if (cycle === m.cycle && office === m.office && !primaryRace(st, m)) nofeed += 1;
      }
      m.states = states;
      m.reporting = reporting;
      m.noFeed = nofeed;
      m.seatList = [...seatsUp.keys()].some((k) => k.startsWith(`${m.cycle} `));
      m.summary = `${reporting} of ${states}${nofeed ? ` (+${nofeed} no feed)` : ""}`;
      // With the expected-races file the count is by race, not by state,
      // and every race on the ballot is in it: a results file wins, and the
      // rest are waiting (a job, no election published yet) or have no
      // live feed (certified-only, or nothing).
      const ids = new Set(store.registry ? (store.registry.races || [])
        .filter((r) => r.office === m.office && r.race_id.startsWith(`${m.cycle}-`))
        .map((r) => r.race_id) : []);
      const exp = new Map();
      for (const [k, list] of expected) {
        if (!k.startsWith(`${m.cycle} ${m.office} `)) continue;
        for (const e of list) { ids.add(e.race_id); exp.set(e.race_id, e); }
      }
      if (exp.size) {
        const n = { reporting: 0, staged: 0, waiting: 0, nolive: 0 };
        for (const id of ids) {
          const d = store.results(id);
          if (d) {
            const votes = store.totalVotes(store.partyTotals(statewideVotes(d), store.race(id)));
            n[votes > 0 ? "reporting" : "staged"] += 1;
          } else {
            const f = (exp.get(id) || {}).feed;
            n[f === "staged" ? "staged" : f === "waiting" ? "waiting" : "nolive"] += 1;
          }
        }
        Object.assign(m, { total: ids.size, staged: n.staged, waiting: n.waiting, noLive: n.nolive });
        m.reporting = n.reporting;
        const parts = [n.staged && `${n.staged} staged`, n.waiting && `${n.waiting} waiting`,
                       n.nolive && `${n.nolive} no live feed`].filter(Boolean);
        m.summary = `${n.reporting} of ${ids.size} reporting${parts.length ? ` · ${parts.join(", ")}` : ""}`;
      }
      if (LEGISLATURE.has(m.office)) Object.assign(m, legislatureCounts(m));
    }
    return out;
  }

  /* A chamber counts by seat, not by state: "1 of 1" said nothing about
   * Pennsylvania's 25 Senate districts. The seats up are the file's units
   * once there is a file, else the expected row's district list. */
  function legislatureCounts(m) {
    const n = { total: 0, reporting: 0, staged: 0, waiting: 0, noLive: 0 };
    for (const st of new Set([...store.states(), ...[...pending.values()].map((r) => r.state)])) {
      const race = primaryRace(st, m);
      if (!race || !LEGISLATURE.has(race.office)) continue;
      const data = store.results(race.race_id);
      if (data) {
        for (const u of data.units || []) {
          n.total += 1;
          n[store.totalVotes(store.partyTotals(u.votes, race)) > 0 ? "reporting" : "staged"] += 1;
        }
      } else {
        const up = race.up ? race.up.size : 0;
        n.total += up;
        n[race.feed === "waiting" ? "waiting" : race.feed === "staged" ? "staged" : "noLive"] += up;
      }
    }
    const parts = [n.staged && `${n.staged} staged`, n.waiting && `${n.waiting} waiting`,
                   n.noLive && `${n.noLive} no live feed`].filter(Boolean);
    return { ...n, summary: `${n.reporting} of ${n.total} districts${n.reporting < n.total ? " reporting" : ""}` +
      (parts.length ? ` · ${parts.join(", ")}` : "") };
  }

  /* The mode without the counting: called once per state per frame, so it
   * is parsed from the key rather than looked up in raceModes(). */
  function mode() {
    const fixed = FIXED_MODES.find((m) => m.key === modeKey);
    if (fixed) return { ...fixed, statewide: false };
    // "state-house-2026": the office is everything before the year.
    const cut = modeKey.lastIndexOf("-");
    const office = modeKey.slice(0, cut), cycle = modeKey.slice(cut + 1);
    return { key: modeKey, label: `${OFFICE_LABEL[office] || office} ${cycle}`,
             office, cycle, statewide: true };
  }

  /* The race a state contributes to a statewide mode: the regular seat,
   * unless only a special has been harvested. Oklahoma 2022 had both; the
   * readout lists the other. */
  function primaryRace(st, m) {
    const races = store.racesFor(st, m.office, m.cycle);
    return races.find((r) => !r.special && store.hasResults(r.race_id)) ||
      races.find((r) => store.hasResults(r.race_id)) || races[0] ||
      // A legislature expected but not yet harvested (see pending).
      (LEGISLATURE.has(m.office) && [...pending.values()].find((r) =>
        r.state === st && r.office === m.office && r.race_id.startsWith(m.cycle))) || null;
  }

  function statewideVotes(data) {
    if (data.statewide && data.statewide.votes) return data.statewide.votes;
    // A file without a statewide block still has every unit, mapped or not.
    const out = {};
    for (const u of data.units || []) {
      for (const [k, v] of Object.entries(u.votes || {})) out[k] = (out[k] || 0) + (Number(v) || 0);
    }
    return out;
  }

  /** What is drawn when no race file is: the mode's baseline, or 2024. The
   *  House 2026 mode names house-2024 for its shapes and tier, not its colors. */
  function drawKey() {
    const m = mode();
    const k = m.baseline || m.geometry;
    return k && store.baseline(k) ? k : "pres-2024";
  }

  /** House 2026 at the district tier: each district from its own file. A
   *  district's own race chosen inside a state draws that race instead. */
  function districtMode() {
    return !raceId && !!mode().districts;
  }

  /** The thing being colored: a race id, or a baseline key. */
  function subject() {
    return raceId || drawKey();
  }

  /** At national zoom a statewide mode reads out and picks states. It draws
   *  each state's own units where its race file has them (statewideUnits),
   *  so stateLevel() is about the pointer and the readout, not the shapes. */
  function stateLevel() {
    return !focus && mode().statewide;
  }

  function seatListFor(m) {
    for (const k of seatsUp.keys()) if (k.startsWith(`${m.cycle} `)) return true;
    return false;
  }

  function stateOf(id) {
    const f = unitIndex.get(id);
    if (f) return f.properties.state;
    const m = /^([A-Z]{2})-/.exec(id);
    return m ? m[1] : null;
  }

  /* ------------------------------------------------------------ the cell */

  /* Everything a variable or the readout needs about one drawn shape, unit or
   * state, in one place. Coloring and reading out the same shape from two
   * different computations is how a map and its readout come to disagree. */
  function unitCell(id, rid = null) {
    // rid: the race a unit is drawn from at national zoom in a statewide
    // mode, where each state brings its own race (statewideUnits).
    const subj = rid || subject();
    const race = raceOf(subj);
    const unit = store.baselineUnit(subj, id);
    const live = rid || raceId;
    const data = live ? store.results(live) : null;
    const cell = { kind: "unit", id, race, data, subj, unit,
                   // Florida and Oklahoma print no line for an unopposed
                   // seat, so the baseline carries the winner with no votes.
                   unopposed: unit && unit.unopposed ? unit.winner || null : null,
                   votes: unit ? unit.votes : null,
                   totals: unit ? store.partyTotals(unit.votes, race) : null,
                   reporting: data ? store.reportingPct(unit, data) : null,
                   basis: data ? store.reportingBasis(unit, data) : null };
    // Half a state senate is elected each cycle (Pennsylvania: the odd
    // districts in 2024). A district the file leaves out was not on the
    // ballot, which is not the same as no data.
    if (race && LEGISLATURE.has(race.office)) {
      if (data ? !unit : race.up && !race.up.has(String(id))) cell.notUp = true;
      // Before the first file: what its expected row says about the feed.
      else if (!data) cell[FEED_STATE[race.feed] || "waiting"] = true;
    }
    if (rid ? subj !== baselineKey && store.baselineTier(subj) === store.baselineTier(baselineKey)
            : comparable()) {
      const was = store.baselineUnit(baselineKey, id);
      if (was) cell.baseTotals = store.partyTotals(was.votes, store.race(baselineKey));
    }
    return cell;
  }

  /* Why a race with no numbers on the wall has none. A results file is
   * authoritative when there is one; otherwise expected_<cycle>.json says
   * whether a job is waiting for the state to publish, whether the race
   * only ever arrives certified (by hand, through overrides.json), or
   * whether nothing stands behind it. Three different facts on camera:
   * "soon", "only later" and "not from us". */
  const FEED_STATE = { waiting: "waiting", "certified-only": "certOnly", none: "noLive" };

  function expectedFor(st, m, race) {
    const list = expected.get(`${m.cycle} ${m.office} ${st}`) || [];
    return (race && list.find((e) => e.race_id === race.race_id)) ||
      list.find((e) => !/special/.test(e.seat_type || "")) || list[0] || null;
  }

  function stateCell(st) {
    const m = mode();
    const race = primaryRace(st, m);
    const exp = expectedFor(st, m, race);
    if (!(race && store.hasResults(race.race_id)) && exp && exp.feed !== "staged") {
      const why = FEED_STATE[exp.feed] || "noLive";
      return { kind: "state", st, [why]: true, expected: exp,
               seat: seatsUp.get(`${m.cycle} ${m.office} ${st}`) || null };
    }
    if (!race) {
      // On the ballot but not on this wall: no adapter, or certified-only.
      // Drawing it as "no race" would tell a viewer Georgia has no Senate
      // race in 2026.
      const seat = seatsUp.get(`${m.cycle} ${m.office} ${st}`);
      return seat ? { kind: "state", st, noFeed: true, seat }
                  : { kind: "state", st, noRace: true };
    }
    const data = store.results(race.race_id);
    const cell = { kind: "state", st, race, data, subj: race.race_id, expected: exp,
                   others: store.racesFor(st, m.office, m.cycle).filter((r) => r !== race) };
    if (!data) { cell.awaiting = true; return cell; }
    cell.votes = statewideVotes(data);
    cell.totals = store.partyTotals(cell.votes, race);
    cell.reporting = store.reportingPct(data.statewide, data);
    cell.basis = store.reportingBasis(data.statewide, data);
    cell.precincts = data.statewide && data.statewide.precincts;
    if (comparableAtState()) {
      const sums = store.baselineStateTotals(baselineKey, stateOf);
      if (sums && sums.get(st)) cell.baseTotals = sums.get(st);
    }
    return cell;
  }

  /** A file that says it is a slice of the race (Harris County's own feed:
   *  source.partial, source.coverage "Harris County only"), whatever the
   *  expected file says about the state. */
  function selfPartial(data) {
    return !!(data && data.source && data.source.partial === true);
  }

  /** A file a fallback wrote: the New York Times or AP. Where our own feed
   *  is partial (IL, NJ, MS, WI), a fallback's file is the full count and
   *  replaces it, so the partial marking does not apply; the readout names
   *  the source. */
  const FALLBACKS = { nyt: "New York Times", ap: "AP" };
  function fromFallback(data) {
    return !!(data && data.source && FALLBACKS[data.source.provider]);
  }

  /* ---------------------------------------------------- House by district */

  /* The race id for a district shape: "PA-07" -> 2026-house-pa-07, and an
   * at-large seat -> -al (harvest.py's spelling; data/seats.js also reads
   * -00, so this does too). */
  function houseRaceId(cd) {
    const [st, d] = cd.split("-");
    // The live mode's cycle, not the current mode's: the switcher counts
    // House 2026 while the map shows something else.
    const base = `${FIXED_MODES.find((m) => m.districts).cycle}-house-${st.toLowerCase()}-`;
    if (d !== "AL") return base + d;
    return !store.results(base + "al") && store.results(base + "00") ? base + "00" : base + "al";
  }

  /* Why a district with no file has none. The expected file lists House
   * races when scripts/expected.py does; until then a state with a job for
   * its statewide races is presumed to bring its House races with it, since
   * every adapter emits them (house-2026.md), and a state with none has no
   * live feed. */
  function districtFeed(st, rid) {
    const own = (expected.get(`${rid.slice(0, 4)} house ${st}`) || []).find((e) => e.race_id === rid);
    if (own) return own.feed;
    for (const [k, list] of expected) {
      if (!k.startsWith(`${rid.slice(0, 4)} `) || !k.endsWith(` ${st}`)) continue;
      if (list.some((e) => e.feed === "staged" || e.feed === "waiting")) return "waiting";
    }
    return "none";
  }

  function districtCell(id) {
    const st = id.slice(0, 2);
    const rid = houseRaceId(id);
    const data = store.results(rid);
    const race = store.race(rid);
    const cell = { kind: "district", id, st, rid, race, data, subj: rid, redrawn: redrawn.has(st) };
    // A partial feed's district file holds only the counties that feed
    // covers (Illinois: the collar counties), so its total is a slice.
    cell.expected = (expected.get(`${rid.slice(0, 4)} house ${st}`) || []).find((e) => e.race_id === rid) || null;
    cell.partial = (!!(cell.expected && cell.expected.partial) || selfPartial(data)) && !fromFallback(data);
    if (!data) {
      const f = districtFeed(st, rid);
      cell[f === "staged" ? "awaiting" : FEED_STATE[f] || "noLive"] = true;
      return cell;
    }
    cell.votes = statewideVotes(data);
    cell.totals = store.partyTotals(cell.votes, race);
    cell.reporting = store.reportingPct(data.statewide, data);
    cell.basis = store.reportingBasis(data.statewide, data);
    cell.precincts = data.statewide && data.statewide.precincts;
    // Against the same-numbered 2024 district, which is the same place
    // only where the lines did not move.
    if (!cell.redrawn && store.baselineTier(baselineKey) === "cd") {
      const was = store.baselineUnit(baselineKey, id);
      if (was) cell.baseTotals = store.partyTotals(was.votes, store.race(baselineKey));
    }
    return cell;
  }

  /* A district's county piece (geo/detail/cd-pieces, scripts/build_cd_pieces.py):
   * AP counts a House race by the part of each county inside the district,
   * a unit of the district's own file keyed by county FIPS. Null where the
   * file has no such unit (a feed by district total only, Illinois's). */
  function pieceCell(f) {
    const p = f.properties;
    const rid = houseRaceId(p.cd);
    const data = store.results(rid);
    const unit = data && (data.units || []).find((u) => u.id === p.fips);
    if (!unit) return null;
    const race = store.race(rid);
    return { kind: "piece", id: p.id, cd: p.cd, st: p.state, rid, race, data, subj: rid, unit,
             votes: unit.votes, totals: store.partyTotals(unit.votes, race),
             reporting: store.reportingPct(unit, data), basis: store.reportingBasis(unit, data) };
  }

  /* The seat count the switcher and the national readout give, by district:
   * reporting, staged (a file of zeros), waiting, no live feed. */
  function districtCounts() {
    const n = { reporting: 0, staged: 0, waiting: 0, nolive: 0, lead: { dem: 0, rep: 0, ind: 0 } };
    for (const f of geo.cds) {
      const c = districtCell(f.properties.id);
      if (c.data) {
        if (store.totalVotes(c.totals) > 0) {
          n.reporting += 1;
          const s = leadSide(c, "margin");
          if (s && cellValue(c, "margin") !== 0) n.lead[s] += 1;
        } else n.staged += 1;
      } else if (c.awaiting) n.staged += 1;
      else if (c.waiting) n.waiting += 1;
      else n.nolive += 1;
    }
    const parts = [n.staged && `${n.staged} staged`, n.waiting && `${n.waiting} waiting`,
                   n.nolive && `${n.nolive} no live feed`].filter(Boolean);
    return { total: geo.cds.length, reporting: n.reporting, staged: n.staged, waiting: n.waiting,
             noLive: n.nolive, leading: n.lead, states: null, noFeed: 0,
             summary: `${n.reporting} of ${geo.cds.length} reporting${parts.length ? ` · ${parts.join(", ")}` : ""}` };
  }

  /* A redrawn state's districts on the 2024 shapes would put PA-07's votes
   * on a district that no longer exists there. So such a state is drawn as
   * itself, patterned, and its districts are listed in the readout. */
  let redrawnPat = null;
  onThemeChange(() => { redrawnPat = null; });
  function redrawnFill() {
    const T = theme();
    if (!redrawnPat) {
      const c = document.createElement("canvas");
      c.width = c.height = 10;
      const g = c.getContext("2d");
      g.fillStyle = T.paper;
      g.fillRect(0, 0, 10, 10);
      g.strokeStyle = T.warn;
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(0, 10); g.lineTo(10, 0);
      g.moveTo(0, 0); g.lineTo(10, 10);
      g.stroke();
      redrawnPat = view.ctx.createPattern(c, "repeat");
    }
    const k = view.transform.k || 1;
    if (redrawnPat.setTransform && window.DOMMatrix) redrawnPat.setTransform(new DOMMatrix().scale(1 / k));
    return redrawnPat;
  }

  /** The districts of a state in number order, as cells. */
  /** "Lake County only" / "Lake and Will counties only", from the file's units. */
  function partialWhat(c) {
    if (c.data && c.data.source && c.data.source.coverage) return c.data.source.coverage;
    const names = (c.data && c.data.units || [])
      .map((u) => u.name || ((unitIndex.get(u.id) || {}).properties || {}).name)
      .filter(Boolean).sort();
    if (!names.length) return "a slice of the district";
    const list = names.length === 1 ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    return `${list} ${names.length === 1 ? "County" : "counties"} only`;
  }

  /* A partial count keeps its color, striped with paper, so it still says
   * who leads the slice counted but cannot be read as the district. */
  const partialPats = new Map();
  onThemeChange(() => partialPats.clear());
  function partialFill(color) {
    let pat = partialPats.get(color);
    if (!pat) {
      const c = document.createElement("canvas");
      c.width = c.height = 8;
      const g = c.getContext("2d");
      g.fillStyle = color;
      g.fillRect(0, 0, 8, 8);
      g.strokeStyle = theme().paper;
      g.globalAlpha = 0.6;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(-2, 2); g.lineTo(2, -2);
      g.moveTo(-2, 10); g.lineTo(10, -2);
      g.moveTo(6, 10); g.lineTo(10, 6);
      g.stroke();
      pat = view.ctx.createPattern(c, "repeat");
      partialPats.set(color, pat);
    }
    const k = view.transform.k || 1;
    if (pat.setTransform && window.DOMMatrix) pat.setTransform(new DOMMatrix().scale(1 / k));
    return pat;
  }

  function districtCellsIn(st) {
    return (cdsByState.get(st) || []).map((f) => f.properties.id).sort().map(districtCell);
  }

  /* Every district of a state in a table: who leads and by how much, or why
   * there is nothing. Used for a redrawn state, and inside any state with
   * nothing under the pointer. */
  function districtTable(st) {
    const cells = districtCellsIn(st);
    if (!cells.length) return "";
    const lead = { dem: 0, rep: 0, ind: 0 };
    const was = { dem: 0, rep: 0, ind: 0 };     // the compare-to election, before votes
    const swatch = (p) => `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${partyColor(p)}"></span>`;
    const label = esc(store.baselineLabel(baselineKey));
    const rows = cells.map((c) => {
      const d = c.id.slice(3);
      let who = "", by = "";
      if (c.data && store.totalVotes(c.totals) > 0) {
        const t = topOf(c);
        const side = leadSide(c, "margin");
        if (side && cellValue(c, "margin") !== 0) lead[side] += 1;   // a tie leads nobody
        // topTwo folds a party's candidates together and may carry no name;
        // the candidate rows have the leader's.
        const top = t && store.candidateRows(c.votes, c.race).find((r) => r.party === t.leader.party);
        const name = t && (t.leader.name || (top && top.name) || t.leader.key);
        const m = cellValue(c, "margin");
        who = t ? `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${partyColor(t.leader.party)}"></span> ${esc(name)}` : "";
        by = `${m === 0 ? "Tied" : marginLabel(m, t)}${c.reporting != null ? ` · ${d3.format(".0f")(c.reporting)}%` : ""}` +
          (c.partial ? ` · <span style="color:var(--warn)">partial</span>` : "");
      } else {
        by = c.data || c.awaiting ? "awaiting votes" : c.waiting ? "feed waiting" : c.certOnly ? "override only" : "no live feed";
        // What the Swing map shows for it until then: the compare-to election.
        const b = variable === "swing" ? compareCell(c) : null;
        const m = b && cellValue(b, "margin");
        if (m != null) {
          const side = m > 0 ? "dem" : m < 0 ? "rep" : null;
          const p = b.unopposed || (topOf(b) && topOf(b).leader.party) || side;
          if (p) was[p === "dem" || p === "rep" ? p : "ind"] += 1;
          who = `${p ? swatch(p) : ""} <span style="color:var(--ink-soft)">${label}</span>`;
          by = `${b.unopposed ? "unopposed" : marginLabel(m, topOf(b))} · ${by}`;
        }
      }
      return `<tr><td style="padding:2px 6px 2px 0;font-weight:600">${d === "AL" ? "AL" : Number(d)}</td>
        <td style="padding:2px 6px">${who}</td>
        <td style="padding:2px 0;text-align:right;color:var(--ink-soft);white-space:nowrap">${by}</td></tr>`;
    }).join("");
    const counted = lead.dem + lead.rep + lead.ind;
    const shown = was.dem + was.rep + was.ind;
    const head = counted
      ? `Leading: D ${lead.dem} · R ${lead.rep}${lead.ind ? ` · other ${lead.ind}` : ""} of ${cells.length}`
      : `${cells.length} district${cells.length === 1 ? "" : "s"}, none reporting` +
        (shown ? `. Shown until votes: ${label}, D ${was.dem} · R ${was.rep}${was.ind ? ` · other ${was.ind}` : ""}` : "");
    return `<p class="hint" style="margin:0 0 6px">${head}</p>` +
      `<table class="cands" style="width:100%;border-collapse:collapse;margin:0 0 10px;font-variant-numeric:tabular-nums">${rows}</table>`;
  }

  const NEW_LINES_NOTE = "New district lines for 2026, drawn from the Census 120th Congress " +
    "districts. Swing and turnout against 2024 are off here: the same number is a different place.";
  const REDRAWN_NOTE = "New district lines for 2026. The map has only the 2024 shapes, " +
    "so this state's districts are listed here, not drawn.";
  const OLD_LINES_NOTE = "New district lines for 2026. The lines drawn are 2024's, for reference; " +
    "this state's 2026 districts are listed here.";

  /* Until a race has a results file, who is running: the Wikipedia list
   * (registry/candidates_2026.json), majors first, as the boards print it.
   * Once a file exists its registry candidates are the ones read out. */
  function onBallot(rid) {
    const list = rid && ballots.get(rid);
    if (!list || !list.length) return "";
    const m = /^(\d{4})-(sen|gov|sos|house|statehouse|statesenate)-([a-z]{2})/.exec(rid);
    const like = m && { race_id: rid, state: m[3].toUpperCase(),
      office: { sen: "senate", gov: "governor", sos: "secretary-of-state", statehouse: "state-house", statesenate: "state-senate" }[m[2]] || m[2] };
    return `<p class="hint">On the ballot: ${ballotText(like ? list.map((c) => ({ ...c, incumbent: store.isIncumbent(like, c.name) })) : list)}</p>`;
  }

  /** The race id a statewide cell with no file stands for. */
  function cellRaceId(c) {
    if (c.race) return c.race.race_id;
    if (c.expected && c.expected.race_id) return c.expected.race_id;
    const m = mode();
    const office = { senate: "sen", governor: "gov", "secretary-of-state": "sos" }[m.office] || m.office;
    return `${m.cycle}-${office}-${c.st.toLowerCase()}${c.seat && c.seat.special ? "-special" : ""}`;
  }

  function districtReadout(id) {
    const c = districtCell(id);
    const d = id.slice(3);
    let html = `<h2>${esc(stateName(c.st))} ${d === "AL" ? "at-large" : `District ${Number(d)}`}</h2>` +
      `<p class="hint" style="margin:-6px 0 10px">${esc(mode().label)}</p>`;
    if (!c.data) {
      const what = c.awaiting ? "results file staged; no votes yet."
        : c.waiting ? "feed waiting for the state to publish its 2026 results."
        : c.certOnly ? "no live feed. Numbers arrive only as an override, from certified results."
        : "no live feed for this race.";
      return html + `<p class="hint">${what}</p>` + compareDl(c) + ratingDl(c) + onBallot(c.rid);
    }
    if (c.partial) {
      html += `<p class="hint" style="color:var(--warn);font-weight:600">Partial: ${esc(partialWhat(c))}, not the district total.</p>`;
    }
    html += flipHint(c);
    html += candidateTable(c.votes, c.race);
    const rows = awaiting(c) ? [["Status", "Awaiting votes"], ...compareRows(c), ...ratingRows(c)] : cellRows(c);
    html += dl([...rows, ...sourceRows(c)]);
    return html;
  }

  /** A district's county piece: its own count, and the district's beside it. */
  function pieceReadout(f) {
    const p = f.properties;
    const c = pieceCell(f);
    if (!c) return districtReadout(p.cd);
    const d = p.cd.slice(3);
    const where = `${stateName(p.state)} ${d === "AL" ? "at-large" : `District ${Number(d)}`}`;
    const dc = districtCell(p.cd);
    const rows = [["Total votes", fmt(store.totalVotes(c.totals))]];
    if (store.totalVotes(c.totals) > 0) {
      rows.push(["Margin", marginLabel(cellValue(c, "margin"), topOf(c))],
                ["Raw lead", leadLabel(cellValue(c, "lead"), topOf(c))]);
    }
    if (c.reporting != null) {
      rows.push([c.basis === "expected vote" ? "Expected vote in" : "Precincts reporting", `${d3.format(".1f")(c.reporting)}%`]);
    }
    const dm = cellValue(dc, "margin");
    if (dm != null) rows.push([`${d === "AL" ? "Statewide" : `District ${Number(d)}`}`, `${marginLabel(dm, topOf(dc))}`]);
    return `<h2>${esc(c.unit.name || p.name)}</h2>` +
      `<p class="hint" style="margin:-6px 0 10px">${esc(where)} · the county's part of the district</p>` +
      candidateTable(c.votes, c.race) + dl([...rows, ...sourceRows(c)]);
  }

  /** A baseline's state total, for the readout under a county at national zoom. */
  function baselineStateCell(st) {
    const key = drawKey();
    const sums = store.baselineStateTotals(key, stateOf);
    const t = sums && sums.get(st);
    return t ? { kind: "state", st, subj: key, votes: t, totals: t } : null;
  }

  /* Swing and turnout need a baseline at the same tier as the thing being
   * colored. At national zoom in a statewide mode both are states -- any
   * baseline file sums to states -- so the question is answerable whenever
   * the baseline is a file rather than another state's race. */
  function comparableAtState() {
    return !!store.baseline(baselineKey) && !store.race(baselineKey);
  }

  function comparable() {
    if (stateLevel()) return comparableAtState();
    if (districtMode()) return store.baselineTier(baselineKey) === "cd";
    const subj = subject();
    if (subj === baselineKey) return false;
    const tier = store.baselineTier(subj);
    return !!tier && tier === store.baselineTier(baselineKey);
  }

  function variableAvailable(key) {
    if (key === "swing" || key === "turnout") return comparable();
    if (key === "rating" || key === "vsrating") return ratingsHere();
    // Reporting is a property of a count in progress. A baseline file is a
    // certified result, and calling every county "100% reported" would be a
    // map of nothing.
    if (key === "reporting") return stateLevel() || districtMode() || !!raceId;
    return true;
  }

  function variableNote(key) {
    if (variableAvailable(key)) return null;
    if (key === "reporting") return "Only a race file reports progress";
    if (key === "rating" || key === "vsrating") return "Ratings are for 2026 races";
    if (subject() === baselineKey) return "Pick a different baseline to compare against";
    return "No baseline at this tier";
  }

  const share = (t) => (t ? store.twoPartyDemShare(t) : null);

  /* Who leads a cell, computed once per cell. */
  function topOf(c) {
    if (!c || !c.votes) return null;
    if (c._top === undefined) c._top = store.topTwo(c.votes, c.race || store.race(c.subj));
    return c._top;
  }

  /* "dem", "rep", or "ind" for anyone else ahead -- King in Maine, Osborn in
   * Nebraska -- who is colored on a ramp of their own rather than as a
   * Democrat or as nothing. Only margin and lead have a side. */
  function leadSide(c, key = variable) {
    if (key !== "margin" && key !== "lead") return null;
    if (c && c.unopposed) return c.unopposed === "rep" ? "rep" : c.unopposed === "dem" ? "dem" : "ind";
    const t = topOf(c);
    if (!t) return null;
    const p = t.leader.party;
    return p === "dem" || p === "rep" ? p : "ind";
  }

  function cellValue(c, key = variable) {
    if (!c || c.noRace || c.noFeed || c.waiting || c.certOnly || c.noLive || c.awaiting || !c.totals) return null;
    // An unopposed seat is the most one-sided result there is, not a
    // missing one; it is drawn at the end of the ramp and nothing else.
    if (c.unopposed && key === "margin") return c.unopposed === "dem" ? 100 : c.unopposed === "rep" ? -100 : null;
    const total = store.totalVotes(c.totals);
    if (key === "reporting") return c.reporting;
    // Nothing counted is not a margin of zero and not a turnout of zero.
    if (total <= 0) return null;
    if (key === "margin" || key === "lead") {
      // The two leading contenders, not Democrat against Republican: see
      // store.topTwo. Signed for the parties (D positive, R negative); an
      // independent's lead is positive and leadSide() says whose it is.
      const t = topOf(c);
      if (!t) return null;
      const v = key === "margin" ? t.pts : t.lead;
      return t.leader.party === "rep" ? -v : v;
    }
    if (!variableAvailable(key) || !c.baseTotals) return null;
    if (key === "swing") {
      const a = share(c.totals), b = share(c.baseTotals);
      return a == null || b == null ? null : (a - b) * 200;
    }
    if (key === "turnout") {
      const was = store.totalVotes(c.baseTotals);
      return was > 0 ? total / was : null;
    }
    return null;
  }

  /** A race file whose every count is zero: staged, polls not closed. */
  function awaiting(c) {
    if (!c || c.noRace || c.notUp || c.noFeed || c.waiting || c.certOnly || c.noLive) return false;
    if (c.awaiting) return true;
    return !!(c.data && c.totals && store.totalVotes(c.totals) === 0);
  }

  /* --------------------------------------------------- against the ratings */

  /* The pre-election ratings (data/ratings.js): Cook for Senate, governor
   * and House, StateNavigate for Pennsylvania's legislature, all 2026. A race
   * is rated as a whole, so a Senate race's counties all carry the state's
   * rating and are judged on the state's count; a legislature's districts
   * are each a race of their own. */
  const RATED_RACE = /^(\d{4})-(sen|gov|house|statehouse|statesenate)-([a-z]{2})(?:-(.+))?$/;

  /** The seat data/ratings.js keys a race by, or null. */
  function ratedSeat(rid, unit) {
    const m = RATED_RACE.exec(rid || "");
    if (!m || m[1] !== "2026") return null;
    const st = m[3].toUpperCase();
    switch (m[2]) {
      case "sen": return { chamber: "senate", state: st };
      case "gov": return { chamber: "governor", state: st };
      case "house": return { chamber: "house", label: `${st}-${/^(al|00)$/.test(m[4] || "") ? "AL" : m[4]}` };
      case "statehouse": return unit ? { chamber: `${m[3]}-house`, unitId: String(unit) } : null;
      // West Virginia's unexpired terms (2026-statesenate-wv-unexpired) are
      // rated apart from the regular seat in the same district: "WV-S03:unexpired".
      case "statesenate": return unit ? { chamber: `${m[3]}-senate`, unitId: m[4] ? `${unit}:${m[4]}` : String(unit) } : null;
      default: return null;
    }
  }

  function ratingsHere() {
    if (raceId) return !!ratedSeat(raceId, "-");
    const m = mode();
    return m.cycle === "2026" && (m.statewide || !!m.districts);
  }

  /** The race a cell is rated as: { rid, unit, own } (own: the cell is that race). */
  function ratedRace(c) {
    if (c.kind === "district") return { rid: c.rid, own: true };
    if (c.kind === "state") return { rid: cellRaceId(c), own: true };
    const r = c.race;
    if (r && LEGISLATURE.has(r.office)) return { rid: r.race_id, unit: c.id, own: true };
    if (r && ratedSeat(r.race_id)) return { rid: r.race_id, own: false };
    // A county of a 2026 statewide race whose state has no file yet.
    const st = stateOf(c.id), m = mode();
    if (st && m.statewide && m.cycle === "2026" && !LEGISLATURE.has(m.office)) {
      return { rid: cellRaceId(stateCell(st)), own: false };
    }
    return null;
  }

  /** A cell's rating: Cook's or StateNavigate's label, parsed. Null if unrated. */
  function ratingOf(c) {
    if (!c || c.kind === "precinct") return null;
    const r = ratedRace(c);
    const seat = r && ratedSeat(r.rid, r.unit);
    const label = seat && ratingFor(seat);
    const parsed = parseRating(label);
    if (!parsed) return null;
    return { ...r, label, parsed, shown: legLabel(seat) || label, src: ratingSource(seat) };
  }

  /** Who leads the rated race, or null before a vote is counted. */
  function raceLeader(R, c) {
    if (R.own) return cellValue(c, "margin") == null ? null : topOf(c);
    const data = store.results(R.rid);
    if (!data) return null;
    const race = store.race(R.rid);
    const votes = statewideVotes(data);
    if (store.totalVotes(store.partyTotals(votes, race)) <= 0) return null;
    return store.topTwo(votes, race);
  }

  /* Against the rating: "held" when the rated favorite leads, "tossup" when
   * the race was rated a toss-up, "upset" when the other side leads. */
  function versus(c) {
    const R = ratingOf(c);
    if (!R) return null;
    const t = raceLeader(R, c);
    if (!t || t.pts === 0) return { R, t: null, kind: null };
    const lead = t.leader.party === "dem" || t.leader.party === "rep" ? t.leader.party : "ind";
    const fav = R.parsed.party;
    return { R, t, lead, kind: !fav ? "tossup" : lead === fav ? "held" : "upset" };
  }

  /* Three shades a side: Lean, Likely, Solid -- and for vs. Rating, as
   * rated, a toss-up decided, an upset. The theme's own classes where it
   * has them. */
  function ratingShade(side, level) {
    const P = partisanClasses(3);
    if (P) return P[side][level];
    const T = theme();
    if (side === "ind") return d3.interpolateLab(T.paper, T.ind)([0.35, 0.65, 1][level]);
    return diverge((side === "rep" ? -1 : 1) * [0.25, 0.55, 1][level] * MARGIN_CLAMP, MARGIN_CLAMP);
  }

  /* Cook's toss-up orange, the same in every theme: the theme's gold mixed
   * into Studio's black paper came out olive, which read as green. */
  function tossupColor() {
    return "#f39c33";
  }

  const RATING_LEVEL = { Lean: 0, Likely: 1, Solid: 2 };

  function ratingFill(c) {
    const R = ratingOf(c);
    if (!R) return theme().nodata;
    return R.parsed.party ? ratingShade(R.parsed.party, RATING_LEVEL[R.parsed.strength]) : tossupColor();
  }

  function versusFill(v) {
    return v.kind === "held" ? ratingShade(v.lead, 0)
      : v.kind === "tossup" ? ratingShade(v.lead, 1) : ratingShade(v.lead, 2);
  }

  const ratingDl = (c) => { const r = ratingRows(c); return r.length ? dl(r) : ""; };

  /** The readout's rows for a rated race. */
  function ratingRows(c) {
    const v = versus(c);
    if (!v || !v.R.own) return [];
    const rows = [[`Rating (${esc(v.R.src)})`, esc(v.R.shown)]];
    if (v.kind) {
      rows.push(["vs. Rating", v.kind === "upset" ? `<strong>Upset</strong>: ${PARTY_LETTER[v.lead] || "other"} ahead`
        : v.kind === "tossup" ? `Toss-up: ${PARTY_LETTER[v.lead] || "other"} ahead` : "As rated"]);
    }
    return rows;
  }

  /* ------------------------------------------------------------- coloring */

  function diverge(value, clamp) {
    if (value == null) return null;
    const t = Math.max(0, Math.min(1, (value + clamp) / (2 * clamp)));
    return theme().election(t);
  }

  /* A single-hue ramp for the non-partisan variables. It starts at a tint
   * rather than at the paper, so a county at 0% reported is still visibly a
   * county with a count, not a hole. */
  function sequential(t, hue) {
    const T = theme();
    const lo = d3.interpolateRgb(T.paper, hue)(0.14);
    return d3.interpolateRgb(lo, hue)(Math.max(0, Math.min(1, t)));
  }

  function seqHue(key) {
    const T = theme();
    return key === "reporting" ? T.good : T.warn;
  }

  function breaksFor(key, atState) {
    if (key === "lead") return atState ? BREAKS.leadState : BREAKS.leadUnit;
    return BREAKS[key] || null;
  }

  /* The theme's steps respread to n classes a side, lightest first, plus
   * the tie color, interpolated in Lab between its steps so the lightness
   * matching in wall.css carries over. The strongest color is the theme's;
   * the lightest starts a third of the way to the next step, because the
   * theme's lightest tint was made to sit next to white and, alone in a
   * close county, reads as white on a wall. Null for a theme without steps. */
  let classCache = null;
  onThemeChange(() => { classCache = null; });
  function partisanClasses(n) {
    const cls = theme().classes;
    if (!cls || cls.length < 5 || cls.length % 2 === 0) return null;
    if (classCache && classCache.n === n) return classCache;
    const mid = (cls.length - 1) / 2;
    const side = (c) => {
      const f = d3.piecewise(d3.interpolateLab, c);
      const t0 = 1 / (3 * (c.length - 1));      // a third of the first step
      return d3.range(n).map((i) => d3.color(f(t0 + (1 - t0) * i / (n - 1))).formatHex());
    };
    const ind = theme().indSteps;
    classCache = {
      n,
      tie: cls[mid],
      rep: side(cls.slice(0, mid).reverse()),
      dem: side(cls.slice(mid + 1)),
      // An independent's ramp, lightness-matched to the parties' (wall.css).
      ind: ind && ind.length >= 2 ? side(ind) : side(cls.slice(mid + 1)),
    };
    return classCache;
  }

  /* The class a value falls in: white only for an exact tie, else the
   * lightest red or blue inside the first break and one step darker per
   * break crossed. Null when the theme has no steps. */
  function stepped(v, breaks, side = null) {
    if (!breaks) return null;
    const P = partisanClasses(breaks.length + 1);
    if (!P) return null;
    if (v === 0) return P.tie;
    let i = 0;
    while (i < breaks.length && Math.abs(v) >= breaks[i]) i++;
    return (side === "ind" ? P.ind : v < 0 ? P.rep : P.dem)[i];
  }

  function colorFor(v, key = variable, atState = false, side = null) {
    if (v == null) return null;
    const s = stepped(v, breaksFor(key, atState), side);
    if (s) return s;
    if (side === "ind") {
      const clamp = key === "lead" ? (atState ? LEAD_CLAMP_STATE : LEAD_CLAMP_UNIT) : MARGIN_CLAMP;
      return d3.interpolateLab(theme().paper, theme().ind)(Math.min(1, Math.abs(v) / clamp));
    }
    switch (key) {
      case "margin": return diverge(v, MARGIN_CLAMP);
      case "swing": return diverge(v, SWING_CLAMP);
      case "lead": {
        const L = atState ? LEAD_CLAMP_STATE : LEAD_CLAMP_UNIT;
        const t = Math.sign(v) * Math.sqrt(Math.min(1, Math.abs(v) / L));
        return theme().election(0.5 + 0.5 * t);
      }
      case "reporting": return sequential(v / 100, seqHue(key));
      case "turnout": return sequential(v / TURNOUT_CLAMP, seqHue(key));
      default: return null;
    }
  }

  /* Awaiting votes is hatched, not grey: grey already means "no number for
   * this variable", and a race that exists but has not reported is a
   * different fact from one that has no baseline. The hatch is kept a
   * constant size on screen by undoing the zoom in its own transform. */
  let hatch = null;
  onThemeChange(() => { hatch = null; });
  function hatchFill() {
    const T = theme();
    if (!hatch) {
      const c = document.createElement("canvas");
      c.width = c.height = 8;
      const g = c.getContext("2d");
      // Stripes on paper, not on grey: averaged by the eye at national
      // zoom, grey-on-grey stripes read as the solid "no feed" grey.
      g.fillStyle = T.paper;
      g.fillRect(0, 0, 8, 8);
      g.strokeStyle = T.nodata;
      g.lineWidth = 2.2;
      g.beginPath();
      g.moveTo(-2, 10); g.lineTo(10, -2);
      g.moveTo(6, 10); g.lineTo(10, 6);
      g.moveTo(-2, 2); g.lineTo(2, -2);
      g.stroke();
      hatch = view.ctx.createPattern(c, "repeat");
    }
    const k = view.transform.k || 1;
    if (hatch.setTransform && window.DOMMatrix) hatch.setTransform(new DOMMatrix().scale(1 / k));
    return hatch;
  }

  /* Feed waiting: dots, not stripes. Both say "nothing yet", but a staged
   * race will light up at poll close and a waiting one only once the state
   * publishes its election -- the second is the one to keep an eye on. */
  let dots = null;
  onThemeChange(() => { dots = null; });
  function dotFill() {
    const T = theme();
    if (!dots) {
      const c = document.createElement("canvas");
      c.width = c.height = 7;
      const g = c.getContext("2d");
      g.fillStyle = T.paper;
      g.fillRect(0, 0, 7, 7);
      g.fillStyle = T.nodata;
      g.beginPath();
      g.arc(3.5, 3.5, 1.6, 0, 2 * Math.PI);
      g.fill();
      dots = view.ctx.createPattern(c, "repeat");
    }
    const k = view.transform.k || 1;
    if (dots.setTransform && window.DOMMatrix) dots.setTransform(new DOMMatrix().scale(1 / k));
    return dots;
  }

  function lightGrey() {
    const T = theme();
    return d3.interpolateRgb(T.paper, T.nodata)(0.45);
  }

  function cellFill(c, atState) {
    const T = theme();
    if (c.noRace || c.notUp) return T.basefill;
    // A race the rating bar's picks leave out is plain land.
    if (!ratingPicked(c)) return d3.interpolateRgb(T.paper, T.ink)(0.14);
    // A rating is there before any feed is: every rated race takes its color.
    // Chiclets: the shapes are plain land; the markers carry the rating.
    if (chiclets()) return d3.interpolateRgb(T.paper, T.ink)(0.14);
    if (variable === "rating") return ratingFill(c);
    if (variable === "vsrating") {
      const v = versus(c);
      if (v && v.kind) return versusFill(v);
    }
    if (variable === "swing" && beforeVotes(c)) {
      const b = compareCell(c);
      const v = b && cellValue(b, "margin");
      if (v != null) return colorFor(v, "margin", atState, leadSide(b, "margin"));
    }
    // A called race is its winner's color at full strength, votes or not
    // (an unopposed seat is called before a vote is counted).
    // Hidden first: under Flips only, a called seat that stays put is land too.
    if (raceHidden(c)) return d3.interpolateRgb(T.paper, T.ink)(0.14);
    const call = callOf(c);
    // A county piece keeps its own margin; its district's call only lifts
    // it from muted to full strength, as the district is.
    if (call && c.kind !== "piece") return wonColor(call.party, atState);
    if (c.noFeed || c.certOnly) return T.nodata;
    if (c.noLive) return lightGrey();
    if (c.waiting) return dotFill();
    if (awaiting(c)) return hatchFill();
    const fill = colorFor(cellValue(c), variable, atState, leadSide(c));
    // Counted but not called: the same margin, muted toward the paper, so a
    // call reads as the shape filling in -- the networks' convention.
    return call === null && typeof fill === "string" ? pendingColor(fill) : fill;
  }

  /* Called or not, for a shape that is a whole race -- a state on a
   * statewide map, a House district, a legislature district -- on tonight's
   * Margin and Lead maps: the call (calls.json, through data/seats.js), null
   * when there is none yet, undefined where the question does not apply
   * (a county, a past election, another variable). */
  function callOf(c) {
    if (variable !== "margin" && variable !== "lead") return undefined;
    const S = seatsSrc();
    if (!S || !S.call) return undefined;
    let id = null;
    if (c.kind === "state") id = c.noRace ? null : cellRaceId(c);
    else if (c.kind === "district" || c.kind === "piece") id = c.rid;
    else if (c.kind === "unit" && c.race && LEGISLATURE.has(c.race.office)) id = `${c.race.race_id}:${c.id}`;
    if (!id || !id.startsWith(`${FIXED_MODES.find((m) => m.districts).cycle}-`)) return undefined;
    return S.call(id) || null;
  }

  const liveCycle = () => FIXED_MODES.find((m) => m.districts).cycle;

  /** Whether this map is one of tonight's races on Margin or Raw lead, where
   *  calls mean something: the Called only switch shows here. */
  function callsApply() {
    const S = seatsSrc();
    return !!(S && S.call) && (variable === "margin" || variable === "lead") &&
      (raceId ? raceId.slice(0, 4) : mode().cycle) === liveCycle() && !!mode().office &&
      mode().office !== "president";
  }

  /** Tonight's race a shape belongs to, for the Races filter and the flip
   *  outline: a whole race's own id, a county read by its state's race, a
   *  precinct by the race in view; null for anything else. */
  function liveRaceKey(c) {
    let id = null;
    if (c.kind === "state") id = c.noRace ? null : cellRaceId(c);
    else if (c.kind === "district" || c.kind === "piece") id = c.rid;
    else if (c.kind === "unit" && c.race && LEGISLATURE.has(c.race.office)) id = `${c.race.race_id}:${c.id}`;
    else if (c.kind === "unit") id = c.race ? c.race.race_id : null;
    else if (c.kind === "precinct") id = raceId;
    return id && id.startsWith(`${liveCycle()}-`) ? id : null;
  }

  /** Called only / Flips only: a shape whose race is not in. */
  function raceHidden(c) {
    if (raceFilter === "all" || !callsApply()) return false;
    const id = liveRaceKey(c);
    if (!id) return false;
    if (raceFilter === "called") return !seatsSrc().call(id);
    const s = seatByRace(id);
    return !(s && s.flip && s.status === "called");
  }

  /* data/seats.js's seats by race id and seat id ("2026-house-pa-07",
   * "2026-statehouse-pa:PA-001"), rebuilt when the seats change (a call, a
   * new count). A legislature chamber is one race for all its seats, so its
   * race id is left out: those are looked up by seat. */
  let seatIdx = null, seatIdxOf = null;
  function seatByRace(id) {
    const S = seatsSrc();
    if (!S || !S.seats) return null;
    if (seatIdxOf !== S) {
      seatIdxOf = S;
      seatIdx = null;
      if (S.onChange) S.onChange(() => { seatIdx = null; });
    }
    if (!seatIdx) {
      const idx = new Map();
      for (const ch of ALL_CHAMBERS) {
        for (const s of S.seats(ch)) {
          idx.set(s.id, s);
          if (s.raceId && !s.id.includes(":") && !idx.has(s.raceId)) idx.set(s.raceId, s);
        }
      }
      if (!idx.size) return null;            // seats not loaded yet: ask again later
      seatIdx = idx;
    }
    return seatIdx.get(id) || null;
  }

  /** The seat behind a whole-race shape when it has changed hands tonight:
   *  called for a party other than the one holding it. A party only leading
   *  is not a flip until the call is entered, the user's rule (November 3). */
  function flipOf(c) {
    if (!callsApply()) return null;
    const id = liveRaceKey(c);
    const s = id && seatByRace(id);
    return s && s.flip && s.status === "called" ? s : null;
  }

  /* Flips hashed, the user's ask (November 3; a gold outline first, which
   * did not look good): stripes in the paper color laid over the shape's
   * own fill, so a pickup keeps its party's color; only once it is called
   * (flipOf). The stripes run the
   * other way from Awaiting votes' grey hatch, which is on paper, not on a
   * party's color. Over the whole race's shape: the state on a statewide
   * map (over its counties), the district, the legislature district. */
  function flipShapes(data) {
    if (!callsApply() || chiclets()) return [];
    // A legislature's seats are its districts, which it draws at every zoom.
    const r = raceId && raceOf(raceId);
    if (LEGISLATURE.has((r || mode()).office)) return precinctShown ? [] : data;
    if (districtMode()) return precinctShown ? [] : data;
    return focus ? focusOutline(focus) : natStates();
  }
  let flipHashPat = null;
  onThemeChange(() => { flipHashPat = null; });
  function flipHash() {
    if (!flipHashPat) {
      const c = document.createElement("canvas");
      c.width = c.height = 9;
      const g = c.getContext("2d");
      const paper = d3.color(theme().paper);
      paper.opacity = 0.62;
      g.strokeStyle = paper.formatRgb();
      g.lineWidth = 2.6;
      g.beginPath();                       // "\": top left to bottom right
      g.moveTo(-2, -2); g.lineTo(11, 11);
      g.moveTo(-2, 7); g.lineTo(2, 11);
      g.moveTo(7, -2); g.lineTo(11, 2);
      g.stroke();
      flipHashPat = view.ctx.createPattern(c, "repeat");
    }
    const k = view.transform.k || 1;
    if (flipHashPat.setTransform && window.DOMMatrix) flipHashPat.setTransform(new DOMMatrix().scale(1 / k));
    return flipHashPat;
  }
  const PARTY_WORD = { dem: "Democratic", rep: "Republican", ind: "independent", other: "independent" };
  function flipHint(c) {
    const s = flipOf(c);
    if (!s) return "";
    const was = PARTY_WORD[s.held] || s.held, now = PARTY_WORD[s.party] || s.party;
    return `<p class="hint" style="color:var(--warn);font-weight:600">Flip: ${esc(was)} seat, called for the ${esc(now)} candidate.</p>`;
  }

  function wonColor(party, atState) {
    const side = party === "dem" || party === "rep" ? party : "ind";
    const clamp = variable === "lead" ? (atState ? LEAD_CLAMP_STATE : LEAD_CLAMP_UNIT) : MARGIN_CLAMP;
    return colorFor(party === "rep" ? -clamp : clamp, variable, atState, side) || theme()[side] || theme().ind;
  }

  const pendingMemo = new Map();
  onThemeChange(() => pendingMemo.clear());
  function pendingColor(color) {
    let c = pendingMemo.get(color);
    if (!c) {
      c = d3.interpolateLab(color, theme().paper)(0.45);
      if (pendingMemo.size > 2000) pendingMemo.clear();
      pendingMemo.set(color, c);
    }
    return c;
  }

  /* Before a race has a vote, the Swing map -- the one about the election
   * it is compared to (COMPARE TO) -- shows that election's margin in the
   * same place, so it opens on last time's map rather than a field of
   * patterns; each shape changes over to its swing as its count starts.
   * Margin and Raw lead show tonight only. Not where the place is not the
   * same one: a district redrawn for 2026 keeps its pattern. */
  function beforeVotes(c) {
    if (!c) return false;
    if (c.waiting || c.noLive || c.certOnly || c.noFeed || awaiting(c)) return true;
    // A county a partial feed does not cover (Illinois's collar-county file,
    // Harris County's) has no unit in the file; until the race counts a vote
    // it is no different from the rest.
    return c.kind === "unit" && !!c.data && !c.unit &&
      !Object.values(statewideVotes(c.data)).some((v) => Number(v) > 0);
  }

  function compareCell(c) {
    if (!c || !(store.baseline(baselineKey) || store.race(baselineKey))) return null;
    let votes = null;
    if (c.kind === "state") {
      if (!comparableAtState()) return null;
      const sums = store.baselineStateTotals(baselineKey, stateOf);
      votes = sums && sums.get(c.st);
    } else if (c.kind === "district" || c.kind === "unit") {
      if (c.redrawn) return null;
      const f = unitIndex.get(c.id);
      const tier = c.kind === "district" ? "cd" : f && f.properties.tier;
      if (!tier || store.baselineTier(baselineKey) !== tier) return null;
      const u = store.baselineUnit(baselineKey, c.id);
      votes = u && u.votes;
      // Florida and Oklahoma print no line for an unopposed seat (unitCell).
      if (u && u.unopposed) {
        const race = store.race(baselineKey);
        return { kind: "compare", votes: votes || {}, totals: store.partyTotals(votes || {}, race), race,
                 subj: baselineKey, unopposed: u.winner || null };
      }
    }
    if (!votes) return null;
    const race = store.race(baselineKey);
    return { kind: "compare", votes, totals: store.partyTotals(votes, race), race, subj: baselineKey };
  }

  /** The readout's line for the election a no-vote race is shown as. */
  function compareRows(c) {
    if (variable !== "swing" || !beforeVotes(c)) return [];
    const b = compareCell(c);
    const m = b && cellValue(b, "margin");
    if (m == null) return [];
    return [[esc(store.baselineLabel(baselineKey)), `${marginLabel(m, topOf(b))} <span style="color:var(--ink-soft);font-weight:400">(on the map until votes are in)</span>`]];
  }
  const compareDl = (c) => { const r = compareRows(c); return r.length ? dl(r) : ""; };

  /** President 2024 is what is on the map inside this state. */
  function pres2024() {
    return raceId ? /^2024-pres-/.test(raceId) : subject() === "pres-2024";
  }

  /* Precincts load county by county, only the counties on screen
   * (scripts/build_precinct_tiles.sh: geo/precincts-2024/<ST>/<FIPS>.json and
   * an index.json of the state's counties). A whole state at once was up to
   * 300 MB of shapes -- California's 18,539 precincts -- and Chrome flagged the
   * tab (November 3); zoomed in on one county the map now holds a few hundred.
   * precincts: state -> Set of its counties with a file, null while the index
   * loads, false for a state with none. tiles: "ST/FIPS" -> features, null
   * while loading. Only the open state's are kept (releasePrecincts). */
  const tiles = new Map();
  const TILE_SLACK = 6;           // off-screen counties kept beyond those on screen

  function loadPrecincts(st) {
    if (!st || precincts.has(st) || !bundle) return;
    precincts.set(st, null);
    getJSON(`${bundle.base}/geo/precincts-2024/${st}/index.json`, {}, { optional: true })
      .then((list) => {
        if (focus !== st) { precincts.delete(st); return; }
        // index.json: {county: precincts in it}; an older list of counties also reads.
        const counts = Array.isArray(list) ? list.map((c) => [c, 0]) : Object.entries(list || {});
        precincts.set(st, counts.length ? new Map(counts) : false);
        if (counts.length) wantPrecincts(); else syncPrecinctButton();
      })
      .catch(() => { precincts.set(st, false); if (focus === st) syncPrecinctButton(); });
  }

  /* The open state's counties whose box is on screen, with a margin so a pan
   * finds its neighbors already loaded. Boxes are projected once per
   * projection and kept. */
  const countyBox = new WeakMap();
  function visibleCounties() {
    const feats = (focus && (countiesByState.get(focus) || [])) || [];
    const proj = view.projection;
    const path = d3.geoPath(proj);
    const t = view.transform;
    const W = canvas.clientWidth || 800, H = canvas.clientHeight || 600;
    const mx = 0.15 * W / t.k, my = 0.15 * H / t.k;
    const v = [-t.x / t.k - mx, -t.y / t.k - my, (W - t.x) / t.k + mx, (H - t.y) / t.k + my];
    const out = [];
    for (const f of feats) {
      let c = countyBox.get(f);
      if (!c || c.proj !== proj || c.fit !== proj.scale()) {
        const [[x0, y0], [x1, y1]] = path.bounds(f);
        c = { proj, fit: proj.scale(), b: [x0, y0, x1, y1] };
        countyBox.set(f, c);
      }
      const b = c.b;
      if (!(b[2] < v[0] || b[0] > v[2] || b[3] < v[1] || b[1] > v[3])) out.push(String(f.properties.id));
    }
    return out;
  }

  let tileTimer = null;
  function tilesArrived() {           // several counties land together: one redraw
    if (tileTimer) return;
    tileTimer = setTimeout(() => { tileTimer = null; changed(); }, 60);
  }

  function loadTile(st, fips) {
    const key = `${st}/${fips}`;
    if (tiles.has(key)) return;
    tiles.set(key, null);
    loadTopoOffThread(`${bundle.base}/geo/precincts-2024/${st}/${fips}.json`)
      .then((t) => {
        if (focus !== st) { tiles.delete(key); return; }
        tiles.set(key, t.precincts || []);
        tilesArrived();
      })
      .catch(() => { tiles.set(key, []); });
  }

  /** The loaded precincts of the counties on screen, as one feature list
   *  (the same array while that set does not change). */
  let tileMemo = { key: "", feats: [] };
  function precinctFeatures() {
    if (!focus) return [];
    const have = visibleCounties().map((c) => `${focus}/${c}`).filter((k) => tiles.get(k));
    const key = have.join(",");
    if (key !== tileMemo.key) tileMemo = { key, feats: have.flatMap((k) => tiles.get(k)) };
    return tileMemo.feats;
  }

  /* The full-detail counties and districts (15 MB) on the first drill into
   * a state, not at startup: a viewer who stays national never needs them.
   * Until they land the state draws from the national file. */
  let detailAsked = null;         // the bundle this panel asked for detail on
  function wantDetail() {
    const b = bundle;
    if (!b || detailAsked === b) return;
    detailAsked = b;
    // A split panel shares the bundle, so the fetch is shared (loadDetail
    // keeps one promise per bundle); each panel indexes it for itself.
    loadDetail(b).then((d) => {
      if (!d || bundle !== b) return;
      const group = (feats) => {
        const m = new Map();
        for (const f of feats) {
          if (!m.has(f.properties.state)) m.set(f.properties.state, []);
          m.get(f.properties.state).push(f);
        }
        return m;
      };
      const name = Object.keys(d.counties).find((k) => k !== "__topo");
      fine = { topo: d.counties, name, counties: group(d.counties[name]),
               cds: group((d.congress && d.congress.districts) || []),
               cds26: group((d.congress26 && d.congress26.districts) || []), outlines: new Map() };
      // A state already open swaps to its detailed units in place.
      if (focus) refresh();
    });
  }

  /* Only the open state's precincts are kept. Loaded, a big state's are
   * ~50 MB of shapes (California's 18,539), and five states visited in a row
   * held 240 MB until the page was reloaded (November 3), which Chrome
   * flagged as a tab using too much memory. Leaving a state lets them go; going
   * back fetches them again (cached by the browser, parsed off-thread).
   * A state found to have none (false) stays remembered. */
  function releasePrecincts(keep = null) {
    for (const [st, v] of [...precincts]) if (st !== keep && v !== false) precincts.delete(st);
    for (const k of [...tiles.keys()]) if (!k.startsWith(`${keep}/`)) tiles.delete(k);
    tileMemo = { key: "", feats: [] };
  }

  /** The counties with precincts on screen, and whether they fit the budget. */
  function onScreenPrecincts() {
    const have = focus && precincts.get(focus);
    if (!have) return { vis: [], fits: false };
    const vis = visibleCounties().filter((c) => have.has(c));
    const n = vis.reduce((a, c) => a + (have.get(c) || 0), 0);
    return { vis, fits: vis.length > 0 && n <= PRECINCT_BUDGET };
  }

  function wantPrecincts() {
    if (!(focus && precinctsOn && precinctVariable() && !cartoOn())) return;
    const have = precincts.get(focus);
    if (have === undefined) { loadPrecincts(focus); return; }
    if (!have) return;
    const { vis, fits } = onScreenPrecincts();
    if (fits) for (const c of vis) loadTile(focus, c);
    // Counties off screen are let go, oldest first, past a little slack.
    const keep = new Set(fits ? vis.map((c) => `${focus}/${c}`) : []);
    for (const k of tiles.keys()) {
      if (tiles.size <= keep.size + TILE_SLACK) break;
      if (!keep.has(k) && tiles.get(k) !== null) tiles.delete(k);
    }
  }

  /* Zoomed in on part of a state, under any race: the 2024 presidential
   * vote by precinct, with the race's own districts or counties outlined on
   * top -- how a district voted for president, block by block. */
  function precinctView() {
    if (cartoOn() || piecesHere()) return false;
    return !!(focus && precinctsOn && precinctVariable() && precincts.get(focus) &&
              onScreenPrecincts().fits && precinctFeatures().length);
  }

  /* A precinct carries one thing, the 2024 presidential vote: a margin and a
   * lead, no rating, reporting, swing or turnout. Under those the precincts
   * step aside and the race's own units keep their color, rather than a
   * state of "no data" grey drawn over them. */
  function precinctVariable() {
    return variable === "margin" || variable === "lead";
  }

  function precinctCell(f) {
    const p = f.properties;
    const votes = { dem: p.dem || 0, rep: p.rep || 0, other: Math.max(0, (p.total || 0) - (p.dem || 0) - (p.rep || 0)) };
    return { kind: "precinct", id: p.id, subj: "pres-2024", votes, totals: store.partyTotals(votes, null),
             official: p.official };
  }

  /** The cell a drawn shape is colored and read out from. */
  function cellFor(f, atState = stateLevel()) {
    if (f.properties.tier === "precinct") return precinctCell(f);
    if (f.properties.tier === "cdpiece") return pieceCell(f) || districtCell(f.properties.cd);
    if (atState) {
      return f.properties.tier === "state" ? stateCell(f.properties.id)
        : unitCell(f.properties.id, natRaceOf.get(f.properties.state));
    }
    if (districtMode() && f.properties.tier === "cd") return districtCell(f.properties.id);
    return unitCell(f.properties.id);
  }

  function fillFor(f) {
    if (districtMode() && f.properties.tier === "state") return redrawnFill();
    const c = cellFor(f, false);
    const fill = cellFill(c, false);
    // A rating is not a count, partial or otherwise.
    // Nor is last time's map, shown before a vote (compareCell): partial
    // says how much of tonight's count is in.
    return c.partial && variable !== "rating" && !chiclets() && !beforeVotes(c) && typeof fill === "string" ? partialFill(fill) : fill;
  }

  function stateFill(f) {
    return cellFill(stateCell(f.properties.id), true);
  }

  /** National zoom in a statewide mode: a state's units where they are drawn,
   *  the state where they are not. */
  function nationalFill(f) {
    return f.properties.tier === "state" ? stateFill(f) : cellFill(cellFor(f, true), false);
  }

  /* --------------------------------------------------------------- layers */

  /* Which geography a state draws at. New England reports by town, so the
   * answer is not a property of the state -- it is a property of the file
   * being shown. A race whose registry entry says unit_tier "town" draws
   * towns; everything else draws counties. A state with no results falls back
   * to the baseline's tier: counties, or congressional districts in the House
   * mode. */
  function tierOf(st) {
    const race = raceId ? raceOf(raceId) : null;
    if (race && race.unit_tier === "town" && townsByState.has(st)) return "town";
    if (race && race.unit_tier === "district" && districtsByState.has(st)) return "district";
    if (race && race.unit_tier === "senate-district" && senatesByState.has(st)) return "senate-district";
    if (!race && store.baselineTier(drawKey()) === "cd" && cdsByState.has(st)) return "cd";
    // (House 2026 names house-2024 as its drawKey, so it lands here too.)
    return "county";
  }

  /* Zoomed in on a district, the user's ask (November 6): each district
   * drawn as its county pieces, each by its own count, under the district's
   * outline. Inside a state in House 2026 on Margin, Raw lead or Reporting,
   * once zoomed past PIECE_K -- a tap on a district zooms well past it --
   * so the whole state still reads district by district. There the pieces
   * win over Precincts, the user's call (November 6): tonight's count by
   * county over 2024's presidential precincts; precincts still show in a
   * state with no pieces, and at the whole-state view. The pieces are on
   * the lines the state is drawn on, one file per state, fetched on the way
   * in and let go on leaving it. */
  const PIECE_K = 1.5;
  const cdPieces = new Map();       // "2024/PA" -> features; null while loading, false if none
  let piecesShown = false;
  let soloCd = null;                // the one district drawn, zoomed to it (see layers)
  const piecesLines = (st) => (newLines(st) ? "2026" : "2024");
  function piecesWanted() {
    return !!focus && districtMode() && mode().cycle === liveCycle() && !cartoOn() &&
      (variable === "margin" || variable === "lead" || variable === "reporting") &&
      !(redrawn.has(focus) && !newLines(focus));
  }
  function loadPieces(st) {
    const key = `${piecesLines(st)}/${st}`;
    if (cdPieces.has(key) || !bundle) return;
    for (const k of [...cdPieces.keys()]) if (!k.endsWith(`/${st}`)) cdPieces.delete(k);
    cdPieces.set(key, null);
    loadTopo(`${bundle.base}/geo/detail/cd-pieces/${key}.topojson`)
      .then((t) => { cdPieces.set(key, (t.pieces || []).map(rewound)); if (focus === st) refresh(); })
      .catch(() => cdPieces.set(key, false));
  }
  /* A polygon wound the wrong way is, to d3, the whole globe outside it:
   * one piece (Walker County's part of TX-08, after quantization) filled
   * the screen. Turned the right way round, part by part. */
  function rewound(f) {
    const g = f.geometry;
    if (!g || d3.geoArea(f) <= 2 * Math.PI && g.type === "Polygon") return f;
    const fix = (poly) => (d3.geoArea({ type: "Polygon", coordinates: poly }) > 2 * Math.PI
      ? poly.map((ring) => ring.slice().reverse()) : poly);
    const coordinates = g.type === "Polygon" ? fix(g.coordinates)
      : g.type === "MultiPolygon" ? g.coordinates.map(fix) : g.coordinates;
    return { ...f, geometry: { ...g, coordinates } };
  }

  /** This state's pieces, when they are what the zoom shows; null otherwise. */
  function piecesHere() {
    if (!piecesWanted()) return null;
    loadPieces(focus);
    const all = view.transform.k >= PIECE_K && cdPieces.get(`${piecesLines(focus)}/${focus}`);
    return all && all.some((f) => pieceCell(f)) ? all : null;
  }

  /** The pieces to draw over these districts: those with a count of their own. */
  function pieceFeatures(districts) {
    const all = !precinctShown && piecesHere();
    if (!all) return [];
    const drawn = new Set(districts.map((f) => f.properties.id));
    return all.filter((f) => drawn.has(f.properties.cd) && pieceCell(f));
  }

  const TIER_MAPS = () => ({ town: townsByState, district: districtsByState, "senate-district": senatesByState,
                             cd: (fine && fine.cds.size && fine.cds) || cdsByState,
                             county: (fine && fine.counties) || countiesByState });

  /* The focused state's outline, dissolved from the full-detail counties so
   * that it lands on their edges; the national outline is thinned with the
   * national counties and would wander across the detailed ones. */
  function focusOutline(st) {
    if (!fine) return stateFeatures.filter((f) => f.properties.id === st);
    if (!fine.outlines.has(st)) {
      const topo = fine.topo.__topo;
      const geoms = topo.objects[fine.name].geometries.filter((g) => g.properties.state === st);
      fine.outlines.set(st, [{ type: "Feature", geometry: topojson.merge(topo, geoms),
                               properties: { state: st, id: st, name: st, tier: "state" } }]);
    }
    return fine.outlines.get(st);
  }

  /* A state that redrew for 2026 draws its districts on the 2026 lines when
   * the Census file for them is loaded. Every other state draws the 2024
   * file, whose lines are the same ones (scripts/build_geo_2026.sh). The
   * redrawn list decides, so the boards and the map agree on which states
   * moved. */
  function cds26For(st) {
    return ((fine && fine.cds26 && fine.cds26.size && fine.cds26) || cds26ByState).get(st) || [];
  }
  function newLines(st) {
    return redrawn.has(st) && cds26ByState.has(st) && shapesNow() !== "lines2024";
  }

  /* ------------------------------------------------------------- shapes */

  /** The shapes on offer for what is drawn now, cartogram first: the House
   *  modes and the legislatures, where the cartogram has the chamber. House
   *  2026 adds the 2024 lines; Pennsylvania's legislature has one plan for
   *  2022-2030, so its lines are its lines. */
  function shapeChoices() {
    if (!carto) return [];
    const r = raceId ? raceOf(raceId) : null;
    const office = r ? r.office : mode().office;
    if (LEGISLATURE.has(office)) {
      const m = cartoUnits();
      return (focus ? m.has(focus) : m.size) ? ["cartogram", "lines"] : [];
    }
    if (r || office !== "house") return [];
    return mode().districts ? ["cartogram", "lines", "lines2024"] : ["cartogram", "lines"];
  }
  function shapesNow() {
    const c = shapeChoices();
    if (!c.length) return null;
    return c.includes(shapes) ? shapes : shapes === "lines2024" ? "lines" : c[0];
  }
  function cartoOn() {
    return shapesNow() === "cartogram";
  }
  /** The House at national zoom on the cartogram's own layout and projection. */
  function cartoNational() {
    return !focus && mode().office === "house" && cartoOn();
  }
  /** The cartogram's cells for what is drawn, by state. */
  function cartoUnits() {
    const r = raceId ? raceOf(raceId) : null;
    const office = r ? r.office : mode().office;
    if (office === "state-house") return carto.house;
    if (office === "state-senate") return carto.senate;
    return mode().districts ? carto.cd26 : carto.cd;
  }
  /** The states drawn at national zoom, outlined, labeled and pointed at. */
  function natStates() {
    return cartoNational() ? carto.states : stateFeatures;
  }
  /** What the national projection is fitted to. */
  function nationalFrame() {
    return cartoNational() ? carto.states : geo.nation;
  }
  /** House 2026 on the 2024 lines: a redrawn state stays crosshatched, its
   *  districts listed, with the old lines over it for where things were. */
  function oldLines() {
    if (!districtMode() || shapesNow() !== "lines2024") return [];
    if (focus) return redrawn.has(focus) ? (TIER_MAPS().cd.get(focus) || []) : [];
    return geo.cds.filter((f) => redrawn.has(f.properties.state));
  }

  function unitsIn(st) {
    if (cartoOn()) return cartoUnits().get(st) || [];
    if (districtMode() && redrawn.has(st)) return newLines(st) ? cds26For(st) : focusOutline(st);
    return TIER_MAPS()[tierOf(st)].get(st) || [];
  }

  let cds2026 = null;                // House 2026's national layer, see redrawn

  /* Which no-number kinds are on screen in House 2026, for the legend. The
   * legend draws every frame and this reads 435 cells, so it is kept until
   * the data or the view changes (refresh, changed). */
  let kindsMemo = null;
  function districtKinds() {
    const key = `${focus}|${modeKey}`;
    if (kindsMemo && kindsMemo.key === key) return kindsMemo;
    const cells = focus ? districtCellsIn(focus)
      : geo.cds.filter((f) => !redrawn.has(f.properties.state) || newLines(f.properties.state))
        .map((f) => districtCell(f.properties.id));
    kindsMemo = { key, waiting: cells.some((c) => c.waiting), certOnly: cells.some((c) => c.certOnly),
                  noLive: cells.some((c) => c.noLive),
                  partial: cells.some((c) => c.partial && c.data && store.totalVotes(c.totals) > 0) };
    return kindsMemo;
  }
  /* Senate and governor at national zoom, drawn like President: each state's
   * counties (towns in New England, house districts in Alaska) from its own
   * race's file, so a state's urban-rural split is on the map and not just
   * its total. A state whose file has no units -- a backfill that is
   * statewide only, a race not harvested, a state with no race -- keeps its
   * state fill. A partial file (Illinois's two counties) draws what it has;
   * the rest of the state reads "no data", and its readout says partial. */
  let natRaceOf = new Map();       // state -> race id, for states drawn by unit
  function unitRace(st, m = mode()) {
    const race = primaryRace(st, m);
    const data = race && store.results(race.race_id);
    return data && data.units && data.units.length ? race : null;
  }
  const STATE_UNITS_K = 2.5;      // national zoom past which a statewide map shows counties
  let natWhole = true;

  function statewideUnits() {
    const m = mode();
    const byTier = { county: countiesByState, town: townsByState, district: districtsByState,
                     "senate-district": senatesByState };
    const out = [];
    natRaceOf = new Map();
    const cells = cartoOn() ? cartoUnits() : null;   // a legislature on the cartogram
    // A statewide race is rated as a whole, so under Rating and vs. Rating
    // every county is the state's one color. Drawn county by county, the
    // antialiased edges between them showed as a faint grid inside the
    // state (plainest on Studio's black paper): the state draws as one shape.
    // A legislature's districts are rated one by one and keep their lines.
    // At national zoom a statewide race (Senate, governor, Secretary of State)
    // is read state by state, so each state draws as one shape in its
    // statewide color; its counties come in once the map is zoomed in.
    const whole = !LEGISLATURE.has(m.office) &&
      (variable === "rating" || variable === "vsrating" || view.transform.k < STATE_UNITS_K);
    for (const s of stateFeatures) {
      const st = s.properties.id;
      const race = whole ? null : unitRace(st, m);
      const feats = race ? (cells && cells.get(st)) ||
        (byTier[race.unit_tier || "county"] || countiesByState).get(st) : null;
      if (feats && feats.length) {
        out.push(...feats);
        natRaceOf.set(st, race.race_id);
      } else {
        out.push(s);
      }
    }
    return out;
  }

  function nationalUnits() {
    if (cartoNational()) return mode().districts ? carto.cd2026 : carto.cd2024;
    if (districtMode() && geo.cds && geo.cds.length) {
      if (!cds2026) {
        cds2026 = geo.cds.filter((f) => !redrawn.has(f.properties.state))
          .concat((geo.cds26 || []).filter((f) => newLines(f.properties.state)))
          .concat(stateFeatures.filter((f) => redrawn.has(f.properties.id) && !newLines(f.properties.id)));
      }
      return cds2026;
    }
    return store.baselineTier(drawKey()) === "cd" && geo.cds && geo.cds.length
      ? geo.cds : geo.counties;
  }

  /* Poll closings (data/reference/poll_close_2026.json): each state's first
   * close, when its first numbers can arrive. On a live-cycle map a state's
   * inner lines are faint until then. Without the file nothing fades. A
   * minute's check redraws when a state crosses its time, numbers or not. */
  let pollFirst = null;           // state -> ms of its first close
  let closedNow = "";
  function loadPollClose(base) {
    getJSON(`${base}/data/reference/poll_close_2026.json`, {}, { optional: true })
      .then((d) => {
        const st = (d && d.states) || {};
        pollFirst = new Map(Object.entries(st).map(([k, v]) => [k, Date.parse(v.first || v.close)])
          .filter(([, t]) => !Number.isNaN(t)));
        closedNow = closedKey();
        refresh();
      })
      .catch(() => {});
  }
  function closedKey() {
    if (!pollFirst) return "";
    const now = Date.now();
    return [...pollFirst].filter(([, t]) => t <= now).map(([k]) => k).join(",");
  }
  setInterval(() => {
    const k = closedKey();
    if (k !== closedNow) { closedNow = k; refresh(); }
  }, 60000);
  function liveCycleMap() {
    const live = FIXED_MODES.find((m) => m.districts).cycle;
    return (raceId ? raceId.slice(0, 4) : mode().cycle) === live;
  }
  function beforeClose(f) {
    if (!pollFirst || !liveCycleMap()) return false;
    const st = f.properties.state || stateOf(f.properties.id);
    const t = st && pollFirst.get(st);
    return !!t && Date.now() < t;
  }
  const fadedMemo = new Map();
  function faded(color) {
    let out = fadedMemo.get(color);
    if (!out) {
      const c = d3.color(color);
      if (c) c.opacity = 0.18;
      out = c ? c.formatRgb() : color;
      fadedMemo.set(color, out);
    }
    return out;
  }

  function layers() {
    const T = theme();
    const atState = stateLevel();
    precinctShown = precinctView();
    const data = precinctShown ? precinctFeatures()
      : focus ? unitsIn(focus) : atState ? statewideUnits() : nationalUnits();
    const fill = atState ? nationalFill : fillFor;
    const quietEdge = d3.interpolateRgb(T.paper, T.ink)(0.4);
    const precinctEdge = (() => { const c = d3.color(T.water); c.opacity = 0.35; return c.formatRgb(); })();
    // Inside a state, only that state. The country's outline and its
    // neighbours still project under the state's CRS -- they just land
    // somewhere arbitrary, and drew as stray lines across the frame.
    const rest = focus || cartoNational() ? [] : geo.nation;
    // In a statewide mode a state with no contest (no Secretary of State in
    // Pennsylvania) is left out: no outline, no label, just the country's.
    const outlines = focus ? focusOutline(focus)
      : stateLevel() ? natStates().filter((f) => !stateCell(f.properties.id).noRace) : natStates();
    const cd = !focus && (data === geo.cds || data === cds2026 || cartoNational());
    const flips = flipShapes(data);
    lastData = data;
    // Pieces after their districts in one layer: drawn and picked over them,
    // and a sliver the pieces leave shows (and picks) the district.
    let pieces = focus && districtMode() ? pieceFeatures(data) : [];
    // Zoomed to one district (tapped, so pinned), the user's ask (November
    // 6): that district alone, its county pieces filled; no other district
    // drawn at all, and no county lines but those between its own pieces
    // (the user's follow-up: "only show the county inner lines to the
    // district"). Zoomed in without a district picked, every district's pieces.
    const pick = pinned && (pinned.properties.tier === "cd" ? pinned.properties.id
      : pinned.properties.tier === "cdpiece" ? pinned.properties.cd : null);
    soloCd = pick && pieces.some((f) => f.properties.cd === pick) ? pick : null;
    if (soloCd) pieces = pieces.filter((f) => f.properties.cd === soloCd);
    piecesShown = pieces.length > 0;
    const shownCds = soloCd ? data.filter((f) => f.properties.id === soloCd) : data;
    return [
      // The country's fill goes behind the data; its borders go over it.
      { id: "nation-fill", features: rest, fill: () => T.basefill },
      { id: "data", features: piecesShown ? [...shownCds, ...pieces] : data, fill, blank: T.nodata, pick: true,
        // Inside a state the unit boundary is structure and always draws;
        // at national zoom 3,143 hairlines are noise until zoomed in. 435
        // districts are not, and a district map without its lines is a
        // map of blobs.
        // A line in the paper color vanishes into a patterned fill (dots,
        // hatching) whose ground is the paper too -- in Studio, a whole state
        // of waiting districts with no lines -- so those get the edge color.
        // A unit in the base color (a seat not up this year) has the paper
        // color around it, which is its own fill in Studio: a mid tone
        // between paper and ink keeps those borders on the map.
        stroke: (f) => {
          if (!(focus || cd || view.transform.k > 4)) return null;
          // Chiclets at national zoom: state lines only, or 435 district
          // hairlines bury them (and the markers).
          if (chiclets() && !focus) return null;
          // Precinct edges are texture, faint, so the district lines over
          // them read as the structure.
          if (precinctShown) return precinctEdge;
          const c = fill(f);
          const line = typeof c !== "string" ? T.baseedge : c === T.basefill ? quietEdge : T.water;
          // Before a state's polls close, its district and county lines are
          // faint: the map reads as the states that can report.
          return beforeClose(f) ? faded(line) : line;
        },
        lineWidth: precinctShown ? 0.3 : focus ? (districtMode() ? 1 : 0.5) : cd ? 0.4 : 0.3 },
      // Over precincts, the race's own units as lines: a district's edge is
      // what the precincts are read against. A paper-colored casing under an
      // ink line keeps it visible on any fill.
      // Over the county pieces, the districts they make up.
      { id: "piece-districts", features: piecesShown ? shownCds : [], stroke: () => T.ink, lineWidth: 1.6 },
      { id: "old-lines", features: oldLines(), stroke: () => T.ink, lineWidth: focus ? 1 : 0.5 },
      { id: "unit-casing", features: precinctShown ? unitsIn(focus) : [],
        stroke: () => T.paper, lineWidth: 4 },
      { id: "unit-lines", features: precinctShown ? unitsIn(focus) : [],
        stroke: () => T.ink, lineWidth: 2 },
      // On the cartogram the states are islands of hatched cells, and a
      // hairline in the base color vanished into them: the user asked for
      // state boundaries there, so they draw in ink, well over the 0.4 px
      // district lines.
      // Not over county pieces: the stripes would hide their colors, and the
      // readout still says flip.
      { id: "flip-hash", features: piecesShown ? [] : flips, fill: (f) => (flipOf(cellFor(f)) ? flipHash() : null) },
      { id: "state-lines", features: outlines,
        // A theme may fix the state-line color (--stateline: white in dark
        // and Studio, the user's call, November 3, 2026); otherwise it
        // follows the view.
        stroke: () => T.stateline ||
          (chiclets() || cartoNational() ? T.ink : focus ? T.baseedge : atState ? T.baseedge : T.baseline),
        lineWidth: cartoNational() ? 1.6 : focus ? 1.2 : chiclets() ? 1 : atState ? 0.8 : 0.7 },
      { id: "nation-line", features: rest, stroke: () => T.baseedge,
        lineWidth: 1 },
      // Thick enough to read against the unit lines under it: inside a state
      // district lines are 1 px, the same color as this one over a dotted
      // fill, and a 1.6 px outline there did not look like a hover at all.
      { id: "hover", features: hovered ? [hovered] : [],
        stroke: () => T.ink, lineWidth: focus ? 2.8 : 2 },
      // A press shows before it is a tap: the morph only starts on release,
      // and a finger on a wall otherwise gets nothing back until then.
      { id: "press", features: pressed ? [pressed] : [],
        stroke: () => T.ink, lineWidth: 3.5 },
    ];
  }

  /* The data layer's features as last laid out, for the legend's flip key. */
  let lastData = [];
  const legendData = () => lastData;

  function refresh() {
    kindsMemo = null;
    view.setLayers(layers());
    view.render();
    if (split) split.refresh();
    showReadout(hovered || pinned);
  }

  /* -------------------------------------------------------------- readout */

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function fmt(n) {
    return n == null ? "—" : d3.format(",")(Math.round(n));
  }

  /* The side a margin is labeled with: D or R, or for anyone else ahead the
   * leader's surname ("King +17.5"), since "I+17.5" would not say which
   * independent. `who` is the cell's top two, or null for a D/R number. */
  const PARTY_LETTER = { dem: "D", rep: "R" };
  function sideLabel(v, who) {
    const p = who && who.leader.party;
    if (p && !PARTY_LETTER[p]) return surname(who.leader.name) || "Ind.";
    return v >= 0 ? "D" : "R";
  }
  function surname(name) {
    if (!name) return null;
    // "King, Angus S. Jr." (last name first) or "Dan Osborn"; a ticket
    // ("Jim Pillen and Joe Kelly") is named by its first half.
    const n = String(name).split(/\s+(?:and|&)\s+|\s*\/\s*/)[0];
    if (n.includes(",")) return n.split(",")[0].trim();
    const words = n.trim().split(/\s+/).filter((w) => !/^(jr|sr|ii|iii|iv)\.?$/i.test(w));
    return words[words.length - 1] || null;
  }

  function marginLabel(pts, who = null) {
    if (pts == null) return "no result";
    const side = sideLabel(pts, who);
    return `${side}${side.length > 1 ? " " : ""}+${d3.format(".1f")(Math.abs(pts))}`;
  }

  function leadLabel(v, who = null) {
    if (v == null) return "—";
    if (v === 0) return "tied";
    return `${sideLabel(v, who)} +${fmt(Math.abs(v))}`;
  }

  function partyColor(p) {
    const T = theme();
    return p === "dem" ? T.dem : p === "rep" ? T.rep : p === "ind" ? T.ind : T.inkSoft;
  }

  function raceLabel(id) {
    const r = raceOf(id);
    if (!r) return store.baselineLabel(id);
    return `${OFFICE_LABEL[r.office] || r.office} ${id.slice(0, 4)}${r.special ? " (special)" : ""}`;
  }

  function asOf(data) {
    if (!data || !data.updated) return null;
    const t = new Date(data.updated);
    const clock = t.toLocaleString([], { month: "short", day: "numeric",
                                         hour: "numeric", minute: "2-digit" });
    return `${clock} (${ago(Date.now() - t.getTime())} ago)`;
  }

  /* The candidate block: who, how many, what share. Shares are of all votes,
   * which is what a candidate actually got; only the margin is two-party. */
  function candidateTable(votes, race, names) {
    const rows = store.candidateRows(votes, race, names).filter((r) => r.votes > 0 || r.id !== "other");
    if (!rows.length) return "";
    const pct = d3.format(".1%");
    return `<table class="cands" style="width:100%;border-collapse:collapse;margin:0 0 10px;font-variant-numeric:tabular-nums">${
      rows.map((r) => `<tr>
        <td style="padding:2px 0;width:10px"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${partyColor(r.party)}"></span></td>
        <td style="padding:2px 6px">${esc(r.name)}${r.incumbent ? ' <span title="Incumbent" style="color:var(--ink-soft);font-size:11px">(i)</span>' : ""}</td>
        <td style="padding:2px 0;text-align:right;font-weight:600">${r.share == null || r.votes === 0 ? "—" : pct(r.share)}</td>
        <td style="padding:2px 0 2px 8px;text-align:right;color:var(--ink-soft)">${fmt(r.votes)}</td></tr>`).join("")
    }</table>`;
  }

  /** Rows for the definition list under the candidates, one cell. */
  function cellRows(c) {
    const rows = [];
    if (!c.totals) return rows;
    const total = store.totalVotes(c.totals);
    rows.push(["Total votes", fmt(total)]);
    if (total > 0) {
      rows.push(["Margin", marginLabel(cellValue(c, "margin"), topOf(c))]);
      rows.push(["Raw lead", leadLabel(cellValue(c, "lead"), topOf(c))]);
    }
    if (c.precincts && Array.isArray(c.precincts) && c.precincts[1]) {
      rows.push(["Precincts", `${fmt(c.precincts[0])} of ${fmt(c.precincts[1])}`]);
    }
    if (c.reporting != null) {
      // Precincts reporting is not percent of the vote, and the label says
      // which one this is (docs/schema.md §2).
      const basis = c.basis === "expected vote" ? "Expected vote in"
        : c.basis === "certified" ? "Reporting (certified)" : "Precincts reporting";
      rows.push([basis, `${d3.format(".1f")(c.reporting)}%`]);
    }
    rows.push(...ratingRows(c));
    if (c.baseTotals && total > 0) {
      const label = store.baselineLabel(baselineKey);
      const sw = cellValue(c, "swing");
      if (sw != null) rows.push([`Swing vs ${label}`, `${marginLabel(sw)} margin`]);
      const to = cellValue(c, "turnout");
      if (to != null) rows.push([`Turnout vs ${label}`, d3.format(".1%")(to)]);
      // An estimate and labeled as one: the vote still to come if this
      // place turns out exactly as it did in the baseline. Not a projection,
      // and meaningless for a certified file, where nothing is outstanding.
      if (c.data && !c.data.final) {
        const left = Math.max(0, store.totalVotes(c.baseTotals) - total);
        rows.push(["Est. outstanding", `~${fmt(left)} <span style="color:var(--ink-soft);font-weight:400">(if turnout = ${esc(label)})</span>`]);
      }
    }
    return rows;
  }

  const dl = (rows) =>
    `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;

  function sourceRows(c) {
    const rows = [];
    const data = c.data;
    // Every number carries the age of its source (DESIGN.md §10), and a
    // hand-entered one says whose hand.
    if (data && data.updated) {
      rows.push(data.override === "race"
        ? ["Override", `${esc((data.source && data.source.source) || "manual")} · ${asOf(data)}`]
        : ["As of", asOf(data)]);
    } else if (!data && c.subj && store.baseline(c.subj)) {
      rows.push(["Source", esc(store.baselineLabel(c.subj))]);
    }
    if (fromFallback(data) && data.override !== "race") {
      // AP is the primary source since the user's rule of November 6; the
      // Times is still the fallback.
      const prov = data.source.provider;
      rows.push(["Source", prov === "ap" ? FALLBACKS.ap : `${FALLBACKS[prov]} (fallback)`]);
    }
    if (c.unit && c.unit.override && data && data.override_source) {
      rows.push(["Override", `this ${tierWord(tierOf(focus))}: ${esc(data.override_source.source)}`]);
    }
    return rows;
  }

  function zoomHint(t) {
    return tierWord(t) === "district" ? "Tap it to zoom in" : "Tap twice to zoom in";
  }

  function tierWord(t) {
    return { town: "town", district: "district", "senate-district": "district", cd: "district" }[t] || "county";
  }

  function stateBlock(c, heading) {
    const parts = [];
    if (heading) parts.push(heading);
    if (c.noRace) {
      parts.push(`<p class="hint">${seatListFor(mode())
        ? `No ${esc(mode().label)} race here.`
        : `No ${esc(mode().label)} race harvested for this state.`}</p>`);
      return parts.join("");
    }
    if (c.waiting || c.certOnly || c.noLive) {
      const what = c.waiting ? "feed waiting for the state to publish its 2026 results."
        : c.certOnly ? "no live feed. Numbers arrive only as an override, from certified results."
        : "no live feed for this race.";
      const s = c.seat;
      const who = s && s.incumbent ? `<br>Seat held by ${esc(s.incumbent)} (${(s.held || "").slice(0, 1).toUpperCase()}), ${
        esc(String(s.incumbent_status || "").replace(/-/g, " "))}.` : "";
      parts.push(`<p class="hint">${esc(mode().label)}${c.expected && /special/.test(c.expected.seat_type || "") ? " (special)" : ""}: ${what}${
        c.expected && c.expected.why ? `<br><span style="font-size:12px">${esc(c.expected.why)}</span>` : ""}${who}</p>`);
      parts.push(compareDl(c));
      parts.push(ratingDl(c));
      parts.push(onBallot(cellRaceId(c)));
      return parts.join("");
    }
    if (c.noFeed) {
      const s = c.seat;
      const who = s.incumbent ? `${esc(s.incumbent)} (${(s.held || "").slice(0, 1).toUpperCase()}), ${
        esc(String(s.incumbent_status || "").replace(/-/g, " "))}` : "";
      parts.push(`<p class="hint">${esc(mode().label)}${s.special ? " (special)" : ""} is on the ballot here, but no results feed is on this wall.${
        who ? `<br>Seat held by ${who}.` : ""}</p>`);
      parts.push(onBallot(cellRaceId(c)));
      return parts.join("");
    }
    if (c.awaiting || !c.votes) {
      parts.push(`<p class="hint">${esc(raceLabel(c.subj))}: no results file yet.</p>`);
      if (!c.data) parts.push(onBallot(cellRaceId(c)));
      return parts.join("");
    }
    const names = BASELINE_NAMES[c.subj];
    // A partial feed's statewide line is not a statewide total, and the
    // readout says how much of the state it is.
    if (((c.expected && c.expected.partial) || selfPartial(c.data)) && c.data && !fromFallback(c.data)) {
      const have = (c.data.units || []).filter((u) => u.id != null).length;
      const of = (countiesByState.get(c.st) || []).length;
      const what = (c.data.source && c.data.source.coverage) || `${have}${of ? ` of ${of}` : ""} counties`;
      parts.push(`<p class="hint" style="color:var(--warn);font-weight:600">Partial: ${esc(what)}, not a statewide total.</p>`);
    }
    parts.push(flipHint(c));
    parts.push(candidateTable(c.votes, c.race, names));
    const rows = awaiting(c) ? [["Status", "Awaiting votes"], ...compareRows(c), ...ratingRows(c)] : cellRows(c);
    parts.push(dl([...rows, ...sourceRows(c)]));
    return parts.join("");
  }

  /* The readout as HTML, so a split panel's readout can be put under this
   * one's rather than fighting it for the same element. */
  function readoutHTML(f) {
    const m = mode();
    if (f && f.properties.tier === "precinct") return precinctHTML(f);
    if (districtMode()) return districtReadoutHTML(f);
    if (!f) {
      if (focus) {
        const lr = raceOf(raceId);
        if (lr && LEGISLATURE.has(lr.office)) return legislatureHTML(lr);
        // Inside a state with nothing under the pointer: the statewide total
        // of whatever is on the map, so the headline number is always up.
        const c = raceId ? statewideCellFor(raceId) : baselineStateCell(focus);
        // A file with a statewide count and no units (a past race backfilled
        // from MEDSL where the county rows did not add up) says so, rather
        // than leaving a grey state unexplained.
        const noUnits = c && c.data && Array.isArray(c.data.units) && !c.data.units.length;
        return `<h2>${esc(stateName(focus))}</h2>` +
          `<p class="hint" style="margin:-6px 0 10px">${esc(raceLabel(subject()))} — statewide</p>` +
          (c ? stateBlock(c) : "") +
          (noUnits
            ? `<p class="hint">Statewide total only: no ${tierWord(tierOf(focus))} results on file for this race. Click the map background to go back.</p>`
            : `<p class="hint">Point at a ${tierWord(tierOf(focus))}. ${zoomHint(tierOf(focus))}; tap outside the state to go back.</p>`);
      }
      const counted = raceModes().find((x) => x.key === m.key) || m;
      const tail = m.statewide
        ? (counted.total
            ? `${counted.summary}. Point at a state; click to go in.`
            : `${counted.states} states on this wall, ${counted.reporting} reporting${
                counted.noFeed ? `; ${counted.noFeed} more on the ballot with no feed` : ""}. Point at a state; click to go in.`)
        : `Point at a state; click to go in.`;
      return `<h2>${esc(m.label)}</h2><div class="hint">${tail}</div>`;
    }
    const p = f.properties;

    if (stateLevel()) {
      const lr = LEGISLATURE.has(m.office) && primaryRace(p.id, m);
      if (lr) return legislatureHTML(lr);
      const c = stateCell(p.id);
      let html = `<h2>${esc(stateName(p.id))}</h2>`;
      if (c.race) html += `<p class="hint" style="margin:-6px 0 10px">${esc(raceLabel(c.subj))}</p>`;
      html += stateBlock(c);
      for (const r of c.others || []) {
        const oc = statewideCellFor(r.race_id);
        html += `<h3 style="margin:12px 0 6px;font-size:14px">${esc(raceLabel(r.race_id))}</h3>` +
          (oc ? stateBlock(oc) : `<p class="hint">No results file yet.</p>`);
      }
      return html;
    }
    if (!focus && p.tier === "state") return nationalStateHTML(p.id);

    if (p.tier === "precinct") return precinctHTML(f);
    const c = unitCell(p.id);
    const title = `${esc(p.name)}${p.state ? `, ${p.state}` : ""}`;
    let html = `<h2>${title}</h2><p class="hint" style="margin:-6px 0 10px">${esc(raceLabel(c.subj))}</p>`;
    // Where this shape's count comes from, when it is not this shape's own
    // line: a township counted with a town ("Weston/Bancroft Twp" on
    // Bancroft), or several townships summed onto one Census territory.
    if (c.unit && c.unit.id != null && String(c.unit.id) !== String(p.id)) {
      html += `<p class="hint" style="margin:-4px 0 10px">Counted with ${esc(c.unit.name)}</p>`;
    } else if (c.unit && / \+ /.test(c.unit.name || "")) {
      html += `<p class="hint" style="margin:-4px 0 10px">Townships reporting: ${esc(c.unit.name.split(" + ").join(", "))}</p>`;
    }
    if (c.notUp) {
      html += `<p class="hint">Not on the ballot in ${esc(c.subj.slice(0, 4))}: this seat was elected in another year.</p>`;
    } else if (c.waiting || c.certOnly || c.noLive) {
      html += `<p class="hint">${c.waiting ? `Waiting for ${esc(stateName(c.race.state))} to publish its ${esc(c.subj.slice(0, 4))} results.`
        : "No live feed for this race."}</p>` + compareDl(c) + ratingDl(c);
    } else if (c.unopposed) {
      html += dl([["Result", `Unopposed (${c.unopposed === "dem" ? "Democratic" : c.unopposed === "rep" ? "Republican" : esc(c.unopposed)})`],
                  ["Votes", "none printed for an unopposed seat"], ...sourceRows(c)]);
    } else if (c.votes) {
      html += candidateTable(c.votes, c.race, BASELINE_NAMES[c.subj]);
      const rows = awaiting(c) ? [["Status", "Awaiting votes"], ...compareRows(c), ...ratingRows(c)] : cellRows(c);
      html += dl([...rows, ...sourceRows(c)]);
    } else {
      html += dl([["Result", "none in this file"], ...sourceRows(c)]);
    }
    // At national zoom a county is read against its state: the statewide
    // total for the same baseline goes underneath.
    if (!focus && p.state) {
      const sc = baselineStateCell(p.state);
      if (sc) {
        html += `<h3 style="margin:14px 0 6px;font-size:14px">${esc(stateName(p.state))} statewide</h3>` +
          candidateTable(sc.votes, null, BASELINE_NAMES[sc.subj]) +
          dl([["Margin", marginLabel(cellValue(sc, "margin"), topOf(sc))],
              ["Total votes", fmt(store.totalVotes(sc.totals))]]);
      }
    }
    return html;
  }

  /** A precinct, credited to the Times as its data agreement requires. */
  function precinctHTML(f) {
    const p = f.properties;
    const c = precinctCell(f);
    const county = unitIndex.get(p.county);
    const where = county ? `${county.properties.name} County, ${p.state}` : p.state;
    const name = /^\d+$/.test(p.name) ? `Precinct ${p.name}` : p.name;
    const note = pres2024() ? "" : `<p class="hint" style="margin:-4px 0 10px">Precinct colors are the 2024 presidential vote, not ${esc(districtMode() ? mode().label : raceLabel(subject()))}.</p>`;
    return `<h2>${esc(name)}</h2><p class="hint" style="margin:-6px 0 10px">${esc(where)} · 2024 presidential</p>` + note +
      candidateTable(c.votes, null, BASELINE_NAMES["pres-2024"]) +
      dl([...cellRows(c), ["Boundary", p.official ? "official" : "estimated from the voter file"],
          ["Source", "The New York Times"]]);
  }

  /** A state at national zoom over counties or districts: its total for
   *  what the map draws. */
  function nationalStateHTML(st) {
    const c = baselineStateCell(st);
    return `<h2>${esc(stateName(st))}</h2>` + (c
      ? `<p class="hint" style="margin:-6px 0 10px">${esc(raceLabel(c.subj))} — statewide</p>` + stateBlock(c)
      : "") + `<p class="hint">Click to go in.</p>`;
  }

  function districtReadoutHTML(f) {
    const m = mode();
    if (!f && !focus) {
      const n = raceModes().find((x) => x.key === m.key) || {};
      const moved = [...redrawn].sort();
      const drawn = moved.filter(newLines), hatched = moved.filter((st) => !newLines(st));
      return `<h2>${esc(m.label)}</h2><div class="hint">${esc(n.summary || "")}.` +
        (n.reporting ? ` Leading: D ${n.leading.dem} · R ${n.leading.rep}${n.leading.ind ? ` · other ${n.leading.ind}` : ""}.` : "") +
        ` Point at a state; click to go in.</div>` +
        (drawn.length ? `<p class="hint">New lines for 2026 in ${drawn.join(", ")}, drawn from the Census 120th Congress districts. Swing against 2024 is off there.</p>` : "") +
        (hatched.length ? `<p class="hint" style="color:var(--warn)">Crosshatched: new lines for 2026 (${hatched.join(", ")}). Their districts are listed, not drawn` +
          `${shapesNow() === "lines2024" ? "; the lines over them are 2024's" : ""}.</p>` : "");
    }
    const st = focus || (f && f.properties.tier === "state" ? f.properties.id : null);
    if (f && f.properties.tier === "cd") return districtReadout(f.properties.id);
    if (f && f.properties.tier === "cdpiece") return pieceReadout(f);
    if (!st) return "";
    return `<h2>${esc(stateName(st))}</h2><p class="hint" style="margin:-6px 0 10px">${esc(m.label)} — by district</p>` +
      (redrawn.has(st) ? (newLines(st)
        ? `<p class="hint">${NEW_LINES_NOTE}</p>`
        : `<p class="hint" style="color:var(--warn);font-weight:600">${shapesNow() === "lines2024" ? OLD_LINES_NOTE : REDRAWN_NOTE}</p>`) : "") +
      districtTable(st) +
      (focus ? `<p class="hint">${redrawn.has(st) && !newLines(st) ? "" : "Point at a district. Tap it to zoom in. "}Tap outside the state to go back.</p>` : "");
  }

  function showReadout(f, id = undefined) {
    updateTip();
    if (!readout) return;
    let html = bins.on && !bins.out ? binsHTML() : withPlaces(readoutHTML(f), f);
    const at = id !== undefined ? id : f ? f.properties.id : null;
    // In split screen the other panel's reading of the same place goes
    // underneath, headed by what that panel is showing.
    if (split) {
      html += `<hr style="border:0;border-top:1px solid var(--rule);margin:14px 0 10px">` +
        `<p class="hint" style="margin:0 0 6px;text-transform:uppercase;font-size:11px;letter-spacing:.04em">Right panel · ${esc(split.paneTitle())}</p>` +
        split.readoutFor(at);
    }
    readout.innerHTML = html;
  }

  /** A district's readout names its largest places under its heading. */
  function withPlaces(html, f) {
    const line = !bins.on && f && DISTRICT_TIERS.has(f.properties.tier) ? placeLine(f) : "";
    if (!line) return html;
    const at = html.indexOf("</h2>");
    return at < 0 ? html : `${html.slice(0, at + 5)}<p class="hint" style="margin:-6px 0 8px">${esc(line)}</p>${html.slice(at + 5)}`;
  }

  /* ------------------------------------------------------------ the tooltip */

  /* A small card beside the pointer with the gist of what it is on (name,
   * where, the candidates), the user's ask after the Times's maps. A tapped
   * district docks it in the map's top-left corner, where it stays while
   * the pointer moves on; pointing at another place shows that one beside
   * the pointer instead, and leaving it brings the docked one back. The
   * readout beside the map keeps the whole story. A touch has no pointer to
   * follow, so a tap only docks. */
  const tip = document.createElement("div");
  tip.className = "map-tip";
  tip.style.cssText = "position:absolute;z-index:3;pointer-events:none;display:none;max-width:300px;" +
    "background:var(--paper);color:var(--ink);border:1px solid var(--rule);border-radius:4px;" +
    "box-shadow:0 2px 10px rgba(0,0,0,.2);padding:8px 10px 6px;font-size:13px;line-height:1.3;";
  pane.appendChild(tip);
  let pointer = null;               // { x, y } in the pane, from a mouse or pen
  canvas.addEventListener("pointermove", (ev) => {
    if (ev.pointerType === "touch") { pointer = null; return; }
    const r = pane.getBoundingClientRect();
    pointer = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    if (tip.dataset.mode === "follow") placeTip();
    // The view's hover listener runs before this one, so the first move
    // onto a place found no pointer yet.
    else if (hovered && hovered !== pinned && tipOn && !bins.on) updateTip();
  });
  canvas.addEventListener("pointerleave", () => { pointer = null; updateTip(); });

  function placeTip() {
    const W = pane.clientWidth, H = pane.clientHeight;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = pointer.x + 16, y = pointer.y + 16;
    if (x + w > W - 8) x = pointer.x - 16 - w;
    if (y + h > H - 8) y = pointer.y - 16 - h;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }

  function updateTip() {
    const follow = hovered && pointer && hovered !== pinned &&
      !(pinned && String(hovered.properties.id) === String(pinned.properties.id));
    const f = bins.on || !tipOn ? null : follow ? hovered : pinned;
    const was = tip.dataset.mode;
    // The city names make room for the docked card, so its coming and
    // going redraws them (next frame: this runs from the view's own events).
    const redraw = () => { if ((was === "dock") !== (tip.dataset.mode === "dock")) requestAnimationFrame(() => view.render()); };
    if (!f) { tip.style.display = "none"; tip.dataset.mode = ""; redraw(); return; }
    tip.innerHTML = tipHTML(withPlaces(readoutHTML(f), f));
    tip.style.display = "block";
    tip.dataset.mode = follow ? "follow" : "dock";
    redraw();
    if (follow) placeTip();
    else {
      const k = theme().scale || 1;
      tip.style.left = "10px";
      // Below the Shapes menu when it is there, which holds the same corner.
      tip.style.top = `${!shapesBtn.hidden ? corner.offsetTop + corner.offsetHeight + 6
        : titleOn ? 40 * k : 10}px`;
    }
  }

  /** The card's content, cut from the readout's own: its heading, the line
   *  or two under it, the first candidates (four at most) and the first
   *  facts, so the card and the readout can never disagree. */
  function tipHTML(html) {
    const t = document.createElement("template");
    t.innerHTML = html;
    const root = t.content;
    const h2 = root.querySelector("h2");
    let out = h2 ? `<div style="font-weight:700;font-size:15px;margin:0 0 2px">${h2.innerHTML}</div>` : "";
    // The line under the heading, then any short ones after it ("38
    // districts, none reporting"); a paragraph of explanation stays in the readout.
    let n = 0;
    for (let el = h2 && h2.nextElementSibling; el && n < 3 && el.classList.contains("hint"); el = el.nextElementSibling) {
      if (n && el.textContent.length > 80) continue;
      out += `<div style="color:var(--ink-soft);font-size:12px;margin:0 0 4px">${el.innerHTML}</div>`;
      n += 1;
    }
    // Candidates only (a party chip in the first cell), not a state's list
    // of districts.
    const table = [...root.querySelectorAll("table.cands")]
      .find((x) => x.rows.length && x.rows[0].cells[0] && x.rows[0].cells[0].querySelector("span[style*=background]"));
    if (table) {
      const rows = [...table.rows];
      for (const r of rows.slice(4)) r.remove();
      table.style.margin = "4px 0";
      table.style.fontSize = "12.5px";
      out += table.outerHTML;
      if (rows.length > 4) out += `<div style="color:var(--ink-soft);font-size:11px">+${rows.length - 4} more</div>`;
    }
    const dl = root.querySelector("dl");
    if (dl) {
      const pairs = [];
      for (const dt of dl.querySelectorAll("dt")) {
        const dd = dt.nextElementSibling;
        // The Times's precincts are credited wherever they are shown.
        if (pairs.length < 2 || /New York Times/.test(dd ? dd.textContent : "")) pairs.push([dt.innerHTML, dd ? dd.innerHTML : ""]);
      }
      out += `<div style="display:grid;grid-template-columns:auto 1fr;gap:1px 10px;font-size:12px;margin:4px 0 2px;border-top:1px solid var(--rule);padding-top:4px">` +
        pairs.map(([a, b]) => `<span style="color:var(--ink-soft)">${a}</span><span style="font-weight:600;text-align:right">${b}</span>`).join("") + `</div>`;
    } else if (!table) {
      const hint = root.querySelector(".hint:not(:first-of-type)") || null;
      if (hint && !out.includes(hint.innerHTML)) out += `<div style="color:var(--ink-soft);font-size:12px">${hint.innerHTML}</div>`;
    }
    return out;
  }

  /* A legislature's statewide vote total answers nothing -- uncontested
   * seats print one name and no opponent -- so its headline is seats: who
   * leads (or won, once the file is final) how many districts, and how many
   * were not on the ballot this year. */
  function legislatureHTML(race) {
    const data = store.results(race.race_id);
    const st = race.state;
    // By the race's own tier: at national zoom tierOf() has no race to go on.
    const tiers = { district: districtsByState, "senate-district": senatesByState };
    const drawn = ((tiers[race.unit_tier] || TIER_MAPS()[tierOf(st)]).get(st) || []).length;
    if (!data) {
      const up = race.up ? race.up.size : drawn;
      return `<h2>${esc(stateName(st))}</h2>` +
        `<p class="hint" style="margin:-6px 0 10px">${esc(raceLabel(race.race_id))} — by district</p>` +
        `<p class="hint">${race.feed === "waiting" ? `Waiting for ${esc(stateName(st))} to publish its ${esc(race.race_id.slice(0, 4))} results.`
          : "No results file yet."}</p>` +
        dl([["Seats on the ballot", fmt(up)], ...(drawn > up ? [["Not on the ballot this year", fmt(drawn - up)]] : []),
            ["Districts", fmt(drawn)]]) + legislatureHint();
    }
    const n = { dem: 0, rep: 0, other: 0, none: 0 };
    for (const u of (data && data.units) || []) {
      const t = store.partyTotals(u.votes, race);
      if (!store.totalVotes(t)) { n.none += 1; continue; }
      const top = t.dem > t.rep && t.dem > t.other ? "dem" : t.rep > t.dem && t.rep > t.other ? "rep"
        : t.other > t.dem && t.other > t.rep ? "other" : null;
      if (top) n[top] += 1; else n.none += 1;
    }
    const units = (data && data.units || []).length;
    const verb = data && data.final ? "won" : "leading";
    const rows = [[`Democrats ${verb}`, fmt(n.dem)], [`Republicans ${verb}`, fmt(n.rep)]];
    if (n.other) rows.push([`Others ${verb}`, fmt(n.other)]);
    if (n.none) rows.push(["No votes yet, or tied", fmt(n.none)]);
    if (drawn > units) rows.push(["Not on the ballot this year", fmt(drawn - units)]);
    rows.push(["Districts", fmt(drawn || units)]);
    return `<h2>${esc(stateName(st))}</h2>` +
      `<p class="hint" style="margin:-6px 0 10px">${esc(raceLabel(race.race_id))} — by district</p>` +
      dl([...rows, ...sourceRows({ data })]) + legislatureHint();
  }

  function legislatureHint() {
    return `<p class="hint">${focus ? "Point at a district. Tap it to zoom in; tap outside the state to go back." : "Click to go in."}</p>`;
  }

  /** A statewide cell for an explicit race, whatever the national mode. */
  function statewideCellFor(id) {
    const race = store.race(id);
    const data = store.results(id);
    if (!race || !data) return null;
    const votes = statewideVotes(data);
    const c = { kind: "state", st: race.state, race, data, subj: id, votes,
                totals: store.partyTotals(votes, race),
                reporting: store.reportingPct(data.statewide, data),
                basis: store.reportingBasis(data.statewide, data),
                precincts: data.statewide && data.statewide.precincts,
                expected: expectedFor(race.state, { cycle: id.slice(0, 4), office: race.office }, race) };
    const base = store.baseline(baselineKey)
      ? (store.baselineStateTotals(baselineKey, stateOf) || new Map()).get(race.state)
      : null;
    if (base && baselineKey !== id) c.baseTotals = base;
    return c;
  }

  /* ------------------------------------------------------- drill in / out */

  /* Only the state outlines and the destination state's units are morphed.
   * The explorer morphs all 435 districts because that is what it draws;
   * projecting 3,143 counties twice per transition costs about ten frames of
   * budget and buys nothing -- at national zoom a county is a few pixels and
   * the eye follows the state outline.
   *
   * In a statewide mode the national map is fifty state fills, so those are
   * morphed too: the other states fade with their outlines, and the chosen
   * state's units fade in over its own fill (or out, on the way back) so
   * that neither end of the move is a cut. */
  function morphItems(keep, fadeIn) {
    const T = theme();
    const items = [];
    // A state drawn by unit at national zoom morphs as President does: its
    // units stay, the outlines fade. Only a state drawn as one fill fades
    // its units in over that fill.
    const atState = mode().statewide && !unitRace(keep);
    for (const f of geo.nation) {
      items.push({ f, fill: T.basefill, a0: 1, a1: 1 });
    }
    if (atState) {
      for (const f of stateFeatures) {
        const mine = f.properties.id === keep;
        const fill = stateFill(f);
        // A canvas pattern is drawn in screen space by the morph; fine for a
        // flat fill, so a hatched state morphs as its base grey.
        items.push({ f, fill: typeof fill === "string" ? fill : T.nodata,
                     a0: mine ? 1 : (fadeIn ? 0 : 1), a1: mine ? 1 : (fadeIn ? 1 : 0) });
      }
    }
    for (const f of unitsIn(keep)) {
      const fill = fillFor(f);
      items.push({ f, fill: typeof fill === "string" ? fill : T.nodata,
                   a0: atState && !fadeIn ? 0 : 1, a1: atState && fadeIn ? 0 : 1 });
    }
    for (const f of stateFeatures) {
      const mine = f.properties.id === keep;
      items.push({ f, stroke: mine ? T.ink : T.baseline, lw: mine ? 1.4 : 0.7,
                   a0: mine ? 1 : (fadeIn ? 0 : 1),
                   a1: mine ? 1 : (fadeIn ? 1 : 0) });
    }
    return items;
  }

  /* Which race a state opens on when the national mode does not name one.
   * The newest cycle that has any votes in it, and otherwise the newest cycle
   * at all. Before polls close that is 2024, because the staged 2026 files
   * are all zeros and open as a grey state -- which is what Virginia, Ohio,
   * Nebraska and South Dakota did until this. Once the first county reports
   * on November 3, the same rule picks 2026 without anyone touching it. */
  function defaultRace(races) {
    if (!races.length) return null;
    const votes = (r) => {
      const d = store.results(r.race_id);
      if (!d || !d.statewide) return 0;
      return Object.values(d.statewide.votes || {}).reduce((a, b) => a + b, 0);
    };
    const byCycle = [...races].sort((a, b) => b.race_id.localeCompare(a.race_id));
    const live = byCycle.find((r) => votes(r) > 0);
    return (live || byCycle[0]).race_id;
  }

  /* The state's race follows the national choice when the state has it: a
   * click on Ohio from the Senate 2026 map opens Ohio's Senate race, staged
   * zeros and all, because that is the question being asked. The House mode
   * opens on districts from its baseline. Anything else falls back to the
   * newest statewide race with votes -- never a House race: "2026-house-ca-52"
   * sorts above "2026-gov-ca", and a click on California from the Senate map
   * should not open one district. With no statewide race the state draws
   * the baseline; House 2026 is a national mode of its own. */
  function raceFor(st) {
    const m = mode();
    const races = store.racesIn(st).filter((r) => store.hasResults(r.race_id));
    if (m.office === "house") return null;
    const own = store.racesFor(st, m.office, m.cycle).filter((r) => store.hasResults(r.race_id));
    if (own.length) return (own.find((r) => !r.special) || own[0]).race_id;
    if (LEGISLATURE.has(m.office)) {
      const p = primaryRace(st, m);
      if (p) return p.race_id;
    }
    // A presidential mode with no race file for the state draws the
    // baseline, which is the same election at county level.
    if (m.office === "president" && store.baseline(m.baseline)) return null;
    return defaultRace(races.filter((r) => r.office !== "house" && !LEGISLATURE.has(r.office)));
  }

  /* The morph into a state ends on that state's race, at that race's tier
   * (towns, for Connecticut's governor), so its items are built as if the
   * drill-in had already happened. Built from the national state, the
   * counties would sweep in wearing the presidential baseline and then
   * crossfade to the race -- a color change the eye reads as data moving. */
  function as(st, rid, fn) {
    const was = [focus, raceId];
    focus = st; raceId = rid;
    try { return fn(); } finally { [focus, raceId] = was; }
  }

  /* The destination projection is fitted when a transition starts. If the
   * stage changes size during the morph -- the back button appearing rewraps
   * the rail -- the view's resize refits the projection it then holds, which
   * is the old one, and nothing refits the new one after. So it is refitted
   * here, at settle, to the box the stage has now. */
  function refit() {
    const feats = focus ? countiesByState.get(focus) : nationalFrame();
    if (feats && feats.length) fitClear(view.projection, feats);
  }

  /* The fit, clear of what sits over the map's bottom corners -- the legend
   * or the rating bar (left), the control strip (right) -- the user's ask:
   * a state fitted edge to edge had its southwest under the legend and
   * Philadelphia under the strip. Fitted to the whole box first; if that
   * puts land under an overlay, the box is shortened from the bottom and
   * narrowed from either side, a few steps of each, and the biggest fit with
   * no land under an overlay wins (the least covered if none is clear).
   * A fit only scales and shifts the projection, so each try is worked from
   * the first fit's projected points rather than refitted. The boxes are the
   * last frame's; the overlay refits once they settle (see fitWatch). */
  let legendBox = null;               // the canvas legend's box in the last frame, pane px
  let fitSig = null;                  // the pane size and boxes the last fit kept clear of
  const fitSamples = new WeakMap();   // feature list -> up to 4,000 of its vertices
  function overlayBoxes() {
    const out = legendBox ? [legendBox] : [];
    for (const el of [ratingBar, stripBox]) {
      if (!el.hidden && el.offsetWidth) out.push({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    }
    return out.map((b) => ({ x0: b.x - 6, y0: b.y - 6, x1: b.x + b.w + 6, y1: b.y + b.h + 6 }));
  }
  function boxesSig() {
    return [pane.clientWidth, pane.clientHeight,
            ...overlayBoxes().map((b) => [b.x0, b.y0, b.x1, b.y1].map(Math.round).join(","))].join("|");
  }
  function samplesOf(feats) {
    if (fitSamples.has(feats)) return fitSamples.get(feats);
    const all = [];
    const walk = (c) => (typeof c[0] === "number" ? all.push(c) : c.forEach(walk));
    for (const f of feats) if (f.geometry) walk(f.geometry.coordinates);
    const step = Math.max(1, Math.ceil(all.length / 4000));
    const out = all.filter((_, i) => i % step === 0);
    fitSamples.set(feats, out);
    return out;
  }
  function fitClear(proj, feats) {
    const E = view.extentBox();
    fitProjection(proj, feats, E);
    fitSig = boxesSig();
    const boxes = overlayBoxes();
    if (!boxes.length) return proj;
    const [[bx0, by0], [bx1, by1]] = d3.geoPath(proj).bounds({ type: "FeatureCollection", features: feats });
    if (!(bx1 > bx0 && by1 > by0)) return proj;
    const pts = samplesOf(feats).map((ll) => proj(ll)).filter(Boolean);
    const [[ex0, ey0], [ex1, ey1]] = E;
    const midX = (ex0 + ex1) / 2;
    const raise = Math.max(0, ...boxes.map((b) => ey1 - b.y0));
    const left = Math.max(0, ...boxes.filter((b) => b.x0 < midX).map((b) => b.x1 - ex0));
    const right = Math.max(0, ...boxes.filter((b) => b.x1 > midX).map((b) => ex1 - b.x0));
    const cbx = (bx0 + bx1) / 2, cby = (by0 + by1) / 2;
    let best = null;
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 4; j++) {
        for (let m = 0; m <= 4; m++) {
          const x0 = ex0 + left * j / 4, x1 = ex1 - right * m / 4, y1 = ey1 - raise * i / 8;
          if (x1 - x0 < 50 || y1 - ey0 < 50) continue;
          const sc = Math.min((x1 - x0) / (bx1 - bx0), (y1 - ey0) / (by1 - by0));
          const cx = (x0 + x1) / 2, cy = (ey0 + y1) / 2;
          let hits = 0;
          for (const [px, py] of pts) {
            const x = sc * (px - cbx) + cx, y = sc * (py - cby) + cy;
            for (const b of boxes) if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1) { hits += 1; break; }
          }
          if (!best || hits < best.hits || (hits === best.hits && sc > best.sc + 1e-9)) best = { hits, sc, cx, cy };
        }
      }
    }
    if (!best || best.sc === 1 && best.cx === (ex0 + ex1) / 2 && best.cy === (ey0 + ey1) / 2) return proj;
    const k0 = proj.scale(), [tx, ty] = proj.translate();
    proj.scale(k0 * best.sc);
    proj.translate([best.sc * (tx - cbx) + best.cx, best.sc * (ty - cby) + best.cy]);
    return proj;
  }

  /* After a frame: if the overlays or the pane changed since the last fit
   * (the bar appeared, the strip came or went, a resize the view fitted on
   * its own), refit -- but only while the map sits at its fit, never under
   * a zoom or pan someone made, and not mid-morph or under the bins. */
  let fitQueued = false;
  function fitWatch(transform) {
    if (fitQueued || morphing() || bins.on || !geo) return;
    if (transform.k !== 1 || transform.x !== 0 || transform.y !== 0) return;
    if (boxesSig() === fitSig) return;
    fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      const t = view.transform;
      if (morphing() || t.k !== 1 || t.x !== 0 || t.y !== 0 || boxesSig() === fitSig) return;
      refit();
      view.render();
    });
  }

  function focusState(st) {
    binsReset();
    // The frame is fitted to the state's counties, which bound the same
    // ground as its towns and its districts.
    const feats = countiesByState.get(st);
    if (!feats || !feats.length) return;
    const next = raceFor(st);
    const projB = fitClear(stateProjection(st, feats), feats);
    startMorph();
    view.transitionTo({
      projection: projB,
      transform: d3.zoomIdentity,
      // The cartogram's national cells are layout pixels, not ground, so
      // there is nothing to morph between: it crossfades.
      items: cartoNational() ? [] : as(st, next, () => morphItems(st, false)),
      apply: () => {
        focus = st;
        hovered = null;
        pinned = null;
        pressed = null;
        // Nothing else changes the variable: a reader who was looking at
        // swing stays on swing.
        raceId = next;
        refit();
        autoBaseline();
        wantDetail();
        releasePrecincts(st);
        wantPrecincts();               // a small state fits the budget at its full view
        syncPrecinctButton();
        view.setLayers(layers());
        showReadout(null);
        if (onState) onState(api.status());
        settled();
      },
    });
    // Same geography in both panels, always: the right one follows.
    if (split) split.focusState(st);
  }

  function unfocus() {
    binsReset();
    const from = focus;
    if (!from) return;
    // The view's first projection, refitted, rather than a new one: the view
    // caches every county's projected path against its projection, and the
    // same projection at the same fit finds all 3,144 still valid, where a
    // new one would rebuild them in the first frame after the morph.
    const toCarto = as(null, null, cartoNational);
    const projB = toCarto ? fitClear(cartoProj, carto.states) : fitClear(nationalProj, geo.nation);
    startMorph();
    view.transitionTo({
      projection: projB,
      transform: d3.zoomIdentity,
      items: toCarto ? [] : morphItems(from, true),
      apply: () => {
        focus = null;
        raceId = null;
        hovered = null;
        pinned = null;
        pressed = null;
        releasePrecincts();
        refit();
        autoBaseline();
        syncPrecinctButton();
        view.setLayers(layers());
        showReadout(null);
        if (onState) onState(api.status());
        settled();
      },
    });
    if (split) split.unfocus();
  }

  /* ------------------------------------------------------------ labelling */

  /** What this panel shows, in a few words: its race, then its variable. */
  function paneTitle() {
    const v = VARIABLES.find((x) => x.key === variable) || VARIABLES[0];
    const what = districtMode() ? `${mode().label}${focus ? ` · ${focus}` : ""}`
      : focus ? raceLabel(subject()) : mode().label;
    return `${what} · ${v.label}`;
  }

  function drawTitle(ctx, dpr) {
    const T = theme();
    const text = paneTitle();
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = theme().scale || 1;
    ctx.font = FONT(700, 14);
    ctx.textBaseline = "top";
    const w = ctx.measureText(text).width;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = T.paper;
    ctx.fillRect(8 * k, 8 * k, w + 12 * k, 24 * k);
    ctx.globalAlpha = 1;
    ctx.fillStyle = T.ink;
    ctx.fillText(text, 14 * k, 13 * k);
    ctx.restore();
  }

  /* The legend is drawn on the canvas, not in the page: it belongs to the
   * picture, and a screenshot or a split panel has to carry its own key. */
  /* Whether any shape on screen has someone other than a Democrat or a
   * Republican ahead, so the legend keys the independent ramp only when it
   * is drawn. The legend redraws every frame; the answer changes only with
   * what is drawn, so it is cached on the data layer's feature list and the
   * results it was read from. */
  let indMemo = { key: null, feats: null, shown: false };
  function independentShown() {
    if (variable !== "margin" && variable !== "lead") return false;
    const L = view.getLayers().find((x) => x.id === "data");
    const feats = (L && L.features) || [];
    const d = raceId ? store.results(raceId) : null;
    const key = `${subject()}|${variable}|${d ? d.updated : ""}`;
    if (indMemo.feats === feats && indMemo.key === key) return indMemo.shown;
    const atState = stateLevel();
    const shown = feats.some((f) => f.properties.tier !== "state" || atState
      ? leadSide(cellFor(f, atState)) === "ind" : false);
    indMemo = { key, feats, shown };
    return shown;
  }

  function legendSpec() {
    const T = theme();
    const v = VARIABLES.find((x) => x.key === variable) || VARIABLES[0];
    const note = variableNote(variable);
    const title = note ? `${v.label}: ${note.toLowerCase()}` : v.label +
      (variable === "swing" || variable === "turnout" ? ` vs ${store.baselineLabel(baselineKey)}` : "");
    if (variable === "rating" || variable === "vsrating") return ratingLegend(note);
    let stops, ends;
    // A national Senate map is drawn by county, so its lead scale is the
    // county one -- unless no state has units to draw.
    const atState = stateLevel() && !natRaceOf.size;
    switch (variable) {
      case "swing": stops = (t) => diverge((t * 2 - 1) * SWING_CLAMP, SWING_CLAMP);
        ends = [`R+${SWING_CLAMP}`, "0", `D+${SWING_CLAMP}`]; break;
      case "lead": stops = (t) => T.election(t);
        ends = [`R +${d3.format("~s")(atState ? LEAD_CLAMP_STATE : LEAD_CLAMP_UNIT)}`, "0",
                `D +${d3.format("~s")(atState ? LEAD_CLAMP_STATE : LEAD_CLAMP_UNIT)}`]; break;
      case "reporting": stops = (t) => sequential(t, seqHue("reporting"));
        ends = ["0%", "50%", "100%"]; break;
      case "turnout": stops = (t) => sequential(t, seqHue("turnout"));
        ends = ["0%", "60%", `${TURNOUT_CLAMP * 100}%+`]; break;
      default: stops = (t) => diverge((t * 2 - 1) * MARGIN_CLAMP, MARGIN_CLAMP);
        ends = [`R+${MARGIN_CLAMP}`, "0", `D+${MARGIN_CLAMP}`];
    }
    const keys = [];
    // Without a seat list for the cycle, a blank state may be a race that
    // was never harvested, and the key says so rather than claim "no race".
    if (stateLevel()) keys.push([seatListFor(mode()) ? "No race" : "None on file", T.basefill]);
    keys.push(["Awaiting votes", "hatch"]);
    // Before votes the shapes carry the compare-to election (compareCell).
    const live = FIXED_MODES.find((m) => m.districts).cycle;
    if (variable === "swing" && (store.baseline(baselineKey) || store.race(baselineKey)) &&
        (raceId ? raceId.slice(0, 4) : mode().cycle) === live) {
      keys.push([`No votes yet: ${store.baselineLabel(baselineKey)} margin shown`, "text"]);
    }
    const lr = focus && raceOf(raceId);
    if (lr && LEGISLATURE.has(lr.office)) {
      const d = store.results(raceId);
      const up = d ? (d.units || []).length : lr.up ? lr.up.size : Infinity;
      if (!d) keys.push(["Feed waiting", "dots"]);
      if ((TIER_MAPS()[tierOf(focus)].get(focus) || []).length > up) keys.push(["Not up this year", T.basefill]);
    }
    if (districtMode()) {
      const K = districtKinds();
      if (K.waiting) keys.push(["Feed waiting", "dots"]);
      if (K.certOnly) keys.push(["Override only", T.nodata]);
      if (K.noLive) keys.push(["No live feed", lightGrey()]);
      if (K.partial) keys.push(["Partial count", "partial"]);
      if (focus ? redrawn.has(focus) && !newLines(focus) : [...redrawn].some((st) => !newLines(st))) {
        keys.push(["New 2026 lines", "redrawn"]);
      }
    }
    if (stateLevel()) {
      const kinds = new Set(stateFeatures.map((f) => {
        const c = stateCell(f.properties.id);
        return c.waiting ? "waiting" : c.certOnly ? "certOnly" : c.noLive ? "noLive" : c.noFeed ? "noFeed" : null;
      }));
      if (kinds.has("waiting")) keys.push(["Feed waiting", "dots"]);
      if (kinds.has("certOnly")) keys.push(["Override only", T.nodata]);
      if (kinds.has("noLive")) keys.push(["No live feed", lightGrey()]);
      if (kinds.has("noFeed")) keys.push(["No feed", T.nodata]);
    }
    // A stepped theme keys the classes themselves, each break labeled.
    const breaks = breaksFor(variable, atState);
    const fmt = variable === "lead" ? d3.format("~s") : String;
    const P = !note && breaks ? partisanClasses(breaks.length + 1) : null;
    if (!note && independentShown()) {
      keys.push(["Independent ahead", P ? P.ind[Math.floor(P.ind.length / 2)] : T.ind]);
    }
    keys.push(["No data", T.nodata]);
    // Called races solid, the rest muted (callOf): on tonight's maps of
    // whole races -- states, House districts, legislature districts.
    const tonight = (raceId ? raceId.slice(0, 4) : mode().cycle) === live;
    if ((variable === "margin" || variable === "lead") && tonight && seatsSrc() &&
        (stateLevel() || districtMode() || (lr && LEGISLATURE.has(lr.office)))) {
      keys.push([raceFilter === "called" ? "Called races only" : raceFilter === "flips" ? "Called flips only"
        : "Full color: called · muted: not yet called", "text"]);
      if (flipShapes(legendData()).some((f) => flipOf(cellFor(f)))) {
        keys.push(["Flip (called)", "flip"]);
      }
    }
    // The Times's data agreement asks for credit wherever its data shows.
    if (precinctShown) {
      keys.push([`${pres2024() ? "Precincts" : "Precincts: 2024 president"} · The New York Times`, "text"]);
    }
    if (cartoOn()) keys.push(["Cartogram: every district the same size", "text"]);
    if (piecesShown) keys.push(["Districts split by county: AP's count for each piece", "text"]);
    const classes = P
      ? { colors: [...P.rep].reverse().concat([P.tie], P.dem), labels: breaks.map(fmt) } : null;
    return { title, stops: note ? null : stops, classes, ends, keys };
  }

  /* Rating and vs. Rating are categories, keyed swatch by swatch. */
  function ratingLegend(note) {
    const T = theme();
    const leg = raceId ? LEGISLATURE.has((raceOf(raceId) || {}).office) : LEGISLATURE.has(mode().office);
    const src = leg ? "StateNavigate" : "Cook";
    const v = VARIABLES.find((x) => x.key === variable);
    const title = note ? `${v.label}: ${note.toLowerCase()}` : `${v.label} · ${src}`;
    const keys = [];
    if (note) {
      keys.push(["No data", T.nodata]);
    } else if (variable === "rating" && chiclets()) {
      keys.push(["Lean D", ratingShade("dem", 0)], ["Toss-up", tossupColor()], ["Lean R", ratingShade("rep", 0)],
                ["Chiclets: Lean and Toss-up races only", "text"]);
    } else if (variable === "rating") {
      for (const [lab, side, lv] of [["Solid D", "dem", 2], ["Likely D", "dem", 1], ["Lean D", "dem", 0]]) keys.push([lab, ratingShade(side, lv)]);
      keys.push(["Toss-up", tossupColor()]);
      for (const [lab, side, lv] of [["Lean R", "rep", 0], ["Likely R", "rep", 1], ["Solid R", "rep", 2]]) keys.push([lab, ratingShade(side, lv)]);
      keys.push(["Not rated", T.nodata]);
    } else {
      keys.push(["D upset", ratingShade("dem", 2)], ["R upset", ratingShade("rep", 2)],
                ...(leg ? [] : [["Other upset", ratingShade("ind", 2)]]),
                ["Toss-up, D ahead", ratingShade("dem", 1)], ["Toss-up, R ahead", ratingShade("rep", 1)],
                ["As rated, D", ratingShade("dem", 0)], ["As rated, R", ratingShade("rep", 0)],
                ...(chiclets() ? [["Chiclets: Lean and Toss-up races, and upsets", "text"]]
                  : [["Awaiting votes", "hatch"], ["Feed waiting", "dots"], ["No data", T.nodata]]));
    }
    if (stateLevel() && !chiclets()) keys.unshift([seatListFor(mode()) ? "No race" : "None on file", T.basefill]);
    return { title, stops: null, classes: null, ends: null, keys };
  }

  function drawLegend(ctx, dpr, W, H) {
    const T = theme();
    const L = legendSpec();
    const k = theme().scale || 1;
    const w = 188 * k, barH = 8 * k, x = 12 * k, sw = 10 * k;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = FONT(600, 11);
    // How many rows the keys wrap to, the same rule as the drawing below,
    // so the backing box is sized before anything is drawn on it.
    const cw = 26 * k;   // one class swatch, wide enough for a "100k" under it
    // The tie swatch is a sliver: it is a color for one exact value, not a band.
    const tw = 8 * k;
    let rows = 1, rx = x, widest = L.classes ? Math.max(w, (L.classes.colors.length - 1) * cw + tw) : w;
    for (const [label, fill] of L.keys) {
      const kw = (fill === "text" ? 0 : sw + 4 * k) + ctx.measureText(label).width + 10 * k;
      if (rx > x && rx + kw > x + w * 1.6) { rows += 1; rx = x; }
      rx += kw;
      widest = Math.max(widest, rx - x);
    }
    const h = (20 + (L.stops ? 26 : 0) + 16 * rows) * k;
    const y = H - h - 10 * k;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = T.paper;
    ctx.fillRect(x - 6 * k, y - 4 * k, widest + 12 * k, h + 4 * k);
    legendBox = { x: x - 6 * k, y: y - 4 * k, w: widest + 12 * k, h: h + 4 * k };
    ctx.globalAlpha = 1;
    ctx.textBaseline = "top";
    ctx.fillStyle = T.ink;
    ctx.fillText(L.title.length > 34 ? L.title.slice(0, 33) + "…" : L.title, x, y);
    let cy = y + 18 * k;
    if (L.classes) {
      const { colors, labels } = L.classes;
      const n = labels.length;            // breaks a side; n + 1 classes a side
      const left = (i) => x + i * cw + (i > n + 1 ? tw - cw : 0);
      const width = (i) => i === n + 1 ? tw : cw;
      colors.forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.fillRect(left(i), cy, width(i) + 0.5, barH);
      });
      const end = left(colors.length - 1) + cw;
      // White on a light paper needs an edge to be seen as a swatch.
      ctx.strokeStyle = T.baseedge;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, cy + 0.5, end - x - 1, barH - 1);
      ctx.font = FONT(600, 10);
      ctx.fillStyle = T.inkSoft;
      ctx.textAlign = "center";
      // Each break sits on the edge between two swatches, strongest outside;
      // the tie sliver in the middle is labeled 0.
      labels.forEach((t, i) => {
        ctx.fillText(t, left(n - i), cy + barH + 3 * k);
        ctx.fillText(t, left(n + 2 + i) + cw, cy + barH + 3 * k);
      });
      ctx.fillText("0", left(n + 1) + tw / 2, cy + barH + 3 * k);
      ctx.textAlign = "left";
      ctx.fillText("R", x, cy + barH + 3 * k);
      ctx.textAlign = "right";
      ctx.fillText("D", end, cy + barH + 3 * k);
      ctx.textAlign = "left";
      ctx.font = FONT(600, 11);
      cy += barH + 18 * k;
    } else if (L.stops) {
      const n = 48;
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = L.stops(i / (n - 1));
        ctx.fillRect(x + (i * w) / n, cy, w / n + 0.5, barH);
      }
      ctx.fillStyle = T.inkSoft;
      ctx.textAlign = "left";
      ctx.fillText(L.ends[0], x, cy + barH + 3 * k);
      ctx.textAlign = "center";
      ctx.fillText(L.ends[1], x + w / 2, cy + barH + 3 * k);
      ctx.textAlign = "right";
      ctx.fillText(L.ends[2], x + w, cy + barH + 3 * k);
      ctx.textAlign = "left";
      cy += barH + 18 * k;
    }
    let kx = x;
    for (const [label, fill] of L.keys) {
      // Keys wrap to a second row rather than running off under the readout.
      const kw = (fill === "text" ? 0 : sw + 4 * k) + ctx.measureText(label).width + 10 * k;
      if (kx > x && kx + kw > x + w * 1.6) { kx = x; cy += 16 * k; }
      if (fill === "text") {                 // a credit line, no swatch
        ctx.fillStyle = T.inkSoft;
        ctx.fillText(label, kx, cy);
        kx += kw;
        continue;
      }
      if (fill === "flip") {                 // stripes over a party-neutral grey
        ctx.fillStyle = T.inkSoft;
        ctx.fillRect(kx, cy + 1, sw, sw);
        const hp = flipHash();
        if (hp.setTransform) hp.setTransform(new DOMMatrix());
        ctx.fillStyle = hp;
        ctx.fillRect(kx, cy + 1, sw, sw);
        ctx.fillStyle = T.inkSoft;
        ctx.fillText(label, kx + sw + 4 * k, cy);
        kx += sw + 4 * k + ctx.measureText(label).width + 10 * k;
        continue;
      }
      const pat = fill === "hatch" ? hatchFill() : fill === "dots" ? dotFill()
        : fill === "redrawn" ? redrawnFill() : fill === "partial" ? partialFill(T.inkSoft) : null;
      ctx.fillStyle = pat || fill;
      if (pat && pat.setTransform) pat.setTransform(new DOMMatrix());
      ctx.fillRect(kx, cy + 1, sw, sw);
      ctx.strokeStyle = T.baseedge;
      ctx.lineWidth = 1;
      ctx.strokeRect(kx + 0.5, cy + 1.5, sw - 1, sw - 1);
      ctx.fillStyle = T.inkSoft;
      ctx.fillText(label, kx + sw + 4 * k, cy);
      kx += sw + 4 * k + ctx.measureText(label).width + 10 * k;
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- bins */

  /* Seats in bins: every seat of a chamber leaves its place on the map,
   * shrinks to one equal square and flies into one of three stacks --
   * Democrat, Toss-up (or not yet leading), Republican -- with a count
   * under each and the majority marked, so who holds the chamber reads at
   * a glance. The user's ask, for the U.S. House and Senate and
   * Pennsylvania's two chambers. Squares keep the color their place has on
   * the map; seats not on the ballot (65 senators, Pennsylvania's odd
   * Senate districts) sit at the bottom of their party's stack, muted.
   *
   * A 2026 chamber is counted by data/seats.js, the boards' own count
   * (a call, else the leader, else nothing), so the bins and the Boards and
   * Battle tabs agree; under Rating and vs. Rating it is the rating. A past
   * chamber is counted from its results on the map. */
  const bins = { on: false, items: [], spec: null, t0: 0, dur: 0, out: false, move: false, raf: 0,
                 hover: null, layout: null };
  const BIN_ORDER = ["dem", "mid", "rep"];

  function seatsSrc() {
    return seatsIn || (typeof window !== "undefined" && window.wall && window.wall.seats) || null;
  }
  const ratingVar = () => variable === "rating" || variable === "vsrating";

  /** What the bins would show here, or null: { key, title, chamber, cycle, st }. */
  function binsSpec() {
    const r = raceId ? raceOf(raceId) : null;
    const office = r ? r.office : mode().office;
    const cycle = r ? r.race_id.slice(0, 4) : mode().cycle;
    const S = seatsSrc();
    if (office === "house" && !r) {
      if (cycle === "2026" && !S) return null;
      return { key: `house-${cycle}-${focus || "US"}`, chamber: "house", cycle, st: focus,
               title: `${focus ? `${stateName(focus)} · ` : ""}U.S. House ${cycle}` };
    }
    if (office === "senate" && !focus && cycle === "2026" && S) {
      return { key: "senate-2026", chamber: "senate", cycle, st: null, title: "U.S. Senate 2026" };
    }
    if (LEGISLATURE.has(office)) {
      // Nationally, Pennsylvania's chamber; inside a state, that state's
      // (data/seats.js LEG_CHAMBERS: "wv-house").
      const st = focus || (r && r.state) || "PA";
      const word = office === "state-house" ? "House" : "Senate";
      const chamber = `${st.toLowerCase()}-${word.toLowerCase()}`;
      const rid = r ? r.race_id : (primaryRace(st, mode()) || {}).race_id || null;
      if (cycle === "2026" ? !S || !S.rules(chamber) : !rid) return null;
      return { key: `${chamber}-${cycle}`, chamber, cycle, st, rid,
               title: `${stateName(st)} ${word} ${cycle}` };
    }
    return null;
  }

  /** A Senate seat's own cell: the state's race, or its special. */
  function senateCell(seat) {
    const c = stateCell(seat.state);
    const race = store.race(seat.raceId);
    if (!race || cellRaceId(c) === seat.raceId) return c;
    const data = store.results(seat.raceId);
    const cell = { kind: "state", st: seat.state, race, data, subj: race.race_id };
    if (!data) { cell.awaiting = true; return cell; }
    cell.votes = statewideVotes(data);
    cell.totals = store.partyTotals(cell.votes, race);
    cell.reporting = store.reportingPct(data.statewide, data);
    cell.basis = store.reportingBasis(data.statewide, data);
    return cell;
  }

  /** Which stack a cell goes to by its rating: { bin, rank } (rank 0 sits lowest). */
  function ratingBin(c) {
    const R = ratingOf(c);
    if (!R) return { bin: "mid", rank: 9, how: "Not rated" };
    const p = R.parsed.party;
    return { bin: p === "dem" || p === "rep" ? p : "mid",
             rank: { Solid: 0, Likely: 1, Lean: 2 }[R.parsed.strength] ?? 3, how: R.label };
  }

  /** By who won or leads, from the cell's own count. */
  function resultBin(c) {
    const v = c ? cellValue(c, "margin") : null;
    // Unopposed (Florida's 20th, Oklahoma's 3rd in 2024): won, with no count.
    if (c && (c.unopposed === "dem" || c.unopposed === "rep")) {
      return { bin: c.unopposed, rank: 0, how: "Unopposed" };
    }
    if (v == null) return { bin: "mid", rank: 9, how: "No result" };
    const t = topOf(c);
    const p = t && t.leader && t.leader.party;
    return { bin: p === "dem" || p === "rep" ? p : "mid", rank: 100 - Math.min(99, Math.abs(v)),
             how: marginLabel(v, t) };
  }

  /** The chamber's seats as squares-to-be: { id, f, fill, bin, rank, muted, html, sort }. */
  /* The squares take each seat's own color. Under the Chiclets style a
   * shape's map fill is plain land (the chiclet carries the rating), and the
   * bins came out grey; so while they read fills, chiclets are off. */
  function binSeats(spec) {
    binsFilling = true;
    let items;
    try { items = binSeatsFrom(spec); } finally { binsFilling = false; }
    // A seat called before it has a vote (unopposed: scripts/call_unopposed.py)
    // is its party's, not a waiting pattern, once it is in the party's bin.
    for (const it of items) {
      if (/^Called/.test(it.how || "") && typeof it.fill !== "string" && (it.bin === "dem" || it.bin === "rep")) {
        it.fill = partyColor(it.bin);
      }
    }
    return items;
  }

  function binSeatsFrom(spec) {
    const T = theme();
    const fillOf = (x) => (x == null ? T.nodata : x);
    const out = [];
    const S = seatsSrc();
    const live = spec.cycle === "2026";
    // Under a rating or before a count, the rating; once a count is on, the boards' count.
    const fromSeat = (s, c) => {
      if (ratingVar()) return ratingBin(c);
      if (s.status === "called" || s.status === "leading") {
        const p = s.party === "dem" || s.party === "rep" ? s.party : "mid";
        return { bin: p, rank: s.status === "called" ? 0 : 1,
                 how: `${s.status === "called" ? "Called" : "Leading"}${p === "mid" ? ": other" : ""}` };
      }
      return { bin: "mid", rank: 9, how: "No leader yet" };
    };
    if (spec.chamber === "house") {
      if (live) {
        for (const s of S.seats("house")) {
          if (spec.st && s.state !== spec.st) continue;
          const c = districtCell(s.label);
          out.push({ id: s.label, key: s.label, st: s.state, fill: fillOf(cellFill(c, false)), ...fromSeat(s, c) });
        }
      } else {
        const feats = spec.st ? unitsIn(spec.st) : (cartoNational() ? carto.cd2024 : geo.cds);
        for (const f of feats) {
          const c = cellFor(f, false);
          out.push({ id: f.properties.id, key: f.properties.id, st: f.properties.state,
                     fill: fillOf(cellFill(c, false)), ...resultBin(c) });
        }
      }
    } else if (spec.chamber === "senate") {
      for (const s of S.seats("senate")) {
        const c = senateCell(s);
        out.push({ id: s.id, key: s.state, st: s.state, fill: fillOf(cellFill(c, true)), ...fromSeat(s, c),
                   special: s.special });
      }
      const h = S.holdovers && S.holdovers.senate;
      for (const x of (h && h.holdovers) || []) {
        const p = x.party === "dem" || x.party === "rep" ? x.party
          : x.caucus === "dem" || x.caucus === "rep" ? x.caucus : "other";
        out.push({ id: `hold-${x.state}-${x.class}`, st: x.state, bin: p === "other" ? "mid" : p, rank: -1,
                   muted: true, fill: partyColor(p === "other" ? "ind" : p),
                   html: `<h2>${esc(stateName(x.state))}</h2><p class="hint">${esc(x.senator)} (${esc(x.party === "dem" ? "D" : x.party === "rep" ? "R" : "I")})` +
                     ` is not up this year: next election ${esc(x.next_election)}.</p>` });
      }
    } else {
      const st = spec.st, rid = spec.rid;
      if (live) {
        // Each seat from its own race: West Virginia's unexpired terms
        // (2026-statesenate-wv-unexpired) share a district with the regular
        // seat, so a district can be two squares.
        for (const s of S.seats(spec.chamber)) {
          const [c, fill] = as(st, s.raceId || rid, () => { const x = unitCell(s.unitId); return [x, cellFill(x, false)]; });
          out.push({ id: s.id || s.unitId, key: s.unitId, st, fill: fillOf(fill), ...fromSeat(s, c) });
        }
        const n = S.tally(spec.chamber).notUp;
        for (const p of ["dem", "rep"]) {
          for (let i = 0; i < (n[p] || 0); i++) {
            out.push({ id: `hold-${p}-${i}`, st, bin: p, rank: -1, muted: true, fill: partyColor(p),
                       html: `<h2>${esc(spec.title)}</h2><p class="hint">A ${p === "dem" ? "Democratic" : "Republican"} seat not up this year (elected in 2024).</p>` });
          }
        }
      } else if (rid) {
        as(st, rid, () => {
          for (const f of unitsIn(st)) {
            const c = unitCell(f.properties.id);
            if (c.notUp) continue;
            out.push({ id: f.properties.id, key: f.properties.id, st,
                       fill: fillOf(cellFill(c, false)), ...resultBin(c) });
          }
        });
      }
    }
    return out;
  }

  /** The majority mark per stack, or null where only part of the chamber is drawn. */
  function binsMajority(spec, items) {
    if (spec.st && spec.chamber === "house") return null;
    const S = seatsSrc();
    if (spec.cycle === "2026" && S) {
      const r = S.rules(spec.chamber);
      return r && r.need ? { dem: r.need.dem, rep: r.need.rep, seats: r.seats, tiebreak: r.tiebreak } : null;
    }
    const seats = { house: 435, "pa-house": 203, "wv-house": 100 }[spec.chamber];
    if (!seats || items.length !== seats) return null;
    const m = Math.floor(seats / 2) + 1;
    return { dem: m, rep: m, seats };
  }

  /** What the pane's own menus take at its top (Shapes, Races) and bottom
   *  (the control bar's box, Seats) edges, so the bins stay clear of them. */
  function binsInsets() {
    const top = [corner, calledBtn].reduce((m, el) => (el.offsetHeight ? Math.max(m, el.offsetTop + el.offsetHeight) : m), 0);
    return { top, bottom: stripBox.hidden ? 0 : pane.clientHeight - stripBox.offsetTop };
  }

  /** Square size and columns for three stacks in the pane, from the biggest stack. */
  function binsLayout(W, H, items, maj) {
    const n = { dem: 0, mid: 0, rep: 0 };
    for (const it of items) n[it.bin] += 1;
    const k = theme().scale || 1;
    const ins = binsInsets();
    const x0 = 24, x1 = W - 24, y0 = ins.top + 104 * Math.min(k, 1.5), yb = H - 64 * k - ins.bottom;
    const gap = Math.max(24, (x1 - x0) * 0.05);
    const cw = (x1 - x0 - 2 * gap) / 3;
    const big = Math.max(n.dem, n.mid, n.rep, maj ? Math.max(maj.dem, maj.rep) : 0, 1);
    let best = { s: 0, per: 1 };
    for (let c = 1; c <= big; c++) {
      const s = Math.min(cw / c, (yb - y0) / Math.ceil(big / c), 28 * k);
      if (s > best.s) best = { s, per: c };
    }
    const cols = {};
    BIN_ORDER.forEach((b, i) => {
      const left = x0 + i * (cw + gap);
      cols[b] = { left, w: cw, x: left + (cw - best.per * best.s) / 2 };
    });
    return { ...best, yb, cols, n, W, H, ins };
  }

  /** Each item's square in its stack: lowest rank at the bottom. */
  function placeBins(items, L) {
    const by = { dem: [], mid: [], rep: [] };
    for (const it of items) by[it.bin].push(it);
    for (const b of BIN_ORDER) {
      by[b].sort((a, z) => a.rank - z.rank || String(a.st).localeCompare(String(z.st)) ||
                           String(a.id).localeCompare(String(z.id)));
      by[b].forEach((it, i) => {
        const col = L.cols[b];
        // Democrats fill from the center outward (right to left), Republicans
        // from the center too, so the two majorities face each other.
        const c = i % L.per, r = Math.floor(i / L.per);
        const cc = b === "dem" ? L.per - 1 - c : c;
        it.tx = col.x + cc * L.s;
        it.ty = L.yb - (r + 1) * L.s;
        it.ts = L.s;
      });
    }
  }

  /** Where a seat starts and ends on the map: the square of its shape's own size. */
  function mapSquares(items) {
    const path = d3.geoPath(view.projection);
    const t = view.transform;
    const L = view.getLayers().find((x) => x.id === "data");
    const byId = new Map();
    for (const f of (L && L.features) || []) byId.set(String(f.properties.id), f);
    const states = new Map(natStates().map((f) => [f.properties.id, f]));
    if (focus) for (const f of focusOutline(focus)) states.set(focus, f);
    for (const it of items) {
      const f = (it.key && byId.get(String(it.key))) || (it.st && !it.muted && states.get(it.st)) || null;
      it.f = it.muted ? null : f;
      if (!f) { it.fx = it.tx; it.fy = it.ty; it.fs = 0; continue; }
      const [cx, cy] = path.centroid(f);
      const side = Math.max(3, Math.min(48, Math.sqrt(Math.max(0, path.area(f))) * t.k));
      // A state that sends two (a special) starts both from its middle.
      it.fs = it.special ? side * 0.7 : side;
      it.fx = t.applyX(cx) - it.fs / 2 + (it.special ? it.fs * 0.3 : 0);
      it.fy = t.applyY(cy) - it.fs / 2;
    }
  }

  const easeIO = (q) => (q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2);

  /** Run the flight: out = back to the map. Each square starts in turn, west to east. */
  function flyBins(out) {
    cancelAnimationFrame(bins.raf);
    bins.out = out;
    bins.move = false;
    bins.dur = 1700;
    bins.t0 = performance.now();
    const order = [...bins.items].filter((it) => !it.muted)
      .sort((a, z) => (a.fx - z.fx) || (a.fy - z.fy));
    order.forEach((it, i) => { it.delay = order.length > 1 ? 0.4 * i / (order.length - 1) : 0; });
    for (const it of bins.items) if (it.muted) it.delay = out ? 0.5 : 0.05;
    const tick = () => {
      view.render();
      if (performance.now() - bins.t0 < bins.dur) { bins.raf = requestAnimationFrame(tick); return; }
      bins.raf = 0;
      if (bins.out) {
        bins.on = false;
        bins.items = [];
        bins.hover = null;
      }
      syncBinsButton();
      view.render();
      showReadout(hovered || pinned);
    };
    bins.raf = requestAnimationFrame(tick);
  }

  function binsOpen() {
    const spec = binsSpec();
    if (!spec) return;
    hovered = null;
    pressed = null;
    bins.spec = spec;
    bins.items = binSeats(spec);
    bins.maj = binsMajority(spec, bins.items);
    bins.layout = binsLayout(canvas.clientWidth, canvas.clientHeight, bins.items, bins.maj);
    placeBins(bins.items, bins.layout);
    mapSquares(bins.items);
    bins.on = true;
    view.setLayers(layers());
    flyBins(false);
    syncBinsButton();
    showReadout(null);
  }

  function binsClose() {
    if (!bins.on || bins.out) return;
    mapSquares(bins.items);    // the map may have moved under them
    flyBins(true);
  }

  /** Off at once: a state entered or left, or a view with no bins. */
  function binsReset() {
    if (!bins.on) return;
    cancelAnimationFrame(bins.raf);
    bins.raf = 0;
    bins.on = false;
    bins.items = [];
    bins.hover = null;
    syncBinsButton();
  }

  /** New numbers, or a new variable, while the bins are up: the squares
   *  that change stacks move there; a new chamber comes in from the map. */
  function binsUpdate() {
    if (!bins.on || bins.out) return;
    const spec = binsSpec();
    if (!spec) { binsReset(); return; }
    const was = new Map(bins.items.map((it) => [it.id, it]));
    const same = bins.spec && bins.spec.key === spec.key;
    bins.spec = spec;
    const items = binSeats(spec);
    bins.maj = binsMajority(spec, items);
    bins.layout = binsLayout(canvas.clientWidth, canvas.clientHeight, items, bins.maj);
    placeBins(items, bins.layout);
    mapSquares(items);
    if (same) {
      let moved = false;
      for (const it of items) {
        const o = was.get(it.id);
        if (!o) continue;
        const q = binProgress(o);
        [it.fx, it.fy, it.fs] = [o.x ?? lerp(o.fx, o.tx, q), o.y ?? lerp(o.fy, o.ty, q), o.s ?? lerp(o.fs, o.ts, q)];
        if (it.fx !== it.tx || it.fy !== it.ty || it.fs !== it.ts) moved = true;
      }
      bins.items = items;
      if (!moved) { view.render(); return; }
      bins.out = false;
      bins.move = true;
      bins.dur = 900;
      bins.t0 = performance.now();
      for (const it of items) it.delay = 0;
      cancelAnimationFrame(bins.raf);
      const tick = () => {
        view.render();
        if (performance.now() - bins.t0 < bins.dur) bins.raf = requestAnimationFrame(tick);
        else { bins.raf = 0; view.render(); }
      };
      bins.raf = requestAnimationFrame(tick);
      return;
    }
    bins.items = items;
    flyBins(false);
  }

  const lerp = (a, b, q) => a + (b - a) * q;
  const FLY = 0.55;
  function binsP() {
    return bins.dur ? Math.min(1, (performance.now() - bins.t0) / bins.dur) : 1;
  }
  /** How far along its own flight an item is, 0 on the map to 1 in its stack. */
  function binProgress(it) {
    const q = easeIO(Math.max(0, Math.min(1, (binsP() - it.delay) / FLY)));
    return bins.out ? 1 - q : q;
  }
  /** How much of the map is covered: 1 with the bins up. */
  function binsCover() {
    if (!bins.on) return 0;
    const p = binsP();
    if (bins.move) return 1;
    return bins.out ? 1 - Math.max(0, Math.min(1, (p - 0.6) / 0.35)) : Math.min(1, p / 0.35);
  }

  function drawBins(ctx, dpr, W, H) {
    const T = theme();
    const k = T.scale || 1;
    // A pane resized under the bins (a split, the rail rewrapping): the
    // stacks are laid out again for it, and the squares go to their new places.
    // Or the menus over it changed size (Seats alone once the count leaves).
    const ins = binsInsets();
    if (bins.layout.W !== W || bins.layout.H !== H || bins.layout.ins.top !== ins.top ||
        bins.layout.ins.bottom !== ins.bottom) {
      bins.layout = binsLayout(W, H, bins.items, bins.maj);
      placeBins(bins.items, bins.layout);
    }
    const L = bins.layout;
    const cover = binsCover();
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = cover;
    ctx.fillStyle = T.paper;
    ctx.fillRect(0, 0, W, H);
    const landed = { dem: 0, mid: 0, rep: 0 };
    // The squares fade with the map's return on the way back.
    const fade = bins.out ? Math.min(1, cover / 0.6) : 1;
    for (const it of bins.items) {
      const q = binProgress(it);
      it.x = lerp(it.fx, it.tx, q);
      it.y = lerp(it.fy, it.ty, q);
      it.s = lerp(it.fs, it.ts, q);
      if (q >= 0.999) landed[it.bin] += 1;
      if (it.s < 0.5) continue;
      const pad = Math.max(0.5, it.s * 0.1);
      // A seat not up is its party's color mixed halfway to a mid grey: at
      // 38% opacity it went to navy and maroon on a dark screen.
      ctx.globalAlpha = fade;
      ctx.fillStyle = it.muted ? d3.interpolateLab(it.fill, d3.interpolateRgb(T.paper, T.ink)(0.62))(0.5) : it.fill;
      ctx.fillRect(it.x + pad / 2, it.y + pad / 2, it.s - pad, it.s - pad);
    }
    ctx.globalAlpha = cover;
    if (bins.hover) {
      const it = bins.hover;
      ctx.strokeStyle = T.ink;
      ctx.lineWidth = 2;
      ctx.strokeRect(it.x, it.y, it.s, it.s);
    }
    // The majority: a rule across a party's stack at the seat that makes it.
    const maj = bins.maj;
    ctx.font = FONT(600, 12);
    ctx.textBaseline = "bottom";
    if (maj) {
      for (const p of ["dem", "rep"]) {
        const need = maj[p];
        if (!need) continue;
        const col = L.cols[p];
        const y = L.yb - Math.ceil(need / L.per) * L.s;
        ctx.strokeStyle = T.ink;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(col.left, y);
        ctx.lineTo(col.left + col.w, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = T.ink;
        ctx.textAlign = p === "dem" ? "left" : "right";
        const vp = maj.tiebreak && maj.tiebreak.party === p ? " with the VP" : "";
        ctx.fillText(`${need} for majority${vp}`, p === "dem" ? col.left : col.left + col.w, y - 3);
      }
    }
    // Counts under each stack, counting up as the squares land.
    const names = { dem: "Democrats", rep: "Republicans", mid: midName() };
    const color = { dem: T.dem, rep: T.rep, mid: ratingVar() ? tossupColor() : T.inkSoft };
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const b of BIN_ORDER) {
      const col = L.cols[b];
      const cx = col.left + col.w / 2;
      ctx.fillStyle = color[b];
      ctx.font = FONT(800, 30);
      ctx.fillText(String(bins.out || bins.move ? L.n[b] : landed[b]), cx, L.yb + 6 * k);
      ctx.fillStyle = T.ink;
      ctx.font = FONT(600, 13);
      ctx.fillText(names[b], cx, L.yb + 40 * k);
    }
    ctx.textAlign = "left";
    ctx.font = FONT(700, 15);
    ctx.fillStyle = T.ink;
    ctx.fillText(bins.spec.title, 24, L.ins.top + 16);
    ctx.font = FONT(400, 12);
    ctx.fillStyle = T.inkSoft;
    ctx.fillText(binsBasis(), 24, L.ins.top + 38 * Math.min(k, 1.5));
    ctx.restore();
  }

  /** The middle stack's name: what its seats have in common. */
  function midName() {
    if (ratingVar()) {
      return bins.items.some((it) => it.bin === "mid" && it.how === "Not rated") ? "Toss-up or not rated" : "Toss-up";
    }
    return bins.spec.cycle === "2026" ? "No leader yet" : "Other or no result";
  }

  /** One line on what put each seat in its stack. */
  function binsBasis() {
    const S = bins.spec;
    const muted = bins.items.filter((it) => it.muted).length;
    const notUp = muted ? ` · ${muted} not up this year, muted at the bottom` : "";
    if (ratingVar()) return `By rating${notUp}`;
    if (S.cycle === "2026") return `Called, else leading (the Boards' count)${notUp}`;
    const size = { "pa-senate": 50, "wv-senate": 34 }[S.chamber];
    const left = size ? ` · ${size - bins.items.length} not up in ${S.cycle}` : "";
    return `By result${left}`;
  }

  function binsHTML() {
    const it = bins.hover;
    if (it) return it.html || (it.f ? readoutHTML(it.f) : "");
    const L = bins.layout, n = L.n;
    const muted = { dem: 0, mid: 0, rep: 0 };
    for (const x of bins.items) if (x.muted) muted[x.bin] += 1;
    const row = (b, name) => `<tr><td style="padding:2px 0">${name}</td><td style="text-align:right;font-weight:700">${n[b]}</td>` +
      `<td style="text-align:right;color:var(--ink-soft);padding-left:8px">${muted[b] ? `${muted[b]} not up` : ""}</td></tr>`;
    const maj = bins.maj;
    return `<h2>${esc(bins.spec.title)}</h2><p class="hint" style="margin:-6px 0 10px">${esc(binsBasis())}</p>` +
      `<table class="cands" style="width:100%;border-collapse:collapse;margin:0 0 10px;font-variant-numeric:tabular-nums">` +
      row("dem", "Democrats") + row("mid", midName()) +
      row("rep", "Republicans") + `</table>` +
      (maj ? `<p class="hint">Majority: ${maj.dem === maj.rep ? maj.dem : `${maj.dem} for Democrats, ${maj.rep} for Republicans (the vice president breaks ties)`} of ${maj.seats}.</p>` : "") +
      `<p class="hint">Point at a square for its seat. Pick Seats: Map to put them back on the map.</p>`;
  }

  canvas.addEventListener("pointermove", (ev) => {
    if (!bins.on || bins.out) return;
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const it = bins.items.find((s) => s.s && x >= s.x && x < s.x + s.s && y >= s.y && y < s.y + s.s) || null;
    if (it === bins.hover) return;
    bins.hover = it;
    view.render();
    showReadout(null);
  });

  let stateLabelBoxes = [];         // this frame's state labels, for chiclets to avoid
  let numberBoxes = [];             // this frame's district numbers, for city names to avoid

  /* ------------------------------------------------------------- places */

  function adoptPlaces(d) {
    const ix = Object.fromEntries((d.fields || []).map((k, i) => [k, i]));
    const byState = new Map(), byDistrict = new Map();
    for (const r of d.places || []) {
      const p = { name: r[ix.name], st: r[ix.st], ll: [r[ix.lon], r[ix.lat]], pop: r[ix.pop] };
      (byState.get(p.st) || byState.set(p.st, []).get(p.st)).push(p);
      for (const k of ["cd24", "cd26", "sldl", "sldu"]) {
        const id = r[ix[k]];
        if (id) (byDistrict.get(`${k}:${id}`) || byDistrict.set(`${k}:${id}`, []).get(`${k}:${id}`)).push(p);
      }
    }
    places = { byState, byDistrict, source: d.source };
  }

  /** A district's largest places, as a reader would name it: "Pittsburgh,
   *  Bethel Park and North Huntingdon". Real geography, so the same on the
   *  cartogram's cell as on the district's lines. */
  function placeLine(f) {
    if (!places || !f) return "";
    const p = f.properties;
    const key = p.tier === "cd" ? (Number(p.vintage) === 2026 ? "cd26" : "cd24")
      : p.tier === "district" ? "sldl" : p.tier === "senate-district" ? "sldu" : null;
    const list = key && places.byDistrict.get(`${key}:${p.id}`);
    if (!list || !list.length) return "";
    const n = list.slice(0, 3).map((x) => x.name);
    return n.length === 1 ? n[0] : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
  }

  /* City and town names inside a state, the user's ask: biggest first, each
   * a dot and a name, as many as fit without touching each other, the
   * district numbers or the edge. Zooming in makes room for smaller towns.
   * Not on the cartogram: its cells are not where the towns are, so a town
   * would sit in the wrong district. */
  function drawCities(ctx, dpr, W, H, transform, obstacles) {
    if (!places || cartoOn()) return;
    const list = places.byState.get(focus);
    if (!list) return;
    const T = theme();
    const k = theme().scale || 1;
    const big = FONT(600, 12 * k), small = FONT(400, 11 * k);
    const numbers = obstacles.map((L) => [L.x - L.hw, L.y - L.hh, L.x + L.hw, L.y + L.hh]);
    // The legend's corner and the buttons over the map stay clear.
    const boxes = [[0, H - 150 * k, 240 * k, H]];
    const pr = pane.getBoundingClientRect();
    for (const el of pane.children) {
      if (el === canvas || el === tip || el.hidden || !el.offsetWidth) continue;
      const r = el.getBoundingClientRect();
      boxes.push([r.left - pr.left - 4, r.top - pr.top - 4, r.right - pr.left + 4, r.bottom - pr.top + 4]);
    }
    // The docked card covers its corner.
    if (tip.dataset.mode === "dock") {
      const r = tip.getBoundingClientRect();
      boxes.push([r.left - pr.left - 4, r.top - pr.top - 4, r.right - pr.left + 4, r.bottom - pr.top + 4]);
    }
    const overlaps = (b, list) => list.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
    let hit = (b) => overlaps(b, boxes) || overlaps(b, numbers);
    // A dozen or so names at the size of the state, a few more zoomed in:
    // a map of towns, not a gazetteer.
    const cap = Math.round(Math.min(30, 8 + (W * H) / 50000) * Math.min(Math.sqrt(transform.k), 1.8));
    const pad = 6;
    const out = [];
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const [i, c] of list.entries()) {
      if (out.length >= cap) break;
      // The state's biggest city is always named, over a district number if
      // need be: Philadelphia sits among four of them.
      hit = i === 0 ? (b) => overlaps(b, boxes) : (b) => overlaps(b, boxes) || overlaps(b, numbers);
      const pt = view.projection(c.ll);
      if (!pt) continue;
      const x = transform.applyX(pt[0]), y = transform.applyY(pt[1]);
      if (x < 8 || y < 8 || x > W - 8 || y > H - 8) continue;
      const font = c.pop >= 100000 ? big : small;
      ctx.font = font;
      const w = ctx.measureText(c.name).width, h = 7 * k;
      const dot = [x - 3, y - 3, x + 3, y + 3];
      if (hit(dot)) continue;
      // Right of the dot, else left, above or below it.
      const spots = {
        right: [x + 4, y - h, x + 7 * k + w, y + h], left: [x - 7 * k - w, y - h, x - 4, y + h],
        above: [x - w / 2 - 2, y - 4 - 2 * h, x + w / 2 + 2, y - 4], below: [x - w / 2 - 2, y + 4, x + w / 2 + 2, y + 4 + 2 * h],
      };
      const side = Object.keys(spots).find((sd) => {
        const b = spots[sd];
        return !hit(b) && b[0] > 4 && b[2] < W - 4 && b[1] > 4 && b[3] < H - 4;
      });
      if (!side) continue;
      const b = spots[side];
      boxes.push(dot, [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]);
      out.push({ c, x, y, w, h, side, font });
    }
    ctx.lineJoin = "round";
    ctx.textBaseline = "middle";
    for (const L of out) {
      ctx.beginPath();
      ctx.arc(L.x, L.y, 2.2 * k, 0, 2 * Math.PI);
      ctx.fillStyle = T.ink;
      ctx.strokeStyle = T.paper;
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.font = L.font;
      ctx.textAlign = L.side === "right" ? "left" : L.side === "left" ? "right" : "center";
      const tx = L.side === "right" ? L.x + 5 * k : L.side === "left" ? L.x - 5 * k : L.x;
      const ty = L.side === "above" ? L.y - 4 - L.h : L.side === "below" ? L.y + 4 + L.h : L.y;
      ctx.lineWidth = 3.5;
      ctx.strokeText(L.c.name, tx, ty);
      ctx.fillStyle = T.ink;
      ctx.fillText(L.c.name, tx, ty);
    }
    ctx.restore();
  }
  view.on("overlay", ({ ctx, dpr, W, H, transform }) => {
    if (!geo) return;
    const T = theme();
    if (!focus) {
      const items = [];
      // On the cartogram the cells are the data, so a state's label sits
      // beside it, in the gap (cartoLabelSpots), not on it -- the user's call.
      const spots = cartoNational() ? cartoLabelSpots(ctx, transform.k) : null;
      for (const f of natStates()) {
        if (stateLevel() && stateCell(f.properties.id).noRace) continue;   // no contest, no label
        let pt = spots && spots.get(f);
        if (!pt) {
          const ll = anchorOf(f);
          pt = ll && view.projection(ll);
        }
        if (!pt) continue;
        items.push({ text: f.properties.id, x: transform.applyX(pt[0]),
                     y: transform.applyY(pt[1]) });
      }
      const labels = layoutLabels(ctx, items, { x: 0, y: 0, w: W, h: H }, FONT(600, 12));
      stateLabelBoxes = labels;
      // A state with no contest in a statewide mode has no label (above).
      drawLabels(ctx, labels, dpr, FONT(600, 12), T.ink, T.paper);
    } else if (!precinctShown && (mode().office === "house" || LEGISLATURE.has(mode().office))) {
      // Inside a state each district carries its number, the user's call:
      // the House and the legislatures, on their lines or on the cartogram.
      const items = [];
      for (const f of unitsIn(focus) || []) {
        const m = DISTRICT_TIERS.has(f.properties.tier) && /-S?0*(\d+|AL)$/.exec(f.properties.id || "");
        if (!m || (soloCd && f.properties.id !== soloCd)) continue;
        const ll = anchorOf(f);
        const pt = ll && view.projection(ll);
        if (!pt) continue;
        const x = transform.applyX(pt[0]), y = transform.applyY(pt[1]);
        // A district zoomed off the screen has no number, rather than one
        // pinned to the edge.
        if (x < 0 || y < 0 || x > W || y > H) continue;
        items.push({ text: m[1], x, y });
      }
      numberBoxes = layoutLabels(ctx, items, { x: 0, y: 0, w: W, h: H }, FONT(600, 11));
      drawLabels(ctx, numberBoxes, dpr, FONT(600, 11), T.ink, T.paper);
    }
    if (focus && binsCover() < 0.5) drawCities(ctx, dpr, W, H, transform, numberBoxes);
    numberBoxes = [];
    if (chiclets()) drawChiclets(ctx, dpr, W, H, transform, focus ? [] : stateLabelBoxes);
    if (bins.on) drawBins(ctx, dpr, W, H);
    syncRatingBar();
    legendBox = null;
    if (legendOn && binsCover() < 0.5 && ratingBar.hidden) drawLegend(ctx, dpr, W, H);
    if (titleOn) drawTitle(ctx, dpr);
    fitWatch(transform);
  });

  /* Where each state's label goes on the cartogram: just outside its box,
   * above first, then beside, below and at the corners, then the same a
   * label's height further out; the first spot whose label box touches no
   * state wins. A state boxed in on every side keeps its label inside, on
   * its own anchor. Worked in projected pixels (the label's size divided by
   * the zoom), and kept until the projection or the zoom changes. */
  let cartoSpots = null;
  function cartoLabelSpots(ctx, k) {
    const p = view.projection;
    const key = `${p.scale()} ${p.translate()} ${k}`;
    if (cartoSpots && cartoSpots.key === key) return cartoSpots.spots;
    const path = d3.geoPath(p);
    const shapes = carto.states.map((f) => new Path2D(path(f) || ""));
    const spots = new Map();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);   // isPointInPath tests in the path's own space
    ctx.font = FONT(600, 12);
    for (const f of carto.states) {
      const [[x0, y0], [x1, y1]] = path.bounds(f);
      const w = (ctx.measureText(f.properties.id).width / 2 + 3) / k, h = 8 / k;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const clear = ([x, y]) => {
        for (const [a, b] of [[x, y], [x - w, y - h], [x, y - h], [x + w, y - h], [x + w, y],
                              [x + w, y + h], [x, y + h], [x - w, y + h], [x - w, y]]) {
          for (const sh of shapes) if (ctx.isPointInPath(sh, a, b)) return false;
        }
        return true;
      };
      let spot = null;
      for (const g of [2 / k, 2 / k + 2 * h]) {
        const up = y0 - g - h, down = y1 + g + h, left = x0 - g - w, right = x1 + g + w;
        spot = [[cx, up], [right, cy], [left, cy], [cx, down],
                [right, up], [left, up], [right, down], [left, down]].find(clear);
        if (spot) break;
      }
      if (spot) spots.set(f, spot);
    }
    ctx.restore();
    cartoSpots = { key, spots };
    return spots;
  }

  /* ------------------------------------------------------------ chiclets */

  const anchors = new WeakMap();      // feature -> [lon, lat] inside it
  function anchorOf(f) {
    if (!anchors.has(f)) anchors.set(f, innerPoint(f));
    return anchors.get(f);
  }

  /** The races in play on this map: { f, color, text }. A district race (the
   *  House, a legislature) has one per district; a statewide race one per
   *  state, under its label. */
  function chicletItems() {
    const out = [];
    const add = (f, c, text) => {
      const R = ratingOf(c);
      if (!R || !ratingPicked(c)) return;
      const inPlay = R.parsed.strength === "Lean" || R.parsed.strength === "Toss-up";
      let color = null;
      if (variable === "vsrating") {
        const v = versus(c);
        if (v && v.kind) {
          if (!inPlay && v.kind !== "upset") return;
          color = versusFill(v);
        }
      }
      if (!inPlay && !color) return;
      if (!color) color = R.parsed.party ? ratingShade(R.parsed.party, 0) : tossupColor();
      out.push({ f, color, text });
    };
    const r = raceOf(raceId);
    const leg = r ? LEGISLATURE.has(r.office) : LEGISLATURE.has(mode().office);
    const L = view.getLayers().find((x) => x.id === "data");
    const feats = (L && L.features) || [];
    const num = (id) => { const m = /-S?0*(\d+|AL)$/.exec(String(id)); return m ? m[1] : ""; };
    if (districtMode() || leg) {
      for (const f of feats) {
        const t = f.properties.tier;
        if (t === "state" || t === "precinct") continue;
        add(f, cellFor(f), focus ? num(f.properties.id) : "");
      }
    } else {
      for (const f of stateFeatures) {
        if (focus && f.properties.id !== focus) continue;
        add(f, stateCell(f.properties.id), "");
      }
    }
    return out;
  }

  const CHIC = 17, CHIC_R = 5, CHIC_GAP = 2.5;   // px at type scale 1
  function drawChiclets(ctx, dpr, W, H, transform, fixed) {
    const T = theme();
    const k = T.scale || 1;
    const items = [];
    const statewide = !districtMode() && !LEGISLATURE.has(((raceOf(raceId) || {}).office) || mode().office);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = FONT(700, 11);
    for (const it of chicletItems()) {
      const ll = anchorOf(it.f);
      const pt = ll && view.projection(ll);
      if (!pt) continue;
      const x = transform.applyX(pt[0]), y = transform.applyY(pt[1]) + (statewide && !focus ? 14 * k : 0);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      // 17 px squares with 5 px corners, as on the user's redrawn-districts
      // explorer (jonathancervas.com/maps/redrawn-districts-2026/), where the
      // old 14 x 10 read as specks. A numbered one widens to fit its number.
      const hw = Math.max(CHIC / 2, it.text ? ctx.measureText(it.text).width / 2 + 4 : 0) * k;
      items.push({ ...it, x, y, ax: x, ay: y, hw: hw + CHIC_GAP / 2 * k, hh: (CHIC + CHIC_GAP) / 2 * k });
    }
    relaxLabels(items, { x: 0, y: 0, w: W, h: H }, fixed || [], 40);
    // A connector where a square was pushed clear of its own district, so it
    // never reads as sitting somewhere it does not.
    ctx.strokeStyle = T.baseedge;
    ctx.lineWidth = 1;
    for (const c of items) {
      if (Math.hypot(c.x - c.ax, c.y - c.ay) < CHIC * 0.8 * k) continue;
      ctx.beginPath(); ctx.moveTo(c.ax, c.ay); ctx.lineTo(c.x, c.y); ctx.stroke();
    }
    for (const c of items) {
      const w = c.hw - CHIC_GAP / 2 * k, h = CHIC / 2 * k;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(c.x - w, c.y - h, w * 2, h * 2, CHIC_R * k);
      else ctx.rect(c.x - w, c.y - h, w * 2, h * 2);
      ctx.fillStyle = c.color;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = T.baseedge;
      ctx.stroke();
      if (c.text) {
        ctx.fillStyle = d3.lab(c.color).l > 62 ? "#111" : "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(c.text, c.x, c.y + 0.5);
      }
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------- pointers */

  /* At national zoom the pointer is on a state, whatever the map draws: a
   * county or district is a few pixels there, and clicking goes into the
   * state, where its units can be pointed at one by one. */
  function stateUnder(f) {
    if (focus || !f || f.properties.tier === "state") return f;
    const st = f.properties.state || stateOf(f.properties.id);
    return natStates().find((x) => x.properties.id === st) || f;
  }

  /** A district with no election this year is drawn, but not a target: no
   *  outline, no readout of its own, no click. */
  function inert(f) {
    if (!focus || !f || f.properties.tier === "precinct") return false;
    const r = raceOf(raceId);
    return !!(r && LEGISLATURE.has(r.office) && unitCell(f.properties.id).notUp);
  }

  view.on("hover", (f) => {
    if (bins.on) return;          // the squares have their own pointer, see bins
    f = stateUnder(f);
    if (inert(f)) f = null;
    if (f === hovered) return;
    hovered = f;
    canvas.style.cursor = f && !focus ? "pointer" : "";
    view.setLayers(layers());
    view.render();
    // A split panel's pointer is the left panel's pointer: one readout, one
    // place, outlined in both.
    if (link) { link.hover(f ? f.properties.id : null); return; }
    if (split) split.highlight(f ? f.properties.id : null);
    // Leaving the map falls back to what was tapped, so a touch screen --
    // which has no hover -- keeps the unit it last pointed at.
    showReadout(f || pinned);
  });

  /** The drawn feature with this id, if this panel's layer has one. A town
   *  panel beside a county panel shares no ids, and that is fine. */
  function featureById(id) {
    if (id == null) return null;
    const L = view.getLayers().find((x) => x.id === "data");
    const f = ((L && L.features) || []).find((x) => x.properties.id === id);
    if (f || focus) return f || null;
    // At national zoom the pointer is on a state (stateUnder), whether this
    // panel draws states, counties or districts.
    const st = /^[A-Z]{2}$/.test(id) ? id : stateOf(id);
    return natStates().find((x) => x.properties.id === st) || null;
  }

  function highlight(id) {
    hovered = featureById(id);
    view.setLayers(layers());
    view.render();
  }

  view.on("click", (f, ev) => {
    if (bins.on) return;
    // A tap during a drill-in or -out morph picks from the layers being left
    // -- tap a state just after Back and it lands in the old state's empty
    // surround and is lost, so the second tap is the one that works. Hold it
    // and pick again where it landed once the map has settled.
    if (morphing() && ev) {
      pendingTap = { x: ev.clientX, y: ev.clientY };
      return;
    }
    if (link) { link.click(f); return; }
    clickOn(f);
  });

  // The morph runs 760 ms and its cross-fade 200; past 1.5 s it was
  // cancelled (a zoom, a new morph) without settling, and is not waited on.
  function morphing() {
    return moving && performance.now() - moving < 1500;
  }

  function startMorph() {
    moving = performance.now();
    pendingTap = null;
  }

  function settled() {
    moving = 0;
    const tap = pendingTap;
    pendingTap = null;
    if (!tap) return;
    setTimeout(() => {
      const f = view.featureAt(tap.x, tap.y);
      if (link) link.click(f);
      else clickOn(f);
    }, 0);
  }

  canvas.addEventListener("pointerdown", (ev) => {
    if (bins.on) return;
    if ((ev.pointerType === "mouse" && ev.button !== 0) || !ev.isPrimary || morphing()) return;
    const f = view.featureAt(ev.clientX, ev.clientY);
    pressed = f && !inert(f) ? stateUnder(f) : null;
    view.setLayers(layers());
    view.render();
  });
  const unpress = () => {
    if (!pressed) return;
    pressed = null;
    // On a tap that drills in, the morph has taken the canvas; the layers
    // are rebuilt when it settles.
    if (!morphing()) { view.setLayers(layers()); view.render(); }
  };
  for (const t of ["pointerup", "pointercancel", "pointerleave"]) canvas.addEventListener(t, unpress);

  function clickOn(f) {
    if (!focus) {
      if (f && f.properties.state) focusState(f.properties.state);
      return;
    }
    // A seat with no election this year sits inside the state: a click on
    // it is neither a district nor the way out.
    if (inert(f)) return;
    // Inside a state, the background is the way out -- once the view is back
    // at the whole state; zoomed in, it first returns to the whole state.
    if (!f) {
      if (view.transform.k > 1.05) view.animateTo(d3.zoomIdentity);
      else unfocus();
      return;
    }
    // A tap on a district pins it in the readout and zooms to it:
    // Philadelphia's House districts are a few pixels each at the size of the
    // state. A county only pins -- a presenter reads county after county
    // without the map jumping -- and a second tap on it zooms.
    const again = tierWord(f.properties.tier) === "district" ||
      (pinned && String(pinned.properties.id) === String(f.properties.id));
    // From the right panel the feature is that panel's; pin this panel's
    // feature with the same id, and read the place out by id either way.
    pinned = featureById(f.properties.id);
    showReadout(pinned, f.properties.id);
    if (split) split.highlight(f.properties.id);
    if (again && pinned) view.zoomToFeatures([pinned], { margin: 0.6, maxScale: 60 });
  }

  view.on("zoom", (t) => {
    // The county hairlines appear only once zoomed enough to tell them apart,
    // so the layer list changes with the transform.
    const was = precinctShown;
    const wasPieces = piecesShown;
    const wasWhole = natWhole;
    natWhole = !focus && stateLevel() && view.transform.k < STATE_UNITS_K;
    wantPrecincts();
    view.setLayers(layers());
    // Counties give way to precincts (and back) at PRECINCT_BUDGET, and a
    // statewide map's whole states to their counties at STATE_UNITS_K.
    if (was !== precinctShown || wasWhole !== natWhole || wasPieces !== piecesShown) view.render();
    syncPrecinctButton();
    // Pan and zoom are shared: the panels are one map shown twice. Both are
    // fitted to the same features in panes of the same size, so a transform
    // means the same place in both.
    if (syncing) return;
    if (link) link.zoom(t);
    else if (split) split.followZoom(t);
  });

  function followZoom(t) {
    syncing = true;
    try { view.setZoomTransform(t); } finally { syncing = false; }
  }

  /* ----------------------------------------------------------------- boot */

  /* Compare to: the most recent other election that can be compared, until
   * someone picks one. President 2024 compared with itself left Swing and
   * Turnout greyed out until 2020 was chosen by hand; House 2026 compared
   * with a county file left them greyed out too. A choice made by hand
   * stands, unless it is the very thing on the map. */
  function autoBaseline() {
    const own = raceId || (stateLevel() || districtMode() ? modeKey : subject());
    if (!baselineAuto && baselineKey !== own) return;
    const year = (k) => Number((/(\d{4})/.exec(k) || [])[1] || 0);
    // Never a later election, nor one with no votes yet: Pennsylvania's
    // 2024 president beside its staged 2026 governor compares with zeros.
    const counted = (k) => !store.race(k) || store.totalVotes(store.partyTotals(
      statewideVotes(store.results(k) || {}), store.race(k))) > 0;
    // A state's presidential file and the national one are one election.
    const r = raceOf(own);
    const same = (k) => k === own || (r && r.office === "president" && k === `pres-${year(own)}`);
    // A chamber compares with an election of the same seats: Pennsylvania's
    // 2026 Senate (the even districts) with 2022, not 2024's odd half.
    const seatsOf = (k) => {
      const d = store.results(k), x = raceOf(k);
      return new Set(d ? (d.units || []).map((u) => String(u.id)) : x && x.up ? x.up : []);
    };
    const mine = r && LEGISLATURE.has(r.office) ? seatsOf(own) : null;
    const overlaps = (k) => !mine || [...seatsOf(k)].some((id) => mine.has(id));
    const pick = baselineOptions().filter((o) => o.ok && !same(o.key) && overlaps(o.key) &&
        (!year(own) || year(o.key) <= year(own)) && counted(o.key))
      // Same year: the presidential file, the one every state has.
      .sort((a, b) => year(b.key) - year(a.key) || /^pres-/.test(b.key) - /^pres-/.test(a.key))[0];
    if (pick) baselineKey = pick.key;
  }

  function changed() {
    kindsMemo = null;
    cds2026 = null;
    autoBaseline();
    wantPrecincts();
    if (!reproject()) {
      view.setLayers(layers());
      view.render();
    }
    syncPrecinctButton();              // after layers(): it reads whether precincts are drawn
    binsUpdate();
    syncStrip();
    showReadout(hovered || pinned);
    if (onState) onState(api.status());
  }

  /* At national zoom the House on the cartogram has a projection of its own
   * (cartoProj); everything else has the Albers composite. A change of mode
   * or shapes that crosses between them crossfades to the other, refitted. */
  function reproject() {
    if (focus || !geo || morphing()) return false;
    const want = cartoNational() ? cartoProj : nationalProj;
    if (view.projection === want) return false;
    const projB = fitClear(want, nationalFrame());
    view.transitionTo({ projection: projB, transform: d3.zoomIdentity, items: [],
                        apply: () => view.setLayers(layers()) });
    return true;
  }

  const api = {
    view,
    async load({ base = "." } = {}) {
      bundle = await loadBundle(base);
      api.adopt(bundle);
      return api;
    },
    /** Take geometry already loaded by another map app. */
    adopt(b) {
      bundle = b;
      if (!pollFirst) loadPollClose(b.base);
      const { counties, towns, basemap, districts, congress, congress26, house, holdovers } = b;
      ballots = new Map(Object.entries((b.candidates && b.candidates.races) || {}));
      pending = new Map();
      for (const r of (b.expected && b.expected.races) || []) {
        if (!LEGISLATURE.has(r.office)) continue;
        pending.set(r.race_id, { race_id: r.race_id, office: r.office, state: r.state, special: false,
                                 unit_tier: r.unit_tier || "district", candidates: [], pending: true,
                                 feed: r.feed, up: r.districts ? new Set(r.districts) : null });
      }
      expected = new Map();
      for (const r of (b.expected && b.expected.races) || []) {
        const k = `${String(r.race_id).slice(0, 4)} ${r.office} ${r.state}`;
        if (!expected.has(k)) expected.set(k, []);
        expected.get(k).push(r);
      }
      seatsUp = new Map();
      for (const s of (holdovers && holdovers.up) || []) {
        if (s.office && s.state) seatsUp.set(`${holdovers.cycle || "2026"} ${s.office} ${s.state}`, s);
      }
      redrawn = new Set(((holdovers && holdovers.house && holdovers.house.redrawn_for_2026) || {}).states || []);
      cds2026 = null;
      if (house && !store.baseline("house-2024")) store.setBaseline("house-2024", house);
      const name = Object.keys(counties).find((k) => k !== "__topo");
      geo = { counties: counties[name], towns: towns.towns, nation: basemap.nation,
              cds: congress.districts || [], cds26: (congress26 && congress26.districts) || [] };
      const group = (feats) => {
        const m = new Map();
        for (const f of feats) {
          const st = f.properties.state;
          if (!m.has(st)) m.set(st, []);
          m.get(st).push(f);
        }
        return m;
      };
      districtsByState = group(districts.districts || []);
      senatesByState = group((b.senates && b.senates.districts) || []);
      townsByState = group(geo.towns);
      cdsByState = group(geo.cds);
      cds26ByState = group(geo.cds26);
      // State outlines dissolved from the counties, not taken from the
      // basemap: the basemap's states carry no identity, and two files from
      // different Census releases do not agree on a shared border.
      const outlines = dissolveBy(counties, name, "state");
      stateFeatures = Object.values(outlines);
      countiesByState = group(geo.counties);
      geo.countyIndex = indexBy(geo.counties);
      unitIndex = new Map([...indexBy(geo.towns), ...indexBy(districts.districts || []),
                           ...indexBy((b.senates && b.senates.districts) || []),
                           ...indexBy(geo.cds), ...geo.countyIndex]);
      if (b.carto) {
        b.carto.then((c) => {
          if (!c || bundle !== b) return;
          // Its states are states to the pointer and the readout (stateUnder).
          for (const f of c.nat.states || []) f.properties.tier = "state";
          carto = { states: c.nat.states || [], cd2024: c.nat.cd2024 || [], cd2026: c.nat.cd2026 || [],
                    cd: group(c.cd.districts || []), cd26: group(c.cd26.districts || []),
                    house: group(c.house.districts || []), senate: group(c.senate.districts || []) };
          changed();
        });
      }
      if (b.places) {
        b.places.then((d) => {
          if (!d || bundle !== b) return;
          adoptPlaces(d);
          view.render();
          showReadout(hovered || pinned);
        });
      }
      autoBaseline();
      view.setLayers(layers());
      /* The first frame is drawn after load() returns, not inside it. In
       * the default mode (President 2024) it builds every one of 3,144
       * county shapes, about a second, and the shell switches to House 2026
       * the moment load() returns, so that frame was thrown away -- and the
       * shell waited on it before fetching a single result (November 6).
       * A render from the shell meanwhile fits and draws on its own (the
       * view refits whenever its box or features are new). */
      setTimeout(() => {
        if (bundle !== b) return;
        view.resize();
        showReadout(hovered || pinned);
      }, 0);
      return api;
    },
    refresh,
    focusState,
    unfocus,
    /** Color variable: one of VARIABLES' keys. */
    setVariable(v) {
      if (!VARIABLES.some((x) => x.key === v)) return;
      variable = v;
      changed();
    },
    /** National race mode: one of status().raceModes' keys. Inside a state
     *  the state's race follows it, as a click from the national map would. */
    setRaceMode(key) {
      if (!raceModes().some((m) => m.key === key)) return;
      modeKey = key;
      hovered = null;
      pinned = null;
      if (focus) raceId = raceFor(focus);
      changed();
    },
    // The shell's name for it.
    setNationalRace(key) { api.setRaceMode(key); },
    /** The national race mode's key, for presets. */
    nationalRace() { return modeKey; },
    setRace(id) {
      raceId = id || null;
      pinned = null;
      // The tier can change with the race -- a Massachusetts presidential
      // file draws towns where the baseline drew counties -- so the layer
      // list is rebuilt, not just recolored.
      changed();
    },
    setBaseline(key) {
      baselineKey = key;
      baselineAuto = false;
      // Swing may have just become available or impossible, and the shell
      // owns that control.
      changed();
    },
    /** Shapes for the House and the legislatures: "cartogram", "lines" (the
     *  race's own lines) or "lines2024" (House 2026 on the 2024 lines). */
    setShapes(v) {
      if (!["cartogram", "lines", "lines2024"].includes(v)) return;
      shapes = v;
      try { localStorage.setItem("mw.shapes", shapes); } catch (_) { /* private window */ }
      changed();
    },
    shapes() { return shapesNow(); },
    /** Seats in bins (true) or on the map (false), where the view has a chamber. */
    setTip(on) {
      tipOn = !!on;
      try { localStorage.setItem("mw.tip", tipOn ? "on" : "off"); } catch (_) { /* private window */ }
      updateTip();
      if (split) split.setTip(on);
    },
    tip() { return tipOn; },
    setBins(on) { if (on) { if (!bins.on || bins.out) binsOpen(); } else binsClose(); },
    bins() { return bins.on && !bins.out; },
    /** The boards' seat count (data/seats.js), for the bins. Optional: the
     *  shell's own is found at window.wall.seats without it. */
    useSeats(s) { seatsIn = s; changed(); },
    /** The canvas legend, on by default; a preset may want a clean map. */
    setLegend(on) { legendOn = !!on; view.render(); if (split) split.setLegend(on); },

    /* ---------------------------------------------------- split screen */

    /**
     * Split screen (DESIGN.md §2.1): a second map beside this one, same
     * geography, its own race mode, race, variable and baseline. On is
     * `setSplit(true)` or `setSplit({ raceMode, variable })`; off is
     * `setSplit(false)`. Focus, pan, zoom and the pointer are shared; the
     * readout shows this panel's reading with the right panel's under it.
     * The right panel's controls are the same methods on `app.pane("right")`.
     */
    setSplit(on) {
      if (!on) {
        if (!split) return;
        split.destroy();
        split = null;
        titleOn = false;
        pane.style.right = "0";
        pane.style.bottom = "0";
        view.render();
        showReadout(hovered || pinned);
        if (onState) onState(api.status());
        return;
      }
      if (!bundle) return;
      const opts = typeof on === "object" ? on : {};
      if (!split) {
        const c2 = document.createElement("canvas");
        c2.style.cssText = "position:absolute;inset:0;display:block;touch-action:none";
        pane.parentNode.appendChild(c2);
        const notify = () => { showReadout(hovered || pinned); if (onState) onState(api.status()); };
        split = createMapApp({
          stage, canvas: c2, readout: null, store, onState: notify,
          link: {
            hover: (id) => { highlight(id); showReadout(hovered || pinned, id ?? undefined); },
            click: (f) => clickOn(f),
            zoom: (t) => followZoom(t),
          },
        });
        titleOn = true;
        layoutSplit();
        split.adopt(bundle);
        split.setLegend(legendOn);
        // The right panel picks its own comparison unless one was chosen here.
        if (!baselineAuto) split.setBaseline(baselineKey);
        // Two races is the usual question, so the right panel opens on a
        // different one: 2024 president beside anything else, Senate 2024
        // beside the president.
        split.setRaceMode(modeKey === "pres-2024" ? "senate-2024" : "pres-2024");
        split.setVariable(variable);
        if (focus) split.focusState(focus);
      }
      if (opts.raceMode) split.setRaceMode(opts.raceMode);
      if (opts.variable) split.setVariable(opts.variable);
      if (opts.baseline) split.setBaseline(opts.baseline);
      view.render();
      showReadout(hovered || pinned);
      if (onState) onState(api.status());
    },
    /** "left" is this app, "right" the split panel (or null when unsplit). */
    pane(which) { return which === "right" ? split : api; },
    get split() { return split; },
    /** Removes a split panel's DOM; its owner calls it. */
    destroy() {
      view.cancelAnimations();
      pane.remove();
    },
    highlight,
    followZoom,
    paneTitle,
    /** This panel's readout for a unit id, for the other panel's readout. */
    readoutFor(id) {
      return readoutHTML(featureById(id))
        .replace(/<h2>/g, '<h3 style="margin:0 0 8px;font-size:16px">')
        .replace(/<\/h2>/g, "</h3>");
    },
    status() {
      const m = mode();
      return {
        focus, raceId, variable, baselineKey,
        raceMode: m.key,
        raceModeLabel: m.label,
        raceModes: raceModes().map((x) => ({
          key: x.key, label: x.label, office: x.office, cycle: x.cycle,
          statewide: x.statewide, districts: !!x.districts, states: x.states, reporting: x.reporting,
          noFeed: x.noFeed, total: x.total, staged: x.staged, waiting: x.waiting,
          noLive: x.noLive, summary: x.summary })),
        variables: VARIABLES.map((x) => ({
          key: x.key, label: x.label,
          available: variableAvailable(x.key), title: variableNote(x.key) })),
        // House 2026 draws each district's own race, not house-2024, which
        // it borrows only for its shapes.
        subject: districtMode() ? null : subject(),
        districts: districtMode(),
        tier: focus ? tierOf(focus) : stateLevel() ? "state" : (store.baselineTier(drawKey()) || "county"),
        swingAvailable: variableAvailable("swing"),
        baselineLabel: store.baselineLabel(baselineKey),
        baselineOptions: baselineOptions(),
        units: focus ? unitsIn(focus) : [],
        races: focus ? store.racesIn(focus).filter((r) => store.hasResults(r.race_id))
          .concat([...pending.values()].filter((r) => r.state === focus && !store.hasResults(r.race_id))) : [],
        legend: legendOn,
        title: paneTitle(),
        split: split ? { on: true, ...pick(split.status()) } : { on: false },
      };
    },
  };

  /* What this race can be compared against: every loaded baseline file, plus
   * every other loaded race in the same state. Tier mismatches are offered
   * but marked, because "no county baseline for a town" is worth seeing
   * rather than silently omitting. At national zoom in a statewide mode any
   * baseline file will do: it is summed to states. */
  function baselineOptions() {
    const subj = subject();
    // A pending legislature race has no file yet, so its tier is its own.
    const tier = store.baselineTier(subj) || (raceOf(subj) && raceOf(subj).unit_tier) || "county";
    const atState = stateLevel();
    const out = store.baselineKeys().map((k) => ({
      key: k, label: store.baselineLabel(k), ok: atState || store.baselineTier(k) === tier,
    }));
    if (focus) {
      for (const r of store.racesIn(focus)) {
        if (r.race_id === raceId || !store.hasResults(r.race_id)) continue;
        out.push({ key: r.race_id, label: store.baselineLabel(r.race_id),
                   ok: (r.unit_tier || "county") === tier });
      }
    }
    return out;
  }

  /* Side by side when the stage is wider than tall, stacked when it is not:
   * a portrait wall or a phone gets two maps it can still read. */
  function layoutSplit() {
    if (!split) return;
    const r = stage.getBoundingClientRect();
    const across = r.width >= r.height;
    pane.style.right = across ? "50%" : "0";
    pane.style.bottom = across ? "0" : "50%";
    const p2 = split.paneEl;
    p2.style.left = across ? "50%" : "0";
    p2.style.top = across ? "0" : "50%";
    p2.style.borderLeft = across ? "1px solid var(--rule)" : "0";
    p2.style.borderTop = across ? "0" : "1px solid var(--rule)";
  }
  if (!link && window.ResizeObserver) new ResizeObserver(() => layoutSplit()).observe(stage);

  api.paneEl = pane;
  return api;
}

/** What the shell needs of the right panel's status, without its unit list. */
function pick(st) {
  const { focus, raceId, variable, baselineKey, raceMode, raceModeLabel, variables,
          subject, tier, baselineOptions, races, title } = st;
  return { focus, raceId, variable, baselineKey, raceMode, raceModeLabel, variables,
           subject, tier, baselineOptions, races, title };
}
