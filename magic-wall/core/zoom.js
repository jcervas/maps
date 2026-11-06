/* Framing, tweening, and the crossfade that covers a projection swap.
 *
 * Extracted from jcervas.github.io/maps/redrawn-districts-2026
 * (boundsTransform, boundsTransformFor, snapshot, crossFade,
 * animateZoomTo, fitTo).
 *
 * The approach, which that file credits to daily-district: compute a target
 * transform from the feature's bounds in *projected* space and tween the
 * transform, instead of re-fitting the projection, which can only ever jump.
 * The tween is a plain requestAnimationFrame loop rather than a d3
 * transition -- a d3 transition tween silently failed to drive
 * zoom.transform, which is a trap worth not falling into twice.
 */

/**
 * The zoom transform that frames `features` under `pathGen`.
 * @param margin fraction of the viewport the features should fill (0.85)
 * @param maxScale ceiling, so one tiny county does not zoom to the moon
 */
export function boundsTransformFor(pathGen, features, w, h, margin, maxScale) {
  const b = pathGen.bounds({ type: "FeatureCollection", features });
  const [x0, y0] = b[0], [x1, y1] = b[1];
  const bw = x1 - x0, bh = y1 - y0;
  if (!(bw > 0) || !(bh > 0)) return d3.zoomIdentity;
  const k = Math.min(maxScale || 60, (margin || 0.85) / Math.max(bw / w, bh / h));
  return d3.zoomIdentity
    .translate(w / 2, h / 2)
    .scale(k)
    .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
}

/** Hold the current frame as an image, for crossFade to fade out over. */
export function snapshot(from, into) {
  into.width = from.width;
  into.height = from.height;
  into.getContext("2d").drawImage(from, 0, 0);
}

/*
 * Entering or leaving a state swaps the projection, and two projections have
 * nothing to interpolate between -- a zoom tween cannot cover it. So hold the
 * last frame as an image and fade it out over the newly projected scene.
 */
export function crossFade(ctx, fadeCanvas, dur, render, done) {
  const ease = d3.easeCubicInOut;
  const start = performance.now();
  let raf = null;
  (function frame() {
    const t = Math.min((performance.now() - start) / (dur || 340), 1);
    render();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1 - ease(t);
    ctx.drawImage(fadeCanvas, 0, 0);
    ctx.restore();
    if (t < 1) raf = requestAnimationFrame(frame);
    else if (done) done();
  })();
  return () => { if (raf) cancelAnimationFrame(raf); };
}

/** Tween the zoom transform. Returns a cancel function. */
export function animateZoomTo(zoom, selection, from, target, dur, done) {
  if (!target) { if (done) done(); return () => {}; }
  const k0 = from.k, x0 = from.x, y0 = from.y;
  const k1 = target.k, x1 = target.x, y1 = target.y;
  if (Math.abs(k1 - k0) < 1e-6 && Math.abs(x1 - x0) < 0.5 && Math.abs(y1 - y0) < 0.5) {
    if (done) done();
    return () => {};
  }
  const ease = d3.easeCubicInOut;
  const start = performance.now();
  let raf = null;
  (function frame() {
    const e = performance.now() - start;
    const t = ease(Math.min(e / (dur || 650), 1));
    zoom.transform(selection, d3.zoomIdentity
      .translate(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
      .scale(k0 + (k1 - k0) * t));
    if (e < (dur || 650)) raf = requestAnimationFrame(frame);
    else if (done) done();
  })();
  return () => { if (raf) cancelAnimationFrame(raf); };
}
