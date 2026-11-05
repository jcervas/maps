/* Mid-decade redistricting map.
   Data-driven: everything on the map (fills, hatching, value tiles, key, legend totals,
   annotation arrows) comes from data.csv. Edit the CSV to update the map.

   Label declutter borrows the Daily District approach: each value tile is anchored
   at its state's guaranteed-inside point (innerX/innerY baked into states.topojson),
   then a d3 force simulation (forceX/forceY toward the anchor + forceCollide) is run
   synchronously so tiles settle before first paint; displaced tiles get connector
   arrows back to their state. */

(function () {
  'use strict';

  const W = 975, H = 610;

  const fmtExp = v => {
    const s = Number.isInteger(v) ? String(v) : v.toFixed(2);
    return (v > 0 ? '+' : v < 0 ? '−' : '') + (v < 0 ? s.slice(1) : s);
  };
  const fmtInt = v => (v > 0 ? '+' + v : v < 0 ? '−' + Math.abs(v) : '0');

  Promise.all([
    fetch('states.topojson').then(r => { if (!r.ok) throw new Error('states ' + r.status); return r.json(); }),
    fetch('data.csv').then(r => {
      if (!r.ok) throw new Error('data ' + r.status);
      const mod = r.headers.get('last-modified');
      return r.text().then(text => ({ text, mod }));
    }),
    // Optional: the map still draws if the per-election detail is missing
    fetch('elections.csv').then(r => (r.ok ? r.text() : '')).catch(() => ''),
  ]).then(([topo, csv, electionsText]) => {
    // "Updated" line from the data file's HTTP timestamp (works on GitHub Pages)
    if (csv.mod) {
      const d = new Date(csv.mod);
      if (!isNaN(d)) {
        document.getElementById('updated-date').textContent =
          d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        document.getElementById('updated').hidden = false;
      }
    }

    const rows = d3.csvParse(csv.text, r => ({
      abbr: r.abbr.trim(),
      name: r.name,
      party: r.party || null,                    // dem | gop
      midDecade: r.mid_decade || null,           // partisan | court | possible
      status: r.status || null,                  // enacted | blocked | proposed
      exp: r.exp === '' ? null : +r.exp,
      lo: r.lo === '' ? null : +r.lo,
      hi: r.hi === '' ? null : +r.hi,
      // Drawing party's two-party share below which the new map backfires;
      // stored so tiles can lay out on first paint, checked against the live model
      backfire: r.backfire ? +r.backfire : null,
      callais: r.callais === '1',
      dx: r.dx === '' ? 0 : +r.dx,
      dy: r.dy === '' ? 0 : +r.dy,
    }));
    const byAbbr = new Map(rows.map(r => [r.abbr, r]));

    // One row per statewide election, per state: seats under the old plan and
    // under the new one. Leading #-comments in the file are documentation.
    const elections = d3.csvParse(
      electionsText.split('\n').filter(l => !l.startsWith('#')).join('\n'),
      r => ({
        abbr: r.abbr.trim(),
        code: r.code,                            // column name in data/<ST>_map_*.csv
        label: r.label,
        year: +r.year,
        demOld: +r.dem_old, repOld: +r.rep_old,
        demNew: +r.dem_new, repNew: +r.rep_new,
        gain: +r.rep_new - +r.rep_old,          // positive = Republican gain
      })
    );
    const electionsBy = d3.group(elections, e => e.abbr);

    const statesFC = topojson.feature(topo, topo.objects.states);
    // Leave a right margin clear of the map for the annotation and legend
    const projection = d3.geoAlbersUsa().fitExtent([[6, 6], [W - 185, H - 6]], statesFC);
    const path = d3.geoPath(projection);

    const svg = d3.select('#map').append('svg')
      .attr('viewBox', `0 0 ${W} ${H}`)
      .attr('preserveAspectRatio', 'xMidYMid meet');

    // ----- defs: hatch patterns + arrowhead -----
    const defs = svg.append('defs');

    const blocked = defs.append('pattern')
      .attr('id', 'hatch-blocked').attr('width', 5).attr('height', 5)
      .attr('patternUnits', 'userSpaceOnUse').attr('patternTransform', 'rotate(45)');
    blocked.append('rect').attr('class', 'hatch-b').attr('width', 5).attr('height', 5);
    blocked.append('rect').attr('class', 'hatch-a').attr('width', 5).attr('height', 2.5);

    // Sparser and mirrored, so proposed reads as distinct from blocked even when
    // the two are scattered across the map rather than side by side in the key
    const proposed = defs.append('pattern')
      .attr('id', 'hatch-proposed').attr('width', 9).attr('height', 9)
      .attr('patternUnits', 'userSpaceOnUse').attr('patternTransform', 'rotate(135)');
    proposed.append('rect').attr('class', 'hatch-b').attr('width', 9).attr('height', 9);
    proposed.append('rect').attr('class', 'hatch-a').attr('width', 9).attr('height', 2);

    defs.append('marker')
      .attr('id', 'arrowhead').attr('viewBox', '0 0 10 10')
      .attr('refX', 8).attr('refY', 5)
      .attr('markerWidth', 6).attr('markerHeight', 6)
      .attr('orient', 'auto-start-reverse')
      .append('path').attr('d', 'M 0 0 L 10 5 L 0 10 z').attr('class', 'arrowhead-path')
      .attr('fill', 'context-stroke');

    // ----- state fills -----
    const gStates = svg.append('g').attr('class', 'layer-states');
    gStates.selectAll('path')
      .data(statesFC.features)
      .join('path')
      .attr('d', path)
      .attr('class', f => {
        const r = byAbbr.get(f.properties.state);
        let cls = 'state';
        if (r) {
          cls += ' has-data';
          if (r.status === 'blocked') cls += ' st-blocked';
          else if (r.status === 'proposed') cls += ' st-proposed';
          else if (r.party) cls += ' st-' + r.party;
        }
        return cls;
      });

    // ----- borders: interior mesh, national outline, party outlines on top -----
    svg.append('path')
      .attr('class', 'borders')
      .attr('d', path(topojson.mesh(topo, topo.objects.states, (a, b) => a !== b)));
    svg.append('path')
      .attr('class', 'us-outline')
      .attr('d', path(topojson.mesh(topo, topo.objects.states, (a, b) => a === b)));

    svg.append('g').selectAll('path')
      .data(statesFC.features.filter(f => {
        const r = byAbbr.get(f.properties.state);
        return r && r.party;
      }))
      .join('path')
      .attr('d', path)
      .attr('class', f => {
        const r = byAbbr.get(f.properties.state);
        return 'state-outline st-' + r.party + (r.status === 'proposed' ? ' st-proposed' : '');
      });

    // ----- anchors (guaranteed-inside points from the topojson) -----
    const anchorOf = f => {
      const p = f.properties;
      const pt = (isFinite(p.innerX) && isFinite(p.innerY))
        ? projection([p.innerX, p.innerY]) : null;
      return pt && isFinite(pt[0]) ? pt : path.centroid(f);
    };
    const anchors = new Map(statesFC.features.map(f => [f.properties.state, anchorOf(f)]));

    // ----- value tiles with force-collision declutter -----
    const gConnect = svg.append('g').attr('class', 'layer-connectors');
    const gTiles = svg.append('g').attr('class', 'layer-tiles');

    // Tiles only for states with seat values; the name is added only where a new
    // map is actually in place for 2026 (proposed/blocked states stay unlabeled)
    const nodes = rows.filter(r => r.exp != null && anchors.has(r.abbr)).map(r => {
      const [ax, ay] = anchors.get(r.abbr);
      const ox = ax + r.dx, oy = ay + r.dy;
      return { r, ax, ay, ox, oy, x: ox, y: oy };
    });

    const tileEls = nodes.map(d => {
      const excluded = d.r.status === 'blocked';
      const g = gTiles.append('g')
        .attr('class', 'tile' + (excluded ? ' excluded' : ''));
      const size = Math.max(15, Math.min(30, 13 + d.r.exp * 2.8));
      if (d.r.status === 'enacted') g.append('text')
        .attr('class', 'tile-name')
        .attr('text-anchor', 'middle')
        .attr('font-size', '9.5px')
        .attr('y', -size * 0.9 - 2)
        .text(d.r.name.toUpperCase());
      const value = g.append('text')
        .attr('class', 'tile-value st-' + d.r.party)
        .attr('text-anchor', 'middle')
        .attr('font-size', size + 'px')
        .attr('y', 0)
        .text(fmtExp(d.r.exp));
      let range = null;
      if (d.r.lo != null && d.r.hi != null && !(d.r.lo === d.r.exp && d.r.hi === d.r.exp)) {
        range = g.append('text')
          .attr('class', 'tile-range')
          .attr('text-anchor', 'middle')
          .attr('font-size', '12px')
          .attr('y', 13)
          .text(`(${fmtInt(d.r.lo)}–${fmtInt(d.r.hi)})`);
      }
      if (d.r.backfire != null) g.append('text')
        .attr('class', 'tile-backfire')
        .attr('text-anchor', 'middle')
        .attr('font-size', '10px')
        .attr('y', range ? 25 : 13)
        .text(`backfires < ${d.r.backfire.toFixed(1)}%`);
      // Manual strike lines over both texts for blocked maps (SVG text-decoration
      // support is inconsistent across browsers)
      if (excluded) {
        [value, range].filter(Boolean).forEach(t => {
          const bb = t.node().getBBox();
          const y = bb.y + bb.height / 2 + (t === value ? 2 : 1);
          g.append('line').attr('class', 'strike')
            .attr('stroke-width', t === value ? 2.2 : 1.4)
            .attr('x1', bb.x - 1).attr('x2', bb.x + bb.width + 1)
            .attr('y1', y).attr('y2', y);
        });
      }
      // Collision radius from the rendered bbox; vertically center the group.
      // Wide-but-short name labels get a sub-half-width radius so they don't
      // push neighbors further than they visually need.
      const bb = g.node().getBBox();
      d.shiftY = -(bb.y + bb.height / 2);
      d.collide = Math.max(bb.height * 0.62, bb.width * 0.38) + 3;
      return g;
    });

    function applyTilePositions() {
      nodes.forEach((d, i) => {
        tileEls[i].attr('transform', `translate(${d.x},${d.y + d.shiftY})`);
      });
    }

    // Run the simulation synchronously so tiles are settled on first paint
    // (same pattern as Daily District's district tiles)
    const sim = d3.forceSimulation(nodes)
      .alphaDecay(0.12).alphaMin(0.01)
      .force('collide', d3.forceCollide(d => d.collide))
      .force('x', d3.forceX(d => d.ox).strength(0.7))
      .force('y', d3.forceY(d => d.oy).strength(0.7))
      .stop();
    sim.tick(Math.ceil(Math.log(sim.alphaMin() / sim.alpha()) / Math.log(1 - sim.alphaDecay())));
    applyTilePositions();

    // Connector arrows for tiles that ended up away from their state's anchor
    nodes.forEach(d => {
      const distA = Math.hypot(d.x - d.ax, d.y - d.ay);
      if (distA < 26) return;
      // Start just outside the tile, curve gently toward the anchor
      const angle = Math.atan2(d.ay - d.y, d.ax - d.x);
      const sx = d.x + Math.cos(angle) * (d.collide * 0.7);
      const sy = d.y + Math.sin(angle) * (d.collide * 0.55);
      const ex = d.ax - Math.cos(angle) * 6;
      const ey = d.ay - Math.sin(angle) * 6;
      const mx = (sx + ex) / 2 - (ey - sy) * 0.25;
      const my = (sy + ey) / 2 + (ex - sx) * 0.25;
      gConnect.append('path')
        .attr('class', 'connector')
        .attr('d', `M${sx},${sy} Q${mx},${my} ${ex},${ey}`)
        .attr('marker-end', 'url(#arrowhead)');
    });

    // ----- legend (totals computed from the data) -----
    const counted = rows.filter(r => r.exp != null && r.status === 'enacted');
    const demTotal = d3.sum(counted.filter(r => r.party === 'dem'), r => r.exp);
    const gopTotal = d3.sum(counted.filter(r => r.party === 'gop'), r => r.exp);
    const net = Math.abs(gopTotal - demTotal);
    const netParty = gopTotal >= demTotal ? 'gop' : 'dem';

    const legend = svg.append('g')
      .attr('class', 'legend')
      .attr('transform', `translate(${W - 242}, ${H - 128})`);
    legend.append('text').attr('class', 'legend-title')
      .attr('x', 0).attr('y', -24).text('Expected gain from enacted maps');
    const legendRows = [
      { label: 'Democrat', value: demTotal, party: 'dem' },
      { label: 'Republican', value: gopTotal, party: 'gop' },
      { label: 'Net gain', value: net, party: netParty, net: true },
    ];
    legendRows.forEach((row, i) => {
      const y = i * 34 + (row.net ? 12 : 0);
      if (row.net) {
        legend.append('line').attr('class', 'legend-rule')
          .attr('x1', 0).attr('x2', 230).attr('y1', y - 20).attr('y2', y - 20);
      }
      legend.append('text').attr('class', 'legend-label').attr('x', 0).attr('y', y).text(row.label);
      legend.append('text').attr('class', 'legend-value st-' + row.party)
        .attr('x', 230).attr('y', y).attr('text-anchor', 'end')
        .text('+' + row.value.toFixed(2));
    });

    // ----- key: what the shading means (built from the statuses in the data) -----
    const present = fn => rows.some(fn);
    const keyItems = [
      { swatch: 'st-gop', label: 'New map enacted, R gain',
        show: present(r => r.status === 'enacted' && r.party === 'gop') },
      { swatch: 'st-dem', label: 'New map enacted, D gain',
        show: present(r => r.status === 'enacted' && r.party === 'dem') },
      { swatch: 'st-blocked', label: 'Blocked or overturned', br: true,
        show: present(r => r.status === 'blocked') },
      { swatch: 'st-proposed', label: 'Proposed',
        show: present(r => r.status === 'proposed') },
      { strike: true, label: 'not counted in the totals',
        show: present(r => r.status === 'blocked' && r.exp != null) },
    ].filter(d => d.show);

    if (keyItems.length) {
      const gKey = svg.append('g').attr('class', 'key');
      const SW = 20, SH = 14, GAP = 7, ITEM_GAP = 26, ROW_H = 22;
      const maxW = W - 260;             // stop short of the totals block
      let x = 0, row = 0;
      keyItems.forEach(item => {
        const g = gKey.append('g');
        let markW = SW;
        if (item.strike) {
          // Sample of a struck-through value, drawn the same way the tiles are
          const t = g.append('text').attr('class', 'key-sample').attr('x', 0).attr('y', 0).text('+0.9');
          const bb = t.node().getBBox();
          markW = bb.width;
          g.append('line').attr('class', 'strike')
            .attr('x1', bb.x - 1).attr('x2', bb.x + bb.width + 1)
            .attr('y1', bb.y + bb.height / 2 + 1).attr('y2', bb.y + bb.height / 2 + 1);
        } else {
          g.append('rect').attr('class', 'key-swatch ' + item.swatch)
            .attr('x', 0).attr('y', -SH + 3).attr('width', SW).attr('height', SH);
        }
        const label = g.append('text').attr('class', 'key-label')
          .attr('x', markW + GAP).attr('y', 0).text(item.label);
        const itemW = markW + GAP + label.node().getComputedTextLength();
        // Break for a new line where asked, or when the row would overflow
        if (x > 0 && (item.br || x + itemW > maxW)) { row++; x = 0; }
        g.attr('transform', `translate(${x},${row * ROW_H})`);
        x += itemW + ITEM_GAP;
      });
      // Bottom-align the block, however many rows it needed
      gKey.attr('transform', `translate(6, ${H - 12 - row * ROW_H})`);
    }

    // ----- annotation: states taking steps after Callais -----
    const callaisStates = rows.filter(r => r.callais && anchors.has(r.abbr));
    if (callaisStates.length) {
      const ann = svg.append('g').attr('class', 'annotation');
      const ax = W - 218, ay = H * 0.58;
      const lines = ['Several states have taken', 'steps to change their maps', 'after Callais'];
      lines.forEach((line, i) => {
        const t = ann.append('text').attr('x', ax).attr('y', ay + i * 19);
        if (i === lines.length - 1) {
          t.text('after ');
          t.append('tspan').attr('class', 'em').text('Callais');
        } else t.text(line);
      });
      // One arrow to the nearest flagged state keeps the map uncluttered
      const target = callaisStates
        .map(r => ({ r, pt: anchors.get(r.abbr) }))
        .sort((a, b) => Math.hypot(a.pt[0] - ax, a.pt[1] - ay) - Math.hypot(b.pt[0] - ax, b.pt[1] - ay))[0];
      const [tx, ty] = target.pt;
      // Start below the text block and bow the curve away from the map (to the
      // south-east) so it doesn't cross the value tiles north of the target
      const sx = ax + 24, sy = ay + lines.length * 19 - 6;
      const mx = (sx + tx) / 2 + (ty - sy) * 0.45;
      const my = (sy + ty) / 2 - (tx - sx) * 0.45;
      ann.append('path')
        .attr('class', 'connector')
        .attr('d', `M${sx},${sy} Q${mx},${my} ${tx + 22},${ty + 14}`)
        .attr('marker-end', 'url(#arrowhead)');
    }

    // ----- tooltip -----
    const tooltip = document.getElementById('tooltip');
    const figure = document.querySelector('.map-figure');
    const statusText = r => {
      if (r.status === 'blocked') return 'New map blocked';
      if (r.status === 'proposed') return 'New map proposed';
      if (r.midDecade === 'court') return 'New map enacted after court ruling';
      return 'New map enacted';
    };
    const tipHtml = r => {
      let html = `<div class="tt-name">${r.name}</div><div class="tt-status">${statusText(r)}</div>`;
      if (r.exp != null) {
        const partyName = r.party === 'dem' ? 'D' : 'R';
        html += `<div class="tt-exp st-${r.party}">${fmtExp(r.exp)} ${partyName} expected`
          + (r.lo != null ? ` (${fmtInt(r.lo)}–${fmtInt(r.hi)})` : '') + '</div>';
      }
      const backfire = backfireText(r, readyModels.get(r.abbr));
      if (backfire) html += `<div class="tt-backfire">${backfire}</div>`;
      return html;
    };
    let hovered = null;
    gStates.selectAll('path.has-data')
      .on('mousemove', function (event, f) {
        const r = byAbbr.get(f.properties.state);
        if (!r) return;
        // The backfire line needs the district files; fill it in once they load
        if (hovered !== r.abbr) {
          hovered = r.abbr;
          if (!readyModels.has(r.abbr)) loadModel(r.abbr).then(() => {
            if (hovered === r.abbr && !tooltip.hidden) tooltip.innerHTML = tipHtml(r);
          });
        }
        tooltip.innerHTML = tipHtml(r);
        tooltip.hidden = false;
        const rect = figure.getBoundingClientRect();
        const x = Math.min(event.clientX - rect.left + 14, rect.width - tooltip.offsetWidth - 6);
        const y = event.clientY - rect.top + 14;
        tooltip.style.left = x + 'px';
        tooltip.style.top = y + 'px';
      })
      .on('mouseleave', () => { tooltip.hidden = true; hovered = null; });

    // ----- detail table: one row per election for the selected state -----
    const detail = document.getElementById('detail');
    const featureOf = new Map(statesFC.features.map(f => [f.properties.state, f]));
    // Selection outline lives above every other layer so it is never covered
    const selectOutline = svg.append('g').attr('class', 'layer-select')
      .append('path').attr('class', 'select-outline');

    const esc = v => String(v).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const gainLabel = g => (g > 0 ? 'R +' + g : g < 0 ? 'D +' + -g : 'even');
    const gainParty = g => (g > 0 ? 'gop' : g < 0 ? 'dem' : null);

    // Diverging bar: Republican gains grow right of the centre line, Democratic
    // gains left, scaled against the state's largest swing
    const changeCell = (g, max) => {
      const w = max ? Math.abs(g) / max * 100 : 0;
      const party = gainParty(g);
      const bar = party
        ? `<span class="bar st-${party}" style="width:${w.toFixed(1)}%"></span>` : '';
      return `<td class="c-change">
          <span class="bar-wrap">
            <span class="bar-half left">${g < 0 ? bar : ''}</span>
            <span class="bar-half right">${g > 0 ? bar : ''}</span>
          </span>
          <span class="change-label${party ? ' st-' + party : ''}">${gainLabel(g)}</span>
        </td>`;
    };

    const seatCell = (d, r) =>
      `<td class="c-seats"><span class="st-dem">${d}</span>` +
      `<span class="dash">&ndash;</span><span class="st-gop">${r}</span></td>`;

    // ----- vote share: every election recentered to one two-party split -----
    // data/<ST>_map_{old,new}.csv hold each district's Democratic share of the
    // two-party vote, one column per election (named by elections.csv's code).
    // To put an election at a Democratic share V, every district under both plans
    // moves by the same amount, V minus that election's own average, and seats
    // are recounted. Averaging across elections at each V gives the map's effect
    // at that split with the particular candidates smoothed out. Unshifted, the
    // counts are exactly elections.csv, which the table shows until a share is set.
    const SHARE_MIN = 25, SHARE_MAX = 75;          // Democratic share, percent
    const shareGrid = d3.range(SHARE_MIN * 10, SHARE_MAX * 10 + 1).map(i => i / 10);
    const shareIndex = v => Math.round((v - SHARE_MIN) * 10);
    let share = null;                              // null = actual results
    let redrawSwing = null;

    const partyNoun = p => (p === 'dem' ? 'Democrats' : 'Republicans');
    const pct = v => String(+v.toFixed(1));
    const fmtSplit = v => `${pct(v)}&ndash;${pct(100 - v)}`;
    const plainSplit = v => `${pct(v)}–${pct(100 - v)}`;
    const ownShare = (r, v) => (r.party === 'dem' ? v : 100 - v);  // the drawing party's share

    const districtCache = new Map();
    function loadDistricts(abbr) {
      if (!districtCache.has(abbr)) {
        const get = which => fetch(`data/${abbr}_map_${which}.csv`)
          .then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
          .then(t => d3.csvParse(t));
        districtCache.set(abbr, Promise.all([get('old'), get('new')]).catch(() => null));
      }
      return districtCache.get(abbr);
    }

    // One model per state, built once and shared by the map tooltip and the
    // detail panel; readyModels holds the finished ones for synchronous use
    const modelCache = new Map(), readyModels = new Map();
    const electionsOf = abbr => (electionsBy.get(abbr) || []).slice()
      .sort((a, b) => a.year - b.year || d3.ascending(a.label, b.label));
    function loadModel(abbr) {
      if (!modelCache.has(abbr)) {
        const r = byAbbr.get(abbr), rows = electionsOf(abbr);
        modelCache.set(abbr, (rows.length ? loadDistricts(abbr) : Promise.resolve(null))
          .then(csvs => {
            const model = csvs ? shareModel(r, rows, csvs) : null;
            readyModels.set(abbr, model);
            const live = model && model.flip != null ? ownShare(r, model.flip) : null;
            if (r.exp != null && (live == null ? r.backfire != null
              : r.backfire == null || Math.abs(live - r.backfire) > 0.05)) {
              console.warn(`data.csv backfire for ${abbr} is ${r.backfire}; `
                + `the district files give ${live == null ? 'none' : live.toFixed(1)}`);
            }
            return model;
          }));
      }
      return modelCache.get(abbr);
    }

    const backfireText = (r, model) => {
      if (!model) return null;
      const party = partyNoun(r.party);
      if (model.flip != null) return `Backfires if ${party} fall below `
        + `${pct(ownShare(r, model.flip))}% of the vote (avg. ${pct(ownShare(r, model.avg))}%)`;
      if (model.flipToward != null) return `Backfires only if ${party} rise above `
        + `${pct(ownShare(r, model.flipToward))}% of the vote`;
      return null;
    };

    function shareModel(r, rows, [oldCsv, newCsv]) {
      const shares = (csv, code) => csv.map(d => +d[code]);
      const elecs = rows.map(e => {
        const old = shares(oldCsv, e.code), nu = shares(newCsv, e.code);
        // An election's vote share is its average district. The two plans
        // average slightly differently (turnout differs by district), so take
        // the midpoint, keeping one shift for both plans: same votes, two maps.
        return { e, old, nu, base: 50 * (d3.mean(old) + d3.mean(nu)) };
      });
      if (!r.party || elecs.some(x => x.old.concat(x.nu).some(v => !isFinite(v)))) return null;
      const dem = (vs, shift) => vs.reduce((n, v) => n + (v + shift > 0.5), 0);
      const at = v => elecs.map(({ e, old, nu, base }) => {
        const shift = (v - base) / 100;
        const demOld = dem(old, shift), demNew = dem(nu, shift);
        const repOld = old.length - demOld, repNew = nu.length - demNew;
        return { label: e.label, year: e.year, demOld, repOld, demNew, repNew, gain: repNew - repOld };
      });
      // The chart follows the drawing party: its average seats under each plan,
      // and the new plan's gain over the old
      const orient = r.party === 'dem' ? -1 : 1;
      const own = (d, rp) => (r.party === 'dem' ? d : rp);
      const curve = shareGrid.map(v => {
        const pts = at(v);
        const olds = pts.map(p => own(p.demOld, p.repOld));
        const nus = pts.map(p => own(p.demNew, p.repNew));
        return {
          v, olds, nus,                            // per election, for the small multiples
          old: d3.mean(olds), nu: d3.mean(nus),
          gain: orient * d3.mean(pts, p => p.gain),
          // How far the individual elections spread around that average
          gLo: d3.min(pts, p => orient * p.gain),
          gHi: d3.max(pts, p => orient * p.gain),
          maxAbs: d3.max(pts, p => Math.abs(p.gain)),
        };
      });
      const avg = d3.mean(elecs, x => x.base);
      // The dummymander point: from the average result, the nearest share
      // against the drawing party at which the old map would have served it
      // better. A map can also fall behind in the drawing party's own wave.
      const against = r.party === 'dem' ? -1 : 1;  // direction of the Democratic share
      const firstLoss = dir => curve
        .filter(c => (c.v - avg) * dir > 0)
        .sort((a, b) => Math.abs(a.v - avg) - Math.abs(b.v - avg))
        .find(c => c.gain < 0);
      const flip = firstLoss(against), flipToward = firstLoss(-against);
      // The same point for each election on its own, measured from its own result
      const elecFlips = elecs.map((x, i) => {
        const c = curve
          .filter(c => (c.v - x.base) * against > 0)
          .sort((a, b) => Math.abs(a.v - x.base) - Math.abs(b.v - x.base))
          .find(c => c.nus[i] < c.olds[i]);
        return c ? c.v : null;
      });
      return {
        at, curve, avg, orient, elecFlips,
        seats: oldCsv.length,
        labels: rows.map(e => `${e.label} ${e.year}`),
        bases: elecs.map(x => x.base),
        flip: flip ? flip.v : null, flipToward: flipToward ? flipToward.v : null,
        max: Math.max(d3.max(curve, c => c.maxAbs), d3.max(rows, e => Math.abs(e.gain))) || 1,
      };
    }

    function drawShareChart(el, r, model, onPick) {
      el.innerHTML = '';
      const width = Math.max(280, el.clientWidth || 640);
      const narrow = width < 520;
      const party = partyNoun(r.party);
      // Two panels on one x-axis: each map's seats above, the gap between them below
      const m = { r: 14, l: 36 };
      const ph = narrow ? 120 : 140;                 // plot height of each panel
      const top1 = 40, bot1 = top1 + ph;
      const top2 = bot1 + 40, bot2 = top2 + ph;
      const height = bot2 + 44;
      // Democratic share falls left to right, matching the table's D-left bars
      const x = d3.scaleLinear([SHARE_MAX, SHARE_MIN], [m.l, width - m.r]);
      const ySeats = d3.scaleLinear([0, model.seats], [bot1, top1]);
      const lo = d3.min(model.curve, c => c.gLo), hi = d3.max(model.curve, c => c.gHi);
      const yGain = d3.scaleLinear([Math.min(0, lo), Math.max(0, hi)], [bot2, top2]).nice(5);
      const fmtGain = v => (v > 0 ? '+' + v : v < 0 ? '−' + Math.abs(v) : '0');

      const svg = d3.select(el).append('svg')
        .attr('viewBox', `0 0 ${width} ${height}`)
        .attr('width', width).attr('height', height)
        .attr('role', 'img')
        .attr('aria-label', `Seats ${party} win under the old and new maps, and the new map's `
          + `gain over the old, at each two-party vote split from ${SHARE_MAX}–${SHARE_MIN} to `
          + `${SHARE_MIN}–${SHARE_MAX}, Democrats first`
          + (model.flip != null ? `; the gain falls below zero at ${plainSplit(model.flip)}.` : '.'));

      const axis = (y, ticks, fmt, zero) => ticks.forEach(v => {
        svg.append('line').attr('class', v === zero ? 'swing-zero' : 'swing-grid')
          .attr('x1', m.l).attr('x2', width - m.r).attr('y1', y(v)).attr('y2', y(v));
        svg.append('text').attr('class', 'swing-tick').attr('x', m.l - 6).attr('y', y(v))
          .attr('dy', '0.32em').attr('text-anchor', 'end').text(fmt(v));
      });
      axis(ySeats, ySeats.ticks(4).filter(Number.isInteger), String, 0);
      axis(yGain, yGain.ticks(5), fmtGain, 0);

      const title = (y, text) => svg.append('text').attr('class', 'swing-panel-title')
        .attr('x', m.l).attr('y', y).text(text);
      title(top1 - 8, `Seats ${party} win, of ${model.seats}`);
      title(top2 - 8, `${party}’ gain from the new map`);

      [70, 60, 50, 40, 30].forEach(v => {
        svg.append('text').attr('class', 'swing-tick')
          .attr('x', x(v)).attr('y', bot2 + 16).attr('text-anchor', 'middle')
          .text(`${v}–${100 - v}`);
      });
      svg.append('text').attr('class', 'swing-axis-title')
        .attr('x', (m.l + width - m.r) / 2).attr('y', height - 6).attr('text-anchor', 'middle')
        .text('Two-party vote, Democratic–Republican (%)');

      // Where the actual elections fell, and their average
      svg.append('g').attr('class', 'swing-rug').selectAll('line')
        .data(model.bases).join('line')
        .attr('x1', v => x(v)).attr('x2', v => x(v)).attr('y1', bot2).attr('y2', bot2 - 7);
      [[top1, bot1], [top2, bot2]].forEach(([t, b]) => svg.append('line').attr('class', 'swing-actual')
        .attr('x1', x(model.avg)).attr('x2', x(model.avg)).attr('y1', t).attr('y2', b));

      // Range of the individual elections around the average gain; the
      // per-election charts under the table show the spread in seats
      svg.append('path').attr('class', 'swing-band')
        .attr('d', d3.area().x(c => x(c.v)).y0(c => yGain(c.gLo)).y1(c => yGain(c.gHi))(model.curve));

      // Dummymander zone, in both panels: wherever the new map wins fewer seats
      const below = c => c.gain < 0;
      svg.append('path').attr('class', 'swing-zone st-' + r.party)
        .attr('d', d3.area().defined(below)
          .x(c => x(c.v)).y0(c => ySeats(c.old)).y1(c => ySeats(c.nu))(model.curve));
      svg.append('path').attr('class', 'swing-zone st-' + r.party)
        .attr('d', d3.area().x(c => x(c.v)).y0(yGain(0)).y1(c => yGain(Math.min(0, c.gain)))(model.curve));

      svg.append('path').attr('class', 'swing-line swing-old')
        .attr('d', d3.line().x(c => x(c.v)).y(c => ySeats(c.old))(model.curve));
      svg.append('path').attr('class', 'swing-line st-' + r.party)
        .attr('d', d3.line().x(c => x(c.v)).y(c => ySeats(c.nu))(model.curve));
      svg.append('path').attr('class', 'swing-line st-' + r.party)
        .attr('d', d3.line().x(c => x(c.v)).y(c => yGain(c.gain))(model.curve));

      // Labels above the top panel: the average result and the backfire point,
      // each set on the side away from the other
      const flipLeft = model.flip != null && x(model.flip) < x(model.avg);
      const label = (v, text, cls, left) => svg.append('text').attr('class', cls)
        .attr('x', x(v) + (left ? -5 : 5)).attr('y', 11)
        .attr('text-anchor', left ? 'end' : 'start').text(text);
      label(model.avg, 'Avg. result', 'swing-avg-label', model.flip != null && !flipLeft);
      if (model.flip != null) {
        const fx = x(model.flip);
        svg.append('line').attr('class', 'swing-flip')
          .attr('x1', fx).attr('x2', fx).attr('y1', 14).attr('y2', bot2);
        label(model.flip, `Backfires past ${plainSplit(model.flip)}`, 'swing-flip-label', flipLeft);
      }
      // Panel titles sit over the reference lines
      svg.selectAll('.swing-panel-title').raise();

      // Hover guide (where the pointer is) and marker (the share in force),
      // each running through both panels
      const guide = svg.append('g').attr('class', 'swing-guide').style('display', 'none');
      guide.append('line').attr('y1', top1).attr('y2', bot2);
      const guideText = guide.append('text').attr('y', top2 + 12);
      const marker = svg.append('g').attr('class', 'swing-marker');
      marker.append('line').attr('y1', top1).attr('y2', bot2);
      const dotOld = marker.append('circle').attr('r', 4.5).attr('class', 'swing-old');
      const dotNew = marker.append('circle').attr('r', 4.5).attr('class', 'st-' + r.party);
      const dotGain = marker.append('circle').attr('r', 5).attr('class', 'st-' + r.party);

      const seatsText = s => (Math.round(s * 10) / 10).toFixed(1);
      const gainText = g => (g > 0.005 ? '+' + g.toFixed(2) : g < -0.005 ? '−' + (-g).toFixed(2) : '0');
      const place = (sel, v) => {
        sel.attr('transform', `translate(${x(v)},0)`);
        return model.curve[shareIndex(v)];
      };
      const update = v => {
        marker.style('display', v == null ? 'none' : null);
        if (v == null) return;
        const c = place(marker, v);
        dotOld.attr('cy', ySeats(c.old));
        dotNew.attr('cy', ySeats(c.nu));
        dotGain.attr('cy', yGain(c.gain));
      };

      const pick = event => {
        const [px] = d3.pointer(event, svg.node());
        return Math.round(Math.max(SHARE_MIN, Math.min(SHARE_MAX, x.invert(px))) * 10) / 10;
      };
      svg.append('rect').attr('class', 'swing-hit')
        .attr('x', m.l).attr('y', 0).attr('width', width - m.l - m.r).attr('height', bot2 + 4)
        .on('pointerdown', function (event) {
          this.setPointerCapture(event.pointerId);
          onPick(pick(event));
        })
        .on('pointermove', function (event) {
          const v = pick(event);
          if (this.hasPointerCapture(event.pointerId)) onPick(v);
          const c = place(guide.style('display', null), v);
          const right = x(v) > width - 170;
          guideText.attr('x', right ? -6 : 6).attr('text-anchor', right ? 'end' : 'start')
            .text(`${plainSplit(v)}: new ${seatsText(c.nu)}, old ${seatsText(c.old)} (${gainText(c.gain)})`);
        })
        .on('pointerleave', () => guide.style('display', 'none'));

      update(share);
      return update;
    }

    // Small multiples: the top panel's two seat curves for each election on its
    // own, on the same scales, so the spread the averages hide is visible
    function drawEach(el, r, model) {
      const party = partyNoun(r.party);
      const W = 200, H = 90, m = { t: 4, r: 4, b: 4, l: 4 };
      const x = d3.scaleLinear([SHARE_MAX, SHARE_MIN], [m.l, W - m.r]);
      const y = d3.scaleLinear([0, model.seats], [H - m.b, m.t]);
      el.innerHTML = `<h3 class="swing-title">Election by election</h3>
        <p class="swing-each-note">Each election moved to every vote share, on the same scales as
          the chart above: seats ${party} win under the new map (solid) and the old map (dashed),
          shaded where the old map does better. The dotted line marks the election&rsquo;s actual
          result.</p>
        <div class="each-grid"></div>`;
      const grid = d3.select(el).select('.each-grid');
      const markers = model.labels.map((label, i) => {
        const flip = model.elecFlips[i];
        const fig = grid.append('figure').attr('class', 'each');
        fig.append('figcaption').html(`<span class="each-name">${esc(label)}</span>`
          + `<span class="each-flip">${flip != null
            ? `backfires &lt; ${pct(ownShare(r, flip))}%` : 'no backfire point'}</span>`);
        const svg = fig.append('svg')
          .attr('viewBox', `0 0 ${W} ${H}`)
          .attr('role', 'img')
          .attr('aria-label', `${label}: seats ${party} win under each map at each vote share`
            + (flip != null ? `; the new map falls behind at ${plainSplit(flip)}.` : '.'));
        svg.append('line').attr('class', 'swing-zero')
          .attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(0)).attr('y2', y(0));
        svg.append('line').attr('class', 'each-even')
          .attr('x1', x(50)).attr('x2', x(50)).attr('y1', m.t).attr('y2', H - m.b);
        svg.append('line').attr('class', 'swing-actual')
          .attr('x1', x(model.bases[i])).attr('x2', x(model.bases[i])).attr('y1', m.t).attr('y2', H - m.b);
        svg.append('path').attr('class', 'swing-zone st-' + r.party)
          .attr('d', d3.area().defined(c => c.nus[i] < c.olds[i])
            .x(c => x(c.v)).y0(c => y(c.olds[i])).y1(c => y(c.nus[i]))(model.curve));
        svg.append('path').attr('class', 'swing-line swing-old')
          .attr('d', d3.line().x(c => x(c.v)).y(c => y(c.olds[i]))(model.curve));
        svg.append('path').attr('class', 'swing-line st-' + r.party)
          .attr('d', d3.line().x(c => x(c.v)).y(c => y(c.nus[i]))(model.curve));
        return svg.append('line').attr('class', 'each-marker').attr('y1', m.t).attr('y2', H - m.b);
      });
      return v => markers.forEach(mk => mk
        .style('display', v == null ? 'none' : null)
        .attr('x1', v == null ? 0 : x(v)).attr('x2', v == null ? 0 : x(v)));
    }

    const subText = (r, pts, v) => {
      let sub = statusText(r);
      if (!pts.length) return sub;
      const gains = pts.map(e => e.gain);
      sub += ` &middot; ${gainLabel(+d3.mean(gains).toFixed(2))} on average across `
        + `${pts.length} statewide elections (${gainLabel(d3.min(gains))} to `
        + `${gainLabel(d3.max(gains))})`;
      if (v != null) sub += `, with every election set to a ${fmtSplit(v)} D&ndash;R vote`;
      return sub;
    };

    function mountShare(el, eachEl, r, model, fillTable) {
      const party = partyNoun(r.party);
      // The drawing party's share, for prose about it
      const own = v => ownShare(r, v);
      // The readout's key numbers stand out: seats in the drawing party's color
      const seatsEm = n => `<span class="ro-seats st-${r.party}">${n.toFixed(2)}</span>`;
      const gainSentence = (g, lead) => (g > 0.005
        ? `${lead}, the new map gains ${party} ${seatsEm(g)} seats on average`
        : g < -0.005
          ? `${lead}, the map is a dummymander: ${party} would win ${seatsEm(-g)} `
            + `more seats on average under the old one`
          : `${lead}, the new map gains ${party} nothing over the old one`);

      let flipText;
      if (model.flip != null) {
        flipText = `On average, the new map becomes a <strong>dummymander</strong> &mdash; ${party} `
          + `would do better under the old map &mdash; once ${party} fall below `
          + `${pct(own(model.flip))}% of the two-party vote, `
          + `${Math.abs(model.flip - model.avg).toFixed(1)} points below their average result.`;
      } else {
        flipText = `The old map never does better for ${party} as their vote falls, down to `
          + `${pct(own(r.party === 'dem' ? SHARE_MIN : SHARE_MAX))}%`
          + (model.flipToward != null
            ? `, but it does once ${party} rise above ${pct(own(model.flipToward))}%: the old `
              + `lines then hand them more seats.`
            : '.');
      }

      el.innerHTML = `
        <h3 class="swing-title">When does the new map backfire?</h3>
        <p class="swing-flip-text">${flipText}</p>
        <div class="swing-legend">
          <span><i class="sw-line st-${r.party}"></i>New map</span>
          <span><i class="sw-line sw-old"></i>Old map</span>
          <span><i class="sw-band"></i>Range across elections</span>
          <span><i class="sw-zone st-${r.party}"></i>Dummymander: the old map would do better</span>
          <span><i class="sw-rug"></i>Actual elections</span>
        </div>
        <div class="swing-chart"></div>
        <div class="swing-control">
          <input type="range" class="swing-input" min="${SHARE_MIN}" max="${SHARE_MAX}" step="0.1"
            aria-label="Two-party vote share every election is set to">
          <div class="swing-scale">
            <span>&larr; More Democratic</span>
            <span>More Republican &rarr;</span>
          </div>
          <div class="swing-presets">
            <span>Set every election to</span>
            ${[55, 50, 45].map(v => `<button type="button" data-share="${v}">${v}&ndash;${100 - v}</button>`).join('')}
            <button type="button" class="swing-reset">Actual results</button>
          </div>
        </div>
        <p class="swing-readout"></p>
        <p class="swing-note">Vote shares are the average district&rsquo;s, which can differ from the
          statewide vote by a point or two because turnout varies. Each election is moved to the chosen
          share by shifting every district the same amount.</p>`;

      const chartEl = el.querySelector('.swing-chart');
      const input = el.querySelector('.swing-input');
      const readout = el.querySelector('.swing-readout');
      const reset = el.querySelector('.swing-reset');
      let updateChart = () => {};

      // The slider runs Republican to the right, so it holds the Republican share
      const set = v => {
        share = v;
        const shown = v == null ? model.avg : v;
        input.value = 100 - shown;
        input.setAttribute('aria-valuetext', v == null ? 'Actual results'
          : `Democrats ${pct(v)}%, Republicans ${pct(100 - v)}%`);
        reset.disabled = v == null;
        el.querySelectorAll('[data-share]').forEach(b =>
          b.setAttribute('aria-pressed', String(v != null && +b.dataset.share === v)));
        updateChart(v);
        updateEach(v);
        fillTable(v);
        readout.innerHTML = v == null
          ? `In the actual results, Democrats average <span class="ro-share">${pct(model.avg)}%</span> `
            + 'of the two-party vote. '
            + 'Set a share to put every election at the same split.'
          : gainSentence(model.curve[shareIndex(v)].gain,
            `With every election at <span class="ro-share">${fmtSplit(v)}</span>`)
            + '. The table below shows each election.';
      };

      const draw = () => { updateChart = drawShareChart(chartEl, r, model, set); };
      const updateEach = drawEach(eachEl, r, model);
      input.addEventListener('input', () => set(Math.round((100 - input.value) * 10) / 10));
      el.querySelectorAll('[data-share]').forEach(b =>
        b.addEventListener('click', () => set(+b.dataset.share)));
      reset.addEventListener('click', () => set(null));
      draw();
      redrawSwing = draw;
      set(share);
    }

    let resizeFrame = null;
    window.addEventListener('resize', () => {
      if (!redrawSwing || resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => { resizeFrame = null; if (redrawSwing) redrawSwing(); });
    });

    function renderDetail(abbr) {
      const r = byAbbr.get(abbr);
      if (!r) return;
      const rows = electionsOf(abbr);

      let html = `<div class="detail-head">
          <h2 class="detail-name">${esc(r.name)}</h2>
          <button type="button" class="detail-clear">Clear</button>
        </div>
        <p class="detail-sub">${subText(r, rows, null)}</p>`;

      if (!rows.length) {
        html += `<p class="detail-empty">No election-by-election detail for `
          + `${esc(r.name)} yet.</p>`;
      } else {
        html += `<div class="swing" hidden></div>
          <div class="detail-scroll"><table class="detail-table">
            <thead><tr>
              <th scope="col">Election</th>
              <th scope="col">Old<span class="wide"> map</span> <span class="dr">D&ndash;R</span></th>
              <th scope="col">New<span class="wide"> map</span> <span class="dr">D&ndash;R</span></th>
              <th scope="col">Change</th>
            </tr></thead>
            <tbody></tbody>
            <tfoot></tfoot>
          </table></div>
          <div class="swing-each" hidden></div>`;
      }
      detail.innerHTML = html;
      detail.querySelector('.detail-clear').addEventListener('click', () => select(null));
      if (!rows.length) return;

      const sub = detail.querySelector('.detail-sub');
      const tbody = detail.querySelector('tbody');
      const tfoot = detail.querySelector('tfoot');
      const fill = (pts, max, v) => {
        tbody.innerHTML = pts.map(e =>
          `<tr><th scope="row">${esc(e.label)} ${e.year}</th>`
          + seatCell(e.demOld, e.repOld) + seatCell(e.demNew, e.repNew)
          + changeCell(e.gain, max) + '</tr>').join('');
        const mean = +d3.mean(pts, e => e.gain).toFixed(2);
        tfoot.innerHTML = `<tr><th scope="row">Average</th><td></td><td></td>
          ${changeCell(mean, max)}</tr>`;
        sub.innerHTML = subText(r, pts, v);
      };
      fill(rows, d3.max(rows, e => Math.abs(e.gain)) || 1, null);

      loadModel(abbr).then(model => {
        if (selected !== abbr || !model) return;
        const el = detail.querySelector('.swing'), eachEl = detail.querySelector('.swing-each');
        el.hidden = eachEl.hidden = false;
        // Bars keep one scale across every share, so dragging doesn't rescale them
        mountShare(el, eachEl, r, model, v => (v == null
          ? fill(rows, model.max, null) : fill(model.at(v), model.max, v)));
      });
    }

    let selected = null;
    function select(abbr) {
      selected = abbr === selected ? null : abbr;
      selectOutline.attr('d', selected ? path(featureOf.get(selected)) : null);
      gStates.selectAll('path.has-data')
        .classed('is-selected', f => f.properties.state === selected)
        .attr('aria-pressed', f => String(f.properties.state === selected));
      redrawSwing = null;
      if (selected) renderDetail(selected);
      else detail.innerHTML =
        '<p class="detail-hint">Select a shaded state for its election-by-election detail.</p>';
    }

    gStates.selectAll('path.has-data')
      .attr('tabindex', 0)
      .attr('role', 'button')
      .attr('aria-pressed', 'false')
      .attr('aria-label', f => {
        const r = byAbbr.get(f.properties.state);
        return `${r.name}: ${statusText(r).toLowerCase()}`;
      })
      .on('click', (event, f) => select(f.properties.state))
      .on('keydown', (event, f) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select(f.properties.state);
        }
      });

    // Warm the models once the map has painted, so tooltips have their
    // backfire line by the time anyone hovers
    (window.requestIdleCallback || setTimeout)(() =>
      rows.filter(r => r.party && electionsBy.has(r.abbr)).forEach(r => loadModel(r.abbr)));
  }).catch(err => {
    console.error(err);
    document.getElementById('map').innerHTML =
      '<p style="color:var(--text-muted)">Could not load map data (' + err.message + ').</p>';
  });
})();
