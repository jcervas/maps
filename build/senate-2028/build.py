#!/usr/bin/env python3
"""Assemble the 2028 Senate (Class III) data set.

Outputs into elections/2028/data:
  class3_states.csv    one row per state up in 2028
  class3_counties.csv  one row per county / county-equivalent in those states
  senate2028.json      the same, packed for the interactive map
  counties.topojson    county geometry for the 34 states only
  states.topojson      state outlines for all 50, so the map has context

Sources (all local):
  magic-wall/data/raw/mcgovern/2024_county_pres.csv   county 2024 presidential
  magic-wall/results/2022-sen-*.json                  2022 Senate, county units
  magic-wall/registry/races_2022.json                 candidate -> party
  magic-wall/geo/counties.topojson, geo/nation-states.topojson
"""
import csv
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))        # build/senate-2028
REPO = os.path.dirname(os.path.dirname(HERE))            # the maps repo
GH = os.path.dirname(REPO)


def find_magic_wall():
    """Where the magic-wall repo is checked out: $MAGIC_WALL, else beside this
    repo. Nothing else. There is a second copy at ~/magic-wall-live which was
    once in this chain; it is a snapshot frozen on November 3, 2026, the poller
    does not write to it, and falling through to it produced a build from stale
    sources that looked entirely normal. Failing is better."""
    def looks_right(path):
        return os.path.isfile(os.path.join(path, "geo", "counties.topojson"))

    # An explicit MAGIC_WALL that does not hold a magic-wall checkout is an
    # error, not something to quietly route around: being specific about the
    # wrong path should not land you on a different one.
    env = os.environ.get("MAGIC_WALL")
    if env:
        if looks_right(env):
            return env
        raise SystemExit("MAGIC_WALL is set to %r, which has no "
                         "geo/counties.topojson in it." % env)
    tried = [os.path.join(GH, "magic-wall")]
    for path in tried:
        if looks_right(path):
            return path
    raise SystemExit(
        "Cannot find the magic-wall repo. Looked in:\n  " + "\n  ".join(tried)
        + "\nSet MAGIC_WALL to its path and run again.\n"
        "Note ~/magic-wall-live is NOT a safe fallback: it is a dormant snapshot, "
        "not the checkout the poller writes to, and a build from it silently uses "
        "stale geometry and returns.")


MW = find_magic_wall()
OUT = os.path.join(REPO, "elections", "2028", "data")

sys.path.insert(0, HERE)
from incumbents import CLASS_III, SEAT_NOTES, NAME_FIXES  # noqa: E402
import ratings  # noqa: E402

ABBRS = [r[1] for r in CLASS_III]
STATE_NAME = {r[1]: r[0] for r in CLASS_III}
FIPS2AB = {}


def load_fips():
    """state FIPS -> postal abbr, taken from the county topology."""
    topo = json.load(open(os.path.join(MW, "geo", "counties.topojson")))
    for g in topo["objects"]["counties"]["geometries"]:
        p = g["properties"]
        FIPS2AB[p["id"][:2]] = p["state"]
    return topo


# ---------------------------------------------------------------- 2024 president
def load_pres():
    """{abbr: {'state': {...}, 'counties': {fips: {...}}}}"""
    path = os.path.join(MW, "data", "raw", "mcgovern", "2024_county_pres.csv")
    out = {ab: {"dem": 0, "rep": 0, "total": 0, "counties": {}} for ab in ABBRS}
    names = {}
    for r in csv.DictReader(open(path)):
        fips = r["county_fips"].zfill(5)
        ab = FIPS2AB.get(fips[:2])
        if ab not in out:
            continue
        dem, rep = int(float(r["votes_dem"])), int(float(r["votes_gop"]))
        tot = int(float(r["total_votes"]))
        names[fips] = r["county_name"]
        # Alaska's rows are state house districts, not boroughs; so are its 2022
        # Senate rows, so the two still join.
        out[ab]["counties"][fips] = {"dem": dem, "rep": rep, "total": tot}
        out[ab]["dem"] += dem
        out[ab]["rep"] += rep
        out[ab]["total"] += tot
    return out, names


