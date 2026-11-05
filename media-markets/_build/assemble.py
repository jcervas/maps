import json,os
h=open('build/page.head.html').read()
b=open('build/page.body.html').read()
j=open('build/page.js').read()
for need,where in [('.cdline',h),('.tile.cd',h),('.cycwrap',h),('id="t-cd"',b),('id="cycwrap"',b),
                   ('tb-cost',b),('id="flat"',b),('gCd',j),('CDTOPO',j),('drawCd',j),('renderCd',j)]:
    assert need in where, 'missing '+need
cdt=json.load(open('cdall.topo.json'))
assert set(cdt['objects'])=={'y2022','y2024','y2026'}, cdt['objects'].keys()
out=(h+"\n"+b+"\n<script>\nconst DATA="+open('dma_data.json').read()+
 ";\nconst TOPO="+open('dma.topo.json').read()+
 ";\nconst STATES="+open('states.topo.json').read()+
 ";\nconst CDTOPO="+json.dumps(cdt,separators=(',',':'))+
 ";\nconst CDL="+open('cd_layer.json').read()+
 ";\n</script>\n<script>\n"+j+"\n</script>\n")
open('media-markets.html','w').write(out)
print('rebuilt', f"{os.path.getsize('media-markets.html'):,}")
