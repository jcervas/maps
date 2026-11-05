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
    // A state that gains or loses a seat is outlined in that colour, heavier,
    // with a wider halo so the colour keeps its edge against the cells.
    var SW_MOVED_OUTER = W * 0.0046;
    var SW_MOVED_INNER = W * 0.0024;
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
      rec.moved = s.change !== 0;
      rec.outer = el("path", { class: "cg-outer", d: outline });
      rec.inner = el("path", { class: "cg-inner", d: outline });
      if (rec.moved) {
        rec.inner.setAttribute("class", "cg-inner cg-inner--moved");
        rec.inner.style.stroke = DATA.palette[s.change > 0 ? "gained" : "lost"];
      }
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

    // Neighbours share borders, so a state drawn later paints over the edge of
    // one drawn earlier. Raise the states that moved to the top, so their
    // coloured outline is whole. Only the drawing order changes; states[] keeps
    // its order, which the chips and zoom index into.
    states.forEach(function (rec) { if (rec.moved) gStates.appendChild(rec.node); });

    var gLabels = el("g", { class: "cg-slabels" });
    var labelNodes = [];
    DATA.states.forEach(function (s) {
      var t = el("text", {
        x: s.layout.labelX, y: s.layout.labelY,
        "text-anchor": s.layout.labelAnchor || "middle"
      });
      t.textContent = s.st;
      gLabels.appendChild(t);
      labelNodes.push(t);
    });
    svg.appendChild(gLabels);

/* cartogram.js -- render this page's apportionment cartogram.
 *
 * A fork of /maps/apportionment-2020-2030/apportionment.js with the label
 * placement solver removed, and nothing else changed.
 *
 * That page solves label positions in the browser on every load, from anchors
 * the data ships. It gives good placement for free, but it also means a label
 * cannot be put somewhere by hand and stay there -- the solver simply re-places
 * it on the next load. This map's labels have been solved once and written into
 * the JSON, so the file now holds final positions and this file only draws
 * them. What is in the JSON is what appears on screen.
 *
 * To move a label, edit layout.labelX / labelY / labelAnchor in the JSON, by
 * hand or with tools/cartogram-editor.html in the apportionment repo. There is
 * nothing to re-run and nothing to override you.
 */

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
        s.outer.setAttribute("stroke-width", (s.moved ? SW_MOVED_OUTER : SW_STATE_OUTER) * f);
        s.inner.setAttribute("stroke-width", (s.moved ? SW_MOVED_INNER : SW_STATE_INNER) * f);
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
    applyHash();
  }

  // --------------------------------------------------------------- ingest --
  /* The map arrives as one GeoJSON FeatureCollection: every cell, outline and
   * label as a flat feature in one shared coordinate space, grouped by the `st`
   * property, with the y axis pointing up as GIS expects. That is what lets the
   * same file open in mapshaper.
   *
   * This turns it back into the per-state records the renderer below is written
   * against. Two conversions and nothing else: y is flipped into SVG's downward
   * axis, and each state gets an identity transform, since the coordinates are
   * already final rather than waiting on one. */
  function fromFeatureCollection(fc) {
    var H = fc.meta.height;
    var flipRing = function (r) {
      var o = [], i;
      for (i = 0; i < r.length; i++) o.push([r[i][0], H - r[i][1]]);
      return o;
    };
    var flip = function (g) {
      return {
        type: g.type,
        coordinates: g.type === "Polygon"
          ? g.coordinates.map(flipRing)
          : g.coordinates.map(function (poly) { return poly.map(flipRing); }),
      };
    };
    /* Area-weighted centroid of the outer rings, which is where a cell's +1 or
     * -1 is set. A bounding-box centre would drift out of an L-shaped cell. */
    var centroidOf = function (g) {
      var polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      var cx = 0, cy = 0, a2 = 0;
      polys.forEach(function (poly) {
        var r = poly[0], i, j, f;
        for (i = 0, j = r.length - 1; i < r.length; j = i++) {
          f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
          a2 += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f;
        }
      });
      if (!a2) return [polys[0][0][0][0], polys[0][0][0][1]];
      return [cx / (3 * a2), cy / (3 * a2)];
    };
    var bboxOf = function (g) {
      var polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      var b = [Infinity, Infinity, -Infinity, -Infinity];
      polys.forEach(function (poly) {
        poly[0].forEach(function (p) {
          if (p[0] < b[0]) b[0] = p[0];
          if (p[1] < b[1]) b[1] = p[1];
          if (p[0] > b[2]) b[2] = p[0];
          if (p[1] > b[3]) b[3] = p[1];
        });
      });
      return b;
    };

    var byState = {}, order = [];
    fc.features.forEach(function (f) {
      var p = f.properties, st = p.st;
      if (!byState[st]) {
        order.push(st);
        byState[st] = {
          st: st, fips: p.fips || "", name: p.state,
          seatsFrom: p.seatsFrom, seatsTo: p.seatsTo, change: p.change, cells: 0,
          cartogram: { scale: 1, tx: 0, ty: 0 },
          layout: {}, cellList: [], outline: null,
        };
      }
      var s = byState[st];
      if (p.kind === "cell") {
        var g = flip(f.geometry);
        s.cellList.push({
          k: p.cell, status: p.status, label: p.mark || null,
          color: p.fill || fc.palette[p.status] || fc.palette.retained,
          centroid: centroidOf(g), cell: g,
        });
      } else if (p.kind === "outline") {
        s.outline = flip(f.geometry);
        s.fips = p.fips || s.fips;
        s.cells = p.cells;
      } else if (p.kind === "label") {
        s.layout.labelX = f.geometry.coordinates[0];
        s.layout.labelY = H - f.geometry.coordinates[1];
        s.layout.labelAnchor = p.anchor || "middle";
      }
    });

    var states = order.map(function (st) {
      var s = byState[st];
      s.cellList.sort(function (a, b) { return a.k - b.k; });
      s.bbox = bboxOf(s.outline);
      s.centroid = centroidOf(s.outline);
      return s;
    });

    return { meta: fc.meta, palette: fc.palette, totals: fc.totals,
             changes: fc.changes, states: states };
  }

  // ------------------------------------------------------------ data loading --

  function fail(msg) {
    var d = document.createElement("div");
    d.className = "cg-err";
    d.textContent = msg;
    root.appendChild(d);
  }

  if (window.APPORTIONMENT_DATA) {
    var D0 = window.APPORTIONMENT_DATA;
    boot(D0 && D0.type === "FeatureCollection" ? fromFeatureCollection(D0) : D0);
  } else {
    var src = root.getAttribute("data-src");
    fetch(src)
      .then(function (r) {
        if (!r.ok) throw new Error(r.status + " " + r.statusText);
        return r.json();
      })
      .then(function (d) {
        boot(d && d.type === "FeatureCollection" ? fromFeatureCollection(d) : d);
      })
      .catch(function (e) {
        fail("Could not load " + src + " (" + e.message + "). This page needs to " +
             "be served over http:// -- browsers block file:// requests. Use " +
             "the standalone out/apportionment-<from>-<to>-viewer.html instead.");
      });
  }
})();
