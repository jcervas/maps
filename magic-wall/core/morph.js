/* The projection-crossing morph.
 *
 * Extracted from jcervas.github.io/maps/redrawn-districts-2026
 * (morphPlan, drawPlan, runMorph).
 *
 * Going in and out of a state changes the projection. A zoom transform cannot
 * cross that -- the two CRSs share no scale or rotation -- but the picture
 * still can, because the change is continuous in the only place that matters:
 * every vertex has a screen position under the old projection and one under
 * the new, and the straight line between them is a perfectly good path. So
 * project each ring twice, in pixels, and walk from one to the other. The map
 * bends into the new projection while it zooms, and nothing has to be hidden
 * behind a fade.
 *
 * This is d3's path-tween idea applied to the easy case: both ends come from
 * the same geometry, so the vertices already correspond and there is nothing
 * to resample.
 */
import { ringsOf } from "./geom.js";

/**
 * Both endpoints in screen pixels: projection, then the zoom transform in
 * force at that end.
 * @param items [{ f, fill, stroke, lw, a0, a1 }] -- a0/a1 are start and end alpha
 */
export function morphPlan(projA, tA, projB, tB, items, w, h) {
  const plan = [];
  // A point a state projection is not meant for still projects, just
  // enormously far away -- Alaska through a Texas conic is thousands of
  // canvases off. Those rings are dropped rather than swept across the
  // screen; they are off canvas at both ends anyway.
  const BOUND = 50 * Math.max(w, h);
  for (const it of items) {
    const rings = ringsOf(it.f.geometry), keep = [];
    for (const ring of rings) {
      const n = ring.length;
      const ax = new Float64Array(n), ay = new Float64Array(n);
      const bx = new Float64Array(n), by = new Float64Array(n);
      let ok = true;
      for (let i = 0; i < n; i++) {
        const pa = projA(ring[i]), pb = projB(ring[i]);
        if (!pa || !pb || !isFinite(pa[0]) || !isFinite(pb[0])) { ok = false; break; }
        if (Math.abs(pb[0]) > BOUND || Math.abs(pb[1]) > BOUND) { ok = false; break; }
        ax[i] = tA.applyX(pa[0]); ay[i] = tA.applyY(pa[1]);
        bx[i] = tB.applyX(pb[0]); by[i] = tB.applyY(pb[1]);
      }
      if (ok) keep.push({ n, ax, ay, bx, by });
    }
    if (keep.length) {
      plan.push({ rings: keep, fill: it.fill, stroke: it.stroke,
                  lw: it.lw, a0: it.a0, a1: it.a1 });
    }
  }
  return plan;
}

/* Drawn straight in screen pixels, so line widths here are the on-screen
 * widths the renderer arrives at after dividing by the zoom scale. */
export function drawPlan(ctx, plan, u, dpr, w, h) {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);          // transparent, exactly as render leaves it
  for (const o of plan) {
    const a = o.a0 + (o.a1 - o.a0) * u;
    if (a <= 0.002) continue;
    ctx.beginPath();
    for (const g of o.rings) {
      for (let i = 0; i < g.n; i++) {
        const x = g.ax[i] + (g.bx[i] - g.ax[i]) * u;
        const y = g.ay[i] + (g.by[i] - g.ay[i]) * u;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
    ctx.globalAlpha = a;
    if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(); }
    if (o.stroke) { ctx.strokeStyle = o.stroke; ctx.lineWidth = o.lw; ctx.stroke(); }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

export function runMorph(ctx, plan, dur, dpr, w, h, done) {
  const ease = d3.easeCubicInOut, start = performance.now();
  let raf = null;
  (function frame() {
    const e = performance.now() - start;
    const u = ease(Math.min(e / dur, 1));
    drawPlan(ctx, plan, u, dpr, w, h);
    if (e < dur) raf = requestAnimationFrame(frame);
    else if (done) done();
  })();
  return () => { if (raf) cancelAnimationFrame(raf); };
}
