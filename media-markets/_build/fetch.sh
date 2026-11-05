#!/bin/sh
# Downloads every third-party input the pipeline reads. None of these are
# committed: together they are about 8 MB, and all of them are reproducible
# from the URLs below. Run this from _build/ before build.py / agg2.py /
# cdcycle.py / minify_topo.py / thumb.py.
set -e

# --- Nielsen DMA boundaries -------------------------------------------------
# simzou/nielsen-dma is the only openly redistributable DMA boundary file.
# 206 markets, lower 48 only (Nielsen has 210 nationally). Built from whole
# counties, which is what makes the county crosswalk in build.py possible.
curl -sSL -o nielsentopo.json \
  https://raw.githubusercontent.com/simzou/nielsen-dma/master/nielsentopo.json

# --- County and state geography (us-atlas) ----------------------------------
curl -sSL -o counties-10m.json https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json
curl -sSL -o states-10m.json   https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json

# --- County population ------------------------------------------------------
# Bulk CSVs, NOT the Census API: api.census.gov returns "Missing Key" for
# these endpoints without a registered key, so the bulk files are the only
# no-key path. copop.csv is the 2020-2024 vintage; co-est2020 supplies the
# 2020 legacy-county base used to rescue Connecticut (see README).
curl -sSL -o copop.csv \
  https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/counties/totals/co-est2024-alldata.csv
curl -sSL -o co-est2020.csv \
  https://www2.census.gov/programs-surveys/popest/datasets/2010-2020/counties/totals/co-est2020-alldata.csv

# --- 2024 presidential results by county ------------------------------------
# Kept under the name probe.tmp because that is the name the scripts read.
# It was a throwaway filename during exploration that ended up load-bearing;
# renaming it means editing agg2.py, cdcycle.py and build.py together.
curl -sSL -o probe.tmp \
  https://raw.githubusercontent.com/tonmcg/US_County_Level_Election_Results_08-24/master/2024_US_County_Level_Presidential_Results.csv

# --- County polygons for the district overlay -------------------------------
# cdcycle.py reads cd/cty.geojson. Census cartographic boundary shapefile,
# converted with mapshaper.
mkdir -p cd
curl -sSL -o cd/cty.zip \
  https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip
( cd cd && unzip -oq cty.zip && \
  ../nodeenv/node_modules/.bin/mapshaper cb_2024_us_county_500k.shp \
    -o format=geojson cty.geojson )

# --- d3 + topojson, for make_local.py -----------------------------------
# The standalone build inlines these so the file works offline. topojson is
# pinned to 3.0.2 because cdnjs has no topojson-client/3.1.0 bundle, only the
# full topojson package -- the obvious URL 404s.
curl -sSL -o lib_d3.js   https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js
curl -sSL -o lib_topo.js https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js

# --- mapshaper --------------------------------------------------------------
# Pinned: 0.6.102. Installed locally rather than via npx so topo.sh is
# reproducible. --cache is set because npm's default cache is not always
# writable here.
mkdir -p nodeenv
( cd nodeenv && [ -f package.json ] || npm init -y >/dev/null 2>&1
  npm install --no-audit --no-fund --cache ../npmcache mapshaper@0.6.102 )

echo "fetched:"; ls -la nielsentopo.json counties-10m.json states-10m.json copop.csv co-est2020.csv probe.tmp
