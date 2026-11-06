/* The map view: canvas, projection, zoom, layers, hit testing.
 *
 * This is the generalization of drawLayers() in
 * jcervas.github.io/maps/redrawn-districts-2026. That function hard-codes
 * three layers (basemap fill, the choropleth, district strokes) because the
 * explorer draws exactly those. A wall draws counties, towns, districts,
 * states and precincts in different combinations per app, so the layer list
 * is data here and the view knows nothing about elections.
 *
 * A layer is:
 *   { id, features, fill(f)->color|null, stroke(f)->color|null|string,
 *     lineWidth (screen px), alpha(f)->0..1, pick: bool, visible: bool }
 *
 * `fill` returning null means "no data": the view fills with `blank` so the
 * absence is visible rather than reading as zero.
 */
import { nationalProjection } from "./projection.js";
import { PickBuffer } from "./pick.js";
import { boundsTransformFor, snapshot, crossFade, animateZoomTo } from "./zoom.js";
import { morphPlan, runMorph } from "./morph.js";
import { theme, onThemeChange } from "./theme.js";
import { attachGestures } from "./input.js";

export function createView(opts) {
  const stage = opts.stage;
  const cv = opts.canvas;
  const ctx = cv.getContext("2d");
  const picker = new PickBuffer();
  const fadeCanvas = document.createElement("canvas");
  // Capped at 2: beyond that the pixels cost more than they show, and the
  // pick buffer is the same size as the visible one.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  let projection = opts.projection || nationalProjection();
  let path = d3.geoPath(projection, ctx);
  let transform = d3.zoomIdentity;
  let layers = [];
  let W = 0, H = 0;
  let pad = opts.pad == null ? 22 : opts.pad;
  let cancels = [];
  let fitted = { base: null, projection: null };   // what resize() last framed
  let transitioning = false;     // a projection morph is running
  let afterSettle = null;
  const handlers = {};

  function on(name, fn) {
    (handlers[name] = handlers[name] || []).push(fn);
    return api;
  }
  function emit(name, ...args) {
    for (const fn of handlers[name] || []) fn(...args);
  }

  /* Both path generators bind the projection object, so swapping projections
   * means rebuilding them; mutating `projection` alone would leave the old
   * one in use and the map would silently keep drawing in the previous CRS. */
  function setProjection(next) {
    projection = next;
    path = d3.geoPath(projection, ctx);
  }

  function extent() {
    return [[pad, pad], [W - pad, H - pad]];
  }

  /** The padded box, for callers that fit a projection they have not installed. */
  function extentBox() {
    return extent();
  }

  /* Each shape's projected outline, kept as a Path2D. Pan and zoom move the
   * canvas transform, not the projection, so a frame can refill the paths it
   * already has instead of reprojecting every vertex: with the 1:500,000
   * county file that is the difference between a frame in tens of
   * milliseconds and one approaching a second.
   *
   * A refit (resize, the rail rewrapping, map.js's refit) changes only the
   * projection's scale and translate, and every projection here -- the
   * geoAlbersUsa composite and the state conics -- is k * f(lon, lat) + t in
   * those two. So a path built under (k0, t0) is carried to (k1, t1) by one
   * affine copy rather than reprojected; only a different projection, or a
   * changed rotation or parallels, starts again from the coordinates. */
  const shapes = new WeakMap();            // feature -> { form, k, tx, ty, key, p, b }
  const projIds = new WeakMap();
  let projSerial = 0;
  let form = "";                           // which projection, apart from its fit
  let fit = { k: 1, tx: 0, ty: 0, key: "" };
  const recorder = d3.geoPath();
  /* The outline's projected box comes free with drawing it: a context that
   * forwards to the Path2D and keeps the extremes. drawLayer skips a shape
   * whose box is off screen -- zoomed in on a corner of California, most of
   * its 18,539 precincts (about 130 ms a frame drawn in full). */
  let box = null, into = null;
  const boxer = {
    moveTo(x, y) { into.moveTo(x, y); grow(x, y); },
    lineTo(x, y) { into.lineTo(x, y); grow(x, y); },
    closePath() { into.closePath(); },
    arc(x, y, r, a0, a1) { into.arc(x, y, r, a0, a1); grow(x - r, y - r); grow(x + r, y + r); },
  };
  function grow(x, y) {
    if (x < box[0]) box[0] = x;
    if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x;
    if (y > box[3]) box[3] = y;
  }
  function readProjection() {
    if (!projIds.has(projection)) projIds.set(projection, ++projSerial);
    const pr = projection;
    form = [projIds.get(pr), pr.rotate ? pr.rotate() : "", pr.parallels ? pr.parallels() : "",
            pr.center ? pr.center() : ""].join("|");
    const [tx, ty] = pr.translate();
    fit = { k: pr.scale(), tx, ty, key: `${pr.scale()}|${tx}|${ty}` };
  }
  function entry(f) {
    const hit = shapes.get(f);
    if (hit && hit.form === form && hit.key === fit.key) return hit;
    const p = new Path2D();
    let b;
    if (hit && hit.form === form) {
      const r = fit.k / hit.k, dx = fit.tx - r * hit.tx, dy = fit.ty - r * hit.ty;
      p.addPath(hit.p, new DOMMatrix([r, 0, 0, r, dx, dy]));
      b = [r * hit.b[0] + dx, r * hit.b[1] + dy, r * hit.b[2] + dx, r * hit.b[3] + dy];
    } else {
      box = [Infinity, Infinity, -Infinity, -Infinity];
      into = p;
      recorder.projection(projection).context(boxer)(f);
      b = box;
    }
    const e = { form, ...fit, p, b };
    shapes.set(f, e);
    return e;
  }
  /** The map-space rectangle on screen, [x0, y0, x1, y1]. */
  function onScreen() {
    const k = transform.k;
    return [-transform.x / k, -transform.y / k, (W - transform.x) / k, (H - transform.y) / k];
  }
  function off(b, v) {
    return b[2] < v[0] || b[0] > v[2] || b[3] < v[1] || b[1] > v[3];
  }

  function pickLayer() {
    for (let i = layers.length - 1; i >= 0; i--) if (layers[i].pick) return layers[i];
    return null;
  }

  function drawLayer(L) {
    if (L.visible === false || !L.features || !L.features.length) return;
    const blank = L.blank || theme().nodata;
    const lw = (L.lineWidth || 0) / transform.k;
    const v = onScreen();
    for (const f of L.features) {
      const e = entry(f);
      if (off(e.b, v)) continue;
      const fill = L.fill ? L.fill(f) : null;
      const stroke = typeof L.stroke === "function" ? L.stroke(f) : L.stroke;
      if (!fill && !stroke && !L.blank) continue;
      const p = e.p;
      if (fill || L.blank) {
        ctx.globalAlpha = L.alpha ? L.alpha(f) : 1;
        ctx.fillStyle = fill || blank;   // no data: visibly absent, not zero
        ctx.fill(p);
      }
      if (stroke && lw > 0) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lw;
        ctx.stroke(p);
      }
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    // The ResizeObserver below is asynchronous and runs only when the page
    // renders, so a page loaded behind another window, or a pane resized by
    // a split, could draw a frame fitted to a box it no longer has -- the
    // national map spilling off a phone's right edge. Every frame checks its
    // box first; resize() refits and renders, so this cannot recurse.
    const r = stage.getBoundingClientRect();
    if (r.width >= 1 && r.height >= 1 &&
        (Math.floor(r.width) !== W || Math.floor(r.height) !== H)) {
      resize();
      return;
    }
    readProjection();
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);
    for (const L of layers) drawLayer(L);
    ctx.restore();
    ctx.restore();
    // Anything drawn in screen pixels rather than map coordinates -- labels,
    // leader lines, a telestration layer -- goes here.
    emit("overlay", { ctx, dpr, W, H, transform, projection });
    picker.dirty = true;
  }

  function renderPick() {
    const L = pickLayer();
    const feats = (L && L.features) || [];
    readProjection();
    const v = onScreen();
    picker.render(feats, W, H, dpr, (c, setColor) => {
      c.translate(transform.x, transform.y);
      c.scale(transform.k, transform.k);
      for (let i = 0; i < feats.length; i++) {
        const e = entry(feats[i]);
        if (off(e.b, v)) continue;
        setColor(i);
        c.fill(e.p);
      }
    });
  }

  function featureAt(clientX, clientY) {
    const L = pickLayer();
    if (!L || !L.features || !L.features.length) return null;
    if (picker.dirty) renderPick();
    const r = cv.getBoundingClientRect();
    return picker.at(clientX - r.left, clientY - r.top, dpr);
  }

  function fitTo(features) {
    if (!features || !features.length) return;
    projection.fitExtent(extent(), { type: "FeatureCollection", features });
    transform = d3.zoomIdentity;
    d3.select(cv).call(zoom.transform, d3.zoomIdentity);
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    // The minimums are the stage's job (CSS); these guards only keep the
    // canvas from being zero-sized during layout transitions.
    const nextW = Math.max(1, Math.floor(r.width));
    const nextH = Math.max(1, Math.floor(r.height));
    const base = opts.extentFeatures ? opts.extentFeatures() : null;
    const sized = nextW === W && nextH === H;
    /* Same size is not the same as fitted. The box can be measured before
     * the geography has loaded -- the ResizeObserver or the check in
     * render() gets there first -- and the resize after loading then saw
     * an unchanged size and never fitted: the nation stayed at the
     * projection's default scale, twice too big on a phone (the rehearsal
     * failure of October 30). So refit whenever the features or the
     * projection being framed are not the ones last fitted. */
    if (sized && (!base || !base.length ||
                  (base === fitted.base && projection === fitted.projection))) return;
    if (!sized) {
      W = nextW;
      H = nextH;
      for (const c of [cv, picker.canvas]) {
        c.width = Math.floor(W * dpr);
        c.height = Math.floor(H * dpr);
      }
      cv.style.width = W + "px";
      cv.style.height = H + "px";
    }
    if (base && base.length) {
      projection.fitExtent(extent(), { type: "FeatureCollection", features: base });
      fitted = { base, projection };
    }
    render();
    emit("resize", { W, H });
  }

  function cancelAnimations() {
    gestures.stop();
    transitioning = false;
    afterSettle = null;
    for (const c of cancels) c();
    cancels = [];
  }

  /** Frame these features by tweening the zoom transform. */
  function zoomToFeatures(features, { margin = 0.85, maxScale = 60, duration = 650 } = {}) {
    const target = boundsTransformFor(path, features, W, H, margin, maxScale);
    cancelAnimations();
    cancels.push(animateZoomTo(zoom, d3.select(cv), transform, target, duration));
    return target;
  }

  /** The transform these features *would* get under another projection. */
  function frameUnder(proj, features, margin = 0.85, maxScale = 60) {
    return boundsTransformFor(d3.geoPath(proj), features, W, H, margin, maxScale);
  }

  /*
   * The choreography of entering or leaving a state: morph the geometry from
   * one projection to the other, then hand back to the live renderer under a
   * short crossfade. The morph ends on geometry identical to the first real
   * frame after it, so the hand-back carries only the color change from
   * rescaling to the new set of features, never a jump.
   */
  function transitionTo({ projection: projB, transform: endT = d3.zoomIdentity,
                          items = [], duration = 760, apply }) {
    cancelAnimations();
    const plan = morphPlan(projection, transform, projB, endT, items, W, H);
    transitioning = true;
    const settle = () => {
      transitioning = false;
      snapshot(cv, fadeCanvas);
      setProjection(projB);
      transform = endT;
      d3.select(cv).call(zoom.transform, endT);
      if (apply) apply();
      render();
      cancels.push(crossFade(ctx, fadeCanvas, 200, render));
      const next = afterSettle;
      afterSettle = null;
      if (next) next();
    };
    if (!plan.length) { settle(); return; }
    cancels.push(runMorph(ctx, plan, duration, dpr, W, H, settle));
  }

  const zoom = d3.zoom()
    .scaleExtent(opts.scaleExtent || [1, 220])
    // Only the wheel (and a trackpad pinch, which arrives as a ctrl-wheel):
    // drag, pinch, tap and momentum are core/input.js, on pointer events.
    .filter((ev) => ev.type === "wheel")
    .on("zoom", (ev) => {
      transform = ev.transform;
      render();
      emit("zoom", transform);
    });
  d3.select(cv).call(zoom).on("dblclick.zoom", null);

  const gestures = attachGestures(cv, {
    getTransform: () => transform,
    setTransform: (t) => zoom.transform(d3.select(cv), t),
    scaleExtent: opts.scaleExtent || [1, 220],
    onHover: (ev) => emit("hover", ev ? featureAt(ev.clientX, ev.clientY) : null, ev),
    onTap: (ev) => {
      const f = featureAt(ev.clientX, ev.clientY);
      // Hover first, so a tap shows in the readout whatever a mouse would.
      emit("hover", f, ev);
      emit("click", f, ev);
    },
  });

  onThemeChange(() => render());
  /* Not window resize: the stage changes size without the window doing
   * anything. Entering a state puts a back button in the control rail, the
   * rail wraps to two lines, the stage loses 30px -- and a projection fitted
   * to the old height draws the state off centre and over the footer. The
   * observer catches every cause, including the window. */
  window.addEventListener("resize", () => resize());
  if (window.ResizeObserver) new ResizeObserver(() => resize()).observe(stage);
  // A tab brought forward has had its layout changed while it was hidden.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) resize(); });

  const api = {
    on, render, resize, fitTo, featureAt, zoomToFeatures, frameUnder,
    transitionTo, setProjection, cancelAnimations, extentBox,
    setLayers(next) { layers = next; picker.dirty = true; },
    getLayers() { return layers; },
    /** Tween to a transform -- a preset, or back to the full frame. */
    animateTo(t, duration = 650) {
      // Never over a projection morph: cancelling one before it settles
      // leaves its last frame on screen for good. Run after it instead.
      if (transitioning) { afterSettle = () => api.animateTo(t, duration); return; }
      cancelAnimations();
      cancels.push(animateZoomTo(zoom, d3.select(cv), transform, t || d3.zoomIdentity, duration));
    },
    /** Where the view is, geographically: the screen centre as [lon, lat]
     * and the zoom factor. Survives a different screen size, which a pixel
     * transform does not, because the projection is refitted to the screen. */
    geoFrame() {
      const ll = projection.invert && projection.invert(transform.invert([W / 2, H / 2]));
      return { center: ll && ll.every(Number.isFinite) ? ll : null, zoom: transform.k };
    },
    /** The transform that puts [lon, lat] at the screen centre at zoom k. */
    transformFor(center, k) {
      const p = center && projection(center);
      if (!p || !p.every(Number.isFinite)) return null;
      return d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-p[0], -p[1]);
    },
    setZoomTransform(t) {
      transform = t;
      d3.select(cv).call(zoom.transform, t);
    },
    get projection() { return projection; },
    get path() { return path; },
    get transform() { return transform; },
    get size() { return { W, H, dpr }; },
    get ctx() { return ctx; },
    get canvas() { return cv; },
    get zoom() { return zoom; },
    get gestures() { return gestures; },
  };
  return api;
}
