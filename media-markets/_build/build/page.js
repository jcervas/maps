(function(){
const DMAS = DATA.dmas, SUM = DATA.summary;
let cycle = "2026";
const CDC = ()=>CDL.cycles[cycle];
let CDBY = {};
const rebuildCdIndex = ()=>{ CDBY = Object.fromEntries(CDC().cds.map(c=>[c.sd,c])); };
rebuildCdIndex();
const byIndex = new Map(DMAS.map(d=>[d.i,d]));
const fmt = n=>d3.format(",")(n);
const W=960,H=600;

/* ---------- geometry ---------- */
const dmaFC = topojson.feature(TOPO, TOPO.objects.nielsen_dma);
dmaFC.features.forEach((f,i)=>{ f.idx=i; f.rec=byIndex.get(i); });
const stObj = STATES.objects.states;
const projection = d3.geoAlbers().rotate([96,0]).parallels([29.5,45.5])
  .fitExtent([[12,12],[W-12,H-12]], dmaFC);
const path = d3.geoPath(projection);

const svg = d3.select("#map");
const g = svg.append("g");
const gDma = g.append("g");
const gCd = g.append("g").attr("class","cdlayer");
const gState = g.append("g").attr("class","statelayer");

const nodes = gDma.selectAll("path").data(dmaFC.features).join("path")
  .attr("class","dma").attr("d",path)
  .attr("tabindex",0)
  .attr("aria-label",d=>d.rec?d.rec.name:"market")
  .on("pointerenter",(e,d)=>{ hover(d); showTip(e,d); })
  .on("pointermove",showTip)
  .on("pointerleave",()=>{ d3.select("#tip").attr("hidden",""); if(!pinned) clearPanel(); render(); })
  .on("click",(e,d)=>pin(d.idx))
  .on("focus",(e,d)=>hover(d))
  .on("keydown",(e,d)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); pin(d.idx);} });

const cdLine = gCd.append("path").attr("class","cdline").attr("fill","none");
const cdChg  = gCd.append("path").attr("class","cdchg").attr("fill","none");
const cdCache = {};
function drawCd(){
  if(!cdCache[cycle]){
    const o = CDTOPO.objects["y"+cycle];
    const feats = topojson.feature(CDTOPO,o).features;
    cdCache[cycle] = {
      line: path(topojson.mesh(CDTOPO,o,(a,b)=>a!==b)),
      chg:  path({type:"FeatureCollection",
              features:feats.filter(f=>f.properties.changed===1)}) || ""
    };
  }
  cdLine.attr("d",cdCache[cycle].line);
  cdChg.attr("d",cdCache[cycle].chg);
}
drawCd();

gState.append("path").attr("class","stateline")
  .attr("d", path(topojson.mesh(STATES, stObj, (a,b)=>a!==b)));
gState.append("path").attr("class","stateline")
  .attr("d", path(topojson.mesh(STATES, stObj, (a,b)=>a===b)));

/* ---------- scales ---------- */
const popBreaks=[100e3,250e3,500e3,1e6,2e6,5e6];
const popRamp=["#dde8f5","#b6d0ec","#89b3e0","#5a8fd0","#3468b5","#1e4a8e","#12305f"];
const stateRamp={1:"#e7ebf1",2:"#f2d9a8",3:"#e2ab5c",4:"#c8801f",5:"#96570a"};
const tierRamp=["#12305f","#3468b5","#89b3e0","#c8d6e6","#e7ebf1"];
const voteScale=d3.scaleLinear().domain([-40,-12,0,12,40])
  .range(["#1f5fa8","#7fa9d6","#efe8dd","#d99287","#b3332b"]).clamp(true);

function margin(d){ return d.tot>0 ? 100*(d.gop-d.dem)/d.tot : null; }
function tier(r){ return r==null?null : r<=10?0 : r<=25?1 : r<=50?2 : r<=100?3 : 4; }

let mode="pop";
function fill(d){
  const r=d.rec;
  if(!r || r.pop===0) return "var(--nodata)";
  if(mode==="pop"){ let i=0; while(i<popBreaks.length && r.pop>=popBreaks[i]) i++; return popRamp[i]; }
  if(mode==="states"){ return stateRamp[Math.min(5,r.states.filter(s=>s[1]>0).length)]||"#e7ebf1"; }
  if(mode==="vote"){ const m=margin(r); return m==null?"var(--nodata)":voteScale(m); }
  if(mode==="tier"){ const t=tier(r.rank); return t==null?"var(--nodata)":tierRamp[t]; }
}

