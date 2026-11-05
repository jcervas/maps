// Pennsylvania population change, 2010-2020. Needs d3 v7 and topojson-client v3.
(function(){
  const root = document.querySelector(".pa-pop");
  fetch(root.dataset.topo).then(r => r.json()).then(topo => {
    const obj = topo.objects[Object.keys(topo.objects)[0]];
    const counties = topojson.feature(topo, obj).features;
    const data = counties.map(f => f.properties);

    const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const bins = [-5, -2, 0, 2, 5];
    const keys = ["--loss3","--loss2","--loss1","--gain1","--gain2","--gain3"];
    const labels = ["Below −5%","−5% to −2%","−2% to 0%","0% to 2%","2% to 5%","Above 5%"];
    const cls = p => d3.bisectRight(bins, p);
    const fill = p => `var(${keys[cls(p)]})`;
    const fmt = d3.format(",");
    const pctf = p => (p > 0 ? "+" : p < 0 ? "−" : "") + Math.abs(p).toFixed(1) + "%";

    // Summary
    const t10 = d3.sum(data, d => d.p10), t20 = d3.sum(data, d => d.p20);
    const grew = data.filter(d => d.pct > 0).length, lost = data.length - grew;
    root.querySelector("#stats").innerHTML = [
      [pctf((t20 - t10) / t10 * 100), "Statewide change"],
      ["+" + fmt(t20 - t10), `${fmt(t10)} → ${fmt(t20)} residents`],
      [`<span class="k-loss">${lost}</span>`, "Counties that lost population"],
      [`<span class="k-gain">${grew}</span>`, "Counties that grew"]
    ].map(([n,l]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join("");

    // Legend with counts
    const counts = d3.rollup(data, v => v.length, d => cls(d.pct));
    document.getElementById("legend").innerHTML = labels.map((l,i) =>
      `<span class="sw"><i style="background:var(${keys[i]})"></i>${l} <span style="font-family:var(--f-data)">(${counts.get(i)||0})</span></span>`).join("");

    // Map (geometry is pre-projected in feet; flip Y)
    const W = 960, H = 560;
    const proj = d3.geoIdentity().reflectY(true).fitExtent([[6,6],[W-6,H-6]], topojson.feature(topo, obj));
    const path = d3.geoPath(proj);
    const svg = d3.select("#map").attr("viewBox", `0 0 ${W} ${H}`);
    const tip = document.getElementById("tip");
    const fig = tip.parentElement;

    function show(d, ev){
      tip.hidden = false;
      tip.innerHTML = `<b>${d.name} County</b><br>
        <span class="v">${fmt(d.p10)} → ${fmt(d.p20)}</span><br>
        <span class="v" style="color:var(${d.pct>=0?"--gain3":"--loss3"});font-weight:600">${pctf(d.pct)}</span>
        <span class="v">(${d.chg>0?"+":""}${fmt(d.chg)})</span>`;
      if (ev){
        const r = fig.getBoundingClientRect();
        let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
        if (x + tip.offsetWidth > r.width - 8) x = ev.clientX - r.left - tip.offsetWidth - 14;
        tip.style.left = x + "px"; tip.style.top = y + "px";
      }
      hi(d.GEOID);
    }
    function hide(){ tip.hidden = true; hi(null); }
    function hi(id){
      d3.selectAll(".county").classed("hi", f => f.properties.GEOID === id).filter(f => f.properties.GEOID === id).raise();
      d3.selectAll("#strip .bar").classed("hi", d => d.GEOID === id);
      d3.selectAll("#tbl tbody tr").classed("hi", d => d.GEOID === id);
    }

    svg.append("g").selectAll("path").data(counties).join("path")
      .attr("class","county").attr("d", path).attr("fill", d => fill(d.properties.pct))
      .on("mousemove", (ev,d) => show(d.properties, ev)).on("mouseleave", hide)
      .append("title").text(d => `${d.properties.name}: ${pctf(d.properties.pct)}`);
    svg.append("path").attr("class","outline").datum(topojson.mesh(topo, obj, (a,b) => a === b)).attr("d", path);

    // Label the extremes and the big metros
    const named = new Set(["Philadelphia","Allegheny","Cumberland","Susquehanna","Cameron","Lancaster","Centre","Erie","Chester"]);
    svg.append("g").selectAll("text").data(counties.filter(f => named.has(f.properties.name))).join("text")
      .attr("class","lbl").attr("text-anchor","middle")
      .attr("transform", d => `translate(${path.centroid(d)})`)
      .text(d => `${d.properties.name} ${pctf(d.properties.pct)}`);

    // Ranked strip, switchable between percent and raw change
    const SW = 960, SH = 300, m = {t:10, r:10, b:78, l:52};
    const s = d3.select("#strip").attr("viewBox", `0 0 ${SW} ${SH}`);
    const gAxis = s.append("g").attr("class","axis").attr("transform",`translate(${m.l},0)`);
    const gBars = s.append("g"), gNames = s.append("g");
    const zero = s.append("line").attr("class","zero").attr("x1",m.l).attr("x2",SW-m.r);
    const kfmt = d3.format("+,~s");
    const modes = {
      pct: {get: d => d.pct, dom: [-12, 12], ticks: [-10,-5,0,5,10], tf: v => (v>0?"+":"") + v + "%",
            sub: "Percent change in total population, 2010 to 2020."},
      raw: {get: d => d.chg, dom: [-20000, 80000], ticks: [-20000,0,20000,40000,60000,80000], tf: v => v === 0 ? "0" : kfmt(v),
            sub: "Change in number of residents, 2010 to 2020. Philadelphia alone added 77,791."}
    };
    function drawStrip(key){
      const M = modes[key];
      document.getElementById("strip-sub").textContent = M.sub + " Hover a bar or a county to link the views.";
      d3.select("#m-pct").attr("aria-pressed", key === "pct");
      d3.select("#m-raw").attr("aria-pressed", key === "raw");
      const sorted = data.slice().sort((a,b) => d3.ascending(M.get(a), M.get(b)));
      const x = d3.scaleBand().domain(sorted.map(d => d.name)).range([m.l, SW-m.r]).padding(.18);
      const y = d3.scaleLinear().domain(M.dom).range([SH-m.b, m.t]);
      const t = s.transition().duration(matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 600);
      gAxis.transition(t).call(d3.axisLeft(y).tickValues(M.ticks).tickFormat(M.tf).tickSize(-(SW-m.l-m.r)))
        .call(g => g.select(".domain").remove());
      gBars.selectAll("rect").data(sorted, d => d.GEOID).join(
          enter => enter.append("rect").attr("class","bar").attr("fill", d => fill(d.pct))
            .on("mousemove", (ev,d) => show(d, ev)).on("mouseleave", hide))
        .transition(t)
        .attr("x", d => x(d.name)).attr("width", x.bandwidth())
        .attr("y", d => y(Math.max(0, M.get(d)))).attr("height", d => Math.abs(y(M.get(d)) - y(0)));
      gNames.selectAll("text").data(sorted, d => d.GEOID).join("text").attr("text-anchor","end").text(d => d.name)
        .transition(t).attr("transform", d => `translate(${x(d.name)+x.bandwidth()/2+3},${SH-m.b+8}) rotate(-60)`);
      zero.transition(t).attr("y1", y(0)).attr("y2", y(0));
    }
    document.getElementById("m-pct").onclick = () => drawStrip("pct");
    document.getElementById("m-raw").onclick = () => drawStrip("raw");
    drawStrip("pct");

    // Sortable table of all 67 counties
    const popRank = new Map(data.slice().sort((a,b) => b.p20 - a.p20).map((d,i) => [d.GEOID, i+1]));
    data.forEach(d => d.rank = popRank.get(d.GEOID));
    let sortKey = "p20", sortDir = "descending";
    function drawTable(){
      const rows = data.slice().sort((a,b) => {
        const c = sortKey === "name" ? d3.ascending(a.name, b.name) : d3.ascending(a[sortKey], b[sortKey]);
        return sortDir === "ascending" ? c : -c;
      });
      d3.selectAll("#tbl th").attr("aria-sort", function(){ return this.dataset.k === sortKey ? sortDir : null; });
      d3.select("#tbl tbody").selectAll("tr").data(rows, d => d.GEOID).join(enter => {
          const tr = enter.append("tr").on("mouseenter", (ev,d) => hi(d.GEOID)).on("mouseleave", () => hi(null));
          tr.append("td").attr("class","rank").text(d => d.rank);
          tr.append("td").html(d => `<span class="chip" style="background:${fill(d.pct)}"></span>${d.name}`);
          tr.append("td").attr("class","num").text(d => fmt(d.p10));
          tr.append("td").attr("class","num").text(d => fmt(d.p20));
          tr.append("td").attr("class","num").style("color", d => `var(${d.chg>=0?"--gain3":"--loss3"})`).text(d => (d.chg>0?"+":d.chg<0?"−":"") + fmt(Math.abs(d.chg)));
          tr.append("td").attr("class","num").style("color", d => `var(${d.pct>=0?"--gain3":"--loss3"})`).text(d => pctf(d.pct));
          return tr;
        }).order();
    }
    d3.selectAll("#tbl th button").on("click", function(){
      const k = this.parentNode.dataset.k;
      if (k === sortKey) sortDir = sortDir === "descending" ? "ascending" : "descending";
      else { sortKey = k; sortDir = (k === "name" || k === "rank") ? "ascending" : "descending"; }
      drawTable();
    });
    drawTable();
  });
})();
