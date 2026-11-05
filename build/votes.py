#!/usr/bin/env python3
"""The numbers, split out from the shapes so they can be refreshed on their own.

    python3 build/votes.py <scraper dir> [ST ...]

The precinct boundaries change when a state redraws them, which is to say
almost never; the votes change every hour until the count is finished. Keeping
them in one file means re-committing 51 MB of geometry to record that a county
in Alaska found another two hundred ballots. So the geometry files carry only
what is permanent -- geoid, county, county name -- and everything that moves
lives here, in one small file per state that the page fetches alongside and
joins on the geoid.

    elections/2026/data/votes/<ST>.json

    {"vintage": "20261105_00",
     "fetched": "2026-11-05T01:12:44Z",
     "fields": ["votes","dem","rep","ind","oth","margin","winner","density","types"],
     "rows": {"13001-1B": [748, 310, 430, 0, 8, -16, "R", 29, "am,ei,ed"]}}

Rows are arrays rather than objects because the key names would otherwise be
four fifths of the file: Georgia is 150 KB this way and 600 KB spelled out.
Vote types are abbreviated by the same reasoning; TYPES below is the key.

All eleven states come to about 2.5 MB, which is a tolerable thing to commit
once an hour and a useful thing to have committed -- the git history of this
directory is a record of how the count actually moved, which is not something
the Times keeps for you.
"""
import csv, json, os, sys, datetime

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "elections", "2026", "data", "votes")
FIELDS = ["votes", "dem", "rep", "ind", "oth", "margin", "winner", "density", "types"]
# The Times's vote-type names, shortened. Anything unrecognised passes through
# whole rather than being dropped: a new type should look odd, not vanish.
TYPES = {
    "election_day_in_person": "ed", "early_in_person": "ei", "absentee_mail": "am",
    "advance_in_person": "ai", "advance": "av", "provisional": "pr",
    "other": "ot", "all": "all",
}


def num(x):
    try:
        return int(x)
    except (TypeError, ValueError):
        return 0


def build(src, st):
    path = os.path.join(src, "out", "votes", f"{st}.csv")
    if not os.path.exists(path):
        return None
    rows, vintage = {}, None
    for r in csv.DictReader(open(path)):
        geoid = r["geoid"]
        if not geoid:
            continue
        vintage = vintage or r.get("vintage")
        rows[geoid] = [
            num(r["votes"]), num(r["dem_votes"]), num(r["rep_votes"]),
            num(r["ind_votes"]), num(r["other_votes"]),
            num(r["win_margin"]) * (-1 if r["winner"] in ("D", "I") else 1),
            r["winner"] or "",
            num(r["voter_density"]),
            ",".join(TYPES.get(t, t) for t in (r["vote_types"] or "").split(",") if t),
        ]
    os.makedirs(OUT, exist_ok=True)
    doc = {
        "state": st, "vintage": vintage,
        "fetched": datetime.datetime.now(datetime.timezone.utc)
                   .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fields": FIELDS, "types": {v: k for k, v in TYPES.items()}, "rows": rows,
    }
    p = os.path.join(OUT, f"{st}.json")
    json.dump(doc, open(p, "w"), separators=(",", ":"))
    return len(rows), os.path.getsize(p), vintage


def main():
    src = sys.argv[1]
    states = sys.argv[2:] or sorted(
        f[:-4] for f in os.listdir(os.path.join(src, "out", "votes")) if f.endswith(".csv"))
    total = 0
    for st in states:
        r = build(src, st)
        if not r:
            print(f"{st}: no votes file")
            continue
        n, size, vintage = r
        total += size
        print(f"{st}: {n:,} precincts, {size / 1024:.0f} KB, {vintage}")
    print(f"votes/: {total / 1e6:.1f} MB in all")


if __name__ == "__main__":
    main()
