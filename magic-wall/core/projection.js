/* One projection per view, and a sensible one per state.
 *
 * Extracted from jcervas.github.io/maps/redrawn-districts-2026
 * (nationalProjection, STATE_PROJ, stateProjection), then extended: the
 * explorer needed nine states and a national wall needs fifty, so a state
 * with no hand-tuned entry gets a conic derived from its own bounds instead
 * of falling back to the national composite.
 */

/* geoAlbersUsa, not a plain geoAlbers: its composite insets Alaska and Hawaii
 * at the lower left. With a single conic they project thousands of miles off
 * canvas, and a US map without them reads as broken. geoAlbersUsa takes no
 * rotate, center or parallels -- the composite fixes its own. */
export function nationalProjection() {
  return d3.geoAlbersUsa();
}

/* Parameters of each state's own official statewide CRS. Conformal (Lambert)
 * where the state's State Plane zones are conformal, equal-area (Albers)
 * where the published statewide CRS is -- CA 3310, FL 3086 and TX 3083 are
 * all Albers. One national Albers across states from Utah to Florida shears
 * every one of them; a State Plane zone is the cartographic answer, but d3
 * carries no EPSG database, so the parameters are written out. */
export const STATE_PROJ = {
  AL: { type: "lcc",    lon0: -86.8,   lat0: 32.5,   parallels: [30.5, 34.5] },
  // EPSG:3338, Alaska Albers (daily-district's EPSG_STATE). Derived from its
  // bounds Alaska centered on 21°E: the Aleutians cross the antimeridian.
  AK: { type: "albers", lon0: -154.0,  lat0: 50.0,   parallels: [55.0, 65.0] },
  CA: { type: "albers", lon0: -120.0,  lat0: 0.0,    parallels: [34.0, 40.5] },
  FL: { type: "albers", lon0: -84.0,   lat0: 24.0,   parallels: [24.0, 31.5] },
  LA: { type: "lcc",    lon0: -91.33,  lat0: 30.5,   parallels: [29.3, 31.2] },
  NC: { type: "lcc",    lon0: -79.0,   lat0: 33.75,  parallels: [34.333, 36.167] },
  OH: { type: "lcc",    lon0: -82.5,   lat0: 39.667, parallels: [38.733, 41.7] },
  TN: { type: "lcc",    lon0: -86.0,   lat0: 34.333, parallels: [35.25, 36.417] },
  TX: { type: "albers", lon0: -100.0,  lat0: 18.0,   parallels: [27.5, 35.0] },
  UT: { type: "lcc",    lon0: -111.5,  lat0: 38.333, parallels: [38.0, 41.0] },
};

function conic(cfg) {
  const proj = cfg.type === "albers" ? d3.geoAlbers() : d3.geoConicConformal();
  return proj.rotate([-cfg.lon0, 0]).center([0, cfg.lat0]).parallels(cfg.parallels);
}

/* Derived from the state's own extent, by the rule cartographers use when
 * there is no published zone to copy: standard parallels at one sixth and
 * five sixths of the latitude span, central meridian through the middle. For
 * a single state that is within a hair of its State Plane zone, and it is a
 * great deal better than the national composite, which shears everything
 * that is not Kansas. */
export function derivedProjection(features) {
  const fc = { type: "FeatureCollection", features };
  const [[x0, y0], [x1, y1]] = d3.geoBounds(fc);
  const span = y1 - y0;
  // Bounds that cross the antimeridian come back west > east (172°E to
  // 130°W); their middle is half the way round from the plain average.
  const mid = x0 <= x1 ? (x0 + x1) / 2 : ((x0 + x1 + 360) / 2 + 180) % 360 - 180;
  return d3.geoConicConformal()
    .rotate([-mid, 0])
    .center([0, y0 + span / 2])
    .parallels([y0 + span / 6, y1 - span / 6]);
}

/**
 * A projection for one state. `features` are that state's shapes, used only
 * when there is no hand-tuned entry -- Alaska and Hawaii included, where a
 * derived conic beats the composite once they are the only thing on screen.
 */
export function stateProjection(st, features) {
  if (STATE_PROJ[st]) return conic(STATE_PROJ[st]);
  if (features && features.length) return derivedProjection(features);
  return nationalProjection();
}

/** Fit a projection to features inside a padded box, and hand it back. */
export function fitProjection(proj, features, extent) {
  proj.fitExtent(extent, { type: "FeatureCollection", features });
  return proj;
}
