import json, csv, collections
from shapely.geometry import shape, Point
from shapely.strtree import STRtree
from shapely.ops import unary_union

def topo_to_features(topo, obj):
    tr = topo.get('transform')
    arcs_raw = topo['arcs']
    def decode(arc):
        if not tr: return [tuple(p) for p in arc]
        sx, sy = tr['scale']; tx, ty = tr['translate']
        out=[]; x=y=0
        for dx,dy in arc:
            x+=dx; y+=dy
            out.append((x*sx+tx, y*sy+ty))
        return out
    arcs=[decode(a) for a in arcs_raw]
    def ring(idxs):
        pts=[]
        for i in idxs:
            a = arcs[~i][::-1] if i<0 else arcs[i]
            pts.extend(a if not pts else a[1:])
        return pts
    feats=[]
    for g in topo['objects'][obj]['geometries']:
        t=g['type']
        def rings(rs):
            out=[r for r in (ring(x) for x in rs) if len(r)>=4]
            return out
        if t=='Polygon':
            cs=rings(g['arcs'])
            if not cs: continue
            geom={'type':'Polygon','coordinates':cs}
        elif t=='MultiPolygon':
            ps=[rings(p) for p in g['arcs']]
            ps=[p for p in ps if p]
            if not ps: continue
            geom={'type':'MultiPolygon','coordinates':ps}
        else:
            continue
        feats.append({'id':g.get('id'),'properties':g.get('properties',{}),'geometry':geom})
    return feats

dma_topo=json.load(open('nielsentopo.json'))
dmas=topo_to_features(dma_topo,'nielsen_dma')
print('DMAs:',len(dmas))

cty_topo=json.load(open('counties-10m.json'))
ctys=topo_to_features(cty_topo,'counties')
print('counties:',len(ctys))

dgeo=[]; dmeta=[]
for d in dmas:
    g=shape(d['geometry'])
    if not g.is_valid: g=g.buffer(0)
    dgeo.append(g); dmeta.append(d['properties'])
tree=STRtree(dgeo)

STFIPS=json.loads(open('stfips.json').read()) if False else None

assign={}
unmatched=[]
for c in ctys:
    fips=str(c['id']).zfill(5)
    g=shape(c['geometry'])
    if not g.is_valid: g=g.buffer(0)
    p=g.representative_point()
    hit=None
    for i in tree.query(p):
        if dgeo[i].contains(p): hit=i; break
    if hit is None:
        # nearest by centroid distance, only if plausibly close
        best=None;bd=1e9
        for i in tree.query(g.buffer(0.3)):
            dd=dgeo[i].distance(p)
            if dd<bd: bd=dd;best=i
        if best is not None and bd<0.35: hit=best
    if hit is None:
        unmatched.append((fips,c['properties'].get('name')))
    else:
        assign[fips]=hit
print('assigned',len(assign),'unmatched',len(unmatched))
print('sample unmatched',unmatched[:12])
assign={k:int(v) for k,v in assign.items()}
json.dump({'assign':assign,'dmeta':dmeta,'unmatched':unmatched},open('crosswalk.json','w'))
