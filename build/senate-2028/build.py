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
from incumbents import (CLASS_III, SEAT_NOTES, NAME_FIXES,  # noqa: E402
                        CHAMBER_CONTROL, CLASS_II, CLASS_II_NOTES,
                        CLASS_II_SOURCE)
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


def check_class_ii():
    """Re-derive Class II from magic-wall's AP tree and complain if the literal
    in incumbents.py no longer matches it.

    The literal is what gets published, on purpose: magic-wall's results are a
    live feed the election-night wall keeps refreshing, and a page that quietly
    changes its chamber arithmetic every time that feed moves is worse than one
    carrying a dated figure. But a dated figure that has silently gone wrong is
    worse than both, so the build checks and says so."""
    reg_path = os.path.join(MW, "registry", "races_2026.json")
    if not os.path.isfile(reg_path):
        print("  class II: no 2026 registry in magic-wall, literal not checked")
        return
    raw = json.load(open(reg_path))["races"]
    reg = {r["race_id"]: r for r in raw} if isinstance(raw, list) else raw
    want = {ab: pty for _, ab, _, pty, _, _ in CLASS_II}
    seen, bad = set(), []
    for ab in sorted(want):
        rid = "2026-sen-" + ab.lower()
        res = os.path.join(MW, "results", rid + ".json")
        if rid not in reg or not os.path.isfile(res):
            continue
        votes = json.load(open(res)).get("statewide", {}).get("votes", {}) or {}
        if not votes:
            continue
        cands = {c["id"]: c for c in reg[rid].get("candidates", [])}
        lead = max(votes.items(), key=lambda kv: kv[1])[0]
        pty = {"dem": "D", "rep": "R"}.get(cands.get(lead, {}).get("party"), "I")
        seen.add(ab)
        if pty != want[ab]:
            bad.append("%s: literal says %s, the feed now leads %s" % (ab, want[ab], pty))
    if bad:
        print("  class II: THE FEED HAS MOVED -- update incumbents.CLASS_II")
        for b in bad:
            print("    " + b)
    else:
        print("  class II: %d of 33 seats re-checked against the AP tree, all agree"
              % len(seen))


def check_overrides():
    """An overridden seat reads a 2026 margin, and 2026 is still being counted
    in places. Same deal as the Class II literal: publish the dated figure, but
    re-derive it every build so a count that has moved cannot pass silently."""
    reg_path = os.path.join(MW, "registry", "races_2026.json")
    if not ratings.OVERRIDE:
        return
    if not os.path.isfile(reg_path):
        print("  overrides: no 2026 registry in magic-wall, not checked")
        return
    raw = json.load(open(reg_path))["races"]
    reg = {r["race_id"]: r for r in raw} if isinstance(raw, list) else raw
    for ab, ov in sorted(ratings.OVERRIDE.items()):
        rid = "2026-sen-" + ab.lower()
        res = os.path.join(MW, "results", rid + ".json")
        if rid not in reg or not os.path.isfile(res):
            print("  overrides: %s has no 2026 result to check against" % ab)
            continue
        votes = json.load(open(res)).get("statewide", {}).get("votes", {}) or {}
        cands = {c["id"]: c for c in reg[rid].get("candidates", [])}
        total = sum(votes.values())
        if not total:
            continue
        side = {"dem": 0, "rep": 0}
        for cid, v in votes.items():
            party = cands.get(cid, {}).get("party")
            if party in side:
                side[party] += v
        now = 100.0 * (side["rep"] - side["dem"]) / total
        drift = abs(now - ov["margin"])
        if drift > 0.25:
            print("  overrides: %s SAYS %+.2f, the feed now says %+.2f "
                  "-- update ratings.OVERRIDE" % (ab, ov["margin"], now))
        else:
            print("  overrides: %s %+.2f, the feed agrees to %.2f points"
                  % (ab, ov["margin"], drift))


