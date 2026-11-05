#!/bin/sh
# Turn the scraped precincts into what the page loads.
#
#     sh build/build.sh /path/to/nyt2026        # all eleven states
#     sh build/build.sh /path/to/nyt2026 GA TX
#
# Takes the WGS84 precincts written by the scraper (out/geo/<ST>.geojson) and
# writes two tiers under elections/2026/data/precincts:
#
#     <ST>.topojson      the whole state, thinned -- what the state view draws
#     <ST>/<FIPS>.json   one county, full detail -- fetched when you zoom in
#     <ST>/index.json    {"13001": 12, ...}  precincts in each county
#
# Shapes only: geoid, county, county name, and nothing that moves. The votes
# are build/votes.py's job, in a file a hundredth the size that can be rebuilt
# every hour without re-committing the geometry. Run that after this one.
#
# Both tiers are run through mapshaper -clean first. The precincts come back
# from the Times's vector tiles a piece at a time, cut at every tile edge and
# reassembled, so neighbouring edges do not quite agree until they are snapped;
# without it, simplifying tears a thousand holes in the state.
set -eu
cd "$(dirname "$0")/.."
SRC=${1:?usage: build.sh <scraper dir> [ST ...]}
shift || true
OUT=elections/2026/data/precincts
mkdir -p "$OUT"
STATES=${*:-$(ls "$SRC/out/geo" | sed -n 's/^\([A-Z][A-Z]\)\.geojson$/\1/p')}
for st in $STATES; do
  in="$SRC/out/geo/$st.geojson"
  [ -s "$in" ] || { echo "$st: nothing to build"; continue; }

  mapshaper "$in" -clean gap-fill-area=0 \
    -simplify visvalingam weighted 12% keep-shapes \
    -filter-fields geoid,county_fips,fid_name \
    -rename-layers precincts \
    -o format=topojson quantization=1e5 "$OUT/$st.topojson" 2>&1 | grep -v '^\[o\]' || true

  rm -rf "$OUT/$st.tmp"; mkdir -p "$OUT/$st.tmp"
  mapshaper "$in" -clean gap-fill-area=0 \
    -simplify visvalingam weighted 45% keep-shapes \
    -filter-fields geoid,county_fips,fid_name \
    -split county_fips \
    -o format=topojson quantization=1e6 singles "$OUT/$st.tmp/" 2>&1 | grep -v '^\[o\]' || true

  python3 -I build/index_counties.py "$OUT/$st.tmp"
  rm -rf "$OUT/$st"; mv "$OUT/$st.tmp" "$OUT/$st"
  printf '%s: %s, %s counties, %s\n' "$st" \
    "$(du -h "$OUT/$st.topojson" | cut -f1)" \
    "$(ls "$OUT/$st" | grep -c '\.json$' || true)" \
    "$(du -sh "$OUT/$st" | cut -f1)"
done
