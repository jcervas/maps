#!/bin/sh
# Builds cdall.topo.json: all three district cycles in ONE topology.
#
# combine-files is the point of this step. Three separate topojson files came
# to 1,071,750 bytes; sharing one arc table across the cycles gives 608,284,
# because most district boundaries are identical from one cycle to the next
# and get stored once. -simplify runs AFTER the files are combined so the
# cycles stay coincident where they agree -- simplifying them separately
# would leave hairline slivers between lines that should be the same line.
#
# AK and HI are dropped to match the DMA boundary file, which is lower-48.
set -e
SRCD="${SRCD:-$HOME/Library/CloudStorage/GoogleDrive-jcervas@andrew.cmu.edu/My Drive/GitHub/createMaps/national/output}"
MS="${MS:-./nodeenv/node_modules/.bin/mapshaper}"

"$MS" -i "$SRCD/national-cd-2022-raw.geojson" \
         "$SRCD/national-cd-2024-raw.geojson" \
         "$SRCD/national-cd-2026-raw.geojson" combine-files \
 -rename-layers y2022,y2024,y2026 \
 -each 'sd=this.properties["state-district"]' 'target=*' \
 -filter 'state != "AK" && state != "HI"' 'target=*' \
 -filter-fields sd,state,changed,TotalPop,Margin2024Pres 'target=*' \
 -simplify 2% keep-shapes planar -clean 'target=*' \
 -o format=topojson quantization=1e5 cdall.topo.json

python3 -c "
import json,os; t=json.load(open('cdall.topo.json'))
print('objects',list(t['objects'].keys()),'arcs',len(t['arcs']),'bytes',os.path.getsize('cdall.topo.json'))"
