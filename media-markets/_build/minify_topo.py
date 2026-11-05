# Strips the two base topologies down to what the page actually draws.
# DMA properties are dropped entirely: the page matches markets to
# dma_data.json by geometry index, not by any field carried in the topology.
import json, os

t = json.load(open('nielsentopo.json'))
for g in t['objects']['nielsen_dma']['geometries']:
    g['properties'] = {}
    g.pop('id', None)
json.dump(t, open('dma.topo.json', 'w'), separators=(',', ':'))

s = json.load(open('states-10m.json'))
s['objects'].pop('counties', None)
s['objects'].pop('nation', None)
for g in s['objects']['states']['geometries']:
    g['properties'] = {'n': g['properties'].get('name', '')}
json.dump(s, open('states.topo.json', 'w'), separators=(',', ':'))

for f in ['dma.topo.json', 'states.topo.json']:
    print(f, f'{os.path.getsize(f):,}')
