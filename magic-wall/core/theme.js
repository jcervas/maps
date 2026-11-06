/* Palette, read off :root once and cached.
 *
 * Canvas cannot use CSS custom properties, so the tokens are read from the
 * document and cached here. Without this the map would need its own
 * hard-coded colors and would stop matching the page the moment the theme
 * changed -- which, in the explorer this is extracted from, is how the
 * district strokes ended up invisible in dark mode.
 *
 * Extracted from jcervas.github.io/maps/redrawn-districts-2026 (theme()).
 */

const TOKENS = [
  "paper", "panel", "ink", "ink-soft", "rule", "accent", "accent-soft",
  "dem", "rep", "water", "nodata", "basefill", "baseline", "baseedge",
  "good", "warn", "bad", "ind", "stateline",
];
// Optional tokens: unset means "the map's own choice", not grey.
const OPTIONAL = new Set(["stateline"]);

let cache = null;
const listeners = [];

function cssVar(cs, name, fallback) {
  const v = (cs.getPropertyValue("--" + name) || "").trim();
  return v || fallback;
}

export function theme() {
  if (cache) return cache;
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const t of TOKENS) {
    // ink-soft becomes inkSoft: CSS wants hyphens, JS does not.
    const key = t.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    out[key] = cssVar(cs, t, OPTIONAL.has(t) ? "" : "#888888");
  }
  const stops = [];
  for (let i = 0; i < 7; i++) stops.push(cssVar(cs, "ramp" + i, "#888888"));
  out.stops = stops;
  // A diverging red-to-blue ramp as a function of 0..1, so a margin can be
  // colored without the caller knowing how many stops there are. With
  // --ramp-steps set (wall.css sets it for every theme) it is equal-width
  // classes rather than a blend; the odd middle class is white, the tossups.
  const steps = cssVar(cs, "ramp-steps", "").split(",").map((c) => c.trim()).filter(Boolean);
  if (steps.length >= 2) {
    out.election = d3.scaleQuantize().domain([0, 1]).range(steps);
    out.stepped = steps.length;
    out.classes = steps;     // R+ strongest .. even .. D+ strongest
  } else {
    out.election = d3.interpolateRgbBasis(stops);
    out.stepped = 0;
    out.classes = null;
  }
  // An independent's steps, lightest to strongest (wall.css --ind-steps).
  out.indSteps = cssVar(cs, "ind-steps", "").split(",").map((c) => c.trim()).filter(Boolean);
  // The broadcast type scale (1, 1.5, 2), for anything drawn on a canvas in
  // screen pixels -- labels, leader lines -- that CSS cannot reach.
  out.scale = parseFloat(cssVar(cs, "s", "1")) || 1;
  cache = out;
  return cache;
}

/** The water color at partial opacity -- hairlines between dense shapes. */
export function waterAlpha(a) {
  const c = d3.color(theme().water);
  if (!c) return `rgba(255,255,255,${a})`;
  c.opacity = a;
  return String(c);
}

/** Light, dark or studio, however it was arrived at: attribute wins, else
 * the OS. Studio is never the OS's choice -- it is a mode for a camera. */
export function themeKey() {
  const set = document.documentElement.getAttribute("data-theme");
  if (set === "dark" || set === "light" || set === "studio") return set;
  return window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function onThemeChange(fn) {
  listeners.push(fn);
}

function invalidate() {
  cache = null;
  for (const fn of listeners) fn();
}

if (window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  if (mq.addEventListener) mq.addEventListener("change", invalidate);
  else if (mq.addListener) mq.addListener(invalidate);
}

/** The type scale: 1 on a laptop, 1.5 or 2 on a wall seen from across a room. */
export function setScale(s) {
  const v = [1, 1.5, 2].includes(Number(s)) ? Number(s) : 1;
  document.documentElement.style.setProperty("--s", String(v));
  document.documentElement.setAttribute("data-scale", String(v));
  invalidate();
  return v;
}

/** Switch the document theme and tell everyone who cares. */
export function setTheme(next) {
  if (next) document.documentElement.setAttribute("data-theme", next);
  else document.documentElement.removeAttribute("data-theme");
  invalidate();
}