# ------------------------------------------------------------------ 2022 senate
def load_senate():
    reg = json.load(open(os.path.join(MW, "registry", "races_2022.json")))
    party = {}
    cand_name = {}
    for race in reg["races"]:
        if race["office"] != "senate":
            continue
        party[race["race_id"]] = {c["id"]: c["party"] for c in race["candidates"]}
        cand_name[race["race_id"]] = {c["id"]: c["name"] for c in race["candidates"]}

    out = {}
    for ab in ABBRS:
        rid = "2022-sen-%s" % ab.lower()
        path = os.path.join(MW, "results", rid + ".json")
        res = json.load(open(path))
        pmap, nmap = party[rid], cand_name[rid]

        def split(votes):
            d = r = o = 0
            for cid, v in votes.items():
                p = pmap.get(cid, "other")
                if p == "dem":
                    d += v
                elif p == "rep":
                    r += v
                else:
                    o += v
            return d, r, o

        sw = res["statewide"]["votes"]
        d, r, o = split(sw)
        ranked = sorted(sw.items(), key=lambda kv: -kv[1])
        top = ranked[0]
        tot = d + r + o
        topn = []
        for cid, v in ranked[:2]:
            topn.append({
                "name": clean_name(nmap.get(cid, cid), cid),
                "party": {"dem": "D", "rep": "R", "lib": "L", "grn": "G"}.get(
                    pmap.get(cid, "other"), "I"),
                "votes": v,
                "pct": pct(v, tot),
            })
        counties = {}
        # Only county-tier units are usable; CT/NH/VT report towns, AK has none.
        for u in res.get("units", []):
            uid = u.get("id") or ""
            if len(uid) != 5 or not uid.isdigit():
                continue
            cd, cr, co = split(u["votes"])
            counties[uid] = {"dem": cd, "rep": cr, "total": cd + cr + co}
        out[ab] = {
            "dem": d, "rep": r, "other": o, "total": tot,
            "winner": clean_name(nmap.get(top[0], top[0]), top[0]),
            "winner_party": pmap.get(top[0], "other"),
            "top": topn,
            "counties": counties,
            "tier": "county",
            "source": "state election-office feeds collected in magic-wall",
        }
    apply_fills(out)
    return out


def last_name(s):
    parts = [re.sub(r"[^a-z]", "", t.lower()) for t in s.replace(",", " ").split()]
    parts = [t for t in parts if t and t not in ("jr", "sr", "ii", "iii", "iv")]
    return parts[-1] if parts else ""


def apply_fills(out):
    """Replace the seven statewide-only or town-tier states with the county
    figures fill_gaps.py pulled from each state's own certified returns."""
    path = os.path.join(OUT, "sen2022_filled.json")
    if not os.path.exists(path):
        print("no sen2022_filled.json; run build/fill_gaps.py first")
        return
    filled = json.load(open(path))
    for ab, block in filled.items():
        if ab not in out:
            continue
        cur, sw = out[ab], block["statewide"]
        cur["counties"] = {fips: {"dem": u["dem"], "rep": u["rep"], "total": u["total"]}
                           for fips, u in block["units"].items()}
        cur["unit_names"] = {fips: u["name"] for fips, u in block["units"].items()}
        cur["dem"], cur["rep"] = sw["dem"], sw["rep"]
        cur["other"], cur["total"] = sw["other"], sw["total"]
        cur["tier"] = block["tier"]
        cur["source"] = block["source"]
        # Keep the registry's spelling of the top two names, take the official counts.
        by_last = {last_name(c["name"]): c for c in block["candidates"]}
        for slot in cur["top"]:
            c = by_last.get(last_name(slot["name"]))
            if c:
                slot["votes"] = c["votes"]
            slot["pct"] = pct(slot["votes"], sw["total"])
    return out


def pct(a, b):
    return round(100.0 * a / b, 2) if b else None


SMALL = {"de", "la", "von", "van", "jr", "sr", "ii", "iii", "iv"}


def clean_name(raw, slug=None):
    """The feeds spell names three different ways: 'FETTERMAN, JOHN K',
    'Raphael Warnock (I)', 'schatz-brian'. Normalize to 'First Last'."""
    if slug and slug in NAME_FIXES:
        return NAME_FIXES[slug]
    s = raw.strip()
    for tag in (" (I)", " (i)", " (D)", " (R)", " (L)", " (G)"):
        s = s.replace(tag, "")
    if "," in s:
        last, first = [p.strip() for p in s.split(",", 1)]
        s = "%s %s" % (first, last)
    parts = []
    for w in s.split():
        if len(w) == 1 or (len(w) == 2 and w.endswith(".")):
            parts.append(w.upper().rstrip(".") + ".")
        elif w.lower() in SMALL:
            parts.append(w.capitalize() if w.lower() in ("de", "la", "von", "van")
                         else w.capitalize() + ".")
        else:
            parts.append("-".join(p.capitalize() for p in w.split("-")))
    return " ".join(parts)


