import json,collections,statistics
DM=json.load(open('dma_data.json'))['dmas']
dmaPop={d['i']:d['pop'] for d in DM}; dmaName={d['i']:d['name'] for d in DM}
CY=['2022','2024','2026']
cycles={}
for Y in CY:
    S=json.load(open(f'cd_dma_{Y}.json')); CDS=S['cds']
    rows=collections.defaultdict(dict)
    for key,v in S['dxm'].items():
        k,m=key.split('|'); rows[int(k)][int(m)]=v
    out=[]; permkt=collections.defaultdict(list)
    for k,cd in enumerate(CDS):
        r=rows.get(k,{}); tot=sum(r.values()) or 1
        sh=[(m,v/tot) for m,v in sorted(r.items(),key=lambda x:-x[1])]
        sh=[(m,s) for m,s in sh if s>=0.01]
        nrm=sum(s for _,s in sh) or 1
        sh=[(m,s/nrm) for m,s in sh]
        prim,primsh=sh[0] if sh else (None,0)
        n2=sum(1 for _,s in sh if s>=0.02)
        out.append({'sd':cd['sd'],'st':cd['st'],'pop':cd['pop'],'chg':cd['chg'],'mar':cd['mar'],
            'n':n2,'prim':prim,'primsh':round(primsh,4),
            'reach':round(dmaPop.get(prim,0)/cd['pop'],2) if prim is not None and cd['pop'] else None})
        for m,s in sh:
            if s>=0.02: permkt[m].append((cd['sd'],round(s,4)))
    mk={}
    for m,lst in permkt.items():
        lst.sort(key=lambda x:-x[1])
        mk[str(m)]={'n':len(lst),'whole':sum(1 for _,s in lst if s>=0.97),'top':[[sd,s] for sd,s in lst[:14]]}
    ns=[r['n'] for r in out]; rc=[r['reach'] for r in out if r['reach']]
    cycles[Y]={'cds':out,'mk':mk,'summary':{
        'n_cd':len(out),'mean_mk':round(statistics.mean(ns),2),
        'one':sum(1 for n in ns if n==1),'two_plus':sum(1 for n in ns if n>=2),
        'four_plus':sum(1 for n in ns if n>=4),'max_mk':max(ns),
        'changed':sum(1 for r in out if r['chg']),
        'median_reach':round(statistics.median(rc),1),
        'mean_reach':round(statistics.mean(rc),1)}}

# districts whose market footprint actually moved between cycles
base={r['sd']:r for r in cycles['2022']['cds']}
moves=[]
for Y in ['2024','2026']:
    cur={r['sd']:r for r in cycles[Y]['cds']}
    d=[sd for sd in cur if sd in base and (cur[sd]['n']!=base[sd]['n'] or cur[sd]['prim']!=base[sd]['prim'])]
    moves.append((Y,len(d),d[:14]))
json.dump({'cycles':cycles,'order':CY},open('cd_layer.json','w'),separators=(',',':'))

print(f"{'cycle':6s} {'redrawn':>8s} {'1 mkt':>6s} {'2+':>5s} {'4+':>4s} {'max':>4s} {'mean mk':>8s} {'med reach':>10s}")
for Y in CY:
    s=cycles[Y]['summary']
    print(f"{Y:6s} {s['changed']:8d} {s['one']:6d} {s['two_plus']:5d} {s['four_plus']:4d} {s['max_mk']:4d} {s['mean_mk']:8.2f} {s['median_reach']:10.1f}")
for Y,n,d in moves: print(f"\nvs 2022, {Y}: {n} districts changed market footprint  e.g. {d[:10]}")
import os; print('\nfile',os.path.getsize('cd_layer.json'))