def chamber(state_rows):
    """All 100 seats, so the map can say what the 2028 class walks into.

    Class I comes from magic-wall's holdovers file, which is checked against the
    senate.gov roster. Class II is the November 3, 2026 result, hand-entered in
    incumbents.py and re-checked here against the AP tree. Class III is counted
    from our own rows.

    Two counts come out of this and they are not the same number. The settled
    count leaves out Mississippi and Alaska, which are still being counted; the
    full count puts them with whoever leads. The page prints the settled one and
    names the other two, because a seat that is 43 votes apart is not a seat."""
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

    check_class_ii()
    check_overrides()

    # ---- every seat, so the map can paint a delegation rather than a class
    PARTY = {"dem": "D", "rep": "R", "ind": "I"}
    seats = []
    for h in c1:
        seats.append({
            "cls": 1, "abbr": h["state"], "senator": h["senator"],
            "party": PARTY.get(h.get("party"), "I"),
            "caucus": PARTY.get(h.get("caucus"), "I"),
            "next": 2030, "settled": True,
        })
    for name, ab, who, pty, called, marg in CLASS_II:
        seat = {"cls": 2, "abbr": ab, "senator": who, "party": pty,
                "caucus": pty, "next": 2032, "settled": bool(called),
                "margin": marg}
        if ab in CLASS_II_NOTES:
            seat["note"] = CLASS_II_NOTES[ab]
        seats.append(seat)
    for r in state_rows:
        seats.append({
            "cls": 3, "abbr": r["abbr"], "senator": r["incumbent"],
            "party": r["incumbent_party"], "caucus": r["incumbent_party"],
            "next": 2028, "settled": False, "rating": r["rating"],
            "on_ballot": True,
        })

    # Every state holds two of the three classes, so Class II and Class III
    # between them name all fifty -- the map needs the name of a state whether
    # or not it is on the 2028 ballot.
    names = {}
    for name, ab, _, _, _, _ in CLASS_II:
        names[ab] = name
    for r in state_rows:
        names[r["abbr"]] = r["state"]
    assert len(names) == 50, "expected 50 state names, got %d" % len(names)

    assert len(seats) == 100, "expected 100 seats, got %d" % len(seats)
    per_state = {}
    for s in seats:
        per_state.setdefault(s["abbr"], []).append(s["cls"])
    odd = {k: v for k, v in per_state.items() if len(v) != 2}
    assert not odd, "states without exactly two seats: %r" % odd

    # ---- the 2029 arithmetic
    def side(rating):
        if rating == "Toss Up":
            return None
        return "D" if rating.endswith("Democrat") else "R"

    held = {"D": 0, "R": 0}
    for s in seats:
        if s["cls"] in (1, 2) and s["settled"]:
            held[s["caucus"]] = held.get(s["caucus"], 0) + 1

    rated = {"D": 0, "R": 0}
    toss = []
    for r in state_rows:
        who = side(r["rating"])
        if who is None:
            toss.append(r["abbr"])
        else:
            rated[who] += 1

    pending = [{"abbr": ab, "state": name, "leader": who, "party": pty,
                "margin": marg, "note": CLASS_II_NOTES.get(ab, "")}
               for name, ab, who, pty, called, marg in CLASS_II if not called]

    floor_d = held["D"] + rated["D"]
    open_seats = len(toss) + len(pending)
    lean_d = floor_d + sum(1 for p in pending if p["party"] == "D")

    projection = {
        "settled_dem": held["D"], "settled_rep": held["R"],
        "rated_dem": rated["D"], "rated_rep": rated["R"],
        "tossup": toss, "pending": pending,
        "open": open_seats,
        "floor_dem": floor_d, "ceiling_dem": floor_d + open_seats,
        "floor_rep": held["R"] + rated["R"],
        "ceiling_rep": held["R"] + rated["R"] + open_seats,
        "lean_dem": lean_d, "lean_rep": 100 - lean_d - len(toss),
        # Spelled from the counts rather than written out: an override that
        # moves a seat into or out of Toss Up would otherwise leave this
        # sentence quietly wrong.
        "note": ("Class I and the settled Class II seats are holdovers: nobody "
                 "votes on them in 2028. Class III is on the ballot, so its "
                 "seats enter at their rating, and the %d toss-ups enter "
                 "nowhere. %s are 2026 races still being counted, so they are "
                 "open here too." % (
                     len(toss),
                     " and ".join(p["state"] for p in pending) or "No seats")),
    }

    return {
        "seats": sen["seats"], "majority": sen["majority"],
        "control": CHAMBER_CONTROL,
        "all_seats": seats,
        "state_names": names,
        "projection": projection,
        "classes": [
            {"name": "Class I", "seats": len(c1), "elected": 2024, "next": 2030,
             "dem": party["dem"], "rep": party["rep"], "ind": party["ind"],
             "caucus_dem": caucus["dem"], "caucus_rep": caucus["rep"]},
            {"name": "Class II", "seats": len(CLASS_II), "elected": 2026, "next": 2032,
             "dem": sum(1 for r in CLASS_II if r[3] == "D" and r[4]),
             "rep": sum(1 for r in CLASS_II if r[3] == "R" and r[4]),
             "ind": 0,
             "caucus_dem": sum(1 for r in CLASS_II if r[3] == "D" and r[4]),
             "caucus_rep": sum(1 for r in CLASS_II if r[3] == "R" and r[4]),
             "counting": len(pending)},
            {"name": "Class III", "seats": len(state_rows), "elected": 2022, "next": 2028,
             "dem": d3, "rep": len(state_rows) - d3, "ind": 0,
             "caucus_dem": d3, "caucus_rep": len(state_rows) - d3, "this_map": True},
        ],
        "source": "magic-wall data/reference/holdovers_2026.json, checked against "
                  "the senate.gov roster; Class II from " + CLASS_II_SOURCE +
                  " Class III counted from this data set.",
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
        rating, lean, adj, basis, overridden = ratings.rate(
            row["abbr"], row["pres24_margin_pct"], row["sen22_margin_pct"],
            row["incumbent_party"])
        row["rating"] = rating
        row["rating_lean"] = lean
        row["rating_adjusted"] = adj
        row["rating_basis"] = basis
        row["rating_overridden"] = 1 if overridden else 0

    cols = ["state", "abbr", "incumbent", "incumbent_party", "rating",
            "rating_lean", "rating_adjusted", "rating_overridden",
            "in_office_since", "seat_path",
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
