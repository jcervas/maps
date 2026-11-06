/* Pointer input: tap, drag, pinch, momentum, and hover where there is one.
 *
 * d3-zoom handles mouse and touch as two separate event families and has no
 * momentum, and a wall is fingers first: two people at the screen, a pinch
 * that starts as a pan, a flick that should keep going. So every gesture
 * except the wheel is handled here on pointer events, and d3-zoom is kept
 * only for the wheel (and trackpad pinch, which arrives as a ctrl-wheel) and
 * as the owner of the canonical transform -- everything here writes through
 * `setTransform`, which calls zoom.transform, so a wheel turn after a pinch
 * continues from where the pinch left off.
 *
 * Hover is a mouse affordance and only a mouse gets it. A tap is reported as
 * a hover on what was tapped and then a click, so whatever a pointer would
 * have shown in the readout, a finger shows too (DESIGN.md §9: no
 * hover-only affordance).
 */

// A finger wobbles more than a mouse; past this many CSS pixels a press is a
// drag, not a tap.
const SLOP = { mouse: 4, pen: 6, touch: 10 };
// Momentum: flicks slower than this stop dead, and velocity decays with this
// time constant (ms) -- roughly what a phone map feels like.
const MIN_FLICK = 0.25;          // px per ms
const DECAY = 325;
const SAMPLE_MS = 90;            // velocity is measured over the last 90 ms
const HOVER_MS = 24;             // see view.js: a move can outrun a pick rebuild

export function attachGestures(el, {
  getTransform, setTransform, scaleExtent = [1, 220],
  onTap, onHover, onGestureStart,
}) {
  const pointers = new Map();    // pointerId -> { x, y, type }
  let pan = null;                // { x0, y0, t0, moved, type, samples }
  let pinch = null;              // { c0, d0, t0 }
  let flick = null;              // rAF id
  let hoverTimer = null;

  const local = (ev) => {
    const r = el.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const clampK = (k) => Math.max(scaleExtent[0], Math.min(scaleExtent[1], k));
  const at = (x, y, k) => d3.zoomIdentity.translate(x, y).scale(k);

  function stop() {
    if (flick) cancelAnimationFrame(flick);
    flick = null;
  }

  function startPan(p, type, moved) {
    pan = { x0: p.x, y0: p.y, t0: getTransform(), moved, type,
            samples: [{ x: p.x, y: p.y, t: performance.now() }] };
  }

  function startPinch() {
    const [a, b] = [...pointers.values()];
    pinch = {
      c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      t0: getTransform(),
    };
    pan = null;
  }

  el.addEventListener("pointerdown", (ev) => {
    // The left button, a finger or a pen; a right or middle click is not a
    // map gesture.
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    stop();
    try { el.setPointerCapture(ev.pointerId); } catch (_) { /* already gone */ }
    pointers.set(ev.pointerId, { ...local(ev), type: ev.pointerType });
    if (onGestureStart) onGestureStart();
    if (pointers.size === 1) startPan(local(ev), ev.pointerType, false);
    else if (pointers.size === 2) startPinch();
    ev.preventDefault();
  });

  el.addEventListener("pointermove", (ev) => {
    const p = local(ev);
    if (!pointers.has(ev.pointerId)) {
      // Not pressed: only a mouse (or a hovering pen) gets here.
      if (ev.pointerType === "touch" || !onHover || hoverTimer) return;
      hoverTimer = setTimeout(() => { hoverTimer = null; }, HOVER_MS);
      onHover(ev);
      return;
    }
    pointers.set(ev.pointerId, { ...p, type: ev.pointerType });

    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const { t0, c0, d0 } = pinch;
      const k = clampK(t0.k * d / d0);
      // Keep the map point that was under the fingers' midpoint at the start
      // under their midpoint now: that one rule gives pinch, pan and both
      // together.
      const mx = (c0.x - t0.x) / t0.k, my = (c0.y - t0.y) / t0.k;
      setTransform(at(c.x - mx * k, c.y - my * k, k));
      return;
    }
    if (!pan) return;
    const dx = p.x - pan.x0, dy = p.y - pan.y0;
    if (!pan.moved && Math.hypot(dx, dy) < (SLOP[pan.type] || SLOP.touch)) return;
    pan.moved = true;
    const now = performance.now();
    pan.samples.push({ x: p.x, y: p.y, t: now });
    while (pan.samples.length > 2 && now - pan.samples[0].t > SAMPLE_MS) pan.samples.shift();
    setTransform(at(pan.t0.x + dx, pan.t0.y + dy, pan.t0.k));
  });

  function release(ev, cancelled) {
    if (!pointers.has(ev.pointerId)) return;
    pointers.delete(ev.pointerId);
    if (pinch) {
      // Lifting one finger of a pinch hands over to a pan by the other, from
      // where the map is now, and can never become a tap.
      pinch = null;
      if (pointers.size === 1) {
        const [rest] = pointers.values();
        startPan(rest, rest.type, true);
      } else if (pointers.size >= 2) startPinch();
      return;
    }
    if (!pan || pointers.size) return;
    const done = pan;
    pan = null;
    if (cancelled) return;
    if (!done.moved) {
      if (onTap) onTap(ev);
      return;
    }
    coast(done.samples);
  }
  el.addEventListener("pointerup", (ev) => release(ev, false));
  el.addEventListener("pointercancel", (ev) => release(ev, true));
  el.addEventListener("pointerleave", (ev) => {
    if (ev.pointerType === "mouse" && !pointers.size && onHover) onHover(null);
  });

  function coast(samples) {
    const a = samples[0], b = samples[samples.length - 1];
    const dt = b.t - a.t;
    if (!(dt > 0) || performance.now() - b.t > 60) return;   // held still before letting go
    let vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
    if (Math.hypot(vx, vy) < MIN_FLICK) return;
    let last = performance.now();
    const frame = () => {
      const now = performance.now(), step = now - last;
      last = now;
      const t = getTransform();
      setTransform(at(t.x + vx * step, t.y + vy * step, t.k));
      const f = Math.exp(-step / DECAY);
      vx *= f; vy *= f;
      flick = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(frame) : null;
    };
    flick = requestAnimationFrame(frame);
  }

  return { stop, get active() { return pointers.size > 0; } };
}