def alaska_districts(county_topo):
    """Alaska reports by state house district, so draw it that way. The house
    topology is quantized on its own grid, so its arcs are re-encoded onto the
    county topology's transform and appended to its arc list."""
    sh = json.load(open(os.path.join(MW, "geo", "state-house.topojson")))
    ct, st = county_topo["transform"], sh["transform"]
    base = len(county_topo["arcs"])
    keep = [g for g in sh["objects"]["districts"]["geometries"]
            if g["properties"].get("state") == "AK"]
    used = sorted({abs(a) - (1 if a < 0 else 0) for g in keep for a in flat_arcs(g)})
    remap = {old: base + i for i, old in enumerate(used)}
    for old in used:
        county_topo["arcs"].append(requantize(sh["arcs"][old], st, ct))
    out = []
    for g in keep:
        n = int(g["properties"]["id"].split("-")[1])
        g = json.loads(json.dumps(g))
        relabel(g, remap)
        g["properties"] = {"id": "02%03d" % n, "state": "AK",
                           "name": "House District %d" % n}
        out.append(g)
    return out


def flat_arcs(geom):
    def walk(a):
        if isinstance(a, list):
            for x in a:
                for y in walk(x):
                    yield y
        else:
            yield a
    return list(walk(geom.get("arcs") or []))


def relabel(geom, remap):
    def walk(a):
        if a and isinstance(a[0], list):
            return [walk(x) for x in a]
        return [(~remap[~i] if i < 0 else remap[i]) for i in a]
    if geom.get("arcs"):
        geom["arcs"] = walk(geom["arcs"])


def requantize(arc, src, dst):
    """Delta-encoded arc from one transform's grid to another's."""
    x = y = 0
    points = []
    for dx, dy in arc:
        x += dx
        y += dy
        points.append((x * src["scale"][0] + src["translate"][0],
                       y * src["scale"][1] + src["translate"][1]))
    quant = []
    for lon, lat in points:
        quant.append((int(round((lon - dst["translate"][0]) / dst["scale"][0])),
                      int(round((lat - dst["translate"][1]) / dst["scale"][1]))))
    # Alaska's house districts carry a far more detailed coastline than this map
    # ever draws, so drop points inside a cell about 200 m across. Arcs are shared
    # between neighboring districts and each is thinned the same way, so the
    # boundaries still meet.
    tol = 30
    thinned = [quant[0]]
    for q in quant[1:-1]:
        last = thinned[-1]
        if abs(q[0] - last[0]) >= tol or abs(q[1] - last[1]) >= tol:
            thinned.append(q)
    if len(quant) > 1 and quant[-1] != thinned[-1]:
        thinned.append(quant[-1])
    out, px, py = [], 0, 0
    for qx, qy in thinned:
        out.append([qx - px, qy - py])
        px, py = qx, qy
    return out


def chamber(state_rows):
    """The other two thirds of the Senate, so the map says what is and is not in
    play. Class I comes from magic-wall's holdovers file, which is checked
    against the senate.gov roster; Class III is counted from our own rows, and
    the two agree on the 32 Class III seats the holdovers file also lists.

    Class II was elected on November 3, 2026 and is still being counted, so it
    carries no numbers here. Guessing at the split from a two-day-old count is
    exactly the sort of figure that is wrong by morning."""
    path = os.path.join(MW, "data", "reference", "holdovers_2026.json")
    sen = json.load(open(path))["senate"]
    c1 = [h for h in sen["holdovers"] if h.get("class") == 1]
    c3_file = [h for h in sen["holdovers"] if h.get("class") == 3]

    def tally(rows, key):
        out = {"dem": 0, "rep": 0, "ind": 0}
        for h in rows:
            out[h.get(key, "ind")] = out.get(h.get(key, "ind"), 0) + 1
        return out

    party, caucus = tally(c1, "party"), tally(c1, "caucus")
    d3 = sum(1 for r in state_rows if r["incumbent_party"] == "D")

    # The holdovers file lists 32 Class III seats: Florida and Ohio were on the
    # 2026 ballot as specials, so they are ours to count, not its.
    check = tally(c3_file, "party")
    assert check["dem"] + check["rep"] + 2 == len(state_rows), "Class III mismatch"

    return {
        "seats": sen["seats"], "majority": sen["majority"],
        "classes": [
            {"name": "Class I", "seats": len(c1), "elected": 2024, "next": 2030,
             "dem": party["dem"], "rep": party["rep"], "ind": party["ind"],
             "caucus_dem": caucus["dem"], "caucus_rep": caucus["rep"]},
            {"name": "Class II", "seats": 33, "elected": 2026, "next": 2032,
             "pending": "Elected November 3, 2026. Still being counted."},
            {"name": "Class III", "seats": len(state_rows), "elected": 2022, "next": 2028,
             "dem": d3, "rep": len(state_rows) - d3, "ind": 0,
             "caucus_dem": d3, "caucus_rep": len(state_rows) - d3, "this_map": True},
        ],
        "source": "magic-wall data/reference/holdovers_2026.json, checked against "
                  "the senate.gov roster; Class III counted from this data set.",
    }


