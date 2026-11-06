/* Labels that do not sit on top of each other.
 *
 * Extracted from jcervas.github.io/maps/redrawn-districts-2026
 * (separate, layoutStateLabels, drawStateLabels), generalized from state
 * abbreviations to any list of labels.
 */

/**
 * Push L off o along whichever axis they overlap least.
 * `share` is how much of the correction L takes: 1 when o is immovable,
 * 0.5 when both ends are being separated and will each take half.
 */
export function separate(L, o, ohw, ohh, share) {
  const dx = L.x - o.x, dy = L.y - o.y;
  const ox = (L.hw + ohw) - Math.abs(dx);
  const oy = (L.hh + ohh) - Math.abs(dy);
  if (ox <= 0 || oy <= 0) return;              // not overlapping
  if (ox / (L.hw + ohw) < oy / (L.hh + ohh)) {
    L.x += (dx >= 0 ? ox : -ox) * share;       // least penetration: sideways
  } else {
    L.y += (dy >= 0 ? oy : -oy) * share;       // least penetration: vertically
  }
}

/**
 * Relax a label set until it stops overlapping, inside a box.
 * @param labels [{ text, x, y, hw, hh }] -- half-width and half-height in px
 * @param box    { x, y, w, h }
 * @param fixed  [{ x, y, hw, hh }] obstacles that do not move
 */
export function relaxLabels(labels, box, fixed = [], iterations = 60) {
  for (let it = 0; it < iterations; it++) {
    for (let a = 0; a < labels.length; a++) {
      const L = labels[a];
      for (const o of fixed) separate(L, o, o.hw, o.hh, 1);
      for (let d = 0; d < labels.length; d++) {
        if (d !== a) separate(L, labels[d], labels[d].hw, labels[d].hh, 0.5);
      }
      L.x = Math.min(Math.max(L.x, box.x + L.hw + 4), box.x + box.w - L.hw - 4);
      L.y = Math.min(Math.max(L.y, box.y + L.hh + 4), box.y + box.h - L.hh - 4);
    }
  }
  return labels;
}

/** Measure and lay out labels anchored at projected screen points. */
export function layoutLabels(ctx, items, box, font, fixed) {
  ctx.font = font;
  const labels = [];
  for (const it of items) {
    if (!isFinite(it.x) || !isFinite(it.y)) continue;
    labels.push({
      ...it,
      hw: ctx.measureText(it.text).width / 2 + 3,
      hh: 8,
    });
  }
  return relaxLabels(labels, box, fixed);
}

/** Draw with a halo, so the type survives any fill underneath it. */
export function drawLabels(ctx, labels, dpr, font, ink, paper, haloWidth = 3.5) {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  for (const L of labels) {
    ctx.lineWidth = haloWidth;
    ctx.strokeStyle = paper;
    ctx.strokeText(L.text, L.x, L.y);
    ctx.fillStyle = ink;
    ctx.fillText(L.text, L.x, L.y);
  }
  ctx.restore();
}
