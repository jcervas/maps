/* Packed cartogram of the United States.
 *
 * Every state keeps its exact outline. Only its SIZE and its POSITION change:
 * each state is scaled about its own centroid so that its area is proportional
 * to the value being mapped, and then the whole set is packed by a physics pass
 * that treats each state as a rigid body and refuses to let any two overlap.
 *
 * ---------------------------------------------------------------- the method
 *
 * The packing works on circles, not polygons. Each state's outline is resampled
 * at a uniform arc length s, and a circle of radius s/2 sits at every sample.
 * Two facts follow, and between them they are the whole method:
 *
 *   1. Consecutive circles touch -- centres s apart, radii summing to s -- so
 *      the ring of circles is a SEALED wall. Nothing crosses it, however small,
 *      so no state can ever finish up inside another one. This is why boundary
 *      circles alone are enough and the interiors never need filling, which is
 *      what keeps the count near 3,000 instead of near 30,000.
 *
 *   2. The union of those circles is the outline dilated by s/2 -- a Minkowski
 *      sum with a disc. Forbid circles of different states from coming closer
 *      than s + gap and every point of one outline ends up at least `gap` from
 *      every point of the other. Proof: a boundary point p is within s/2 of its
 *      nearest sample a, likewise q and b, so |p-q| >= |a-b| - s = gap.
 *
 * So s is a resolution knob and `gap` is the padding, independently. The padding
 * is not approximated and not merely typical: it is a guaranteed minimum, held
 * uniformly along every border on the map.
 *
 * Because the shapes are never deformed, shape error is zero and area error is
 * zero -- one pixel means the same number of people everywhere on the map, and
 * every state is still exactly its own recognisable self. All of the distortion
 * is absorbed by position, and by the loss of contiguity: the states no longer
 * touch. That is the trade this map makes, and it is the only one it makes.
 *
 * ---------------------------------------------------------------- the solver
 *
 * Position-based relaxation rather than a velocity integrator, because overlaps
 * are projected out directly and so nothing can tunnel through a wall no matter
 * how large the step. Each pass: hash the circles into a uniform grid, push
 * every overlapping cross-state pair apart along its centre line, average each
 * body's corrections into ONE translation (rigid: no rotation either, since a
 * tilted Florida costs more legibility than the packing gains), then pull the
 * body back toward its true geographic centroid.
 *
 * Three things underneath make it work, and each of them replaced something
 * that looked more obvious and did not:
 *
 *   - The layout starts EXPANDED, not small. Scaling every state about its own
 *     centroid pushes neighbours into each other, so the true layout is not a
 *     legal starting point. Growing the states from tiny is the obvious answer
 *     and it is the wrong one: a growing arm sweeps sideways and can close
 *     AROUND a neighbour, and a body that may only translate can never undo
 *     that. Maryland does exactly that to Delaware. So the states are held at
 *     full size and the POSITIONS are pushed apart until nothing overlaps;
 *     gravity then draws them back together. Rigid shapes that only ever
 *     approach cannot interlock -- they meet and stop.
 *
 *   - One pull toward geography, then several projections to pay for it.
 *     Interleaving them one for one lets gravity walk straight back into the
 *     overlap that separation had just resolved.
 *
 *   - The per-body correction is weighted by contact DEPTH, not a flat mean.
 *     This is the one that mattered most. Under a flat mean, a hundred contacts
 *     resting at the padding out-vote the single contact that is genuinely
 *     overlapping, and the deepest contact never clears no matter how long the
 *     solve runs -- which is why every earlier version stalled with a handful
 *     of states permanently touching.
 *
 * Gravity also ramps to zero, so the run ends on pure separation: held constant
 * it fights the separation pass forever and settles at an equilibrium that
 * still contains overlap.
 *
 * A fourth force holds NEIGHBOURS in their true bearing to one another, because
 * gravity says where each state belongs on its own and nothing whatever about
 * where states belong relative to each other -- so a large state on the edge of
 * the pack can shoulder a small one straight past itself, which is how Maine
 * came to sit west of New Hampshire. It corrects only the component ACROSS the
 * true bearing, never along it, so the padding is still free to drive
 * neighbours apart.
 *
 * That force is switched on by MEASURED distortion and is off for most of this
 * map's settings. True bearings are only simultaneously satisfiable while the
 * resizing is mild: once New Jersey is 3.6x its true size it cannot sit at its
 * true bearing from both New York and Pennsylvania without overlapping one of
 * them, and a spring demanding it fights the separation pass until the packing
 * is worse than with no alignment at all -- measured, at every strength tried.
 * So its strength scales with the spread of the scale factors and reaches zero
 * by a coefficient of variation of 0.25. Under "land area" the spread is zero
 * and it runs at full strength, halving the misordered pairs; under the three
 * resized measures it is off entirely and the packing is bit-for-bit what it
 * was without it.
 *
 * KNOWN LIMITS, both measured rather than guessed at:
 *
 *   - Convergence is not robust at every padding, and "two per state" falls
 *     short at the default. The readout MEASURES the clearance achieved rather
 *     than assuming it, and says so when the packing misses. Trust the number
 *     on the page, not the value on the slider.
 *
 *   - Relative position is approximate under the resized measures, where the
 *     alignment force is off: about 1% of east-west state pairs come out on the
 *     wrong side of each other against the true projection. Under "land area",
 *     with alignment on, that is halved.
 */

