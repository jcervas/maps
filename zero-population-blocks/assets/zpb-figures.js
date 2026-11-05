(function () {
/* The seven figures, lifted out of index.html, plus the loader that feeds
   them. Requires d3, loaded just before this. */

/* ------------------------------------------------------------------
   Geometry loader.

   The figures draw from path data that used to sit inline in the page.
   It now lives in assets/data/, and a figure asks for its own file when
   the reader gets near it, so a reader who stops at figure 2 never pays
   for the Kansas-Utah panels or the District.

   Each figure still builds its <svg> frame synchronously, before its data
   is asked for. That matters: the static twin for a section is hidden the
   moment a real <svg> appears there, and a frame that arrived late would
   leave the twin sitting under the live figure. If the geometry then
   fails to arrive, restore() puts the twin back, so a dropped request
   shows the static chart rather than an empty box.

   WHY IT DOES NOT ONLY WATCH THE VIEWPORT. IntersectionObserver does not
   report while the document is hidden, and a hidden document is not a
   rare thing: a link opened in a background tab, a print or screenshot
   run, a preview pane. Waiting on the viewport there would hold every
   figure empty for as long as nobody looked. So a page that starts hidden
   loads everything at once, exactly as it did when the data was inline,
   and the deadline catches the rest -- a figure whose box never reports,
   because a stylesheet failed and it has no height, still draws.
   ------------------------------------------------------------------ */
function zpbData(sel, url, draw) {
  var DEADLINE = 20000;
  var el = document.querySelector(sel);

  /* Put this section's static twin back. The sweep in zpb-doc.js hid it
     when the empty frame appeared; nothing else will bring it back. */
  function restore() {
    var n = el;
    while (n && n !== document.body && !(n.classList && n.classList.contains('section'))) n = n.parentNode;
    var twins = (n || document.body).querySelectorAll('.dd-fallback');
    for (var i = 0; i < twins.length; i++) twins[i].style.display = '';
  }

  var started = false;
  function go() {
    if (started) return;
    started = true;
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(draw).catch(restore);
  }

  /* The bundle is shared with the landing page, which carries only the
     national map. A figure whose container is not on this page has
     nothing to draw and nothing to fetch. */
  if (!el) return;

  if (!window.IntersectionObserver || document.hidden) return go();

  var io = new IntersectionObserver(function (es) {
    for (var i = 0; i < es.length; i++) {
      if (es[i].isIntersecting) { io.disconnect(); go(); return; }
    }
  }, { rootMargin: '800px 0px' });
  io.observe(el);
  setTimeout(function () { io.disconnect(); go(); }, DEADLINE);
}

(function(){
const W=40000,H=25006;
const wrap=d3.select("#zmap"), back=d3.select("#zmap-back");
const svg=wrap.append("svg").attr("viewBox","0 0 "+W+" "+H)
  .attr("style","max-width:100%;height:auto;display:block;cursor:pointer");
const g=svg.append("g");
// The layers are created empty, now, in paint order. The static twin for this
// section is keyed to an <svg> being present, so making the frame up front
// keeps the twin from sitting under the live figure while the geometry is
// still on the wire.
const gland=g.append("g"), gcoarse=g.append("g"), gcty=g.append("g"),
      gfine=g.append("g"), gborder=g.append("g"), ghit=g.append("g");
const tip=wrap.append("div").attr("class","zpb-tip").style("display","none");
const f=d3.format(",");
const card=(t,rows,foot)=>`<h4>${t}</h4><table>`+
  rows.map(r=>`<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join("")+`</table>`+
  (foot?`<div class="foot">${foot}</div>`:"");
let sel=-1, D=null, land=null, coarse=null;
const zoom=d3.zoom().scaleExtent([1,80]).on("zoom",ev=>g.attr("transform",ev.transform));
svg.call(zoom).on("wheel.zoom",null);

// The fine geometry rides along as STRINGS, one file per state, fetched the
// first time that state is opened. The country needs 134,000 vertices to
// draw; laying out the other 999,000 at load is work for a view nobody is on.
const fine={};
function stateGeom(i){
  if(!fine[i]) fine[i]=fetch("assets/data/st/"+i+".json").then(r=>r.json());
  return fine[i];
}

function show(i){
  if(!D) return;
  sel=i;
  land.attr("fill",(d,j)=>i<0||j===i?"#ffffff":"#E4E7E9");
  coarse.style("display",i<0?null:"none");
  gfine.selectAll("path").remove(); gcty.selectAll("path").remove();
  if(i>=0) stateGeom(i).then(s=>{
    if(sel!==i) return;            // the reader moved on while it loaded
    gcty.selectAll("path").data(s.c).join("path").attr("d",d=>d)
      .attr("fill","none").attr("stroke","#C3CBD1").attr("stroke-width",0.5)
      .attr("vector-effect","non-scaling-stroke");
    gfine.selectAll("path").data(s.z).join("path").attr("d",d=>d)
      .attr("fill","#C41230").attr("fill-rule","evenodd");
  });
  back.style("display",i<0?"none":"block");
  const t=i<0?d3.zoomIdentity
    :(()=>{const[x0,y0,x1,y1]=D.BB[i],k=Math.min(80,0.92/Math.max((x1-x0)/W,(y1-y0)/H));
           return d3.zoomIdentity.translate(W/2,H/2).scale(k)
             .translate(-(x0+x1)/2,-(y0+y1)/2);})();
  svg.transition().duration(760).call(zoom.transform,t);
}

zpbData("#zmap","assets/data/us.json",d=>{
  D=d;
  const {S,H:H_,OV,NM,PO,BL,LA,PL,AR,DN}=D;
  land=gland.selectAll("path").data(H_).join("path").attr("d",d=>d)
    .attr("fill","#ffffff").attr("fill-rule","evenodd");
  coarse=gcoarse.selectAll("path").data(OV).join("path").attr("d",d=>d)
    .attr("fill","#C41230").attr("fill-rule","evenodd");
  gborder.selectAll("path").data(S).join("path").attr("d",d=>d)
    .attr("fill","none").attr("stroke","#8d99ae").attr("stroke-width",0.6)
    .attr("vector-effect","non-scaling-stroke");
  ghit.selectAll("path").data(H_).join("path").attr("d",d=>d)
    .attr("fill","transparent").attr("fill-rule","evenodd")
    .on("click",function(ev,d){ ev.stopPropagation(); const i=H_.indexOf(d);
       tip.style("display","none"); show(i===sel?-1:i); })
    .on("mousemove",function(ev,d){
      const i=H_.indexOf(d);
      if(sel>=0&&i!==sel) return;
      tip.style("display","block").html(card(NM[i],[
        ["Population",f(PO[i])],
        ["Land area",f(AR[i])+" sq mi"],
        ["Land with no residents",f(LA[i])+" sq mi ("+PL[i].toFixed(1)+"%)"],
        ["Census blocks",f(BL[i])],
        ["Density",f(DN[i])+" per sq mi"]],
        sel>=0?"County lines shown for bearings. Land area only; blocks that are all water are not drawn."
              :"Click to zoom to "+NM[i]+"."));
      const b=wrap.node().getBoundingClientRect(), t=tip.node().getBoundingClientRect();
      let x=ev.clientX-b.left+16, y=ev.clientY-b.top+16;
      if(x+t.width>b.width) x=ev.clientX-b.left-t.width-16;
      if(y+t.height>b.height) y=Math.max(0,ev.clientY-b.top-t.height-16);
      tip.style("left",x+"px").style("top",y+"px");
    })
    .on("mouseleave",()=>tip.style("display","none"));
});

svg.on("click",()=>show(-1));
back.on("click",()=>show(-1));
const full=d3.select("#zmap-full");
full.on("click",ev=>{ ev.stopPropagation();
  const el=wrap.node();
  if(document.fullscreenElement) document.exitFullscreen();
  else if(el.requestFullscreen) el.requestFullscreen();
});
d3.select(document).on("fullscreenchange.zmap",()=>{
  const on=!!document.fullscreenElement;
  full.html(on?"&#10005;":"&#9974;")
      .attr("title",on?"Exit full screen":"Full screen")
      .attr("aria-label",on?"Exit full screen":"Full screen");
});
d3.select(window).on("keydown.zmap",ev=>{ if(ev.key==="Escape") show(-1); });
})();

(function(){
const L=["0","1-4","5-9","10-19","20-49","50-99","100-249","250-499","500-999","1,000+"],N=[2368443,499966,705628,1067631,1679778,1063661,585927,143011,49282,11628],P=[29,6.1,8.6,13.1,20.5,13,7.2,1.7,0.6,0.1],C=[29,35.1,43.7,56.8,77.3,90.3,97.5,99.3,99.9,100],TOT=8174955;
const W=700,HT=250,HB=120,GAP=34,FOOT=22,H=HT+GAP+HB,M={l:84,r:16,t:28,b:26};
const wrap=d3.select("#zhist");
const svg=wrap.append("svg").attr("viewBox","0 0 "+W+" "+(H+FOOT))
  .attr("style","max-width:100%;height:auto;font:12px inherit");
const f=d3.format(",");
const x=d3.scaleBand().domain(L).range([M.l,W-M.r]).padding(0.2);
const y=d3.scaleLinear().domain([0,d3.max(N)]).nice().range([HT-M.b,M.t]);
svg.append("g").attr("stroke","#76838C").attr("opacity",0.28)
  .selectAll("line").data(y.ticks(4)).join("line")
  .attr("x1",M.l).attr("x2",W-M.r).attr("y1",y).attr("y2",y);
const bars=svg.append("g").selectAll("rect").data(L).join("rect")
  .attr("x",d=>x(d)).attr("width",x.bandwidth())
  .attr("y",(d,i)=>y(N[i])).attr("height",(d,i)=>y(0)-y(N[i]))
  .attr("fill",(d,i)=>i===0?"#C41230":"#8d99ae");
// the share each bin holds, over its own bar
svg.append("g").selectAll("text").data(L).join("text")
  .attr("x",d=>x(d)+x.bandwidth()/2).attr("y",(d,i)=>y(N[i])-6)
  .attr("text-anchor","middle").attr("font-size","10px")
  .attr("fill",(d,i)=>i===0?"#C41230":"#4E5A63")
  .attr("font-weight",(d,i)=>i===0?700:400)
  .text((d,i)=>P[i].toFixed(1)+"%");
svg.append("g").attr("transform","translate(0,"+(HT-M.b)+")")
  .call(d3.axisBottom(x).tickSizeOuter(0));
svg.append("g").attr("transform","translate("+M.l+",0)")
  .call(d3.axisLeft(y).ticks(4).tickFormat(f).tickSizeOuter(0));
svg.append("text").attr("transform","rotate(-90)").attr("x",-(M.t+HT-M.b)/2)
  .attr("y",14).attr("text-anchor","middle").attr("font-size","11px")
  .attr("fill","#4E5A63").text("census blocks");
// running share
const y2=d3.scaleLinear().domain([0,100]).range([H-M.b,HT+GAP]);
svg.append("g").attr("stroke","#76838C").attr("opacity",0.28)
  .selectAll("line").data([0,50,100]).join("line")
  .attr("x1",M.l).attr("x2",W-M.r).attr("y1",y2).attr("y2",y2);
const pts=L.map((d,i)=>[x(d)+x.bandwidth()/2,y2(C[i])]);
svg.append("path").attr("fill","none").attr("stroke","#C41230")
  .attr("stroke-width",2)
  .attr("d",d3.line()(pts));
svg.append("g").selectAll("circle").data(L).join("circle")
  .attr("cx",(d,i)=>pts[i][0]).attr("cy",(d,i)=>pts[i][1]).attr("r",3)
  .attr("fill","#C41230");
svg.append("g").attr("transform","translate(0,"+(H-M.b)+")")
  .call(d3.axisBottom(x).tickSizeOuter(0));
svg.append("g").attr("transform","translate("+M.l+",0)")
  .call(d3.axisLeft(y2).tickValues([0,50,100]).tickFormat(d=>d+"%").tickSizeOuter(0));
svg.append("text").attr("transform","rotate(-90)").attr("x",-(HT+GAP+H-M.b)/2)
  .attr("y",14).attr("text-anchor","middle").attr("font-size","11px")
  .attr("fill","#4E5A63").text("running share");
svg.append("text").attr("x",(M.l+W-M.r)/2).attr("y",H+FOOT-6)
  .attr("text-anchor","middle").attr("font-size","11px").attr("fill","#4E5A63")
  .text("people counted in the block, 2020");
const tip=wrap.append("div").attr("class","zpb-tip").style("display","none");
const card=(t,rows)=>`<h4>${t}</h4><table>`+
  rows.map(r=>`<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join("")+`</table>`;
// one hit target per bin, spanning both panels
svg.append("g").selectAll("rect.hit").data(L).join("rect")
  .attr("x",d=>x(d)-x.step()*0.1).attr("y",M.t)
  .attr("width",x.step()).attr("height",H-M.b-M.t)
  .attr("fill","transparent").style("cursor","pointer")
  .on("mousemove",function(ev,d){
    const i=L.indexOf(d);
    bars.attr("opacity",(q,j)=>j===i?1:0.45);
    tip.style("display","block").html(card(
      d==="0"?"Blocks with nobody":d+" people",
      [["Census blocks",f(N[i])],["Share of all blocks",P[i].toFixed(1)+"%"],
       ["This bin and below",C[i].toFixed(1)+"%"]]));
    const b=wrap.node().getBoundingClientRect(), t=tip.node().getBoundingClientRect();
    let px=ev.clientX-b.left+16;
    if(px+t.width>b.width) px=ev.clientX-b.left-t.width-16;
    tip.style("left",px+"px")
       .style("top",Math.max(0,ev.clientY-b.top-t.height-14)+"px");
  })
  .on("mouseleave",()=>{tip.style("display","none");bars.attr("opacity",1);});
})();

(function(){
const L=["all water","under 1","1-4","5-9","10-24","25-49","50-99","100-249","250-999","1,000+"],N=[239227,327058,2387151,1183584,1017271,557333,479619,585581,1039528,358603],P=[2.9,4,29.2,14.5,12.4,6.8,5.9,7.2,12.7,4.4],C=[2.9,6.9,36.1,50.6,63,69.9,75.7,82.9,95.6,100],TOT=8174955;
const W=700,HT=250,HB=120,GAP=34,FOOT=22,H=HT+GAP+HB,M={l:84,r:16,t:28,b:26};
const wrap=d3.select("#zland");
const svg=wrap.append("svg").attr("viewBox","0 0 "+W+" "+(H+FOOT))
  .attr("style","max-width:100%;height:auto;font:12px inherit");
const f=d3.format(",");
const x=d3.scaleBand().domain(L).range([M.l,W-M.r]).padding(0.2);
const y=d3.scaleLinear().domain([0,d3.max(N)]).nice().range([HT-M.b,M.t]);
svg.append("g").attr("stroke","#76838C").attr("opacity",0.28)
  .selectAll("line").data(y.ticks(4)).join("line")
  .attr("x1",M.l).attr("x2",W-M.r).attr("y1",y).attr("y2",y);
const bars=svg.append("g").selectAll("rect").data(L).join("rect")
  .attr("x",d=>x(d)).attr("width",x.bandwidth())
  .attr("y",(d,i)=>y(N[i])).attr("height",(d,i)=>y(0)-y(N[i]))
  .attr("fill",(d,i)=>i===0?"#C41230":"#8d99ae");
// the share each bin holds, over its own bar
svg.append("g").selectAll("text").data(L).join("text")
  .attr("x",d=>x(d)+x.bandwidth()/2).attr("y",(d,i)=>y(N[i])-6)
  .attr("text-anchor","middle").attr("font-size","10px")
  .attr("fill",(d,i)=>i===0?"#C41230":"#4E5A63")
  .attr("font-weight",(d,i)=>i===0?700:400)
  .text((d,i)=>P[i].toFixed(1)+"%");
svg.append("g").attr("transform","translate(0,"+(HT-M.b)+")")
  .call(d3.axisBottom(x).tickSizeOuter(0));
svg.append("g").attr("transform","translate("+M.l+",0)")
  .call(d3.axisLeft(y).ticks(4).tickFormat(f).tickSizeOuter(0));
svg.append("text").attr("transform","rotate(-90)").attr("x",-(M.t+HT-M.b)/2)
  .attr("y",14).attr("text-anchor","middle").attr("font-size","11px")
  .attr("fill","#4E5A63").text("census blocks");
// running share
const y2=d3.scaleLinear().domain([0,100]).range([H-M.b,HT+GAP]);
svg.append("g").attr("stroke","#76838C").attr("opacity",0.28)
  .selectAll("line").data([0,50,100]).join("line")
  .attr("x1",M.l).attr("x2",W-M.r).attr("y1",y2).attr("y2",y2);
const pts=L.map((d,i)=>[x(d)+x.bandwidth()/2,y2(C[i])]);
svg.append("path").attr("fill","none").attr("stroke","#C41230")
  .attr("stroke-width",2)
  .attr("d",d3.line()(pts));
svg.append("g").selectAll("circle").data(L).join("circle")
  .attr("cx",(d,i)=>pts[i][0]).attr("cy",(d,i)=>pts[i][1]).attr("r",3)
  .attr("fill","#C41230");
svg.append("g").attr("transform","translate(0,"+(H-M.b)+")")
  .call(d3.axisBottom(x).tickSizeOuter(0));
svg.append("g").attr("transform","translate("+M.l+",0)")
  .call(d3.axisLeft(y2).tickValues([0,50,100]).tickFormat(d=>d+"%").tickSizeOuter(0));
svg.append("text").attr("transform","rotate(-90)").attr("x",-(HT+GAP+H-M.b)/2)
  .attr("y",14).attr("text-anchor","middle").attr("font-size","11px")
  .attr("fill","#4E5A63").text("running share");
svg.append("text").attr("x",(M.l+W-M.r)/2).attr("y",H+FOOT-6)
  .attr("text-anchor","middle").attr("font-size","11px").attr("fill","#4E5A63")
  .text("land area of the block, in acres");
const tip=wrap.append("div").attr("class","zpb-tip").style("display","none");
const card=(t,rows)=>`<h4>${t}</h4><table>`+
  rows.map(r=>`<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join("")+`</table>`;
// one hit target per bin, spanning both panels
svg.append("g").selectAll("rect.hit").data(L).join("rect")
  .attr("x",d=>x(d)-x.step()*0.1).attr("y",M.t)
  .attr("width",x.step()).attr("height",H-M.b-M.t)
  .attr("fill","transparent").style("cursor","pointer")
  .on("mousemove",function(ev,d){
    const i=L.indexOf(d);
    bars.attr("opacity",(q,j)=>j===i?1:0.45);
    tip.style("display","block").html(card(
      d==="all water"?"Blocks that are all water"
        :d==="under 1"?"Under 1 acre":d+" acres",
      [["Census blocks",f(N[i])],["Share of all blocks",P[i].toFixed(1)+"%"],
       ["This bin and below",C[i].toFixed(1)+"%"]]));
    const b=wrap.node().getBoundingClientRect(), t=tip.node().getBoundingClientRect();
    let px=ev.clientX-b.left+16;
    if(px+t.width>b.width) px=ev.clientX-b.left-t.width-16;
    tip.style("left",px+"px")
       .style("top",Math.max(0,ev.clientY-b.top-t.height-14)+"px");
  })
  .on("mouseleave",()=>{tip.style("display","none");bars.attr("opacity",1);});
})();

(function(){
const N=["Puerto Rico","Connecticut","Rhode Island","Massachusetts","New Jersey","Pennsylvania","New York","Indiana","Ohio","New Hampshire","Maryland","Michigan","Delaware","Illinois","District of Columbia","Tennessee","Florida","North Carolina","Vermont","California","South Carolina","Virginia","West Virginia","Wisconsin","Colorado","Georgia","Iowa","Washington","Arizona","Minnesota","Hawaii","Kentucky","Alabama","Mississippi","Oklahoma","Texas","Nebraska","Missouri","Utah","Maine","Arkansas","Louisiana","Kansas","Nevada","Oregon","South Dakota","Idaho","New Mexico","Montana","North Dakota","Wyoming","Alaska"],V=[12.9,15.86,16.64,17.78,17.95,18.39,20.25,20.45,20.53,20.76,22.13,22.17,24.17,24.82,25.15,25.52,25.74,26.05,26.96,27.35,28.18,28.22,28.54,28.62,28.82,28.96,29.12,29.51,30.56,30.71,30.97,30.97,30.98,31.02,32.38,32.85,33.02,33.37,34.29,35.19,35.41,35.48,36.74,38.6,39.54,42.89,43.66,47.2,50.56,52.47,57.49,58.82],BL=[41987,49926,25649,107278,137972,336985,288819,204568,276428,31948,83827,254730,20198,369978,6012,179717,390066,236638,24611,519723,146844,163491,72558,203059,140345,232717,175199,158093,155444,198705,14732,132662,185976,112241,180154,668757,119103,253632,71207,47138,136422,142874,172529,57409,130807,71383,81879,107215,88417,84566,53769,28568],ZB=[5417,7918,4267,19071,24760,61962,58480,41829,56759,6631,18553,56486,4881,91812,1512,45871,100414,61650,6635,142132,41375,46130,20708,58111,40446,67384,51024,46652,47506,61016,4563,41090,57610,34815,58328,219672,39324,84628,24415,16590,48301,50694,63380,22160,51726,30617,35745,50610,44700,44368,30912,16803];
const rowH=11,M={t:8,r:40,b:24,l:84},W=700,H=M.t+N.length*rowH+M.b;
const wrap=d3.select("#zstate");
const svg=wrap.append("svg").attr("viewBox","0 0 "+W+" "+H)
  .attr("style","max-width:100%;height:auto;font:7px inherit");
const f=d3.format(",");
const x=d3.scaleLinear().domain([0,d3.max(V)]).range([M.l,W-M.r]);
const y=d3.scaleBand().domain(N).range([M.t,H-M.b]).padding(0.24);
const bars=svg.append("g").selectAll("rect").data(N).join("rect")
  .attr("x",M.l).attr("y",d=>y(d)).attr("height",y.bandwidth())
  .attr("width",(d,i)=>x(V[i])-M.l).attr("fill","#C41230");
svg.append("g").selectAll("text").data(N).join("text")
  .attr("x",M.l-5).attr("y",d=>y(d)+y.bandwidth()/2).attr("dy","0.34em")
  .attr("text-anchor","end").attr("font-size","7px").attr("fill","#4E5A63").text(d=>d);
svg.append("g").selectAll("text").data(N).join("text")
  .attr("x",(d,i)=>x(V[i])+4).attr("y",d=>y(d)+y.bandwidth()/2).attr("dy","0.34em")
  .attr("font-size","7px").attr("fill","#76838C").text((d,i)=>V[i].toFixed(1)+"%");
svg.append("g").attr("transform","translate(0,"+(H-M.b)+")").attr("font-size","9px")
  .call(d3.axisBottom(x).ticks(6).tickFormat(d=>d+"%").tickSizeOuter(0));
const tip=wrap.append("div").attr("class","zpb-tip").style("display","none");
const card=(t,rows)=>`<h4>${t}</h4><table>`+
  rows.map(r=>`<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join("")+`</table>`;
bars.style("cursor","pointer")
  .on("mousemove",function(ev,d){
    const i=N.indexOf(d);
    bars.attr("opacity",(q,j)=>j===i?1:0.45);
    tip.style("display","block").html(card(d,[
      ["Share of its blocks",V[i].toFixed(2)+"%"],
      ["Blocks with no residents",f(ZB[i])],
      ["Census blocks",f(BL[i])]]));
    const b=wrap.node().getBoundingClientRect(), t=tip.node().getBoundingClientRect();
    let px=ev.clientX-b.left+16;
    if(px+t.width>b.width) px=ev.clientX-b.left-t.width-16;
    tip.style("left",px+"px")
       .style("top",Math.max(0,ev.clientY-b.top-t.height/2)+"px");
  })
  .on("mouseleave",()=>{tip.style("display","none");bars.attr("opacity",1);});
})();

(function(){
const D=["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","PR"],NM=["Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","District of Columbia","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia","Wisconsin","Wyoming","Puerto Rico"],X=[99.2,1.28,62.92,57.92,253.68,55.71,744.66,508.03,11285.52,401.44,185.59,226.59,22.25,230.8,189.4,57.12,35.93,114.1,107.79,44.17,636.09,901.16,178.02,71.67,63.11,89.53,7.45,25.53,28.26,153.85,1262.98,17.46,428.69,214.7,11.29,288.79,57.72,44.14,290.61,1061.4,170.25,11.7,167.61,111.55,39.72,69.77,218.62,115.95,74.61,108.81,5.94,959.58];
const PAN=[{y:[85.55,32.95,41.55,76.76,47.32,66.39,95.2,92.27,73.65,68.26,82.84,57.31,46.86,82.51,91.25,82.02,57.19,92.38,72.37,53.09,93.8,91.87,82.49,77.14,83.39,82.87,58.68,74.6,22.58,85.33,83.25,40.1,88.82,88.49,49.79,94.04,71.62,41.7,89.3,90.03,83.9,66.26,89.33,57.98,28.19,93.21,91.39,66.4,89.34,87.11,36.65,93.6],lab:"% of land with residents on it",r:0.627,show:[0,1,0,0,0,0,1,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0],fx:[1.284,3177.848],fy:[36.25,100]},
           {y:[69.02,41.18,69.44,64.59,72.65,71.18,84.14,75.83,74.85,74.26,71.04,69.03,56.34,75.18,79.55,70.88,63.26,69.03,64.52,64.81,77.87,82.22,77.83,69.29,68.98,66.63,49.44,66.98,61.4,79.24,82.05,52.8,79.75,73.95,47.53,79.47,67.62,60.46,81.61,83.36,71.82,57.11,74.48,67.15,65.71,73.04,71.78,70.49,71.46,71.38,42.51,87.1],lab:"% of blocks with residents",r:0.873,show:[0,1,0,0,0,0,1,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,1,1],fx:[1.284,11285.516],fy:[44.1,95.96]}];
const W=700,PH=214,GAP=40,M={t:16,r:18,b:30,l:52},H=2*PH+GAP+18;
const wrap=d3.select("#zdens");
const svg=wrap.append("svg").attr("viewBox","0 0 "+W+" "+H)
  .attr("style","max-width:100%;height:auto;font:11px inherit");
const f=d3.format(",");
// Log x: the relationship lives in the orders of magnitude, not the levels.
const x=d3.scaleLog().domain([1,d3.max(X)*1.3]).range([M.l,W-M.r]).nice();
const tip=wrap.append("div").attr("class","zpb-tip").style("display","none");
const card=(t,rows)=>`<h4>${t}</h4><table>`+
  rows.map(r=>`<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join("")+`</table>`;
const all=[];
PAN.forEach((p,pi)=>{
  const y0=pi*(PH+GAP), y=d3.scaleLinear().domain([0,d3.max(p.y)*1.1]).nice()
    .range([y0+PH-M.b,y0+M.t]);
  svg.append("g").attr("stroke","#76838C").attr("opacity",0.24)
    .selectAll("line").data(y.ticks(4)).join("line")
    .attr("x1",M.l).attr("x2",W-M.r).attr("y1",y).attr("y2",y);
  svg.append("line").attr("x1",x(p.fx[0])).attr("y1",y(p.fy[0]))
    .attr("x2",x(p.fx[1])).attr("y2",y(p.fy[1]))
    .attr("stroke","#76838C").attr("stroke-width",1.6).attr("stroke-dasharray","5,4");
  const dots=svg.append("g").selectAll("circle").data(D).join("circle")
    .attr("cx",(d,i)=>x(X[i])).attr("cy",(d,i)=>y(p.y[i])).attr("r",4.2)
    .attr("fill","#C41230").attr("fill-opacity",0.85).style("cursor","pointer");
  all.push(dots);
  svg.append("g").selectAll("text").data(D.filter((d,i)=>p.show[i])).join("text")
    .attr("x",d=>x(X[D.indexOf(d)])+7).attr("y",d=>y(p.y[D.indexOf(d)])+3.4)
    .attr("font-size","9px").attr("fill","#4E5A63").text(d=>d);
  svg.append("g").attr("transform","translate(0,"+(y0+PH-M.b)+")")
    .call(d3.axisBottom(x).ticks(5,"~s").tickSizeOuter(0));
  svg.append("g").attr("transform","translate("+M.l+",0)")
    .call(d3.axisLeft(y).ticks(4).tickFormat(d=>d+"%").tickSizeOuter(0));
  svg.append("text").attr("x",M.l).attr("y",y0+10).attr("font-size","11.5px")
    .attr("font-weight","600").attr("fill","#12181D").text(p.lab);
  svg.append("text").attr("x",W-M.r).attr("y",y0+10).attr("text-anchor","end")
    .attr("font-size","11px").attr("fill","#76838C")
    .text("r = "+p.r.toFixed(2));
  dots.on("mousemove",function(ev,d){
    const i=D.indexOf(d);
    all.forEach(g=>g.attr("fill-opacity",(q,j)=>j===i?1:0.25));
    tip.style("display","block").html(card(NM[i],[
      ["Land with residents",PAN[0].y[i].toFixed(1)+"%"],
      ["Blocks with residents",PAN[1].y[i].toFixed(1)+"%"],
      ["Land with no residents",(100-PAN[0].y[i]).toFixed(1)+"%"],
      ["Population density",f(Math.round(X[i]))+" per sq mi"]]));
    const b=wrap.node().getBoundingClientRect(), t=tip.node().getBoundingClientRect();
    let px=ev.clientX-b.left+16;
    if(px+t.width>b.width) px=ev.clientX-b.left-t.width-16;
    tip.style("left",px+"px")
       .style("top",Math.max(0,ev.clientY-b.top-t.height-14)+"px");
  })
  .on("mouseleave",()=>{tip.style("display","none");
    all.forEach(g=>g.attr("fill-opacity",0.85));});
});
svg.append("text").attr("x",(M.l+W-M.r)/2).attr("y",H-2).attr("text-anchor","middle")
  .attr("font-size","11px").attr("fill","#4E5A63")
  .text("people per square mile of land (log scale)");
})();

(function(){
const DOTS="assets/img/dots-ks-ut.webp";
const L1=["Kansas · 81,759 sq mi","Utah · 82,377 sq mi"],L2=["2,937,880 people · 36 per sq mi","3,271,616 people · 40 per sq mi"],L3=["42.8% of its land has no residents","71.8% of its land has no residents"],L4=["172,529 blocks · 303 acres each","71,207 blocks · 740 acres each"];
const PWT=10191,RH=5492,GAPY=620,PHT=11604;
const TOP=950,BOT=560;
const svg=d3.select("#zksut").append("svg")
  .attr("viewBox","0 "+(-TOP)+" "+PWT+" "+(PHT+TOP+BOT))
  .attr("style","max-width:100%;height:auto;display:block");
const T=(x,y,txt,sz,w,col,anch)=>svg.append("text").attr("x",x).attr("y",y)
  .attr("text-anchor",anch||"middle").attr("font-weight",w||400)
  .attr("fill",col||"#12181D").attr("font-size",sz).text(txt);
// the labels do not wait on the geometry
T(0,-60,"WHERE THE PEOPLE ARE — one dot for 25 residents",180,700,"#4E5A63","start");
T(0,RH+GAPY-110,"WHERE NOBODY LIVES — blocks with no residents",180,700,"#4E5A63","start");
zpbData("#zksut","assets/data/ksut.json",P=>{
  // row one: the state fills, then the dot image over them, then the outlines
  P.forEach(p=>{
    svg.append("g").selectAll("path").data(p.s1).join("path").attr("d",d=>d)
      .attr("fill","#F4F6F7").attr("fill-rule","evenodd");
  });
  svg.append("image").attr("x",0).attr("y",0).attr("width",PWT).attr("height",RH)
    .attr("preserveAspectRatio","none").attr("href",DOTS);
  P.forEach(p=>{
    svg.append("g").selectAll("path").data(p.s1).join("path").attr("d",d=>d)
      .attr("fill","none").attr("stroke","#8d99ae").attr("stroke-width",7);
  });
  P.forEach((p,i)=>{
    svg.append("g").selectAll("path").data(p.s2).join("path").attr("d",d=>d)
      .attr("fill","#ffffff").attr("fill-rule","evenodd");
    svg.append("g").selectAll("path").data(p.z).join("path").attr("d",d=>d)
      .attr("fill","#C41230").attr("fill-rule","evenodd");
    svg.append("g").selectAll("path").data(p.s2).join("path").attr("d",d=>d)
      .attr("fill","none").attr("stroke","#8d99ae").attr("stroke-width",7);
    T(p.cx,-600,L1[i],235,700);
    T(p.cx,-400,L2[i],180,400,"#4E5A63");
    T(p.cx,PHT+250,L3[i],195,700,"#C41230");
    T(p.cx,PHT+450,L4[i],175,400,"#4E5A63");
  });
});
})();

(function(){
const W=760,H=950;
const svg=d3.select("#zdc").append("svg").attr("viewBox","0 0 "+W+" "+H)
  .attr("style","max-width:100%;height:auto;display:block;margin:0 auto");
const draw=(d,fill)=>svg.append("g").selectAll("path").data(d).join("path")
  .attr("d",q=>q).attr("fill",fill).attr("fill-rule","evenodd")
  .attr("stroke","#ffffff").attr("stroke-width",0.25);
zpbData("#zdc","assets/data/dc.json",P=>{
  draw(P.p0,"#EDEFF1");     // somebody lives here
  draw(P.p2,"#C9D6DE");     // all water
  draw(P.p1,"#C41230");   // nobody, and it is land
  const K=[["#C41230","no residents"],["#EDEFF1","residents"],["#C9D6DE","water"]];
  let kx=8;
  K.forEach(k=>{
    svg.append("rect").attr("x",kx).attr("y",H-16).attr("width",11).attr("height",11)
      .attr("fill",k[0]).attr("stroke","#ffffff").attr("stroke-width",0.5);
    svg.append("text").attr("x",kx+15).attr("y",H-7).attr("font-size","11px")
      .attr("fill","#4E5A63").text(k[1]);
    kx+=k[1].length*6.2+34;
  });
});
})();
})();
