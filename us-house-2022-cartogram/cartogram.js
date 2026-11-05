/* viewer.js -- render the cartogram JSON, morph between its two states, and
 * zoom to a state's bounding box on click.
 *
 * The data file carries, per district, its true geography ("geo") and its
 * equal-area counterpart ("cell") in one shared pixel space, plus a per-state
 * affine that moves the rescaled state into the hand-made layout. Animating
 * between the two means doing two things at once:
 *
 *   - interpolating each district's OUTLINE            (flubber)
 *   - interpolating its state's TRANSFORM, identity -> (scale, tx, ty)
 *
 * Zoom is a third, independent animation on the SVG viewBox.
 *
 * Data arrives either as window.CARTOGRAM_DATA (the standalone build inlines it)
 * or by fetch from the container's data-src.
 */
(function () {
  "use strict";

  var root = document.getElementById("cg");
  var $ = function (id) { return document.getElementById(id); };

  function boot(DATA) {
    var W = DATA.meta.width;
    var H = DATA.meta.height;
    var ASPECT = W / H;

    /* flubber adds points until no segment is longer than this, in viewBox
     * units. Smaller looks better and costs more; 4 keeps 435 shapes at ~9ms. */
    var MAX_SEG = 4;

    var MORPH_MS = 1400; // per-state morph duration
    var WAVE_MS = 900; // west-to-east stagger across the country
    var ZOOM_MS = 620;

    /* stroke widths in viewBox units at zoom 1, divided by a state's scale as it
     * grows and by the zoom factor as the viewBox tightens */
    var SW_DISTRICT = W * 0.0006;
    var SW_STATE_OUTER = W * 0.0026;
    var SW_STATE_INNER = W * 0.0013;
    var FS_DISTRICT = W * 0.0105;
    var FS_STATE = W * 0.0108;

    var ZOOM_PAD = 0.05; // fraction of the box's long side
    var MIN_VB = 55; // smallest viewBox width, so Rhode Island stops somewhere

    var reduceMotion = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // -------------------------------------------------------------- geometry --

    function ringToPath(ring) {
      var s = "M" + ring[0][0] + "," + ring[0][1];
      for (var i = 1; i < ring.length - 1; i++) s += "L" + ring[i][0] + "," + ring[i][1];
      return s + "Z";
    }

    /* Points -> path string, rounded to a tenth of a viewBox unit.
     *
     * This is why the interpolators are asked for points rather than flubber's
     * own path strings: flubber emits full float precision, so a 100-point ring
     * becomes ~4 KB of text the browser must re-parse every frame. At 435 shapes
     * that alone cost ~120 ms/frame. A tenth of a unit is well under a device
     * pixel even zoomed in. */
    function ptsToPath(pts) {
      var s = "M", p;
      for (var i = 0; i < pts.length; i++) {
        p = pts[i];
        if (i) s += "L";
        s += Math.round(p[0] * 10) / 10 + "," + Math.round(p[1] * 10) / 10;
      }
      return s + "Z";
    }

    /* interpolate() hands back one ring; combine()/separate() hand back a list
     * of rings. Tell them apart by whether the first element is a point. */
    function shapeToPath(r) {
      if (!Array.isArray(r[0][0])) return ptsToPath(r);
      var s = "";
      for (var i = 0; i < r.length; i++) s += (i ? " " : "") + ptsToPath(r[i]);
      return s;
    }

    /* Outer ring of each part. There are no holes anywhere in this dataset (the
     * build's validator checks), so a part is its outer ring. */
    function parts(geom) {
      var polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
      return polys.map(function (p) { return ringToPath(p[0]); });
    }

    function pathOf(geom) { return parts(geom).join(" "); }

    /* Split n parts into k groups: the largest k-1 alone, the rest lumped into
     * the last. Parts arrive largest-first from the build, so this is a slice. */
    function group(list, k) {
      var out = [];
      for (var i = 0; i < k - 1; i++) out.push([list[i]]);
      out.push(list.slice(k - 1));
      return out;
    }

    /* Build t -> path-string for one district.
     *
     * flubber's three primitives cover one-to-one, many-to-one and one-to-many.
     * When BOTH sides are multipart (10 districts, Alaska worst at 33 -> 13) the
     * shapes are grouped down to min(m, n) buckets first, so within a bucket at
     * most one side is multipart and a primitive always applies. The bucket
     * results are concatenated into one compound path. */
    function makeMorph(geo, cell) {
      var A = parts(geo), B = parts(cell);

      function one(a, b) {
        var o = { maxSegmentLength: MAX_SEG, string: false, single: true };
        if (a.length === 1 && b.length === 1) return flubber.interpolate(a[0], b[0], o);
        if (b.length === 1) return flubber.combine(a, b[0], o);
        if (a.length === 1) return flubber.separate(a[0], b, o);
        return null; // both sides multipart: handled by grouping below
      }

      var simple = one(A, B);
      if (simple) return function (t) { return shapeToPath(simple(t)); };

      var k = Math.min(A.length, B.length);
      var ga = group(A, k), gb = group(B, k);
      var fns = [];
      for (var i = 0; i < k; i++) fns.push(one(ga[i], gb[i]));
      return function (t) {
        var s = "";
        for (var i = 0; i < fns.length; i++) s += (i ? " " : "") + shapeToPath(fns[i](t));
        return s;
      };
    }

    // ----------------------------------------------------------------- build --

    var svg = $("cg-map");
    var NS = "http://www.w3.org/2000/svg";
    function el(name, attrs) {
      var n = document.createElementNS(NS, name);
      for (var k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    }

    var gStates = el("g", { class: "cg-states" });
    svg.appendChild(gStates);

    var states = []; // render bookkeeping, parallel to DATA.states
    var flat = []; // every district, for the tooltip

    DATA.states.forEach(function (s, si) {
      var g = el("g", { class: "cg-state" });
      var gd = el("g", { class: "cg-dists" });
      var rec = {
        st: s.st, data: s, index: si, node: g, dists: gd,
        scale: s.cartogram.scale, tx: s.cartogram.tx, ty: s.cartogram.ty,
        bbox: s.bbox,
        wave: s.centroid[0] / W, // 0 on the west coast, 1 on the east
        k: 1,
        paths: [], morphs: [], geoD: [], cellD: [], labels: [], from: [], to: []
      };

      s.districts.forEach(function (d) {
        var geoD = pathOf(d.geo), cellD = pathOf(d.cell);
        var p = el("path", { d: geoD, fill: d.color, "data-i": flat.length });
        gd.appendChild(p);
        rec.paths.push(p);
        rec.geoD.push(geoD);
        rec.cellD.push(cellD);
        rec.morphs.push(null);
        flat.push({ d: d, state: s, si: si });
      });
      g.appendChild(gd);

      var outline = pathOf(s.outline);
      rec.outer = el("path", { class: "cg-outer", d: outline });
      rec.inner = el("path", { class: "cg-inner", d: outline });
      g.appendChild(rec.outer);
      g.appendChild(rec.inner);

      /* District numbers travel with their district: anchored at the true
       * centroid on the map, at the cell's seed point on the cartogram. */
      s.districts.forEach(function (d) {
        var t = el("text", { class: "cg-dlabel", x: d.centroid[0], y: d.centroid[1] });
        t.textContent = String(parseInt(d.cd, 10));
        g.appendChild(t);
        rec.labels.push(t);
        rec.from.push(d.centroid);
        rec.to.push(d.target);
      });

      gStates.appendChild(g);
      states.push(rec);
    });

    // state abbreviations live outside the scaled groups, at fixed layout points
    var gLabels = el("g", { class: "cg-slabels" });
    DATA.states.forEach(function (s) {
      var t = el("text", { x: s.layout.labelX, y: s.layout.labelY });
      t.textContent = s.st;
      gLabels.appendChild(t);
    });
    svg.appendChild(gLabels);

    // ---------------------------------------------------------------- render --

    var progress = 0; // 0 = traditional, 1 = cartogram
    var showNums = false;
    var showLabels = true;
    var focus = -1; // index of the zoomed state, or -1
    var vb = [0, 0, W, H];
    var zoomK = 1;

    function setViewBox(b) {
      vb = b;
      zoomK = b[2] / W;
      svg.setAttribute("viewBox", b[0] + " " + b[1] + " " + b[2] + " " + b[3]);
      applyScales();
    }

    /* Strokes and type are specified in viewBox units, so they would balloon as
     * the viewBox tightens and shrink as a state scales up. Both factors are
     * divided out here, which keeps every line and label the same apparent size
     * at any zoom and any point in the morph. */
    function applyScales() {
      for (var i = 0; i < states.length; i++) {
        var s = states[i], f = zoomK / s.k;
        s.dists.setAttribute("stroke-width", SW_DISTRICT * f);
        s.outer.setAttribute("stroke-width", SW_STATE_OUTER * f);
        s.inner.setAttribute("stroke-width", SW_STATE_INNER * f);
        if (s.labelsShown) {
          for (var j = 0; j < s.labels.length; j++) {
            s.labels[j].setAttribute("font-size", FS_DISTRICT * f);
            s.labels[j].setAttribute("stroke-width", FS_DISTRICT * f * 0.1);
          }
        }
      }
      gLabels.setAttribute("font-size", FS_STATE * zoomK);
    }

    /* Where state `i`'s bounding box sits on screen at morph position t. The
     * outline itself never morphs -- only the districts inside it do -- so this
     * box is valid at every t, which is what lets a zoom track a state while the
     * morph is running. */
    function stateBox(i, t) {
      var s = states[i];
      var k = 1 + t * (s.scale - 1);
      var b = s.bbox;
      return [b[0] * k + t * s.tx, b[1] * k + t * s.ty,
              b[2] * k + t * s.tx, b[3] * k + t * s.ty];
    }

    /* Pad a box and expand it to the frame's aspect ratio.
     *
     * Matching the aspect ratio matters: the SVG is width:100% / height:auto, so
     * its rendered height follows the viewBox. Zooming to a box of a different
     * shape would resize the element and shove the rest of the page around. */
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

    function targetBox() {
      return focus < 0 ? [0, 0, W, H] : fitBox(stateBox(focus, progress));
    }

    /* Apply a morph position. Each state gets its own local t so the transition
     * sweeps west to east, the way the notebook staggers by centroid. */
    function draw(p, staggered) {
      var total = WAVE_MS + MORPH_MS;
      for (var n = 0; n < states.length; n++) {
        var s = states[n];
        var t = p;
        if (staggered) {
          t = Math.max(0, Math.min(1, (p * total - s.wave * WAVE_MS) / MORPH_MS));
        }
        var k = 1 + t * (s.scale - 1);
        s.k = k;
        s.node.setAttribute(
          "transform", "translate(" + t * s.tx + "," + t * s.ty + ") scale(" + k + ")"
        );

        /* Endpoints use the exact geometry from the file; flubber only fills in
         * between. That keeps both ends pixel-accurate however the interpolator
         * approximates -- and it means a state that has not started moving, or
         * has already arrived, needs no path work at all. `phase` records what
         * was last written so those states skip the DOM writes too. With the
         * west-to-east wave only part of the country is in motion at any moment,
         * so most states cost nothing on most frames. */
        var i, phase = t <= 0 ? "geo" : t >= 1 ? "cell" : "morph";
        if (phase === "morph" || s.phase !== phase) {
          for (i = 0; i < s.paths.length; i++) {
            var d;
            if (phase === "geo") d = s.geoD[i];
            else if (phase === "cell") d = s.cellD[i];
            else {
              if (!s.morphs[i]) {
                s.morphs[i] = makeMorph(s.data.districts[i].geo, s.data.districts[i].cell);
              }
              d = s.morphs[i](t);
            }
            s.paths[i].setAttribute("d", d);
          }
          s.phase = phase;
        }

        // district numbers: on when asked for, or always for a zoomed state
        var vis = showNums || focus === n;
        if (vis || s.labelsShown) {
          for (i = 0; i < s.labels.length; i++) {
            s.labels[i].style.opacity = vis ? 1 : 0;
            if (vis) {
              s.labels[i].setAttribute("x", s.from[i][0] + t * (s.to[i][0] - s.from[i][0]));
              s.labels[i].setAttribute("y", s.from[i][1] + t * (s.to[i][1] - s.from[i][1]));
            }
          }
          s.labelsShown = vis;
        }
      }
      gLabels.style.opacity = p > 0.98 && showLabels && focus < 0 ? 1 : 0;
      progress = p;
      applyScales();
    }

    // ------------------------------------------------------------ animation --

    var ease = function (u) {
      return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    };
    var morphAnim = null, zoomAnim = null;

    function animateMorph(target) {
      if (morphAnim) cancelAnimationFrame(morphAnim);
      if (reduceMotion) {
        draw(target, false);
        slider.value = String(target);
        if (focus >= 0) animateZoom(targetBox());
        return;
      }
      var from = progress, t0 = performance.now();
      var dur = (WAVE_MS + MORPH_MS) * Math.max(0.25, Math.abs(target - from));
      (function step(now) {
        var u = Math.min(1, (now - t0) / dur);
        var p = from + (target - from) * ease(u);
        draw(u >= 1 ? target : p, true);
        slider.value = String(progress);
        // a zoomed state moves as it rescales, so keep the viewBox on it
        if (focus >= 0 && !zoomAnim) setViewBox(targetBox());
        morphAnim = u < 1 ? requestAnimationFrame(step) : null;
      })(t0);
    }

    function animateZoom(target) {
      if (zoomAnim) cancelAnimationFrame(zoomAnim);
      if (reduceMotion) { setViewBox(target); return; }
      var from = vb.slice(), t0 = performance.now();
      (function step(now) {
        var u = Math.min(1, (now - t0) / ZOOM_MS), e = ease(u);
        if (u >= 1) {
          zoomAnim = null;
          setViewBox(focus >= 0 ? targetBox() : [0, 0, W, H]);
          return;
        }
        setViewBox([
          from[0] + (target[0] - from[0]) * e,
          from[1] + (target[1] - from[1]) * e,
          from[2] + (target[2] - from[2]) * e,
          from[3] + (target[3] - from[3]) * e
        ]);
        zoomAnim = requestAnimationFrame(step);
      })(t0);
    }

    // --------------------------------------------------------------- zooming --

    var reset = $("cg-reset");

    function setFocus(i, quiet) {
      if (i === focus) return;
      focus = i;
      for (var n = 0; n < states.length; n++) {
        states[n].node.classList.toggle("cg-dim", focus >= 0 && n !== focus);
      }
      reset.hidden = focus < 0;
      draw(progress, false); // refreshes the auto-shown district numbers
      animateZoom(targetBox());
      if (!quiet) writeHash();
    }

    svg.addEventListener("click", function (e) {
      var i = e.target.getAttribute && e.target.getAttribute("data-i");
      // clicking the focused state, or any empty space, zooms back out
      if (i == null) { setFocus(-1); return; }
      var si = flat[+i].si;
      setFocus(si === focus ? -1 : si);
    });

    reset.addEventListener("click", function () { setFocus(-1); });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && focus >= 0) setFocus(-1);
    });

    // ------------------------------------------------------------- deep links --

    /* The view is captured in the URL fragment so a particular state, or the
     * cartogram itself, can be linked to directly:
     *
     *     #NJ              New Jersey, geographic map
     *     #cartogram       the cartogram, whole country
     *     #cartogram-NJ    New Jersey on the cartogram
     *
     * replaceState rather than assignment, so scrubbing and clicking around does
     * not fill the visitor's back button with history entries.
     */
    var hashLock = false;

    function writeHash() {
      var parts = [];
      if (progress > 0.5) parts.push("cartogram");
      if (focus >= 0) parts.push(states[focus].st);
      var h = parts.length ? "#" + parts.join("-") : "";
      if (h === location.hash || (!h && !location.hash)) return;
      hashLock = true;
      try {
        history.replaceState(null, "", location.pathname + location.search + h);
      } catch (e) {
        location.hash = h; // file:// in some browsers rejects replaceState
      }
      hashLock = false;
    }

    function readHash() {
      var h = (location.hash || "").replace(/^#/, "").trim();
      if (!h) return { p: 0, st: -1 };
      var toks = h.split("-");
      var p = 0;
      if (toks[0].toLowerCase() === "cartogram") { p = 1; toks.shift(); }
      var st = -1;
      if (toks[0]) {
        var code = toks[0].toUpperCase();
        for (var i = 0; i < states.length; i++) if (states[i].st === code) st = i;
      }
      return { p: p, st: st };
    }

    function applyHash(animate) {
      var h = readHash();
      if (animate) animateMorph(h.p); else { draw(h.p, false); slider.value = String(h.p); }
      labelToggle();
      setFocus(h.st, true);
    }

    window.addEventListener("hashchange", function () {
      if (!hashLock) applyHash(true);
    });

    // -------------------------------------------------------------- controls --

    var slider = $("cg-scrub");
    var toggle = $("cg-toggle");
    var status = $("cg-status");

    function labelToggle() {
      toggle.textContent = progress > 0.5 ? "Show traditional map" : "Show cartogram";
    }

    toggle.addEventListener("click", function () {
      animateMorph(progress > 0.5 ? 0 : 1);
      toggle.textContent = progress > 0.5 ? "Show cartogram" : "Show traditional map";
      writeHash();
    });

    slider.addEventListener("input", function () {
      if (morphAnim) { cancelAnimationFrame(morphAnim); morphAnim = null; }
      draw(parseFloat(slider.value), false);
      if (focus >= 0 && !zoomAnim) setViewBox(targetBox());
      labelToggle();
      writeHash();
    });

    $("cg-nums").addEventListener("change", function (e) {
      showNums = e.target.checked;
      draw(progress, false);
    });
    $("cg-labels").addEventListener("change", function (e) {
      showLabels = e.target.checked;
      draw(progress, false);
    });

    // --------------------------------------------------------------- tooltip --

    var tip = $("cg-tip");
    var fmt = function (n) { return n == null ? "n/a" : n.toLocaleString(); };

    svg.addEventListener("mousemove", function (e) {
      var t = e.target;
      var i = t.getAttribute && t.getAttribute("data-i");
      if (i == null) { tip.style.display = "none"; return; }
      var r = flat[+i], d = r.d;
      tip.innerHTML =
        "<b>" + d.id + "</b> &middot; " + r.state.name + "<br>" +
        '<span class="cg-sw" style="background:' + d.color + '"></span>' +
        (d.winner || "—") + " (" + (d.party || "—") + ")<br>" +
        (d.votesTotal == null
          ? "uncontested, no counts published"
          : fmt(d.votesWinner) + " of " + fmt(d.votesTotal) + " votes &middot; +" +
            (d.margin * 100).toFixed(1) + " pts");
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

    var tot = DATA.totals;
    $("cg-legend").innerHTML = Object.keys(DATA.palette)
      .filter(function (p) { return tot[p]; })
      .map(function (p) {
        return '<span class="cg-key"><span class="cg-sw" style="background:' +
          DATA.palette[p] + '"></span>' + p + " " + tot[p] + "</span>";
      }).join("");

    setViewBox([0, 0, W, H]);
    draw(0, false);
    labelToggle();
    applyHash(false);   // honour #NJ / #cartogram / #cartogram-NJ on load

    /* Build every interpolator up front rather than on first use. It costs ~0.2s
     * once; doing it lazily would spend that inside the first animated frame -- a
     * visible hitch exactly when the transition starts. Deferred one frame so
     * the map paints first. */
    status.textContent = "preparing morph…";
    requestAnimationFrame(function () {
      var t0 = performance.now();
      states.forEach(function (s) {
        for (var i = 0; i < s.paths.length; i++) {
          if (!s.morphs[i]) {
            s.morphs[i] = makeMorph(s.data.districts[i].geo, s.data.districts[i].cell);
          }
        }
      });
      var build = performance.now() - t0;

      /* Time a real steady-state frame with the interpolators warm, then put the
       * view back where it WAS -- not at 0. An incoming #cartogram hash has
       * already moved it by this point, and hard-coding 0 here silently undid
       * that, leaving the slider and the geometry disagreeing. */
      var restore = progress;
      var t1 = performance.now();
      draw(restore === 0.5 ? 0.45 : 0.5, false);
      var frame = performance.now() - t1;
      draw(restore, false);
      slider.value = String(restore);
      if (focus >= 0) setViewBox(targetBox());

      status.textContent = DATA.states.length + " states, " + flat.length +
        " districts · " + frame.toFixed(0) + " ms/frame · " +
        build.toFixed(0) + " ms to build " + flat.length + " interpolators";
    });
  }

  // ------------------------------------------------------------ data loading --

  function fail(msg) {
    var d = document.createElement("div");
    d.className = "cg-err";
    d.textContent = msg;
    root.appendChild(d);
  }

  if (window.CARTOGRAM_DATA) {
    boot(window.CARTOGRAM_DATA); // standalone build: inlined
  } else {
    var src = root.getAttribute("data-src");
    fetch(src)
      .then(function (r) {
        if (!r.ok) throw new Error(r.status + " " + r.statusText);
        return r.json();
      })
      .then(boot)
      .catch(function (e) {
        fail("Could not load " + src + " (" + e.message + "). " +
             "This page needs to be served over http:// -- browsers block " +
             "file:// requests. Use out/viewer.html for a standalone copy.");
      });
  }
})();