(function () {
  'use strict';

  /* Frame the projection is laid out in. The finished packing is fitted to the
   * viewport separately, so this is only the shape of the input. */
  const W = 975, H = 610;

  /* Every tunable in one place, so the whole solve is described by one object
   * and the numbers below can be swept rather than guessed at. */
  const TUNE = {
    /* Arc length between collision circles, in output pixels. Sets cost (the
     * circle count scales as 1/s) and the radius of the rounding at convex
     * corners (s/2). It does NOT set the padding -- that is `gap`, and the two
     * are deliberately independent so tight padding stays cheap. */
    SPACING: 3.2,

    /* Total state area as a share of the frame before packing. Irregular shapes
     * pack at roughly 60-70%, so asking for much more only makes the solver
     * push everything outward and the final fit shrink it back again. */
    COVER: 0.62,

    ITERS: 300,        // pulls toward geography before settling is allowed
    ITERS_MAX: 900,    // hard backstop if a pack will not settle
    OMEGA: 1.0,        // relaxation factor on the separation step
    GRAVITY0: 0.055,   // pull toward the true geographic centroid
    GRAVITY_OFF: 0.85, // gravity has ramped to zero this far through
    STEP_FREE: 30,     // furthest a body clear of contact may move in a pass
    STEP_TOUCH: 1.2,   // furthest a body already in contact may move in a pass
    PROJECT: 6,        // separation projections run per pull toward geography
    MAX_BIAS: 0.8,     // share of the move taken from the deepest contact alone
    ALIGN: 0.06,       // how hard neighbours hold each other's true bearing
    ALIGN_FADE: 0.25,  // scale spread at which alignment is switched off entirely

    /* How much a state's value resists being pushed. 1 is physically honest
     * (mass proportional to area) but it makes a 1-seat state absorb 98% of
     * every collision with California, which converges far too slowly to be
     * usable. Lower values flatten the contrast. */
    MASS_EXP: 1,
  };

  /* A polygon smaller than this share of its state's area is dropped, from the
   * drawing as well as from the physics. See the note where it is applied. */
  const PART_FLOOR = 0.0025;

  const smoothstep = (f) => f * f * (3 - 2 * f);

  /* ------------------------------------------------------------- geometry -- */

  const ringArea = (r) => {
    let a = 0;
    for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) {
      a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    }
    return a / 2;
  };

  /* Area-weighted centroid of one ring, paired with its signed area so parts
   * can be combined. Degenerate rings fall back to the vertex mean. */
  function ringCentroid(r) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) {
      const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
      a += f;
      cx += (r[j][0] + r[i][0]) * f;
      cy += (r[j][1] + r[i][1]) * f;
    }
    a /= 2;
    if (Math.abs(a) < 1e-9) {
      let sx = 0, sy = 0;
      for (const p of r) { sx += p[0]; sy += p[1]; }
      return { a: 0, x: sx / r.length, y: sy / r.length };
    }
    return { a, x: cx / (6 * a), y: cy / (6 * a) };
  }

  /* Walk the ring and drop a point every `s` of arc length. Samples land ON the
   * true outline, so every boundary point is within s/2 of one -- which is the
   * covering condition the padding guarantee rests on. A ring shorter than one
   * step still gets a single circle, so tiny islands remain solid obstacles. */
  function resample(ring, s) {
    const out = [];
    let need = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-12) continue;
      dx /= len; dy /= len;
      let t = need;
      while (t <= len) { out.push([a[0] + dx * t, a[1] + dy * t]); t += s; }
      need = t - len;
    }
    if (!out.length) out.push([ring[0][0], ring[0][1]]);
    return out;
  }

  /* ------------------------------------------------------------- the page -- */

  const $ = (id) => document.getElementById(id);
  const svg = d3.select('#map').append('svg')
    .attr('viewBox', `0 0 ${W} ${H}`)
    .attr('preserveAspectRatio', 'xMidYMid meet');
  const gFit = svg.append('g');
  const gStates = gFit.append('g');
  const gLeaders = svg.append('g').attr('class', 'leaders');
  const gLabels = svg.append('g').attr('class', 'labels');
  const tip = $('tooltip');

  let states = [];         // per-state geometry, fixed for the life of the page
  let adjacency = [];      // for each state, the indices of the states it borders
  let bodies = null;       // per-solve rigid bodies
  let raf = null, timer = null;

  Promise.all([
    fetch('states.topojson').then((r) => {
      if (!r.ok) throw new Error('states.topojson ' + r.status);
      return r.json();
    }),
    fetch('data.csv').then((r) => {
      if (!r.ok) throw new Error('data.csv ' + r.status);
      return r.text();
    }),
  ]).then(([topo, csvText]) => {
    const seats = new Map(d3.csvParse(csvText).map((r) => [r.abbr, {
      name: r.name, seats: +r.seats,
    }]));

    /* Who borders whom, taken from the shared arcs in the topology rather than
     * guessed at from the projected outlines. */
    adjacency = topojson.neighbors(topo.objects.states.geometries);

    const fc = topojson.feature(topo, topo.objects.states);
    const projection = d3.geoAlbersUsa().fitExtent([[0, 0], [W, H]], fc);

    states = fc.features.map((f) => {
      const raw = f.geometry.type === 'Polygon'
        ? [f.geometry.coordinates] : f.geometry.coordinates;

      /* geoAlbersUsa returns null outside its three panels. A ring that loses
       * points to that is nonsense rather than merely coarse, so drop it. */
      const all = [];
      for (const rings of raw) {
        const pr = [];
        let lost = false;
        for (const ring of rings) {
          const out = [];
          for (const c of ring) {
            const p = projection(c);
            if (p) out.push(p); else lost = true;
          }
          if (out.length >= 3) pr.push(out);
        }
        if (!pr.length || lost) continue;
        let net = 0;
        for (const ring of pr) net += ringArea(ring);
        all.push({ rings: pr, a: Math.abs(net) });
      }

      /* Drop the offshore specks. Alaska arrives as 412 separate polygons and
       * Florida as 58, nearly all of them well under a pixel once drawn -- and
       * a speck is not harmless here. It is welded rigidly to its mainland, so
       * if it lands inside a neighbour's sealed ring it can never get out, and
       * that one trapped circle holds the whole pair in permanent overlap. They
       * come out of the DRAWN geometry too, not just the collision geometry, so
       * that the clearance guarantee stays true of the map as printed and the
       * area stays exactly proportional to what is on it. */
      const gross = all.reduce((s, p) => s + p.a, 0);
      const parts = all.filter((p) => p.a >= gross * PART_FLOOR).map((p) => p.rings);

      let area = 0, cx = 0, cy = 0, wsum = 0;
      for (const rings of parts) {
        let net = 0;
        for (const ring of rings) net += ringArea(ring);
        const c = ringCentroid(rings[0]);
        area += Math.abs(net);
        const w = Math.abs(net);
        cx += c.x * w; cy += c.y * w; wsum += w;
      }
      const abbr = f.properties.state;
      const rec = seats.get(abbr) || { name: abbr, seats: 1 };
      const inner = projection([f.properties.innerX, f.properties.innerY]);

      return {
        abbr, name: rec.name, seats: rec.seats, parts, area,
        home: [cx / wsum, cy / wsum],
        inner: inner || [cx / wsum, cy / wsum],
      };
    });

    buildUI();
    solve();
  }).catch((err) => {
    $('map').innerHTML = '<p class="load-error">Could not load the map: '
      + err.message + '</p>';
  });

  /* --------------------------------------------------- sizing and bodies -- */

  const METRICS = {
    seats: { label: 'House seats', of: (s) => s.seats, unit: (v) => v + (v === 1 ? ' seat' : ' seats') },
    ev: { label: 'Electoral votes', of: (s) => s.seats + 2, unit: (v) => v + (v === 1 ? ' vote' : ' votes') },
    equal: { label: 'Two per state', of: () => 2, unit: () => '2 senators' },
    land: { label: 'Land area', of: (s) => s.area, unit: () => 'land area' },
  };

  /* Scale each state so its area is exactly its share of the total, then cut it
   * into collision circles and freeze both in body-local coordinates. */
  function build(metricKey, padding) {
    const M = METRICS[metricKey];
    const values = states.map(M.of);
    const totalV = values.reduce((a, b) => a + b, 0);
    const target = W * H * TUNE.COVER;

    const cx = [], cy = [], owner = [];
    const list = states.map((s, i) => {
      const k = Math.sqrt((target * values[i] / totalV) / s.area);
      const [hx, hy] = s.home;
      const local = s.parts.map((rings) =>
        rings.map((ring) => ring.map((p) => [(p[0] - hx) * k, (p[1] - hy) * k])));

      /* Outer rings only. A hole is interior, and nothing needs to be kept out
       * of it -- no state sits inside another state's hole. */
      const first = cx.length;
      for (const rings of local) {
        for (const p of resample(rings[0], TUNE.SPACING)) {
          cx.push(p[0]); cy.push(p[1]); owner.push(i);
        }
      }

      let d = '', bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const rings of local) {
        for (const ring of rings) {
          d += 'M' + ring.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L') + 'Z';
        }
        for (const p of rings[0]) {
          if (p[0] < bx0) bx0 = p[0]; if (p[0] > bx1) bx1 = p[0];
          if (p[1] < by0) by0 = p[1]; if (p[1] > by1) by1 = p[1];
        }
      }

      return {
        state: s, d, k, value: values[i], count: cx.length - first,
        share: values[i] / totalV,
        span: Math.sqrt(s.area) * k,
        bbox: [bx0, by0, bx1, by1],
        label: [(s.inner[0] - hx) * k, (s.inner[1] - hy) * k],
      };
    });

    const N = cx.length, NB = list.length;
    const B = {
      list, N, NB, padding,
      cx: Float64Array.from(cx), cy: Float64Array.from(cy),
      owner: Int32Array.from(owner),
      wx: new Float64Array(N), wy: new Float64Array(N),
      px: Float64Array.from(states.map((s) => s.home[0])),
      py: Float64Array.from(states.map((s) => s.home[1])),
      hx: Float64Array.from(states.map((s) => s.home[0])),
      hy: Float64Array.from(states.map((s) => s.home[1])),
      /* Heavier states yield less in a collision, softened by MASS_EXP. */
      inv: Float64Array.from(list.map((b) =>
        1 / Math.pow(Math.max(1e-6, b.value), TUNE.MASS_EXP))),
      accx: new Float64Array(NB), accy: new Float64Array(NB),
      wsum: new Float64Array(NB), deepest: new Float64Array(NB),
      dx: new Float64Array(NB), dy: new Float64Array(NB),
      cnt: new Int32Array(NB),
      iter: 0, maxOver: 0, ms: 0,
      cellStart: new Int32Array(0), items: new Int32Array(N), cellOf: new Int32Array(N),
    };

    /* Where to start from. Scaling every state about its own centroid pushes
     * neighbours INTO each other -- Rhode Island at 3.9x and Massachusetts at
     * 3.1x overlap long before either reaches full size -- so the true layout
     * is not a legal starting point, and the packing has to begin somewhere
     * that is.
     *
     * Growing the states from tiny was the obvious answer and it is the wrong
     * one: a growing arm sweeps sideways and can close AROUND a neighbour, and
     * once a state is encircled, bodies that may only translate can never undo
     * it. Maryland does exactly that to Delaware and to Virginia's Eastern
     * Shore, and no growth schedule fixes it.
     *
     * So hold the states at full size and move the LAYOUT instead: push the
     * positions apart until nothing overlaps, then let gravity draw them back
     * together with the separation pass holding the line. Rigid shapes that
     * only ever approach each other cannot interlock -- they meet, they stop,
     * and a tip that slides into a bay can always slide back out. */
    const cxAll = B.hx.reduce((a, v) => a + v, 0) / NB;
    const cyAll = B.hy.reduce((a, v) => a + v, 0) / NB;
    const spread = (E) => {
      for (let o = 0; o < NB; o++) {
        B.px[o] = cxAll + (B.hx[o] - cxAll) * E;
        B.py[o] = cyAll + (B.hy[o] - cyAll) * E;
      }
    };
    let lo = 1, hi = 2;
    spread(hi);
    while (!crossingFree(B) && hi < 64) { lo = hi; hi *= 1.5; spread(hi); }
    for (let k = 0; k < 10; k++) {
      const mid = (lo + hi) / 2;
      spread(mid);
      if (crossingFree(B)) hi = mid; else lo = mid;
    }
    spread(hi * 1.04);
    B.startE = hi * 1.04;

    /* How far this measure moves the states away from their true sizes, as the
     * spread of the scale factors. It decides how much say the alignment force
     * gets, because true bearings are only achievable while the resizing is
     * mild: hold every neighbour to its real bearing on a map where New Jersey
     * is 3.6x its true size and the constraints contradict each other, the
     * separation pass never wins, and the packing ends up worse than with no
     * alignment at all. Measured, not assumed -- under "land area" the spread
     * is zero and alignment runs at full strength. */
    const ks = list.map((b) => b.k);
    const mean = ks.reduce((a, v) => a + v, 0) / ks.length;
    const cv = Math.sqrt(ks.reduce((a, v) => a + (v - mean) * (v - mean), 0) / ks.length) / mean;
    B.alignScale = Math.max(0, 1 - cv / TUNE.ALIGN_FADE);

    const pairs = [];
    adjacency.forEach((ns, i) => ns.forEach((j) => { if (j > i) pairs.push(i, j); }));
    B.pairs = Int32Array.from(pairs);

    /* A body in contact may never be pulled further in one step than the gap it
     * is being asked to keep. The padding IS the safety margin here: two states
     * resting at the padding are exactly `padding` away from crossing, so a
     * pull larger than that can walk one straight through the other. At a wide
     * gap this never binds; at a narrow one it is the only thing holding. */
    B.stepTouch = Math.min(TUNE.STEP_TOUCH, padding * 0.4);
    return B;
  }
  /* True when no two states' outlines cross at their current positions. Two
   * circles of radius SPACING/2 whose centres are more than SPACING apart
   * cannot have crossing outlines between them, so this is the same sealed-wall
   * condition the packing itself relies on. */
  function crossingFree(B) {
    const cell = TUNE.SPACING;
    const grid = new Map();
    for (let i = 0; i < B.N; i++) {
      const o = B.owner[i];
      const x = B.px[o] + B.cx[i], y = B.py[o] + B.cy[i];
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const v = grid.get((gx + ox) + ',' + (gy + oy));
          if (!v) continue;
          for (const j of v) {
            if (B.owner[j] === o) continue;
            const dx = B.px[B.owner[j]] + B.cx[j] - x;
            const dy = B.py[B.owner[j]] + B.cy[j] - y;
            if (dx * dx + dy * dy <= cell * cell) return false;
          }
        }
      }
      const key = gx + ',' + gy;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    }
    return true;
  }

  /* -------------------------------------------------------------- solving -- */

  function pass(B) {
    const { N, cx, cy, owner, wx, wy, px, py, inv, accx, accy, cnt } = B;
    const D = TUNE.SPACING + B.padding, D2 = D * D;


    for (let i = 0; i < N; i++) {
      const o = owner[i];
      wx[i] = px[o] + cx[i];
      wy[i] = py[o] + cy[i];
    }

    // uniform grid, built by counting sort so there is nothing to allocate
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < N; i++) {
      if (wx[i] < x0) x0 = wx[i]; if (wx[i] > x1) x1 = wx[i];
      if (wy[i] < y0) y0 = wy[i]; if (wy[i] > y1) y1 = wy[i];
    }
    const cols = Math.max(1, Math.ceil((x1 - x0) / D) + 1);
    const rows = Math.max(1, Math.ceil((y1 - y0) / D) + 1);
    const nc = cols * rows;
    if (B.cellStart.length < nc + 1) B.cellStart = new Int32Array(nc + 1);
    const start = B.cellStart, items = B.items, cellOf = B.cellOf;
    start.fill(0, 0, nc + 1);
    for (let i = 0; i < N; i++) {
      const gx = Math.min(cols - 1, Math.max(0, ((wx[i] - x0) / D) | 0));
      const gy = Math.min(rows - 1, Math.max(0, ((wy[i] - y0) / D) | 0));
      const c = gy * cols + gx;
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < nc; c++) start[c + 1] += start[c];
    const fill = new Int32Array(nc);
    for (let i = 0; i < N; i++) {
      const c = cellOf[i];
      items[start[c] + fill[c]++] = i;
    }

    accx.fill(0); accy.fill(0); cnt.fill(0);
    B.wsum.fill(0); B.deepest.fill(0);
    let maxOver = 0;

    /* Half neighbourhood, so each pair is visited once: the cell itself with
     * j > i, plus the four cells forward in scan order. */
    const OFF = [[1, 0], [-1, 1], [0, 1], [1, 1]];
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const c = gy * cols + gx;
        const s0 = start[c], s1 = start[c + 1];
        if (s0 === s1) continue;
        for (let a = s0; a < s1; a++) {
          const i = items[a];
          const oi = owner[i], xi = wx[i], yi = wy[i];

          for (let b = a + 1; b < s1; b++) {
            const j = items[b];
            if (owner[j] === oi) continue;
            const dx = wx[j] - xi, dy = wy[j] - yi;
            const d2 = dx * dx + dy * dy;
            if (d2 >= D2) continue;
            const d = Math.sqrt(d2) || 1e-9;
            const over = D - d;
            if (over > maxOver) maxOver = over;
            const nx = dx / d, ny = dy / d, oj = owner[j];
            const wa = inv[oi], wb = inv[oj], sw = wa + wb;
            const ka = over * wa / sw, kb = over * wb / sw;
            accx[oi] -= nx * ka * over; accy[oi] -= ny * ka * over;
            accx[oj] += nx * kb * over; accy[oj] += ny * kb * over;
            B.wsum[oi] += over; B.wsum[oj] += over;
            if (ka > B.deepest[oi]) { B.deepest[oi] = ka; B.dx[oi] = -nx * ka; B.dy[oi] = -ny * ka; }
            if (kb > B.deepest[oj]) { B.deepest[oj] = kb; B.dx[oj] = nx * kb; B.dy[oj] = ny * kb; }
            cnt[oi]++; cnt[oj]++;
          }

          for (let k = 0; k < 4; k++) {
            const nx2 = gx + OFF[k][0], ny2 = gy + OFF[k][1];
            if (nx2 < 0 || nx2 >= cols || ny2 >= rows) continue;
            const c2 = ny2 * cols + nx2;
            for (let b = start[c2]; b < start[c2 + 1]; b++) {
              const j = items[b];
              if (owner[j] === oi) continue;
              const dx = wx[j] - xi, dy = wy[j] - yi;
              const d2 = dx * dx + dy * dy;
              if (d2 >= D2) continue;
              const d = Math.sqrt(d2) || 1e-9;
              const over = D - d;
              if (over > maxOver) maxOver = over;
              const nrx = dx / d, nry = dy / d, oj = owner[j];
              const wa = inv[oi], wb = inv[oj], sw = wa + wb;
              const ka = over * wa / sw, kb = over * wb / sw;
              accx[oi] -= nrx * ka * over; accy[oi] -= nry * ka * over;
              accx[oj] += nrx * kb * over; accy[oj] += nry * kb * over;
              B.wsum[oi] += over; B.wsum[oj] += over;
              if (ka > B.deepest[oi]) { B.deepest[oi] = ka; B.dx[oi] = -nrx * ka; B.dy[oi] = -nry * ka; }
              if (kb > B.deepest[oj]) { B.deepest[oj] = kb; B.dx[oj] = nrx * kb; B.dy[oj] = nry * kb; }
              cnt[oi]++; cnt[oj]++;
            }
          }
        }
      }
    }

    /* Weighted by depth, not a flat mean. The correction a body needs is set
     * by the contact that is worst, and a flat mean lets a hundred contacts
     * resting at the padding out-vote the one that is genuinely overlapping --
     * the deepest contact then never clears, however many passes are spent on
     * it. Weighting each contact by its own depth lets the worst one lead while
     * still answering to the rest, and MAX_BIAS blends in the deepest
     * correction outright. */
    for (let o = 0; o < B.NB; o++) {
      if (!cnt[o]) continue;
      const w = B.wsum[o] || 1;
      const mx = accx[o] / w, my = accy[o] / w;
      const f = TUNE.MAX_BIAS;
      px[o] += TUNE.OMEGA * (mx * (1 - f) + B.dx[o] * f);
      py[o] += TUNE.OMEGA * (my * (1 - f) + B.dy[o] * f);
    }
    B.maxOver = maxOver;
  }

  /* One pull toward the true geography, then several projections to answer for
   * it. This ordering is the whole reason the pack stays clean. Interleaved one
   * for one -- separate, then immediately pull -- gravity walks straight back
   * into the overlap separation had just resolved, and a concave state dragged
   * that way closes around its neighbour and is stuck for good. Move once, then
   * project until the move is paid for: the position-based-dynamics ordering,
   * and what actually keeps the wall sealed.
   *
   * The step is capped too. A body already in contact creeps; one with clear
   * space is free to cover ground, because the layout starts about seven times
   * too wide and crawling the whole way in would cost thousands of passes. */
  function attract(B, g) {
    for (let o = 0; o < B.NB; o++) {
      let mx = g * (B.hx[o] - B.px[o]), my = g * (B.hy[o] - B.py[o]);
      const cap = B.cnt[o] ? B.stepTouch : TUNE.STEP_FREE;
      const m = Math.hypot(mx, my);
      if (m > cap) { mx = mx / m * cap; my = my / m * cap; }
      B.px[o] += mx;
      B.py[o] += my;
    }
  }

  /* Stop when the pack is clean, not merely when the budget runs out. Gravity
   * has ended by then, so the remaining passes are pure separation and the
   * overlap falls monotonically -- but how many are needed depends on how far
   * out the layout had to start, which varies by measure: "two per state"
   * begins ten times too wide where House seats begins seven. The cap is a
   * backstop for a pack that genuinely cannot settle, not the normal exit. */
  function done(B) {
    if (B.iter >= TUNE.ITERS_MAX) return true;
    if (B.iter < TUNE.ITERS) return false;
    return B.maxOver <= 0.01;
  }

  /* Neighbours hold each other in their true bearing. Gravity says where each
   * state belongs on its own and nothing at all about where states belong
   * RELATIVE to one another, so a large state on the edge of the pack can
   * shoulder a small one straight past itself. That is how Maine ended up west
   * of New Hampshire: Maine has neighbours on one side only, resists being
   * moved because the correction is mass-weighted, and pushes Vermont and New
   * Hampshire around itself as the pack contracts.
   *
   * Only the component ACROSS the true bearing is corrected. The component
   * along it is left alone, because the padding has to drive neighbours apart
   * and a spring resisting that would simply close the gap again. So a pair may
   * separate as far as the packing needs, but it may not rotate about the other
   * -- and if it has already swapped sides, the second term drives it back. */
  function align(B, s) {
    const { px, py, hx, hy, inv, pairs } = B;
    for (let p = 0; p < pairs.length; p += 2) {
      const i = pairs[p], j = pairs[p + 1];
      const ex = hx[j] - hx[i], ey = hy[j] - hy[i];
      const el = Math.hypot(ex, ey);
      if (el < 1e-6) continue;
      const ux = ex / el, uy = ey / el;
      const dx = px[j] - px[i], dy = py[j] - py[i];
      const along = dx * ux + dy * uy;
      let mx = -(dx - along * ux), my = -(dy - along * uy);
      if (along < 0) { mx -= along * ux; my -= along * uy; }
      mx *= s; my *= s;
      const wi = inv[i], wj = inv[j], sw = wi + wj;
      px[i] -= mx * (wi / sw); py[i] -= my * (wi / sw);
      px[j] += mx * (wj / sw); py[j] += my * (wj / sw);
    }
  }

  function step(B) {
    const gf = Math.min(1, B.iter / (TUNE.ITERS * TUNE.GRAVITY_OFF));
    const g = TUNE.GRAVITY0 * (1 - smoothstep(gf));
    if (g > 0) attract(B, g);
    const a = TUNE.ALIGN * B.alignScale * (1 - smoothstep(gf));
    if (a > 0) align(B, a);
    for (let k = 0; k < TUNE.PROJECT; k++) pass(B);
    B.iter++;
  }

  /* ------------------------------------------------------------ rendering -- */

  let fit = null;

  function draw(B, snap) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < B.NB; i++) {
      const bb = B.list[i].bbox;
      const ax = B.px[i], ay = B.py[i];
      if (ax + bb[0] < x0) x0 = ax + bb[0];
      if (ay + bb[1] < y0) y0 = ay + bb[1];
      if (ax + bb[2] > x1) x1 = ax + bb[2];
      if (ay + bb[3] > y1) y1 = ay + bb[3];
    }
    const pad = 8;
    const K = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (y1 - y0 || 1));
    const target = {
      k: K,
      ox: (W - (x1 - x0) * K) / 2 - x0 * K,
      oy: (H - (y1 - y0) * K) / 2 - y0 * K,
    };
    if (!fit || snap) fit = target;
    else {
      fit.k += (target.k - fit.k) * 0.16;
      fit.ox += (target.ox - fit.ox) * 0.16;
      fit.oy += (target.oy - fit.oy) * 0.16;
    }

    gFit.attr('transform', `translate(${fit.ox.toFixed(2)},${fit.oy.toFixed(2)}) scale(${fit.k.toFixed(4)})`);
    gStates.selectAll('path').attr('transform', (d, i) =>
      `translate(${B.px[i].toFixed(2)},${B.py[i].toFixed(2)})`);

    /* Labels live outside the fitted group so their size is in screen units and
     * stays legible whatever the packing does to the scale. While the pack is
     * still moving they simply sit on their anchors; decluttering waits until
     * it has settled, since there is no point solving an arrangement that is
     * about to change. */
    gLabels.selectAll('text')
      .attr('x', (d, i) => anchor(B, i)[0])
      .attr('y', (d, i) => anchor(B, i)[1])
      .attr('font-size', (d, i) => labelSize(B, i).toFixed(1));
  }

  const anchor = (B, i) => [
    fit.ox + (B.px[i] + B.list[i].label[0]) * fit.k,
    fit.oy + (B.py[i] + B.list[i].label[1]) * fit.k,
  ];

  /* Never smaller than this. Shrinking a label to fit its state is what made
   * New England unreadable: six small states share one corner of the map, and
   * at the size their shapes allowed, the two-letter codes were a smear -- to
   * the point of reading as though New Hampshire sat east of Maine. */
  const LABEL_MIN = 9.5, LABEL_MAX = 20;

  const labelSize = (B, i) =>
    Math.max(LABEL_MIN, Math.min(LABEL_MAX, B.list[i].span * fit.k * 0.34));

  /* Anchor every label at its state's guaranteed-inside point, let a force
   * simulation push the overlapping ones apart, and draw a connector back for
   * any that had to move. Same declutter the mid-decade map uses. Run
   * synchronously, so the labels are settled the moment they appear. */
  function declutter(B) {
    const nodes = B.list.map((b, i) => {
      const [ax, ay] = anchor(B, i);
      const size = labelSize(B, i);
      return {
        i, ax, ay, x: ax, y: ay, size,
        collide: size * 0.82 + 1.8,
        /* A label big enough to sit comfortably inside its own state should
         * hold its ground; it is the cramped ones that need to give way. */
        hold: Math.min(0.95, Math.max(0.10, size / 17)),
      };
    });
    const sim = d3.forceSimulation(nodes)
      .alphaDecay(0.12).alphaMin(0.01)
      .force('collide', d3.forceCollide((d) => d.collide).iterations(3))
      .force('x', d3.forceX((d) => d.ax).strength((d) => d.hold))
      .force('y', d3.forceY((d) => d.ay).strength((d) => d.hold))
      .stop();
    sim.tick(Math.ceil(Math.log(sim.alphaMin() / sim.alpha()) / Math.log(1 - sim.alphaDecay())));

    gLabels.selectAll('text')
      .attr('x', (d, i) => nodes[i].x.toFixed(1))
      .attr('y', (d, i) => nodes[i].y.toFixed(1))
      .attr('font-size', (d, i) => nodes[i].size.toFixed(1));

    const moved = nodes.filter((d) =>
      Math.hypot(d.x - d.ax, d.y - d.ay) > d.collide * 0.85);
    const leads = gLeaders.selectAll('line').data(moved, (d) => d.i);
    leads.exit().remove();
    leads.enter().append('line').attr('class', 'leader').merge(leads)
      .attr('x1', (d) => {
        const a = Math.atan2(d.ay - d.y, d.ax - d.x);
        return (d.x + Math.cos(a) * d.collide).toFixed(1);
      })
      .attr('y1', (d) => {
        const a = Math.atan2(d.ay - d.y, d.ax - d.x);
        return (d.y + Math.sin(a) * d.collide * 0.8).toFixed(1);
      })
      .attr('x2', (d) => d.ax.toFixed(1))
      .attr('y2', (d) => d.ay.toFixed(1));
  }

  function paintOnce(B) {
    const paths = gStates.selectAll('path').data(B.list, (d) => d.state.abbr);
    paths.exit().remove();
    paths.enter().append('path')
      .attr('class', 'state')
      .attr('vector-effect', 'non-scaling-stroke')
      .on('mousemove', showTip).on('mouseleave', hideTip)
      .merge(paths)
      .attr('d', (d) => d.d);

    const texts = gLabels.selectAll('text').data(B.list, (d) => d.state.abbr);
    texts.exit().remove();
    texts.enter().append('text')
      .attr('text-anchor', 'middle').attr('dy', '0.35em')
      .merge(texts)
      .text((d) => d.state.abbr);
  }

  function showTip(event, d) {
    const M = METRICS[$('metric').value];
    tip.hidden = false;
    tip.innerHTML = '<strong>' + d.state.name + '</strong><br>'
      + (M === METRICS.land ? 'sized by land area'
        : M.unit(d.value) + ' &middot; ' + (d.share * 100).toFixed(1) + '% of the map');
    const r = $('map').getBoundingClientRect();
    tip.style.left = (event.clientX - r.left + 14) + 'px';
    tip.style.top = (event.clientY - r.top + 14) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  /* ---------------------------------------------------------------- drive -- */

  /* Drive the solve on animation frames when the page is actually being drawn,
   * and on a timer when it is not. A hidden tab never fires requestAnimationFrame
   * at all, so a page opened in a background tab used to sit on "Packing..."
   * forever and still be sitting there when the reader switched to it. The
   * timer path is not smooth, but nothing is being watched then anyway. */
  function nextFrame(fn) {
    if (document.hidden) {
      timer = setTimeout(fn, 0);
      return;
    }
    raf = requestAnimationFrame(fn);
  }

  function stopFrames() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function solve() {
    stopFrames();
    const padding = +$('padding').value;
    const B = build($('metric').value, padding);
    bodies = B;
    fit = null;
    gLeaders.selectAll('line').remove();
    paintOnce(B);
    draw(B, true);

    const t0 = performance.now();
    $('run').classList.add('busy');

    const finish = () => {
      B.ms = Math.round(performance.now() - t0);
      report(B);
      $('run').classList.remove('busy');
    };

    /* A page that is not on screen gets the whole solve in one go. Animating it
     * is pointless when nobody is watching, and worse than pointless: a hidden
     * tab fires no animation frames at all and throttles timers to about one a
     * second, so yielding between passes would leave the map unsolved for
     * minutes and still unsolved when the reader finally switched to it. */
    if (document.hidden) {
      while (!done(B)) step(B);
      draw(B, true);
      finish();
      declutter(B);
      return;
    }

    (function frame() {
      const until = performance.now() + 12;
      while (!done(B) && performance.now() < until) step(B);
      draw(B, false);
      if (!done(B)) { nextFrame(frame); return; }
      finish();
      /* Let the fit finish easing, THEN declutter -- the label arrangement
       * depends on the final scale, so solving it earlier would only have to
       * be thrown away. */
      let settle = 30;
      (function ease() {
        draw(B, false);
        if (--settle > 0) { nextFrame(ease); return; }
        declutter(B);
      })();
    })();
  }

  /* The clearance actually achieved, measured rather than assumed: the closest
   * cross-state pair of circle centres, minus one sample step. Anything less
   * than the requested padding means the solve did not converge. */
  function trueClearance(B) {
    const t = 1, D = TUNE.SPACING + B.padding;
    let best = Infinity;
    const { N, cx, cy, owner, px, py } = B;
    const cell = Math.max(D, 1);
    const pts = [];
    for (let i = 0; i < N; i++) pts.push([px[owner[i]] + cx[i] * t, py[owner[i]] + cy[i] * t]);
    const map = new Map();
    for (let i = 0; i < N; i++) {
      const key = Math.floor(pts[i][0] / cell) + ',' + Math.floor(pts[i][1] / cell);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(i);
    }
    for (let i = 0; i < N; i++) {
      const gx = Math.floor(pts[i][0] / cell), gy = Math.floor(pts[i][1] / cell);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        const v = map.get((gx + ox) + ',' + (gy + oy));
        if (!v) continue;
        for (const j of v) {
          if (j <= i || owner[j] === owner[i]) continue;
          const d = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
          if (d < best) best = d;
        }
      }
    }
    return best - TUNE.SPACING;
  }

  function report(B) {
    const clear = trueClearance(B);
    let area = 0;
    for (const b of B.list) area += b.state.area * b.k * b.k;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < B.NB; i++) {
      const bb = B.list[i].bbox;
      x0 = Math.min(x0, B.px[i] + bb[0]); y0 = Math.min(y0, B.py[i] + bb[1]);
      x1 = Math.max(x1, B.px[i] + bb[2]); y1 = Math.max(y1, B.py[i] + bb[3]);
    }
    const cover = area / ((x1 - x0) * (y1 - y0));
    const ok = clear >= B.padding - 0.05;
    $('stat-clear').textContent = clear.toFixed(2) + ' px';
    $('stat-clear').className = 'stat-value ' + (ok ? 'ok' : 'bad');
    $('stat-circles').textContent = B.N.toLocaleString();
    $('stat-cover').textContent = (cover * 100).toFixed(0) + '%';
    $('stat-time').textContent = B.ms + ' ms';
    $('verdict').textContent = ok
      ? 'Converged. No two states are closer than the padding, and every state is exactly its own shape at exactly its own share of the area.'
      : 'Did not fully converge — some pair is closer than the requested padding. Try more padding or a less extreme measure.';
    $('verdict').className = 'verdict ' + (ok ? 'ok' : 'bad');
  }

  function buildUI() {
    $('metric').addEventListener('change', solve);
    $('run').addEventListener('click', solve);
    const pad = $('padding');
    pad.addEventListener('input', () => { $('padding-out').textContent = pad.value + ' px'; });
    pad.addEventListener('change', solve);
    $('padding-out').textContent = pad.value + ' px';
  }
})();
