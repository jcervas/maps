/* Ring arithmetic, and the pole of inaccessibility.
 *
 * Extracted verbatim in substance from
 * jcervas.github.io/maps/redrawn-districts-2026 (ringsOfPoly, ringArea,
 * inRing, edgeDist, innerPoint, ringsOf).
 *
 * `innerPoint` is the useful one: the point inside a shape furthest from any
 * edge, which is where a label or a leader line should start. A centroid is
 * not that point -- for Maryland or Florida it lands in water or in another
 * state.
 */

/** Polygon rings as [outer, ...holes][], flattening MultiPolygon. */
export function ringsOfPoly(geom) {
  const c = geom && geom.coordinates;
  if (!c) return [];
  if (geom.type === "Polygon") return [c];
  if (geom.type === "MultiPolygon") return c;
  return [];
}

/** Every ring, flat -- for morphing, where holes and parts are all just paths. */
export function ringsOf(geom) {
  const out = [];
  if (!geom) return out;
  const c = geom.coordinates;
  if (geom.type === "Polygon") {
    for (const ring of c) out.push(ring);
  } else if (geom.type === "MultiPolygon") {
    for (const poly of c) for (const ring of poly) out.push(ring);
  }
  return out;
}

export function ringArea(r) {
  let a = 0;
  for (let i = 0, m = r.length - 1; i < m; i++) {
    a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  }
  return Math.abs(a / 2);
}

export function inRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function edgeDist(x, y, r) {
  let best = Infinity;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const ax = r[j][0], ay = r[j][1];
    const dx = r[i][0] - ax, dy = r[i][1] - ay;
    let t = (dx || dy) ? ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy) : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx - x, py = ay + t * dy - y;
    const d = px * px + py * py;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/* Cached on the feature, because this costs a few hundred point-in-polygon
 * tests and the answer never changes. Four rounds of a coarsening grid search
 * over the largest ring: 12 divisions, then 4, each time narrowing the span
 * by three. */
export function innerPoint(f) {
  if (f.__pole !== undefined) return f.__pole;
  const polys = ringsOfPoly(f.geometry);
  let big = null, bigA = -1;
  for (const poly of polys) {
    const a = ringArea(poly[0]);
    if (a > bigA) { bigA = a; big = poly; }
  }
  if (!big) return (f.__pole = null);

  const outer = big[0], holes = big.slice(1);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of outer) {
    if (q[0] < x0) x0 = q[0];
    if (q[0] > x1) x1 = q[0];
    if (q[1] < y0) y0 = q[1];
    if (q[1] > y1) y1 = q[1];
  }

  const score = (x, y) => {
    if (!inRing(x, y, outer)) return -1;
    for (const h of holes) if (inRing(x, y, h)) return -1;
    let d = edgeDist(x, y, outer);
    for (const h of holes) {
      const dh = edgeDist(x, y, h);
      if (dh < d) d = dh;
    }
    return d;
  };

  let bx = (x0 + x1) / 2, by = (y0 + y1) / 2, bs = score(bx, by);
  let spanX = (x1 - x0) / 2, spanY = (y1 - y0) / 2;
  for (let round = 0; round < 4; round++) {
    const n = round ? 4 : 12, cx = bx, cy = by;
    let found = false, fx = 0, fy = 0;
    for (let ix = -n; ix <= n; ix++) {
      for (let iy = -n; iy <= n; iy++) {
        const x = cx + spanX * ix / n, y = cy + spanY * iy / n;
        const sc = score(x, y);
        if (sc > bs) { bs = sc; fx = x; fy = y; found = true; }
      }
    }
    if (found) { bx = fx; by = fy; }
    spanX /= 3; spanY /= 3;
  }
  // A shape too thin for any sample to land inside falls back to the
  // spherical centroid, which is at least deterministic.
  f.__pole = bs > 0 ? [bx, by] : d3.geoCentroid(f);
  return f.__pole;
}
