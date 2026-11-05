"""Name every split file's layer "precincts" and write the county index.

mapshaper -split names each output layer after the value it split on, so a
county file arrives with its layer called "13001"; the page expects one name.
"""
import json, os, sys

d = sys.argv[1]
counts = {}
for f in sorted(os.listdir(d)):
    if not f.endswith(".json"):
        continue
    p = os.path.join(d, f)
    t = json.load(open(p))
    (name, obj), = t["objects"].items()          # one county per file
    t["objects"] = {"precincts": obj}
    json.dump(t, open(p, "w"), separators=(",", ":"))
    counts[name] = len(obj["geometries"])
json.dump(counts, open(os.path.join(d, "index.json"), "w"), separators=(",", ":"))