/* ---------- legend ---------- */
const LEG={
 pop:["Population",[["<100k",popRamp[0]],["100\u2013250k",popRamp[1]],["250\u2013500k",popRamp[2]],
   ["500k\u20131M",popRamp[3]],["1\u20132M",popRamp[4]],["2\u20135M",popRamp[5]],["5M+",popRamp[6]]]],
 states:["States in the market",[["1 state",stateRamp[1]],["2",stateRamp[2]],["3",stateRamp[3]],
   ["4",stateRamp[4]],["5",stateRamp[5]]]],
 vote:["2024 presidential margin",[["D+40",voteScale(-40)],["D+12",voteScale(-12)],["Even",voteScale(0)],
   ["R+12",voteScale(12)],["R+40",voteScale(40)]]],
 tier:["Rank by population",[["Top 10",tierRamp[0]],["11\u201325",tierRamp[1]],["26\u201350",tierRamp[2]],
   ["51\u2013100",tierRamp[3]],["101+",tierRamp[4]]]]
};
function legend(){
  const [t,keys]=LEG[mode];
  document.getElementById("legtitle").textContent=t;
  const cdOn=!document.getElementById("mapcard").classList.contains("hidden-cd");
  document.getElementById("leg").innerHTML =
    keys.map(([l,c])=>`<span class="lkey"><span class="sw" style="background:${c}"></span>${l}</span>`).join("")
    + `<span class="lkey"><span class="sw" style="background:var(--nodata)"></span>no data</span>`
    + (cdOn&&CDC().summary.changed?`<span class="lkey" style="color:var(--signal)"><span class="sw" style="background:var(--signal);border-radius:1px;height:3px"></span>redrawn for ${cycle}</span>`:"");
}

/* ---------- state + render ---------- */
let pinned=null, hovered=null, matched=null;
function render(){
  nodes.attr("fill",fill)
    .classed("sel",d=>d.idx===pinned)
    .attr("opacity",d=>{
      if(matched && !matched.has(d.idx)) return .18;
      if(pinned!=null && d.idx!==pinned) return .62;
      return 1;
    });
  gDma.selectAll("path.sel").raise();
  legend();
}

function hover(d){ hovered=d.idx; if(pinned==null) fillPanel(d.rec); }

function showTip(e,d){
  const t=d3.select("#tip"), r=(d&&d.rec)||(hovered!=null?byIndex.get(hovered):null);
  if(!r) return;
  const m=margin(r), ms=m==null?"":(m>0?`R+${m.toFixed(1)}`:`D+${(-m).toFixed(1)}`);
  t.attr("hidden",null).html(
    `<span class="t">${r.name}</span>`+
    (r.pop? `${fmt(r.pop)} people \u00b7 rank ${r.rank}<br><span class="m">${r.nc} counties \u00b7 ${r.states.filter(s=>s[1]>0).length} state${r.states.filter(s=>s[1]>0).length>1?"s":""}${ms?" \u00b7 "+ms:""}</span>`
          : `<span class="m">split county \u2014 not estimated</span>`));
  const n=t.node(), pad=14;
  let x=e.clientX+pad, y=e.clientY+pad;
  if(x+n.offsetWidth>innerWidth-8) x=e.clientX-n.offsetWidth-pad;
  if(y+n.offsetHeight>innerHeight-8) y=e.clientY-n.offsetHeight-pad;
  t.style("left",x+"px").style("top",Math.max(8,y)+"px");
}

function pin(i){
  pinned = (pinned===i)?null:i;
  if(pinned==null) clearPanel(); else fillPanel(byIndex.get(pinned));
  render();
}

function clearPanel(){
  document.getElementById("pname").textContent="Hover a market";
  document.getElementById("prank").textContent=`${SUM.n_dma-1} markets in the lower 48`;
  document.getElementById("pbody").hidden=true;
  document.getElementById("phint").hidden=false;
}

const STC={};
function stateColor(s){
  if(!STC[s]){ const h=[...s].reduce((a,c)=>a+c.charCodeAt(0)*37,0)%360;
    STC[s]=d3.hsl(h,.42,.56).formatHex(); }
  return STC[s];
}