def main():
    topo = load_fips()
    pres, cname = load_pres()
    sen = load_senate()
    os.makedirs(OUT, exist_ok=True)

    # ---- state table
    state_rows = []
    for name, ab, who, pty, since, how in CLASS_III:
        p, s = pres[ab], sen[ab]
        state_rows.append({
            "state": name, "abbr": ab,
            "incumbent": who, "incumbent_party": pty,
            "in_office_since": since, "seat_path": how,
            "sen22_winner": s["winner"],
            "sen22_winner_party": {"dem": "D", "rep": "R"}.get(s["winner_party"], "I"),
            "sen22_top1": "%s (%s)" % (s["top"][0]["name"], s["top"][0]["party"]),
            "sen22_top1_votes": s["top"][0]["votes"],
            "sen22_top1_pct": s["top"][0]["pct"],
            "sen22_top2": "%s (%s)" % (s["top"][1]["name"], s["top"][1]["party"]),
            "sen22_top2_votes": s["top"][1]["votes"],
            "sen22_top2_pct": s["top"][1]["pct"],
            "sen22_dem_votes": s["dem"], "sen22_rep_votes": s["rep"],
            "sen22_other_votes": s["other"], "sen22_total_votes": s["total"],
            "sen22_dem_pct": pct(s["dem"], s["total"]),
            "sen22_rep_pct": pct(s["rep"], s["total"]),
            "sen22_margin_pct": round(pct(s["rep"], s["total"]) - pct(s["dem"], s["total"]), 2),
            "pres24_harris_votes": p["dem"], "pres24_trump_votes": p["rep"],
            "pres24_total_votes": p["total"],
            "pres24_harris_pct": pct(p["dem"], p["total"]),
            "pres24_trump_pct": pct(p["rep"], p["total"]),
            "pres24_margin_pct": round(pct(p["rep"], p["total"]) - pct(p["dem"], p["total"]), 2),
            "counties_with_sen22": len(s["counties"]),
            "sen22_county_coverage_pct": pct(
                sum(c["total"] for c in s["counties"].values()), s["total"]),
            "sen22_unit_tier": s["tier"],
            "sen22_county_source": s["source"],
            "note": SEAT_NOTES.get(ab, ""),
        })
    # swing: how much more Republican the 2024 presidential margin was than 2022 Senate
    for row in state_rows:
        row["pres24_minus_sen22_margin"] = round(
            row["pres24_margin_pct"] - row["sen22_margin_pct"], 2)
        rating, lean, adj, basis = ratings.rate(
            row["abbr"], row["pres24_margin_pct"], row["sen22_margin_pct"],
            row["incumbent_party"])
        row["rating"] = rating
        row["rating_lean"] = lean
        row["rating_adjusted"] = adj
        row["rating_basis"] = basis

    cols = ["state", "abbr", "incumbent", "incumbent_party", "rating",
            "rating_lean", "rating_adjusted", "in_office_since", "seat_path",
            "sen22_winner", "sen22_winner_party",
            "sen22_top1", "sen22_top1_votes", "sen22_top1_pct",
            "sen22_top2", "sen22_top2_votes", "sen22_top2_pct",
            "sen22_dem_votes", "sen22_rep_votes", "sen22_other_votes", "sen22_total_votes",
            "sen22_dem_pct", "sen22_rep_pct", "sen22_margin_pct",
            "pres24_harris_votes", "pres24_trump_votes", "pres24_total_votes",
            "pres24_harris_pct", "pres24_trump_pct", "pres24_margin_pct",
            "pres24_minus_sen22_margin", "counties_with_sen22",
            "sen22_county_coverage_pct", "sen22_unit_tier",
            "sen22_county_source", "rating_basis", "note"]
    with open(os.path.join(OUT, "class3_states.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(state_rows)

    # ---- county table
    county_rows = []
    for name, ab, *_ in CLASS_III:
        pc, sc = pres[ab]["counties"], sen[ab]["counties"]
        for fips in sorted(set(pc) | set(sc)):
            p = pc.get(fips)
            s = sc.get(fips)
            unit_name = cname.get(fips) or sen[ab].get("unit_names", {}).get(fips, "")
            row = {"fips": fips, "county": unit_name, "state": name, "abbr": ab}
            if p:
                row.update({
                    "pres24_harris_votes": p["dem"], "pres24_trump_votes": p["rep"],
                    "pres24_total_votes": p["total"],
                    "pres24_harris_pct": pct(p["dem"], p["total"]),
                    "pres24_trump_pct": pct(p["rep"], p["total"]),
                    "pres24_margin_pct": round(pct(p["rep"], p["total"]) - pct(p["dem"], p["total"]), 2),
                })
            if s and s["total"]:
                row.update({
                    "sen22_dem_votes": s["dem"], "sen22_rep_votes": s["rep"],
                    "sen22_total_votes": s["total"],
                    "sen22_dem_pct": pct(s["dem"], s["total"]),
                    "sen22_rep_pct": pct(s["rep"], s["total"]),
                    "sen22_margin_pct": round(pct(s["rep"], s["total"]) - pct(s["dem"], s["total"]), 2),
                })
            if p and s and s["total"]:
                row["pres24_minus_sen22_margin"] = round(
                    row["pres24_margin_pct"] - row["sen22_margin_pct"], 2)
            county_rows.append(row)

    ccols = ["fips", "county", "state", "abbr",
             "pres24_harris_votes", "pres24_trump_votes", "pres24_total_votes",
             "pres24_harris_pct", "pres24_trump_pct", "pres24_margin_pct",
             "sen22_dem_votes", "sen22_rep_votes", "sen22_total_votes",
             "sen22_dem_pct", "sen22_rep_pct", "sen22_margin_pct",
             "pres24_minus_sen22_margin"]
    with open(os.path.join(OUT, "class3_counties.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=ccols, extrasaction="ignore")
        w.writeheader()
        w.writerows(county_rows)

    # ---- JSON for the map: compact arrays, two decimals
    counties_json = {}
    for r in county_rows:
        counties_json[r["fips"]] = [
            r["county"], r["abbr"],
            r.get("pres24_harris_votes"), r.get("pres24_trump_votes"), r.get("pres24_total_votes"),
            r.get("sen22_dem_votes"), r.get("sen22_rep_votes"), r.get("sen22_total_votes"),
        ]
    payload = {
        "generated": "2026-11-04",
        "fields": ["name", "state", "p24_dem", "p24_rep", "p24_total",
                   "s22_dem", "s22_rep", "s22_total"],
        "chamber": chamber(state_rows),
        "rating_order": ratings.ORDER,
        "rating_short": ratings.SHORT,
        "states": state_rows,
        "counties": counties_json,
    }
    with open(os.path.join(OUT, "senate2028.json"), "w") as f:
        json.dump(payload, f, separators=(",", ":"))

    # ---- geometry: counties in the 34 states only
    keep = set(ABBRS)
    geos = [g for g in topo["objects"]["counties"]["geometries"]
            if g["properties"]["state"] in keep]
    for g in geos:
        p = g["properties"]
        g["properties"] = {"id": p["id"], "name": p["name"], "state": p["state"]}
    geos += alaska_districts(topo)
    sub = {"type": "Topology", "transform": topo["transform"], "arcs": topo["arcs"],
           "objects": {"counties": {"type": "GeometryCollection", "geometries": geos}}}
    with open(os.path.join(OUT, "counties.topojson"), "w") as f:
        json.dump(sub, f, separators=(",", ":"))

    states_topo = os.path.join(MW, "geo", "nation-states.topojson")
    with open(states_topo) as f_in, open(os.path.join(OUT, "states.topojson"), "w") as f_out:
        f_out.write(f_in.read())

    print("states: %d  counties: %d" % (len(state_rows), len(county_rows)))
    print("no county-level 2022 Senate: %s" % ", ".join(
        r["abbr"] for r in state_rows if r["counties_with_sen22"] == 0))


if __name__ == "__main__":
    main()
