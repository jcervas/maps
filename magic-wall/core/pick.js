/* Hit testing by color index.
 *
 * An offscreen twin of the map where every shape is filled with a color
 * encoding its index, so one getImageData at the cursor identifies the
 * feature under it. Exact, and O(1) instead of testing three thousand
 * polygons per pointer move -- which is what makes a touch wall feel
 * instant rather than approximate.
 *
 * Extracted from jcervas.github.io/maps/redrawn-districts-2026
 * (idxToColor, colorToIdx, renderPick, featureAt).
 */

export function idxToColor(i) {
  const n = i + 1;                       // 0 is reserved for "nothing here"
  return `rgb(${n & 255},${(n >> 8) & 255},${(n >> 16) & 255})`;
}

export function colorToIdx(r, g, b) {
  return (r | (g << 8) | (b << 16)) - 1;
}

export class PickBuffer {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.features = [];
    this.dirty = true;
  }

  resize(w, h, dpr) {
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.dirty = true;
  }

  /**
   * Redraw the index. `draw` is handed this buffer's context and a function
   * that sets the fill for index i, and fills each feature in order; the caller owns
   * the transform, exactly as it owns the visible canvas's.
   */
  render(features, w, h, dpr, draw) {
    const c = this.ctx;
    this.features = features;
    c.save();
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    draw(c, (i) => { c.fillStyle = idxToColor(i); });
    c.restore();
    this.dirty = false;
  }

  /** The feature at a point in CSS pixels, or null.
   *
   * Canvas fills are anti-aliased, so the pixels along an edge are not an
   * index at all: half-transparent against the background, they decode to
   * a lower index (always an earlier feature -- New Jersey read as Alabama),
   * and between two shapes they blend into a third one. The cartogram, all
   * edges and gaps, made a tap land in the wrong state often enough to see.
   * So the vote is over a small patch around the point, counting only fully
   * opaque pixels, and the center counts double: the edge is a thin line
   * and loses to the shape on either side of it. */
  at(x, y, dpr) {
    const px = Math.floor(x * dpr), py = Math.floor(y * dpr);
    const cw = this.canvas.width, ch = this.canvas.height;
    if (px < 0 || py < 0 || px >= cw || py >= ch) return null;
    const r = Math.max(1, Math.round(dpr));               // 5 x 5 at dpr 2, 3 x 3 at 1
    const x0 = Math.max(0, px - r), y0 = Math.max(0, py - r);
    const w = Math.min(cw, px + r + 1) - x0, h = Math.min(ch, py + r + 1) - y0;
    const d = this.ctx.getImageData(x0, y0, w, h).data;
    const votes = new Map();
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const o = (j * w + i) * 4;
        if (d[o + 3] !== 255) continue;
        const idx = colorToIdx(d[o], d[o + 1], d[o + 2]);
        if (idx < 0 || idx >= this.features.length) continue;
        const center = x0 + i === px && y0 + j === py;
        votes.set(idx, (votes.get(idx) || 0) + (center ? 2 : 1));
      }
    }
    let best = -1, most = 0;
    for (const [idx, n] of votes) if (n > most) { best = idx; most = n; }
    return best >= 0 ? this.features[best] : null;
  }
}
