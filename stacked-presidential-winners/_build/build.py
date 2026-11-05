"""Build ../index.html from template.html.

Inputs, both copied into this folder so the page rebuilds on its own:
  us-albers.geojson          50 states + DC, composite Albers, pre-projected to
                             a 1152 x 748.8 frame (Democracy's Data base map)
  pres_states_1992_2024.csv  statewide presidential winner by year (Democracy's
                             Data, historical-campaigns chapter, 1992 on)

Run:  python3 build.py
"""
import collections
import csv
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
geo = json.load(open(os.path.join(HERE, "us-albers.geojson")))
rows = list(csv.DictReader(open(os.path.join(HERE, "pres_states_1992_2024.csv"))))

YEARS = sorted({int(r["year"]) for r in rows})
win = collections.defaultdict(dict)
cands = collections.defaultdict(dict)
for r in rows:
    y, p = int(r["year"]), "D" if r["party_win"] == "democrat" else "R"
    win[r["state_abbrev"]][y] = p
    cands[y][p] = r["winner"]
assert all(len(v) == len(YEARS) for v in win.values()) and len(win) == 51


def path(geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return "".join("M" + "L".join(f"{x:g},{y:g}" for x, y in ring) + "Z"
                   for poly in polys for ring in poly)


feats = [(f["properties"]["st"], f["properties"]["name"], path(f["geometry"]))
         for f in geo["features"]]
# each outline is drawn once in <defs> and reused by the fill and edge layers
defs = "<defs>" + "".join(f'<path id="spw-{s}" d="{d}"/>' for s, n, d in feats) + "</defs>"
fills = "".join(f'<use class="fillst" data-st="{s}" href="#spw-{s}"/>' for s, n, d in feats)
edges = "".join(f'<use class="edge" data-st="{s}" href="#spw-{s}"/>' for s, n, d in feats)
meta = {"years": YEARS, "win": win, "names": {s: n for s, n, d in feats}, "cands": cands}

html = open(os.path.join(HERE, "template.html")).read()
html = (html.replace("/*META*/", json.dumps(meta, separators=(",", ":")))
            .replace("<!--BASE-->", defs).replace("<!--LAYERS-->", fills)
            .replace("<!--EDGES-->", edges))
open(os.path.join(HERE, "..", "index.html"), "w").write(html)
print(f"wrote index.html ({len(html):,} bytes)")
