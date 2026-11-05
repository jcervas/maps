#!/usr/bin/env python3
"""One small file the page reads before it draws anything.

    python3 build/meta.py <scraper dir>

Pulls together what the map needs to label itself -- who ran, who won, how much
of the vote is in, where each state sits -- from the scraper's races.csv,
candidates.csv and precinct_scrapers.csv, plus the bounds and totals of the
precincts actually built under elections/2026/data/precincts.
"""
import csv, json, os, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "elections", "2026", "data")
PREC = os.path.join(DATA, "precincts")
NAMES = {
    "AK": "Alaska", "FL": "Florida", "GA": "Georgia", "IA": "Iowa", "MI": "Michigan",
    "NC": "North Carolina", "NE": "Nebraska", "OH": "Ohio", "SC": "South Carolina",
    "TX": "Texas", "VA": "Virginia",
}
PARTY = {"DEM": "dem", "GOP": "rep", "IND": "ind", "LIB": "lib", "GRN": "grn"}


def rows(path):
    return list(csv.DictReader(open(path))) if os.path.exists(path) else []


def num(x, cast=float):
    try:
        return cast(x)
    except (TypeError, ValueError):
        return None


def bounds_and_totals(st):
    """Read the state file the build just wrote rather than trusting a bbox.

    mapshaper writes no bbox, so walk the arcs: they are delta-encoded
    quantized integers, and transform turns them back into degrees.
    """
    t = json.load(open(os.path.join(PREC, f"{st}.topojson")))
    (sx, sy), (dx, dy) = t["transform"]["scale"], t["transform"]["translate"]
    lo = [float("inf")] * 2
    hi = [float("-inf")] * 2
    for arc in t["arcs"]:
        x = y = 0
        for px, py in arc:
            x += px; y += py
            lo[0] = min(lo[0], x); hi[0] = max(hi[0], x)
            lo[1] = min(lo[1], y); hi[1] = max(hi[1], y)
    bbox = [lo[0] * sx + dx, lo[1] * sy + dy, hi[0] * sx + dx, hi[1] * sy + dy]
    geoms = t["objects"]["precincts"]["geometries"]
    return {"bbox": [round(v, 5) for v in bbox], "precincts": len(geoms)}


def main():
    src = sys.argv[1]
    out = os.path.join(src, "out")
    races = {r["state"]: r for r in rows(os.path.join(out, "races.csv"))}
    cands = rows(os.path.join(out, "candidates.csv"))
    scrapes = rows(os.path.join(out, "precinct_scrapers.csv"))
    fits = json.load(open(os.path.join(out, "fits.json")))

    by_state = {}
    for st in sorted(x[:-9] for x in os.listdir(PREC) if x.endswith(".topojson")):
        r = races.get(st, {})
        cs = [c for c in cands if c["state"] == st and num(c["votes"], int)]
        cs.sort(key=lambda c: -num(c["votes"], int))
        geo = bounds_and_totals(st)
        # Votes come from the scraper's own table now that the geometry files
        # carry no numbers of their own.
        cast = sum(num(v["votes"], int) or 0
                   for v in rows(os.path.join(out, "votes", f"{st}.csv")))
        by_state[st] = {
            "name": NAMES.get(st, st),
            "bbox": geo["bbox"],
            "precincts": geo["precincts"],
            "precinct_votes": cast,
            "vintage": fits.get(st, {}).get("vintage"),
            "fit_median_m": round((fits.get(st, {}).get("fit") or {}).get("median_m", 0)) or None,
            "eevp": num(r.get("eevp")),
            "state_votes": num(r.get("total_votes"), int),
            "called": r.get("race_call_status"),
            "url": r.get("url"),
            "candidates": [{
                "id": c["nyt_candidate_id"], "name": c["name"],
                "party": PARTY.get(c["party"], (c["party"] or "oth").lower()),
                "votes": num(c["votes"], int), "percent": num(c["percent"]),
                "leader": c["leader"] == "True", "incumbent": c["incumbent"] == "True",
            } for c in cs],
            "scrapers": [{
                "name": s["scraper_name"], "level": s["data_level"],
                "vote_types": s["vote_types"],
                "reporting": num(s["geographies_reporting"], int),
                "total": num(s["geographies_total"], int),
            } for s in scrapes if s["state"] == st],
        }

    meta = {
        "election": "2026-11-03",
        "office": "U.S. Senate",
        "source": "The New York Times",
        "states": by_state,
        "untiled": sorted(st for st in races if st not in by_state),
    }
    json.dump(meta, open(os.path.join(DATA, "meta.json"), "w"), separators=(",", ":"))
    print(f"meta.json: {len(by_state)} states, "
          f"{sum(s['precincts'] for s in by_state.values()):,} precincts")


if __name__ == "__main__":
    main()