function fillPanel(r){
  if(!r) return;
  const $=id=>document.getElementById(id);
  $("pname").textContent=r.name;
  $("phint").hidden=true; $("pbody").hidden=false;
  const act=r.states.filter(s=>s[1]>0);
  $("prank").textContent = r.pop ? `Rank ${r.rank} of ${SUM.n_dma-1} \u00b7 DMA ${r.dma}` : `DMA ${r.dma} \u00b7 split county`;
  $("v-pop").textContent = r.pop?fmt(r.pop):"\u2014";
  $("v-rank").textContent = r.rank?`#${r.rank}`:"\u2014";
  $("v-cty").textContent = r.nc||"\u2014";
  $("v-nst").textContent = act.length?act.map(s=>s[0]).join(" \u00b7 "):"\u2014";
  $("v-tv").textContent = r.tv?`${r.tv}%`:"\u2014";

  const tot=d3.sum(act,s=>s[1])||1;
  $("v-bar").innerHTML = act.map(s=>`<i style="width:${100*s[1]/tot}%;background:${stateColor(s[0])}"></i>`).join("");
  $("v-slist").innerHTML = act.map(s=>
    `<span class="dot" style="background:${stateColor(s[0])}"></span><b>${s[0]}</b><span>${(100*s[1]/tot).toFixed(1)}%</span>`).join("");

  if(r.tot>0){
    const gp=100*r.gop/r.tot, dp=100*r.dem/r.tot;
    $("v-vbar").innerHTML=`<i style="width:${dp}%;background:var(--dem)"></i><i style="width:${gp}%;background:var(--gop)"></i>`;
    $("v-vote").innerHTML=
      `<span class="dot" style="background:var(--dem)"></span><b>Harris</b><span>${dp.toFixed(1)}%</span>`+
      `<span class="dot" style="background:var(--gop)"></span><b>Trump</b><span>${gp.toFixed(1)}%</span>`+
      `<span class="dot" style="background:transparent"></span><b>Total votes</b><span>${fmt(r.tot)}</span>`;
  } else { $("v-vbar").innerHTML=""; $("v-vote").innerHTML=`<span class="dot"></span><b>\u2014</b><span>no data</span>`; }

  const cdm = CDC().mk[String(r.i)];
  if(cdm){
    $("l-cd").hidden=false; $("v-cdn").hidden=false; $("v-cd").hidden=false;
    $("v-cdn").innerHTML = `Reaches <b>${cdm.n}</b> district${cdm.n>1?"s":""}`+
      (cdm.whole?` \u00b7 ${cdm.whole} wholly inside`:"");
    $("v-cd").innerHTML = cdm.top.slice(0,7).map(([sd,s])=>{
      const rec=CDBY[sd];
      return `<span class="dot" style="background:${rec&&rec.chg?"var(--signal)":"var(--accent)"}"></span>`+
        `<b>${sd}</b><span>${(s*100).toFixed(0)}% of it</span>`;}).join("")
      + (cdm.n>7?`<span class="dot" style="background:transparent"></span><span>+${cdm.n-7} more</span><span></span>`:"");
  } else { $("l-cd").hidden=true; $("v-cdn").hidden=true; $("v-cd").hidden=true; }

  $("v-counties").innerHTML = r.cty.slice(0,6).map(c=>
    `<span class="dot" style="background:${stateColor(c[2])}"></span><b>${c[1].replace(/ County$/,"")}, ${c[2]}</b><span>${fmt(c[3])}</span>`).join("")
    + (r.nc>6?`<span class="dot" style="background:transparent"></span><span>+${r.nc-6} more</span><span></span>`:"");
}

/* ---------- zoom ---------- */
const zoom=d3.zoom().scaleExtent([1,14])
  .on("start",()=>svg.classed("dragging",true))
  .on("end",()=>svg.classed("dragging",false))
  .on("zoom",ev=>{
    g.attr("transform",ev.transform);
    g.attr("stroke-width",1/ev.transform.k);
    gDma.selectAll("path").style("stroke-width",null);
    g.style("--k",ev.transform.k);
    document.getElementById("reset").hidden = ev.transform.k<=1.01;
  });
svg.call(zoom);
document.getElementById("reset").onclick=()=>svg.transition().duration(500).call(zoom.transform,d3.zoomIdentity);

function zoomTo(idx){
  const f=dmaFC.features[idx]; if(!f) return;
  const [[x0,y0],[x1,y1]]=path.bounds(f);
  const k=Math.min(9, .62/Math.max((x1-x0)/W,(y1-y0)/H));
  svg.transition().duration(650).call(zoom.transform,
    d3.zoomIdentity.translate(W/2,H/2).scale(k).translate(-(x0+x1)/2,-(y0+y1)/2));
}

