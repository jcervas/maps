/* editor.js -- see index.html for what this page is. */
(function () {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const $ = (id) => document.getElementById(id);
  const svg = $("ce-svg");

  let FC = null;                  // the file, exactly as loaded
  let H = 0, W = 0;               // design frame
  let byState = new Map();        // st -> {feats, cells, outline, label, node, labelNode, off, labOff}
  let FILENAME = "cartogram.geojson";
  let sel = null;                 // {st, kind}

  const r2 = (n) => Math.round(n * 100) / 100;

  // The file is y-up; SVG is y-down. One flip on the way in, one on the way out.
  const toSvg = ([x, y]) => [x, H - y];
  const toFile = ([x, y]) => [r2(x), r2(H - y)];

  const rings = (g) => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);
  const mapGeom = (g, f) => ({
    type: g.type,
    coordinates: g.type === "Polygon"
      ? g.coordinates.map((r) => r.map(f))
      : g.coordinates.map((p) => p.map((r) => r.map(f))),
  });

  function pathOf(g) {
    const ring = (r) => "M" + r.map((p) => p[0] + "," + p[1]).join("L") + "Z";
    return rings(g).map((poly) => poly.map(ring).join("")).join("");
  }

  const el = (name, attrs) => {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  const centroidOf = (g) => {
    let cx = 0, cy = 0, a2 = 0;
    for (const poly of rings(g)) {
      const r = poly[0];
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
        a2 += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f;
      }
    }
    return a2 ? [cx / (3 * a2), cy / (3 * a2)] : rings(g)[0][0][0];
  };

  // ------------------------------------------------------------------ load --

  function load(text, name) {
    const fc = JSON.parse(text);
    if (fc.type !== "FeatureCollection") throw new Error("not a GeoJSON FeatureCollection");
    FC = fc;
    H = (fc.meta && fc.meta.height) || 748.8;
    W = (fc.meta && fc.meta.width) || 1152;
    FILENAME = name || FILENAME;

    byState = new Map();
    for (const f of fc.features) {
      const st = f.properties.st;
      if (!byState.has(st))
        byState.set(st, { st, feats: [], cells: [], outline: null, label: null,
                          off: [0, 0], labOff: [0, 0] });
      const rec = byState.get(st);
      rec.feats.push(f);
      // geometry in SVG space, kept beside the feature so the file is untouched
      // until save
      if (f.properties.kind === "label") {
        rec.label = f;
        rec.labelSvg = toSvg(f.geometry.coordinates);
      } else {
        f._svg = mapGeom(f.geometry, toSvg);
        if (f.properties.kind === "outline") rec.outline = f;
        else rec.cells.push(f);
      }
    }
    sel = null;
    render();
    $("ce-hint").textContent = `${byState.size} states · ${fc.features.length} features`;
  }

  // ---------------------------------------------------------------- render --

  function render() {
    svg.textContent = "";
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const gStates = el("g", {});
    const gLabels = el("g", {});
    const pal = FC.palette || {};

    for (const rec of byState.values()) {
      const g = el("g", { class: "ce-state", "data-st": rec.st });
      for (const c of rec.cells) {
        g.appendChild(el("path", {
          class: "ce-cell", d: pathOf(c._svg),
          fill: c.properties.fill || pal[c.properties.status] || pal.retained || "#B9BEC4",
        }));
      }
      if (rec.outline) g.appendChild(el("path", { class: "ce-outline", d: pathOf(rec.outline._svg) }));
      for (const c of rec.cells) {
        if (!c.properties.mark) continue;
        const [mx, my] = centroidOf(c._svg);
        const t = el("text", { class: "ce-clabel", x: mx, y: my });
        t.textContent = c.properties.mark;
        g.appendChild(t);
      }
      gStates.appendChild(g);
      rec.node = g;

      const t = el("text", {
        class: "ce-slabel", x: rec.labelSvg[0], y: rec.labelSvg[1],
        "text-anchor": rec.label.properties.anchor || "middle", "data-st": rec.st,
      });
      t.textContent = rec.label.properties.text || rec.st;
      gLabels.appendChild(t);
      rec.labelNode = t;
      applyOffsets(rec);
    }
    svg.appendChild(gStates);
    svg.appendChild(gLabels);
    applySelection();
    refreshMoved();
  }

  /* Dragging moves a transform rather than rewriting geometry: one attribute per
   * state instead of thousands of coordinates on every pointer event. The
   * offsets are baked into the coordinates on save. */
  function applyOffsets(rec) {
    rec.node.setAttribute("transform", `translate(${rec.off[0]},${rec.off[1]})`);
    rec.labelNode.setAttribute("x", rec.labelSvg[0] + rec.off[0] + rec.labOff[0]);
    rec.labelNode.setAttribute("y", rec.labelSvg[1] + rec.off[1] + rec.labOff[1]);
  }

  function applySelection() {
    for (const rec of byState.values()) {
      rec.node.classList.toggle("ce-sel", !!sel && sel.st === rec.st && sel.kind === "state");
      rec.labelNode.classList.toggle("ce-sel", !!sel && sel.st === rec.st && sel.kind === "label");
    }
  }

  function refreshMoved() {
    const list = $("ce-moved"); list.textContent = "";
    let n = 0;
    for (const rec of byState.values()) {
      const add = (what, d) => {
        if (!r2(d[0]) && !r2(d[1])) return;
        n++;
        const li = document.createElement("li");
        li.innerHTML = `<span><b>${rec.st}</b> <span class="ce-what">${what}</span></span>` +
                       `<span>${d[0] > 0 ? "+" : ""}${r2(d[0])}, ${d[1] > 0 ? "+" : ""}${r2(d[1])}</span>`;
        list.appendChild(li);
      };
      add("state", rec.off);
      add("label", rec.labOff);
    }
    $("ce-empty").style.display = n ? "none" : "";
    $("ce-save").disabled = $("ce-reset").disabled = !FC;
  }

  // --------------------------------------------------------------- dragging --

  let drag = null;
  const pt = (e) => {
    const b = svg.getBoundingClientRect();
    const k = W / b.width;
    return { x: (e.clientX - b.left) * k, y: (e.clientY - b.top) * k };
  };

  svg.addEventListener("pointerdown", (e) => {
    if (!FC) return;
    const lab = e.target.closest(".ce-slabel");
    const grp = e.target.closest(".ce-state");
    const st = lab ? lab.dataset.st : grp ? grp.dataset.st : null;
    if (!st) { sel = null; applySelection(); return; }
    sel = { st, kind: lab ? "label" : "state" };
    applySelection();
    drag = { rec: byState.get(st), kind: sel.kind, last: pt(e) };
    if (grp && !lab) grp.classList.add("ce-dragging");
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = pt(e);
    const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
    drag.last = p;
    const o = drag.kind === "label" ? drag.rec.labOff : drag.rec.off;
    o[0] += dx; o[1] += dy;
    applyOffsets(drag.rec);
  });

  const endDrag = () => {
    if (!drag) return;
    drag.rec.node.classList.remove("ce-dragging");
    drag = null;
    refreshMoved();
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  window.addEventListener("keydown", (e) => {
    if (!sel || !FC) return;
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    const rec = byState.get(sel.st), k = e.shiftKey ? 10 : 1;
    const o = sel.kind === "label" ? rec.labOff : rec.off;
    o[0] += d[0] * k; o[1] += d[1] * k;
    applyOffsets(rec);
    refreshMoved();
    e.preventDefault();
  });

  // -------------------------------------------------------------------- save --

  function save() {
    // Fold the drag offsets into the coordinates, so what is written is ordinary
    // flat GeoJSON with no transform left to apply.
    for (const rec of byState.values()) {
      const [ox, oy] = rec.off;
      if (ox || oy) {
        for (const f of rec.feats) {
          if (f.properties.kind === "label") continue;
          f.geometry = mapGeom(f._svg, ([x, y]) => toFile([x + ox, y + oy]));
        }
      }
      const lx = rec.labelSvg[0] + ox + rec.labOff[0];
      const ly = rec.labelSvg[1] + oy + rec.labOff[1];
      rec.label.geometry = { type: "Point", coordinates: toFile([lx, ly]) };
    }
    for (const f of FC.features) delete f._svg;
    if (FC.meta) FC.meta.edited = new Date().toISOString();

    const blob = new Blob([JSON.stringify(FC)], { type: "application/geo+json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = FILENAME;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);

    // reload from what was just written, so offsets start from zero again
    load(JSON.stringify(FC), FILENAME);
  }

  // -------------------------------------------------------------- plumbing --

  $("ce-file").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) f.text().then((t) => load(t, f.name)).catch((err) => alert("Could not open: " + err.message));
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) f.text().then((t) => load(t, f.name)).catch((err) => alert("Could not open: " + err.message));
  });
  $("ce-reset").addEventListener("click", () => {
    for (const rec of byState.values()) { rec.off = [0, 0]; rec.labOff = [0, 0]; applyOffsets(rec); }
    refreshMoved();
  });
  $("ce-save").addEventListener("click", save);

  /* Open whatever the page points at, so the editor arrives with a map in it
   * rather than an empty frame. Any other cartogram of the same shape can be
   * dropped on top. */
  const src = document.getElementById("ce-root").dataset.src;
  if (src) {
    fetch(src)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
      .then((t) => load(t, src.split("/").pop().split("?")[0]))
      .catch(() => { $("ce-hint").textContent = "Open a cartogram GeoJSON to begin."; });
  }
})();
