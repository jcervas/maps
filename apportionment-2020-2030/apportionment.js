/* apportionment.js -- render the change-in-apportionment cartogram.
 *
 * No morph here, so no flubber: the geometry is static and the only animation
 * is the viewBox when zooming. Each state holds max(seatsFrom, seatsTo) cells,
 * and the |change| that moved are marked: blue arrives by the to-year, orange
 * departs by it, grey is held through both.
 *
 * THERE IS NO YEAR SWITCH. There used to be, drawing the cells that did not
 * exist in the chosen year as a dashed outline. It carried no information: a
 * cell is absent in the from-year if and only if it is marked gained, and in
 * the to-year if and only if it is marked lost, so the switch only ever
 * restated the colour already on screen. Worse, it invited the from-year view
 * to be read as a statement about that year -- California solid orange four
 * times over in 2020, when in 2020 California still held all 52 of its seats.
 * One view, every mark solid, and the legend says which way each one goes.
 *
 * Data arrives either as window.APPORTIONMENT_DATA (standalone build) or by
 * fetch from the container's data-src.
 */
(function () {
  "use strict";

  var root = document.getElementById("ap");
  var $ = function (id) { return document.getElementById(id); };

  function boot(DATA) {
    var W = DATA.meta.width;
    var H = DATA.meta.height;
    var ASPECT = W / H;

    var ZOOM_MS = 620;
    var SW_CELL = W * 0.0006;
    var SW_STATE_OUTER = W * 0.0026;
    var SW_STATE_INNER = W * 0.0013;
    var FS_CELL = W * 0.0105;
    var FS_STATE = W * 0.0108;
    var ZOOM_PAD = 0.05;
    var MIN_VB = 55;

    var reduceMotion = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // -------------------------------------------------------------- geometry --

    function ringToPath(r) {
      var s = "M" + r[0][0] + "," + r[0][1];
      for (var i = 1; i < r.length - 1; i++) s += "L" + r[i][0] + "," + r[i][1];
      return s + "Z";
    }
    function pathOf(g) {
      var polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      return polys.map(function (p) { return ringToPath(p[0]); }).join(" ");
    }

    // ----------------------------------------------------------------- build --

    var svg = $("ap-map");
    var NS = "http://www.w3.org/2000/svg";
    function el(name, attrs) {
      var n = document.createElementNS(NS, name);
      for (var k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    }

    var gStates = el("g", {});
    svg.appendChild(gStates);

    var states = [];
    var flat = [];

    DATA.states.forEach(function (s, si) {
      var g = el("g", {
        class: "cg-state",
        transform: "translate(" + s.cartogram.tx + "," + s.cartogram.ty +
                   ") scale(" + s.cartogram.scale + ")"
      });
      var gc = el("g", { class: "cg-cells" });
      var rec = {
        st: s.st, data: s, node: g, cells: gc, index: si,
        scale: s.cartogram.scale, tx: s.cartogram.tx, ty: s.cartogram.ty,
        bbox: s.bbox, paths: [], labels: []
      };

      s.cellList.forEach(function (c) {
        var p = el("path", {
          class: "cg-cell", d: pathOf(c.cell), fill: c.color, "data-i": flat.length
        });
        gc.appendChild(p);
        rec.paths.push(p);
        flat.push({ c: c, state: s, si: si });
      });
      g.appendChild(gc);

      var outline = pathOf(s.outline);
      rec.outer = el("path", { class: "cg-outer", d: outline });
      rec.inner = el("path", { class: "cg-inner", d: outline });
      g.appendChild(rec.outer);
      g.appendChild(rec.inner);

      // +1 / -1, only on the cells that moved
      s.cellList.forEach(function (c) {
        if (!c.label) return;
        var t = el("text", { class: "cg-clabel", x: c.centroid[0], y: c.centroid[1] });
        t.textContent = c.label;
        g.appendChild(t);
        rec.labels.push(t);
      });

      gStates.appendChild(g);
      states.push(rec);
    });

    var gLabels = el("g", { class: "cg-slabels" });
    var labelNodes = [];
    DATA.states.forEach(function (s) {
      var t = el("text", { x: s.layout.labelX, y: s.layout.labelY });
      t.textContent = s.st;
      gLabels.appendChild(t);
      labelNodes.push(t);
    });
    svg.appendChild(gLabels);

    // ------------------------------------------------------ label placement --
    /*
     * The source's layout.labelX / labelY are deliberately tight anchors: most
     * of them touch their own state somewhere, which reads fine at either
     * extreme and is unreadable in between -- a label straddling an outline has
     * half its letters on the state's fill and half on the page. Drawn raw,
     * WV, VA, NC, SC, AL and GA all land in that in-between. So one property is
     * enforced, the same one the R build of this map enforces, applied to all
     * fifty alike:
     *
     *   a label must be either wholly inside its own state, or wholly clear of
     *   every state with a margin, and must not overlap another label; if it is
     *   neither, move it the shortest distance that makes it one or the other,
     *   preferring the side it already leans to and the direction away from its
     *   own centroid, and never so far that another state becomes the nearest.
     *
     * The straddle is the defect, not the contact, so the rule sorts labels
     * into "inside" and "outside" rather than pushing every one clear.
     *
     * Two things differ from the R version of the same rule:
     *
     *   * Text is measured, not modelled. The <text> nodes are appended first
     *     and every box comes from getComputedTextLength() and getBBox() on the
     *     real elements, so there is no font table and no cap-height ratio to
     *     go stale on a device whose fallback font is not the one assumed. The
     *     rule's distances are still multiples of the measured cap height, so
     *     they travel between frames.
     *   * It runs on load rather than at build time. 42,000 outline edges go
     *     into a uniform bucket grid held in typed arrays, so a label box is
     *     only ever tested against the handful of edges in the buckets it
     *     covers, and the outline test stops at the first crossing rather than
     *     collecting every state that crosses.
     *
     * Placement happens once, in full-frame geometry, and is never redone:
     * setFocus() fades this whole group to opacity 0 before it zooms, so a
     * zoomed state label is never on screen to be misplaced, and re-solving on
     * every frame of the 620 ms viewBox animation would cost the main thread
     * dearly for something nobody can see.
     */

    var outlineIndex = null;

    /* Every state outline, transformed into final space, as a flat edge list
     * plus a uniform bucket grid over it. Edges are contiguous per state, so a
     * point-in-polygon test for one state is a scan of one range. */
    function buildOutlineIndex() {
      var ns = DATA.states.length;
      var ax = [], ay = [], bx = [], by = [], est = [];
      var soff = new Int32Array(ns + 1);
      var sbb = new Float64Array(ns * 4);

      DATA.states.forEach(function (s, si) {
        soff[si] = ax.length;
        var k = s.cartogram.scale, tx = s.cartogram.tx, ty = s.cartogram.ty;
        var g = s.outline;
        var polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
        var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        polys.forEach(function (p) {
          var r = p[0], px = [], py = [], i, X, Y;
          for (i = 0; i < r.length; i++) {
            X = tx + r[i][0] * k;
            Y = ty + r[i][1] * k;
            if (px.length && px[px.length - 1] === X && py[py.length - 1] === Y)
              continue;                                  // drop zero-length edges
            px.push(X); py.push(Y);
          }
          while (px.length > 1 && px[0] === px[px.length - 1] &&
                 py[0] === py[py.length - 1]) { px.pop(); py.pop(); }
          var n = px.length;
          if (n < 3) return;
          for (i = 0; i < n; i++) {
            var j = (i + 1) % n;                         // + the closing edge
            ax.push(px[i]); ay.push(py[i]); bx.push(px[j]); by.push(py[j]);
            est.push(si);
            if (px[i] < minx) minx = px[i];
            if (px[i] > maxx) maxx = px[i];
            if (py[i] < miny) miny = py[i];
            if (py[i] > maxy) maxy = py[i];
          }
        });
        sbb[si * 4] = minx; sbb[si * 4 + 1] = miny;
        sbb[si * 4 + 2] = maxx; sbb[si * 4 + 3] = maxy;
      });
      soff[ns] = ax.length;

      var NE = ax.length, e, u, v;
      var EX1 = new Float64Array(ax), EY1 = new Float64Array(ay);
      var EX2 = new Float64Array(bx), EY2 = new Float64Array(by);
      var MNX = new Float64Array(NE), MXX = new Float64Array(NE);
      var MNY = new Float64Array(NE), MXY = new Float64Array(NE);
      var lox = Infinity, loy = Infinity, hix = -Infinity, hiy = -Infinity;
      for (e = 0; e < NE; e++) {
        u = EX1[e]; v = EX2[e];
        MNX[e] = u < v ? u : v; MXX[e] = u < v ? v : u;
        u = EY1[e]; v = EY2[e];
        MNY[e] = u < v ? u : v; MXY[e] = u < v ? v : u;
        if (MNX[e] < lox) lox = MNX[e];
        if (MNY[e] < loy) loy = MNY[e];
        if (MXX[e] > hix) hix = MXX[e];
        if (MXY[e] > hiy) hiy = MXY[e];
      }

      var BS = W / 120, PADG = W / 24;
      var gx0 = lox - PADG, gy0 = loy - PADG;
      var NBX = ((hix + PADG - gx0) / BS | 0) + 1;
      var NBY = ((hiy + PADG - gy0) / BS | 0) + 1;
      var NB = NBX * NBY;
      var off = new Int32Array(NB + 1), gx, gy, ga, gb, gc, gd, c;
      for (e = 0; e < NE; e++) {
        ga = (MNX[e] - gx0) / BS | 0; gb = (MXX[e] - gx0) / BS | 0;
        gc = (MNY[e] - gy0) / BS | 0; gd = (MXY[e] - gy0) / BS | 0;
        for (gy = gc; gy <= gd; gy++)
          for (gx = ga; gx <= gb; gx++) off[gy * NBX + gx + 1]++;
      }
      for (e = 0; e < NB; e++) off[e + 1] += off[e];
      var items = new Int32Array(off[NB]), fill = new Int32Array(NB);
      for (e = 0; e < NE; e++) {
        ga = (MNX[e] - gx0) / BS | 0; gb = (MXX[e] - gx0) / BS | 0;
        gc = (MNY[e] - gy0) / BS | 0; gd = (MXY[e] - gy0) / BS | 0;
        for (gy = gc; gy <= gd; gy++)
          for (gx = ga; gx <= gb; gx++) {
            c = gy * NBX + gx;
            items[off[c] + fill[c]++] = e;
          }
      }

      return {
        x1: EX1, y1: EY1, x2: EX2, y2: EY2,
        mnx: MNX, mxx: MXX, mny: MNY, mxy: MXY,
        soff: soff, sbb: sbb,
        gx0: gx0, gy0: gy0, BS: BS, NBX: NBX, NBY: NBY, off: off, items: items
      };
    }

    function placeStateLabels() {
      var t0 = performance.now();
      var ns = DATA.states.length, k, i, r;

      /* Measure from the shipped anchors every time, so a second run -- a web
       * font arriving late -- solves the same problem rather than one already
       * half-solved. */
      for (k = 0; k < ns; k++) {
        labelNodes[k].removeAttribute("text-anchor");
        labelNodes[k].setAttribute("x", DATA.states[k].layout.labelX);
        labelNodes[k].setAttribute("y", DATA.states[k].layout.labelY);
      }

      if (!outlineIndex) outlineIndex = buildOutlineIndex();
      var IX = outlineIndex;
      var EX1 = IX.x1, EY1 = IX.y1, EX2 = IX.x2, EY2 = IX.y2;
      var MNX = IX.mnx, MXX = IX.mxx, MNY = IX.mny, MXY = IX.mxy;
      var BS = IX.BS, gx0 = IX.gx0, gy0 = IX.gy0, NBX = IX.NBX, NBY = IX.NBY;
      var OFF = IX.off, ITEMS = IX.items, SOFF = IX.soff, SBB = IX.sbb;

      /* Does any outline cross this rectangle? Separating-axis test: the
       * rectangle's own two axes are the bucket and bbox filters above, then
       * the edge's normal, which together are exact for a segment against an
       * axis-aligned box. Only the yes/no matters, so stop at the first hit. */
      function crosses(x0, y0, x1, y1) {
        var a = (x0 - gx0) / BS | 0, b = (x1 - gx0) / BS | 0;
        var c = (y0 - gy0) / BS | 0, d = (y1 - gy0) / BS | 0;
        if (a < 0) a = 0; if (c < 0) c = 0;
        if (b > NBX - 1) b = NBX - 1; if (d > NBY - 1) d = NBY - 1;
        for (var gy = c; gy <= d; gy++) {
          var base = gy * NBX;
          for (var gx = a; gx <= b; gx++) {
            var cell = base + gx, hi = OFF[cell + 1];
            for (var p = OFF[cell]; p < hi; p++) {
              var e = ITEMS[p];
              if (MXX[e] < x0 || MNX[e] > x1 || MXY[e] < y0 || MNY[e] > y1) continue;
              var ex = EX1[e], ey = EY1[e];
              var dx = EX2[e] - ex, dy = EY2[e] - ey;
              var s1 = dx * (y0 - ey) - dy * (x0 - ex);
              var s2 = dx * (y0 - ey) - dy * (x1 - ex);
              var s3 = dx * (y1 - ey) - dy * (x1 - ex);
              var s4 = dx * (y1 - ey) - dy * (x0 - ex);
              if ((s1 > 0 && s2 > 0 && s3 > 0 && s4 > 0) ||
                  (s1 < 0 && s2 < 0 && s3 < 0 && s4 < 0)) continue;
              return true;
            }
          }
        }
        return false;
      }

      function pip(px, py, si) {                          // even-odd ray cast
        var n = 0, hi = SOFF[si + 1];
        for (var e = SOFF[si]; e < hi; e++) {
          var ya = EY1[e], yb = EY2[e];
          if ((ya > py) !== (yb > py) &&
              px < EX1[e] + (py - ya) * (EX2[e] - EX1[e]) / (yb - ya)) n++;
        }
        return (n & 1) === 1;
      }
      function stateAt(px, py) {
        for (var s = 0; s < ns; s++) {
          if (px < SBB[s * 4] || px > SBB[s * 4 + 2] ||
              py < SBB[s * 4 + 1] || py > SBB[s * 4 + 3]) continue;
          if (pip(px, py, s)) return s;
        }
        return -1;
      }

      /* --- measured boxes ---------------------------------------------------
       * getBBox() on SVG text is the font's em box, positioned as the browser
       * actually set it -- text-anchor and dominant-baseline already applied.
       * The rule wants the ink box: these are two-letter all-caps codes, so
       * that is the cap box. A probe pinned to the alphabetic baseline says
       * where the baseline sits inside an em box, and canvas TextMetrics --
       * same font string, read off the live element -- gives the ink extent
       * above and below it. Both are measurements of this browser's rendering;
       * neither is a table. If a browser withholds the ink extents, the em box
       * stands in, which is larger and so only ever more cautious. */
      var probe = el("text", { x: 0, y: 0 });
      probe.style.dominantBaseline = "alphabetic";
      probe.textContent = "AZ";
      gLabels.appendChild(probe);
      var pb = probe.getBBox();
      var emAsc = -pb.y;
      gLabels.removeChild(probe);

      var ctx = null;
      try {
        var cs = window.getComputedStyle(labelNodes[0]);
        ctx = document.createElement("canvas").getContext("2d");
        ctx.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize +
                   " " + cs.fontFamily;
      } catch (err) { ctx = null; }

      var natr = [], dyOff = [], lh = 0;
      for (k = 0; k < ns; k++) {
        var t = labelNodes[k];
        var b = t.getBBox();
        var w = t.getComputedTextLength();
        var basey = b.y + emAsc;
        var asc = emAsc, desc = b.height - emAsc;
        if (ctx) {
          var m = ctx.measureText(t.textContent);
          if (m.actualBoundingBoxAscent > 0) {
            asc = m.actualBoundingBoxAscent;
            desc = m.actualBoundingBoxDescent > 0 ? m.actualBoundingBoxDescent : 0;
          }
        }
        r = [b.x, basey - asc, b.x + w, basey + desc];
        natr.push(r);
        dyOff.push((r[1] + r[3]) / 2 - DATA.states[k].layout.labelY);
        if (r[3] - r[1] > lh) lh = r[3] - r[1];
      }

      /* Every distance is a multiple of the measured cap height, so the rule
       * travels between frames and font sizes. The ratios are the ones the R
       * build verified on this same 1152-wide source frame. */
      var MARGIN    = SW_STATE_INNER / 2 + 0.158 * lh;  // daylight past the border
      var BLEED     = 0.030 * lh;                       // slack on the measured box
      var PAD_LABEL = 0.169 * lh;                       // daylight between labels
      var MAX_NUDGE = 3.38 * lh;
      var STEP      = 0.056 * lh;

      /* The +1 / -1 marks on the cells that moved are obstacles too. They are
       * drawn inside the state's transformed group, so their boxes come back in
       * local units and have to be carried into final space. */
      var cellRects = [];
      for (i = 0; i < states.length; i++) {
        var S = states[i];
        for (var j = 0; j < S.labels.length; j++) {
          var cb = S.labels[j].getBBox();
          cellRects.push([
            cb.x * S.scale + S.tx, cb.y * S.scale + S.ty,
            (cb.x + cb.width) * S.scale + S.tx, (cb.y + cb.height) * S.scale + S.ty
          ]);
        }
      }

      /* A box whose margin crosses no outline is wholly on one side of every
       * state, and its centre says which: inside this state, or out in the
       * white. Anything else is a straddle, reported as null. */
      function labMode(rc, si) {
        var d = MARGIN + BLEED;
        if (crosses(rc[0] - d, rc[1] - d, rc[2] + d, rc[3] + d)) return null;
        var s = stateAt((rc[0] + rc[2]) / 2, (rc[1] + rc[3]) / 2);
        return s < 0 ? "out" : (s === si ? "in" : null);
      }

      var place = [], cen = [], codes = [];
      for (k = 0; k < ns; k++) {
        place.push(natr[k].slice());
        codes.push(DATA.states[k].st);
        var cg = DATA.states[k].cartogram, ct = DATA.states[k].centroid;
        cen.push([cg.tx + ct[0] * cg.scale, cg.ty + ct[1] * cg.scale]);
      }

      /* ok(): the whole constraint for one candidate box -- not straddling, and
       * not within `pad` of another label or a +/- mark. Returns "in", "out" or
       * null. */
      function ok(rc, si, pad) {
        var m = labMode(rc, si);
        if (m === null) return null;
        var d = pad + BLEED;
        var a0 = rc[0] - d, a1 = rc[1] - d, a2 = rc[2] + d, a3 = rc[3] + d;
        for (var q = 0; q < ns; q++) {
          if (q === si) continue;
          var o = place[q];
          if (!(a2 < o[0] || o[2] < a0 || a3 < o[1] || o[3] < a1)) return null;
        }
        for (q = 0; q < cellRects.length; q++) {
          var cr = cellRects[q];
          if (!(a2 < cr[0] || cr[2] < a0 || a3 < cr[1] || cr[3] < a1)) return null;
        }
        return m;
      }

      /* Which side does this label already lean to? */
      function leanOf(rc) {
        var inside = 0;
        for (var gx = 0; gx < 9; gx++)
          for (var gy = 0; gy < 5; gy++)
            if (stateAt(rc[0] + (rc[2] - rc[0]) * gx / 8,
                        rc[1] + (rc[3] - rc[1]) * gy / 4) >= 0) inside++;
        return inside >= 23 ? "in" : "out";               // >= half of 45
      }
      /* Which state's outline is nearest this box? Over every vertex, not a
       * thinned sample: when a label sits in the gap between two states the two
       * distances are close, and a sampled ring picks the wrong one often
       * enough to matter. Exact stays cheap because a state whose bounding box
       * is already further than the best distance so far cannot win, and
       * visiting them nearest-box-first knocks out all but three or four. */
      var nordr = new Int32Array(ns), nkey = new Float64Array(ns);
      function nearest(rc) {
        var px = (rc[0] + rc[2]) / 2, py = (rc[1] + rc[3]) / 2, s, i, dx, dy;
        for (s = 0; s < ns; s++) {
          dx = px < SBB[s * 4] ? SBB[s * 4] - px
             : (px > SBB[s * 4 + 2] ? px - SBB[s * 4 + 2] : 0);
          dy = py < SBB[s * 4 + 1] ? SBB[s * 4 + 1] - py
             : (py > SBB[s * 4 + 3] ? py - SBB[s * 4 + 3] : 0);
          nkey[s] = dx * dx + dy * dy;
          nordr[s] = s;
        }
        var ord2 = Array.prototype.slice.call(nordr);
        ord2.sort(function (a, c) { return nkey[a] - nkey[c]; });
        var best = -1, bd = Infinity;
        for (i = 0; i < ns; i++) {
          s = ord2[i];
          if (nkey[s] > bd) break;
          var hi = SOFF[s + 1], d = Infinity;
          for (var e = SOFF[s]; e < hi; e++) {
            dx = EX1[e] - px; dy = EY1[e] - py;
            var dd = dx * dx + dy * dy;
            if (dd < d) d = dd;
          }
          if (d < bd) { bd = d; best = s; }
        }
        return best;
      }

      var lean = natr.map(leanOf);
      var ANG = [];
      for (i = 0; i < 24; i++) ANG.push(i * Math.PI / 12);

      var moved = new Float64Array(ns), relaxed = [], pads = [0, 0, 0];
      pads[0] = PAD_LABEL; pads[1] = PAD_LABEL / 2; pads[2] = 0;

      /* Rings of growing radius, 24 directions each; inside a ring the
       * direction nearest "away from my own centroid" is tried first, so the
       * shortest offset wins and ties go outward. Eight passes, because moving
       * one label can unseat its neighbour. */
      for (var pass = 0; pass < 8; pass++) {
        var dirty = false;
        for (k = 0; k < ns; k++) {
          if (ok(place[k], k, PAD_LABEL) !== null) continue;
          dirty = true;
          var nat = natr[k];
          var away = Math.atan2((nat[1] + nat[3]) / 2 - cen[k][1],
                                (nat[0] + nat[2]) / 2 - cen[k][0]);
          var ord = ANG.slice().sort(function (p, q) {
            return Math.abs(Math.atan2(Math.sin(p - away), Math.cos(p - away))) -
                   Math.abs(Math.atan2(Math.sin(q - away), Math.cos(q - away)));
          });
          var own = nearest(nat) === k;
          var wants = lean[k] === "in" ? ["in", "out"] : ["out", "in"];
          var got = null;
          /* Two constraints of unequal weight: straddling an outline is the
           * defect this rule exists to remove, crowding a neighbouring label is
           * a nuisance. So the label-to-label gap is what gives way when a
           * pocket is too tight -- full, then half, then none. */
          for (var pi = 0; pi < 3 && !got; pi++) {
            for (var wi = 0; wi < 2 && !got; wi++) {
              for (var rr = STEP; rr <= MAX_NUDGE + 1e-9 && !got; rr += STEP) {
                for (var ai = 0; ai < ord.length; ai++) {
                  var dx = rr * Math.cos(ord[ai]), dy = rr * Math.sin(ord[ai]);
                  var cand = [nat[0] + dx, nat[1] + dy, nat[2] + dx, nat[3] + dy];
                  if (ok(cand, k, pads[pi]) !== wants[wi]) continue;
                  if (own && nearest(cand) !== k) continue;
                  got = { r: cand, d: rr, pad: pads[pi] };
                  break;
                }
              }
            }
          }
          if (got) {
            place[k] = got.r;
            moved[k] = got.d;
            if (got.pad < PAD_LABEL && relaxed.indexOf(codes[k]) < 0)
              relaxed.push(codes[k]);
          }
        }
        if (!dirty) break;
      }

      /* --- resolve to a point and an anchor ---------------------------------
       * x is an EDGE of the resolved box, not its centre, and the edge kept is
       * the one nearer the state: if this browser sets the text a shade wider
       * than measured, it then grows away from the shape rather than into it.
       * y is the vertical middle of the cap box, converted back through the
       * offset measured between that middle and the y attribute, so the CSS
       * dominant-baseline is left to do whatever it does. A label placed inside
       * its own state is centred. */
      var report = { straddle: [], inside: [], relaxed: relaxed, moved: {} };
      for (k = 0; k < ns; k++) {
        r = place[k];
        var mode = labMode(r, k);
        var mid = (r[0] + r[2]) / 2;
        var an = mode === "in" ? "middle" : (mid < cen[k][0] ? "end" : "start");
        labelNodes[k].setAttribute("text-anchor", an);
        labelNodes[k].setAttribute(
          "x", an === "middle" ? mid : (an === "end" ? r[2] : r[0]));
        labelNodes[k].setAttribute("y", (r[1] + r[3]) / 2 - dyOff[k]);
        if (mode === null) report.straddle.push(codes[k]);
        else if (mode === "in") report.inside.push(codes[k]);
        if (moved[k] > 0) report.moved[codes[k]] = Math.round(moved[k] * 10) / 10;
      }
      report.ms = performance.now() - t0;
      report.capHeight = lh;
      try { root.cgLabels = report; } catch (err) { /* debug hook only */ }
    }

    // ---------------------------------------------------------------- render --

    var focus = -1;
    var vb = [0, 0, W, H];
    var zoomK = 1;

    function setViewBox(b) {
      vb = b;
      zoomK = b[2] / W;
      svg.setAttribute("viewBox", b[0] + " " + b[1] + " " + b[2] + " " + b[3]);
      applyScales();
    }

    /* Strokes and type are in viewBox units, so they would balloon as the
     * viewBox tightens and shrink as a state scales up. Divide both out. */
    function applyScales() {
      for (var i = 0; i < states.length; i++) {
        var s = states[i], f = zoomK / s.scale;
        s.cells.setAttribute("stroke-width", SW_CELL * f);
        s.outer.setAttribute("stroke-width", SW_STATE_OUTER * f);
        s.inner.setAttribute("stroke-width", SW_STATE_INNER * f);
        for (var j = 0; j < s.labels.length; j++) {
          s.labels[j].setAttribute("font-size", FS_CELL * f);
          s.labels[j].setAttribute("stroke-width", FS_CELL * f * 0.1);
        }
      }
      gLabels.setAttribute("font-size", FS_STATE * zoomK);
    }

    // ---------------------------------------------------------------- zooming --

    function stateBox(i) {
      var s = states[i], b = s.bbox, k = s.scale;
      return [b[0] * k + s.tx, b[1] * k + s.ty, b[2] * k + s.tx, b[3] * k + s.ty];
    }

    /* Pad, then expand to the frame's aspect ratio: the SVG is width:100% /
     * height:auto, so a differently shaped viewBox would resize the element and
     * shove the rest of the page around. */
    function fitBox(b) {
      var w = b[2] - b[0], h = b[3] - b[1];
      var pad = Math.max(w, h) * ZOOM_PAD;
      var x0 = b[0] - pad, y0 = b[1] - pad;
      w += 2 * pad; h += 2 * pad;
      if (w < MIN_VB) { x0 -= (MIN_VB - w) / 2; w = MIN_VB; }
      if (h < MIN_VB / ASPECT) { y0 -= (MIN_VB / ASPECT - h) / 2; h = MIN_VB / ASPECT; }
      if (w / h < ASPECT) { var nw = h * ASPECT; x0 -= (nw - w) / 2; w = nw; }
      else { var nh = w / ASPECT; y0 -= (nh - h) / 2; h = nh; }
      return [x0, y0, w, h];
    }

    var targetBox = function () {
      return focus < 0 ? [0, 0, W, H] : fitBox(stateBox(focus));
    };

    var zoomAnim = null;
    var ease = function (u) {
      return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    };

    function animateZoom(target) {
      if (zoomAnim) cancelAnimationFrame(zoomAnim);
      if (reduceMotion) { setViewBox(target); return; }
      var from = vb.slice(), t0 = performance.now();
      (function step(now) {
        var u = Math.min(1, (now - t0) / ZOOM_MS), e = ease(u);
        if (u >= 1) { zoomAnim = null; setViewBox(target); return; }
        setViewBox([
          from[0] + (target[0] - from[0]) * e,
          from[1] + (target[1] - from[1]) * e,
          from[2] + (target[2] - from[2]) * e,
          from[3] + (target[3] - from[3]) * e
        ]);
        zoomAnim = requestAnimationFrame(step);
      })(t0);
    }

    var reset = $("ap-reset");

    function setFocus(i) {
      if (i === focus) return;
      focus = i;
      for (var n = 0; n < states.length; n++)
        states[n].node.classList.toggle("cg-dim", focus >= 0 && n !== focus);
      reset.hidden = focus < 0;
      var chips = $("ap-chips").children;
      for (var c = 0; c < chips.length; c++)
        chips[c].classList.toggle("is-active",
          focus >= 0 && chips[c].getAttribute("data-si") === String(focus));
      gLabels.style.opacity = focus < 0 ? 1 : 0;
      animateZoom(targetBox());
      writeHash();
    }

    svg.addEventListener("click", function (e) {
      var i = e.target.getAttribute && e.target.getAttribute("data-i");
      if (i == null) { setFocus(-1); return; }
      var si = flat[+i].si;
      setFocus(si === focus ? -1 : si);
    });
    reset.addEventListener("click", function () { setFocus(-1); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && focus >= 0) setFocus(-1);
    });

    // ------------------------------------------------------------- deep links --

    var hashLock = false;

    function writeHash() {
      var parts = [];
      if (focus >= 0) parts.push(states[focus].st);
      var h = parts.length ? "#" + parts.join("-") : "";
      if (h === location.hash || (!h && !location.hash)) return;
      hashLock = true;
      try {
        history.replaceState(null, "", location.pathname + location.search + h);
      } catch (err) { location.hash = h; }
      hashLock = false;
    }

    function applyHash() {
      var h = (location.hash || "").replace(/^#/, "").trim();
      var toks = h ? h.split("-") : [];
      var st = -1;
      toks.forEach(function (t) {
        /* Links shared while the year switch existed look like #2010-TX. The
         * year is gone but the link should still land on Texas, so a four-digit
         * token is skipped rather than treated as a state code. */
        if (/^\d{4}$/.test(t)) return;
        var code = t.toUpperCase();
        for (var i = 0; i < states.length; i++) if (states[i].st === code) st = i;
      });
      applyScales();
      focus = -2;              // force setFocus to run even for -1
      setFocus(st);
    }

    window.addEventListener("hashchange", function () { if (!hashLock) applyHash(); });

    // --------------------------------------------------------------- tooltip --

    var tip = $("ap-tip");
    var sign = function (n) { return (n > 0 ? "+" : "") + n; };

    svg.addEventListener("mousemove", function (e) {
      var i = e.target.getAttribute && e.target.getAttribute("data-i");
      if (i == null) { tip.style.display = "none"; return; }
      var r = flat[+i], s = r.state, c = r.c;
      var note = c.status === "retained"
        ? "seat held through both apportionments"
        : c.status === "gained"
          ? "one of " + Math.abs(s.change) + " seat" + (Math.abs(s.change) > 1 ? "s" : "") + " gained"
          : "one of " + Math.abs(s.change) + " seat" + (Math.abs(s.change) > 1 ? "s" : "") + " lost";
      tip.innerHTML =
        "<b>" + s.name + "</b><br>" +
        DATA.meta.from + ": " + s.seatsFrom + " seats &rarr; " +
        DATA.meta.to + ": " + s.seatsTo + " seats" +
        (s.change ? " (<b>" + sign(s.change) + "</b>)" : " (no change)") + "<br>" +
        '<span class="cg-sw" style="background:' + c.color + '"></span>' + note +
        (c.district ? "<br>current district " + c.district : "");
      tip.style.display = "block";
      var pad = 14, x = e.clientX + pad, y = e.clientY + pad;
      var b = tip.getBoundingClientRect();
      if (x + b.width > window.innerWidth) x = e.clientX - b.width - pad;
      if (y + b.height > window.innerHeight) y = e.clientY - b.height - pad;
      tip.style.left = x + "px";
      tip.style.top = y + "px";
    });
    svg.addEventListener("mouseleave", function () { tip.style.display = "none"; });

    // ------------------------------------------------------------------ boot --

    $("ap-title").textContent = DATA.meta.title;
    /* When the comparison does not end at the apportionment the boundary file was
     * drawn under, no cell carries a district id -- say so rather than leaving a
     * reader to assume the cells line up with districts of that era. */
    $("ap-sub").innerHTML = DATA.meta.subtitle +
      " &middot; state outlines from the createMaps pipeline, cells built with mapshaper and base R" +
      (DATA.meta.districtsAttached === false
        ? " &middot; cells are not matched to district lines for this pair"
        : "") +
      (DATA.meta.projected
        ? '<br><b>' + DATA.meta.to + " is a projection, not a result.</b> " +
          (DATA.meta.projection ? DATA.meta.projection.note.replace(/^The \d+ column is a projection, not a result\. /, "") : "")
        : "");

    /* The swatch carries a +1 / -1 glyph as well as a colour, matching the mark
     * drawn on the cell itself, so the encoding never rests on colour alone.
     * Each key names the move rather than a year, because a mark is about the
     * move: a state holds its lost seats right up to the to-year. */
    var SPAN = DATA.meta.from + "\u2192" + DATA.meta.to;
    $("ap-legend").innerHTML = [
      ["gained", "+1", "seat gained, " + SPAN],
      ["lost", "\u22121", "seat lost, " + SPAN],
      ["retained", "", "held through both"]
    ].map(function (p) {
      return '<span class="cg-key"><span class="cg-sw" style="background:' +
        DATA.palette[p[0]] + '">' + p[1] + "</span>" + p[2] + "</span>";
    }).join("");

    /* The House is the same size at both censuses. What moves is which state
     * holds each seat, and saying the total here keeps the marks from reading
     * as a tally against some other number. */
    $("ap-status").textContent =
      (DATA.totals.retained + DATA.totals.gained) + " seats; " +
      DATA.totals.seatsMoved + " move between " +
      DATA.totals.statesChanged + " states";

    /* One chip per state that changed, biggest movers first, each a shortcut to
     * that state's zoom. */
    var chips = $("ap-chips");
    DATA.states
      .map(function (s, i) { return { s: s, i: i }; })
      .filter(function (o) { return o.s.change !== 0; })
      .sort(function (a, b) {
        return Math.abs(b.s.change) - Math.abs(a.s.change) ||
               b.s.change - a.s.change ||
               (a.s.st < b.s.st ? -1 : 1);
      })
      .forEach(function (o) {
        var d = document.createElement("span");
        d.className = "cg-chip";
        d.setAttribute("data-si", o.i);
        d.innerHTML = '<span class="cg-sw" style="background:' +
          DATA.palette[o.s.change > 0 ? "gained" : "lost"] + '"></span>' +
          o.s.st + " <b>" + sign(o.s.change) + "</b>";
        d.title = o.s.name + ": " + o.s.seatsFrom + " → " + o.s.seatsTo;
        d.addEventListener("click", function () {
          setFocus(o.i === focus ? -1 : o.i);
        });
        chips.appendChild(d);
      });

    setViewBox([0, 0, W, H]);
    /* After setViewBox, so applyScales() has put the real font-size on the
     * group and the boxes measured below are the boxes that will be drawn --
     * and before applyHash(), which may zoom straight to a deep-linked state
     * and fade the labels out. */
    try {
      placeStateLabels();
      /* Only if a font is still arriving: system faces are already resolved, so
       * this is normally never scheduled, and when it is the outline index is
       * already built and only the measure-and-solve runs again. */
      if (document.fonts && document.fonts.status !== "loaded" && document.fonts.ready)
        document.fonts.ready.then(function () {
          try { placeStateLabels(); } catch (err) { /* keep the raw anchors */ }
        });
    } catch (err) { /* keep the raw anchors rather than losing the labels */ }
    applyHash();
  }

  // ------------------------------------------------------------ data loading --

  function fail(msg) {
    var d = document.createElement("div");
    d.className = "cg-err";
    d.textContent = msg;
    root.appendChild(d);
  }

  if (window.APPORTIONMENT_DATA) {
    boot(window.APPORTIONMENT_DATA);
  } else {
    var src = root.getAttribute("data-src");
    fetch(src)
      .then(function (r) {
        if (!r.ok) throw new Error(r.status + " " + r.statusText);
        return r.json();
      })
      .then(boot)
      .catch(function (e) {
        fail("Could not load " + src + " (" + e.message + "). This page needs to " +
             "be served over http:// -- browsers block file:// requests. Use " +
             "the standalone out/apportionment-<from>-<to>-viewer.html instead.");
      });
  }
})();