/* ---------- controls ---------- */
document.querySelectorAll(".chip").forEach(b=>b.onclick=()=>{
  mode=b.dataset.mode;
  document.querySelectorAll(".chip").forEach(o=>o.setAttribute("aria-pressed",String(o===b)));
  render();
});
const lines=document.getElementById("t-lines");
lines.onclick=()=>{ const on=lines.getAttribute("aria-pressed")==="true";
  lines.setAttribute("aria-pressed",String(!on));
  document.getElementById("mapcard").classList.toggle("hidden-lines",on); };

document.getElementById("mapcard").classList.add("hidden-cd");
const cdTog=document.getElementById("t-cd");
cdTog.onclick=()=>{ const on=cdTog.getAttribute("aria-pressed")==="true";
  cdTog.setAttribute("aria-pressed",String(!on));
  document.getElementById("mapcard").classList.toggle("hidden-cd",on);
  document.getElementById("cycwrap").hidden=on; legend(); };

const search=document.getElementById("search");
search.oninput=()=>{
  const q=search.value.trim().toLowerCase();
  if(!q){ matched=null; render(); return; }
  const hits=DMAS.filter(d=>d.name.toLowerCase().includes(q));
  matched=new Set(hits.map(d=>d.i));
  if(hits.length===1){ pinned=hits[0].i; fillPanel(hits[0]); zoomTo(hits[0].i); }
  render();
};

/* ---------- tables + tiles ---------- */
const $=id=>document.getElementById(id);
$("s-multi").textContent=SUM.n_multi;
$("s-multipct").textContent=(100*SUM.pop_multi/SUM.total_pop).toFixed(0)+"%";
$("s-half").textContent=SUM.half_n;
$("s-top10").textContent=SUM.top10_share.toFixed(0)+"%";

const anchors={};
DMAS.forEach(d=>{ (d.cty||[]).forEach(c=>{
  if(d.home && c[2]!==d.home){ anchors[c[2]]=anchors[c[2]]||{};
    anchors[c[2]][d.name]=(anchors[c[2]][d.name]||0)+c[3]; } }); });

$("tb-states").innerHTML = SUM.statewise.filter(r=>r[3]>=5).slice(0,15).map(([s,tot,out,pc])=>{
  const top=Object.entries(anchors[s]||{}).sort((a,b)=>b[1]-a[1]).slice(0,2)
    .map(([n])=>n.split(",")[0].trim()).join(", ");
  return `<tr><td><b>${s}</b></td>
    <td><span class="minibar" style="width:${Math.max(2,pc*.75)}px"></span><span class="pct">${pc.toFixed(1)}%</span></td>
    <td>${fmt(out)}</td><td style="text-align:left;color:var(--muted)">${top||"\u2014"}</td></tr>`;
}).join("");

const ranked=DMAS.filter(d=>d.rank).sort((a,b)=>a.rank-b.rank).slice(0,25);
$("tb-top").innerHTML = ranked.map(r=>{
  const m=margin(r), ms=m==null?"\u2014":(m>0?`R+${m.toFixed(1)}`:`D+${(-m).toFixed(1)}`);
  const ns=r.states.filter(s=>s[1]>0);
  return `<tr><td>${r.rank}</td>
    <td style="text-align:left"><button class="rowbtn" data-i="${r.i}">${r.name}</button></td>
    <td>${fmt(r.pop)}</td><td>${r.nc}</td>
    <td>${ns.length>1?`<span class="pct">${ns.map(s=>s[0]).join(" ")}</span>`:ns[0][0]}</td>
    <td style="color:${m==null?"var(--muted)":(m>0?"var(--gop)":"var(--dem)")}">${ms}</td></tr>`;
}).join("");

const mname=i=>{const d=byIndex.get(i); return d?d.name:"\u2014";};
const mshort=i=>{const n=mname(i).split("(")[0].trim();
  return n.length>24?n.slice(0,23).replace(/[\s,-]+$/,"")+"\u2026":n;};
const mpop=i=>{const d=byIndex.get(i); return d?d.pop:0;};
const marg=m=>m==null?"\u2014":(m<0?`R+${(-m*100).toFixed(0)}`:`D+${(m*100).toFixed(0)}`);
const mcol=m=>m==null?"var(--muted)":(m<0?"var(--gop)":"var(--dem)");

