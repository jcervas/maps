/* Telestration: draw over whatever app is on the wall (DESIGN.md §2.5).
 *
 * Its own transparent canvas, stacked over the stage, so the map underneath
 * keeps rendering and keeps taking new numbers while the marks sit on top.
 * The canvas takes pointer events only while drawing is on; off, it is
 * pointer-events: none and every gesture reaches the map. That toggle is the
 * whole answer to "a finger draws" and "a finger pans" wanting the same
 * finger.
 *
 * Marks are in screen pixels, not map coordinates: a telestrator circles
 * what is on screen now. When the picture underneath changes (a drill-down,
 * a different app) the shell clears them, because a circle around a county
 * that has moved is worse than no circle.
 *
 * Every pointer is its own stroke, so two people can draw at once.
 */
import { theme, onThemeChange } from "../core/theme.js";

export function createTelestrator({ canvas, onChange }) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const strokes = [];            // { color, width, pts: [[x, y], ...] }
  const live = new Map();        // pointerId -> stroke being drawn
  let on = false;
  let color = 0;                 // index into colors()
  let width = 5;
  let W = 0, H = 0;

  // Two pens: a highlighter yellow that reads on every palette, and the
  // page's own ink. Party colors are deliberately not offered -- a red circle
  // on a results map says something nobody meant to say.
  const colors = () => ["#ffd21f", theme().ink];

  function resize() {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    if (w === W && h === H) return;
    W = w; H = h;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    draw();
  }

  function path(pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 1) { ctx.lineTo(pts[0][0] + 0.01, pts[0][1]); return; }
    // Through the midpoints, with each sample as the control point: smooth
    // without lagging behind the finger.
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const halo = theme().paper;
    for (const s of [...strokes, ...live.values()]) {
      if (!s.pts.length) continue;
      // A halo in the page color under every stroke, so yellow still reads
      // on a pale county and ink still reads on a dark one.
      path(s.pts);
      ctx.strokeStyle = halo;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = s.width + 4;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.stroke();
    }
  }

  const local = (ev) => {
    const r = canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  };

  canvas.addEventListener("pointerdown", (ev) => {
    if (!on || (ev.pointerType === "mouse" && ev.button !== 0)) return;
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* gone */ }
    live.set(ev.pointerId, { color: colors()[color], width, pts: [local(ev)] });
    draw();
    ev.preventDefault();
  });
  canvas.addEventListener("pointermove", (ev) => {
    const s = live.get(ev.pointerId);
    if (!s) return;
    // Coalesced events: a fast finger on a 120 Hz panel reports more points
    // than frames, and dropping them turns a circle into a polygon.
    const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
    for (const e of evs.length ? evs : [ev]) s.pts.push(local(e));
    draw();
  });
  const end = (ev) => {
    const s = live.get(ev.pointerId);
    if (!s) return;
    live.delete(ev.pointerId);
    strokes.push(s);
    draw();
    if (onChange) onChange(api);
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  onThemeChange(() => draw());
  if (window.ResizeObserver) new ResizeObserver(() => resize()).observe(canvas);
  window.addEventListener("resize", () => resize());

  const api = {
    get on() { return on; },
    get color() { return color; },
    get count() { return strokes.length; },
    colors,
    setOn(v) {
      on = !!v;
      canvas.classList.toggle("drawing", on);
      if (!on) live.clear();
      if (onChange) onChange(api);
    },
    toggle() { api.setOn(!on); },
    setColor(i) { color = i; if (onChange) onChange(api); },
    setWidth(w) { width = w; },
    undo() { strokes.pop(); draw(); if (onChange) onChange(api); },
    clear() {
      if (!strokes.length && !live.size) return;
      strokes.length = 0; live.clear(); draw();
      if (onChange) onChange(api);
    },
    resize,
  };
  resize();
  return api;
}
