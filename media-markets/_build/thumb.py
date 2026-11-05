import json,math
from shapely.geometry import shape, mapping
from shapely.validation import make_valid

W,PAD = 1000.0,8.0                     # tight box; the card letterboxes it (object-fit:contain)
H = None                               # set below from the map's own aspect
LON0,PHI0,P1,P2 = -96.0,37.5,29.5,45.5

n=(math.sin(math.radians(P1))+math.sin(math.radians(P2)))/2
C=math.cos(math.radians(P1))**2+2*n*math.sin(math.radians(P1))
rho0=math.sqrt(C-2*n*math.sin(math.radians(PHI0)))/n
def albers(lon,lat):
    th=n*math.radians(lon-LON0)
    r=math.sqrt(max(C-2*n*math.sin(math.radians(lat)),0))/n
    return (r*math.sin(th), rho0-r*math.cos(th))

def decode(topo,obj):
    tr=topo['transform']; sx,sy=tr['scale']; tx,ty=tr['translate']
    arcs=[]
    for a in topo['arcs']:
        x=y=0; o=[]
        for dx,dy in a:
            x+=dx; y+=dy; o.append((x*sx+tx,y*sy+ty))
        arcs.append(o)
    def ring(idxs):
        pts=[]
        for i in idxs:
            seg=arcs[~i][::-1] if i<0 else arcs[i]
            pts.extend(seg if not pts else seg[1:])
        return pts
    out=[]
    for g in topo['objects'][obj]['geometries']:
        if g['type']=='Polygon':
            cs=[r for r in (ring(x) for x in g['arcs']) if len(r)>=4]
            out.append({'type':'Polygon','coordinates':cs} if cs else None)
        elif g['type']=='MultiPolygon':
            ps=[[r for r in (ring(x) for x in p) if len(r)>=4] for p in g['arcs']]
            ps=[p for p in ps if p]
            out.append({'type':'MultiPolygon','coordinates':ps} if ps else None)
        else: out.append(None)
    return out

dm=decode(json.load(open('nielsentopo.json')),'nielsen_dma')
_stopo=json.load(open('states-10m.json'))
_stnames=[g.get('properties',{}).get('name','') for g in _stopo['objects']['states']['geometries']]
OFF={'Alaska','Hawaii','Puerto Rico','United States Virgin Islands','Guam',
     'American Samoa','Commonwealth of the Northern Mariana Islands','District of Columbia'}
st=[g if _stnames[i] not in OFF else None
    for i,g in enumerate(decode(_stopo,'states'))]
print('states drawn:',sum(1 for g in st if g),'of',len(st))

def project(geom):
    def r(ring): return [albers(x,y) for x,y in ring]
    if geom['type']=='Polygon': return {'type':'Polygon','coordinates':[r(c) for c in geom['coordinates']]}
    return {'type':'MultiPolygon','coordinates':[[r(c) for c in p] for p in geom['coordinates']]}
dmp=[project(g) if g else None for g in dm]

xs=[];ys=[]
for g in dmp:
    if not g: continue
    cs=g['coordinates'] if g['type']=='Polygon' else [c for p in g['coordinates'] for c in p]
    for ring in cs:
        for x,y in ring: xs.append(x); ys.append(y)
x0,x1,y0,y1=min(xs),max(xs),min(ys),max(ys)
k=(W-2*PAD)/(x1-x0)
H=round(k*(y1-y0)+2*PAD)
ox=PAD-k*x0
oy=PAD                        # screen y grows downward, Albers y grows north
def to_px(g):
    def r(ring): return [(x*k+ox, (y1-y)*k+oy) for x,y in ring]
    if g['type']=='Polygon': return {'type':'Polygon','coordinates':[r(c) for c in g['coordinates']]}
    return {'type':'MultiPolygon','coordinates':[[r(c) for c in p] for p in g['coordinates']]}

def d_of(g,tol=1.1):
    s=make_valid(shape(to_px(g))).simplify(tol)
    gj=mapping(s); t=gj['type']
    polys=[gj['coordinates']] if t=='Polygon' else gj['coordinates'] if t=='MultiPolygon' else []
    out=[]
    for poly in polys:
        for ring in poly:
            if len(ring)<4: continue
            out.append('M'+'L'.join(f'{x:.0f} {y:.0f}' for x,y in ring)+'Z')
    return ''.join(out)

RAMP=["#dde8f5","#b6d0ec","#89b3e0","#5a8fd0","#3468b5","#1e4a8e","#12305f"]
BR=[100e3,250e3,500e3,1e6,2e6,5e6]
data=json.load(open('dma_data.json'))['dmas']
pop={d['i']:d['pop'] for d in data}

parts=[f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}" '
       f'width="{W:.0f}" height="{H:.0f}" role="img" '
       f'aria-label="Map of United States television media markets shaded by population">',
       '<title>U.S. television media markets</title>',
       '<g stroke="#ffffff" stroke-opacity=".5" stroke-width=".7" stroke-linejoin="round">']
for i,g in enumerate(dmp):
    if not g: continue
    p=pop.get(i,0)
    if p<=0: c="#d7d7d7"
    else:
        j=0
        while j<len(BR) and p>=BR[j]: j+=1
        c=RAMP[j]
    d=d_of(g)
    if d: parts.append(f'<path fill="{c}" d="{d}"/>')
parts.append('</g>')
parts.append('<g fill="none" stroke="#5c5c5c" stroke-opacity=".55" stroke-width="1.1" stroke-linejoin="round">')
for g in st:
    if not g: continue
    d=d_of(project(g),1.3)
    if d: parts.append(f'<path d="{d}"/>')
parts.append('</g></svg>')
svg='\n'.join(parts)
open('thumb.svg','w').write(svg)
import os; print('thumb.svg %s bytes  %dx%d  aspect %.2f' % (f"{os.path.getsize('thumb.svg'):,}",W,H,W/H))