function renderCd(){
const CS=CDC().summary;
$("c-split").textContent=CS.two_plus;
$("c-four").textContent=CS.four_plus;
$("c-reach").textContent=CS.median_reach.toFixed(1)+"\u00d7";
$("c-ny").textContent=(CDC().mk[String(DMAS.find(d=>d.rank===1).i)]||{n:0}).n;
$("c-chg").textContent=CS.changed;
$("c-chg").nextElementSibling.innerHTML = CS.changed
  ? `districts were redrawn for ${cycle} \u2014 the red outlines on the map`
  : `districts were redrawn for ${cycle}: these are the post-census lines everything else is measured against`;

const perMkt={}, costList=[];
for(const c of CDC().cds.filter(c=>c.reach).sort((a,b)=>b.reach-a.reach)){
  perMkt[c.prim]=(perMkt[c.prim]||0)+1;
  if(perMkt[c.prim]<=3) costList.push(c);
  if(costList.length===12) break;
}
$("tb-cost").innerHTML = costList
 .map(c=>`<tr><td style="text-align:left"><button class="rowbtn" data-i="${c.prim}">${c.sd}</button>${c.chg?'<span class="cdtag">2026</span>':''}</td>
   <td style="color:${mcol(c.mar)}">${marg(c.mar)}</td>
   <td style="text-align:left;color:var(--muted)" title="${mname(c.prim)}">${mshort(c.prim)}</td>
   <td><span class="xr">${c.reach.toFixed(1)}\u00d7</span></td></tr>`).join("");

$("tb-frag").innerHTML = CDC().cds.slice().sort((a,b)=>b.n-a.n||a.primsh-b.primsh).slice(0,12)
 .map(c=>`<tr><td style="text-align:left"><button class="rowbtn" data-i="${c.prim}">${c.sd}</button>${c.chg?'<span class="cdtag">2026</span>':''}</td>
   <td><span class="pct">${c.n}</span></td>
   <td>${(c.primsh*100).toFixed(0)}%</td>
   <td style="text-align:left;color:var(--muted)" title="${mname(c.prim)}">${mshort(c.prim)}</td></tr>`).join("");

document.querySelectorAll("#tb-cost .rowbtn,#tb-frag .rowbtn").forEach(b=>b.onclick=()=>rowJump(b,true));
}

// three-cycle comparison strip
const base=Object.fromEntries(CDL.cycles["2022"].cds.map(c=>[c.sd,c]));
const moved=y=>CDL.cycles[y].cds.filter(c=>base[c.sd]&&(base[c.sd].n!==c.n||base[c.sd].prim!==c.prim)).length;
$("flat").innerHTML = CDL.order.map(y=>{
  const s=CDL.cycles[y].summary;
  return `<div class="${y===cycle?"now":""}" data-y="${y}"><span class="y">${y} LINES</span>
    <span class="b">${s.two_plus}</span>
    <span class="s">districts split across 2+ markets<br>${s.changed} redrawn \u00b7 median ${s.median_reach.toFixed(1)}\u00d7 reach</span></div>`;
}).join("");
$("f-moved").textContent=moved("2026");

function rowJump(b,isCd){
  const i=+b.dataset.i; if(isNaN(i)) return;
  pinned=i; fillPanel(byIndex.get(i)); zoomTo(i); render();
  if(isCd){ cdTog.setAttribute("aria-pressed","true");
    document.getElementById("mapcard").classList.remove("hidden-cd");
    document.getElementById("cycwrap").hidden=false; legend(); }
  document.getElementById("mapcard").scrollIntoView({behavior:"smooth",block:"center"});
}

// cycle switching
document.querySelectorAll(".cyc button").forEach(btn=>btn.onclick=()=>{
  cycle=btn.dataset.y;
  document.querySelectorAll(".cyc button").forEach(o=>o.setAttribute("aria-pressed",String(o===btn)));
  document.querySelectorAll("#flat div").forEach(d=>d.classList.toggle("now",d.dataset.y===cycle));
  rebuildCdIndex(); drawCd(); renderCd(); legend();
  if(pinned!=null) fillPanel(byIndex.get(pinned));
});
renderCd();

document.querySelectorAll("#tb-top .rowbtn").forEach(b=>b.onclick=()=>rowJump(b,false));

/* ---------- boot ---------- */
clearPanel();
fillPanel(DMAS.find(d=>d.rank===1));
pinned=DMAS.find(d=>d.rank===1).i;
render();
})();
