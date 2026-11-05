import json,csv,collections,re

cw=json.load(open('crosswalk.json')); assign=cw['assign']; dmeta=cw['dmeta']
STATE={'01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI','56':'WY'}

pop={}; cname={}
ct2024=0
for r in csv.DictReader(open('copop.csv',encoding='latin-1')):
    if r['SUMLEV']!='050': continue
    f=r['STATE']+r['COUNTY']
    if r['STATE']=='09': ct2024+=int(r['POPESTIMATE2024']); continue
    pop[f]=int(r['POPESTIMATE2024']); cname[f]=r['CTYNAME']
ct_old={}
for r in csv.DictReader(open('co-est2020.csv',encoding='latin-1')):
    if r['SUMLEV']=='050' and r['STATE']=='09':
        ct_old[r['STATE']+r['COUNTY']]=(int(r['POPESTIMATE2020']),r['CTYNAME'])
ctsum=sum(v for v,_ in ct_old.values()); scale=ct2024/ctsum
for f,(v,n) in ct_old.items():
    pop[f]=round(v*scale); cname[f]=n
print(f'CT patched: 2020 legacy counties scaled by {scale:.4f} to 2024 state total {ct2024:,}')

votes={}
for r in csv.DictReader(open('probe.tmp',encoding='utf-8-sig')):
    f=str(r['county_fips']).zfill(5)
    try: votes[f]=(int(r['votes_gop']),int(r['votes_dem']),int(r['total_votes']))
    except: pass

def home_state(name):
    m=re.search(r',\s*([A-Z]{2})\b',name)
    return m.group(1) if m else None

agg=collections.defaultdict(lambda:{'pop':0,'gop':0,'dem':0,'tot':0,'st':collections.Counter(),'cty':[]})
for f,di in assign.items():
    a=agg[di]; p=pop.get(f,0)
    a['pop']+=p; a['st'][STATE.get(f[:2],'??')]+=p
    a['cty'].append([f,cname.get(f,''),STATE.get(f[:2],''),p])
    if f in votes:
        g,d,t=votes[f]; a['gop']+=g; a['dem']+=d; a['tot']+=t

out=[]
for i,m in enumerate(dmeta):
    a=agg.get(i); name=m['dma1']; hs=home_state(name)
    sts=a['st'].most_common() if a else []
    a2=a or {'pop':0,'gop':0,'dem':0,'tot':0,'cty':[]}
    a2['cty'].sort(key=lambda c:-c[3])
    out.append({'i':i,'dma':int(m['dma']),'name':name,'home':hs,
      'lat':m['latitude'],'lon':m['longitude'],'tv':m['tvperc'],'cable':m['cableperc'],
      'pop':a2['pop'],'nc':len(a2['cty']),'states':[[s,n] for s,n in sts],
      'gop':a2['gop'],'dem':a2['dem'],'tot':a2['tot'],
      'cty':a2['cty'][:60],'split': a is None})
ranked=sorted([r for r in out if r['pop']>0],key=lambda r:-r['pop'])
for k,r in enumerate(ranked): r['rank']=k+1
for r in out: r.setdefault('rank',None)

# state-level: share of each state's people in a market headquartered in another state
stt=collections.Counter(); sto=collections.Counter()
for r in out:
    for f,nm,st,p in r['cty']:
        stt[st]+=p
        if r['home'] and st!=r['home']: sto[st]+=p
statewise=sorted(((s,stt[s],sto[s],100*sto[s]/stt[s]) for s in stt if stt[s]>0),key=lambda x:-x[3])

tot=sum(r['pop'] for r in out)
multi=[r for r in out if len([1 for s,n in r['states'] if n>0])>1]
summary={
 'total_pop':tot,'n_dma':len(out),
 'n_multi':len(multi),'pop_multi':sum(r['pop'] for r in multi),
 'top10_share':100*sum(r['pop'] for r in ranked[:10])/tot,
 'top25_share':100*sum(r['pop'] for r in ranked[:25])/tot,
 'half_n':next(k+1 for k in range(len(ranked)) if sum(x['pop'] for x in ranked[:k+1])>tot/2),
 'statewise':[[s,t,o,round(pc,1)] for s,t,o,pc in statewise],
}
json.dump({'summary':summary,'dmas':out},open('dma_data.json','w'),separators=(',',':'))
print(json.dumps({k:v for k,v in summary.items() if k!='statewise'},indent=1))
print('\nTop 12 states by share living in an out-of-state-anchored market:')
for s,t,o,pc in statewise[:12]: print(f'  {s}  {pc:5.1f}%  ({o:,} of {t:,})')
print('\nfile size', __import__("os").path.getsize('dma_data.json'))
