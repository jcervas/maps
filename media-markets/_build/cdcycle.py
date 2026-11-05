import json,csv,collections,sys
YEAR=sys.argv[1]
from shapely.geometry import shape
from shapely.strtree import STRtree
from shapely.validation import make_valid

SRC="/Users/cervas/Library/CloudStorage/GoogleDrive-jcervas@andrew.cmu.edu/My Drive/GitHub/createMaps/national/output/national-cd-%s-raw.geojson"%YEAR
SKIP={'02','15','60','66','69','72','78'}

cds=[]
for f in json.load(open(SRC))['features']:
    p=f['properties']
    if p['state'] in ('AK','HI'): continue
    cds.append({'sd':p['state-district'],'st':p['state'],'pop':p['TotalPop'],
                'chg':p['changed'],'mar':p.get('Margin2024Pres'),
                'g':make_valid(shape(f['geometry']))})
print('districts:',len(cds))

ctys=[]
for f in json.load(open('cd/cty.geojson'))['features']:
    p=f['properties']
    if p['STATEFP'] in SKIP: continue
    g=make_valid(shape(f['geometry']))
    ctys.append({'fips':p['GEOID'],'name':p['NAMELSAD'],'st':p['STUSPS'],'g':g,'a':g.area})
print('counties:',len(ctys))

cw=json.load(open('crosswalk.json')); assign=cw['assign']
data=json.load(open('dma_data.json')); DM=data['dmas']
popmap={}
for d in DM:
    for fips,nm,st,p in d['cty']: popmap[fips]=p
for r in csv.DictReader(open('copop.csv',encoding='latin-1')):
    if r['SUMLEV']=='050':
        f=r['STATE']+r['COUNTY']
        popmap.setdefault(f,int(r['POPESTIMATE2024']))

# DMA polygons for resolving counties missing from the legacy-FIPS crosswalk (CT)
t=json.load(open('nielsentopo.json')); tr=t['transform']
sx,sy=tr['scale']; tx,ty=tr['translate']; arcs=[]
for a in t['arcs']:
    x=y=0; o=[]
    for dx,dy in a: x+=dx; y+=dy; o.append((x*sx+tx,y*sy+ty))
    arcs.append(o)
def ring(idxs):
    pts=[]
    for i in idxs:
        seg=arcs[~i][::-1] if i<0 else arcs[i]
        pts.extend(seg if not pts else seg[1:])
    return pts
dpolys=[]
for g in t['objects']['nielsen_dma']['geometries']:
    if g['type']=='Polygon':
        gg={'type':'Polygon','coordinates':[c for c in (ring(r) for r in g['arcs']) if len(c)>=4]}
    else:
        ps=[[c for c in (ring(r) for r in p) if len(c)>=4] for p in g['arcs']]
        gg={'type':'MultiPolygon','coordinates':[p for p in ps if p]}
    dpolys.append(make_valid(shape(gg)))
dtree=STRtree(dpolys)
def dma_for(geom):
    p=geom.representative_point()
    for i in dtree.query(p):
        if dpolys[i].contains(p): return int(i)
    return None

cdma={}
for c in ctys:
    di=assign.get(c['fips'])
    if di is None: di=dma_for(c['g'])
    cdma[c['fips']]=di

# ---- seed matrix from intersection areas ----
ctree=STRtree([c['g'] for c in ctys])
cells=[]   # (di_row, ci, area)
for k,cd in enumerate(cds):
    for i in ctree.query(cd['g']):
        c=ctys[i]
        if cdma[c['fips']] is None or popmap.get(c['fips'],0)<=0: continue
        try: inter=cd['g'].intersection(c['g'])
        except Exception: continue
        if inter.is_empty: continue
        a=inter.area
        if a/c['a'] < 0.0005: continue
        cells.append([k,i,a])
    if k%100==0: print('  seed',k,flush=True)
print('cells:',len(cells))

# ---- IPF against both known margins ----
colpop=[popmap.get(c['fips'],0) for c in ctys]
GT=sum(colpop)
sf=GT/sum(c['pop'] for c in cds)
rowpop=[c['pop']*sf for c in cds]
# seed: area share within county x county pop (a sane starting point)
carea=collections.defaultdict(float)
for k,i,a in cells: carea[i]+=a
v=[a/carea[i]*colpop[i] for k,i,a in cells]
for it in range(300):
    rs=collections.defaultdict(float)
    for n,(k,i,a) in enumerate(cells): rs[k]+=v[n]
    for n,(k,i,a) in enumerate(cells):
        if rs[k]>0: v[n]*= rowpop[k]/rs[k]
    cs=collections.defaultdict(float)
    for n,(k,i,a) in enumerate(cells): cs[i]+=v[n]
    for n,(k,i,a) in enumerate(cells):
        if cs[i]>0: v[n]*= colpop[i]/cs[i]
rs=collections.defaultdict(float); cs=collections.defaultdict(float)
for n,(k,i,a) in enumerate(cells): rs[k]+=v[n]; cs[i]+=v[n]
rerr=sorted(((abs(rs[k]-rowpop[k])/max(1,rowpop[k]),cds[k]['sd'],round(rs[k]),round(rowpop[k])) for k in range(len(cds))),reverse=True)
cerr=sorted(((abs(cs[i]-colpop[i])/max(1,colpop[i]),ctys[i]['name']+','+ctys[i]['st'],round(cs[i]),colpop[i]) for i in range(len(ctys)) if colpop[i]>0 and i in cs),reverse=True)
print('worst row (district) errors:')
for e,sd,got,want in rerr[:8]: print(f'   {sd:7s} {e*100:6.2f}%  got {got:>9,} want {want:>9,}')
print('worst col (county) errors:')
for e,nm,got,want in cerr[:5]: print(f'   {nm:28s} {e*100:6.2f}%  got {got:>9,} want {want:>9,}')
import statistics
print('median row err %.4f%%  90th %.3f%%'%(statistics.median(x[0] for x in rerr)*100, sorted(x[0] for x in rerr)[int(.9*len(rerr))]*100))
ncov=sum(1 for i in range(len(ctys)) if i not in cs and colpop[i]>0)
print('counties with no district overlap:',ncov)

# ---- district x DMA ----
dxm=collections.defaultdict(float)
for n,(k,i,a) in enumerate(cells):
    dxm[(k,cdma[ctys[i]['fips']])]+=v[n]
json.dump({'cds':[{'sd':c['sd'],'st':c['st'],'pop':c['pop'],'chg':c['chg'],'mar':c['mar']} for c in cds],
           'dxm':{f'{k}|{m}':round(x) for (k,m),x in dxm.items() if x>=500}},
          open('cd_dma_%s.json'%YEAR,'w'))
print('pairs kept:',sum(1 for x in dxm.values() if x>=500))
