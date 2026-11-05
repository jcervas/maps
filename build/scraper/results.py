#!/usr/bin/env python3
"""The race behind the precincts: all 35 Senate contests, statewide.

    python3 results.py

Reads the Times's own page file -- the one results-senate.html is built from --
and writes two tables. races.csv is the state totals: candidates, votes, the
Times's estimated share of the expected vote, whether the race has been called
and by whom. candidates.csv is the candidate ids, which is what joins the
precinct files' dem_c / rep_c / ind_c / other_c back to a name.

It also writes precinct_scrapers.csv: for every race, the precinct scrapes the
Times is running, how many precincts each covers and which vote types are in
them. That is the straight answer to how complete a state's precinct map is,
and it covers states the Times has not tiled as well as the eleven it has.
"""
import csv, json, os, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
URL = "https://static01.nyt.com/elections-assets/pages/data/2026-11-03/results-senate.json"
UA = "private election-results display, one request per refresh"
OUT = os.path.join(HERE, "out")


def load():
    req = urllib.request.Request(URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def main():
    d = load()
    os.makedirs(OUT, exist_ok=True)
    races, cands, scrapes = [], [], []
    for r in d["races"]:
        tru = r["top_reporting_unit"]
        st = tru["state_postal"]
        by_id = {c["nyt_id"]: c for c in (r.get("candidate_metadata") or {}).values()}
        votes = {v["nyt_id"]: v for v in (tru.get("candidates") or [])}
        races.append({
            "nyt_race_id": r["nyt_id"], "state": st, "office": r["office"],
            "seat_number": r.get("seat_number"), "uncontested": r.get("uncontested"),
            "eevp": tru.get("eevp"), "total_votes": tru.get("total_votes"),
            "total_expected_vote": tru.get("total_expected_vote"),
            "precincts_reporting": tru.get("precincts_reporting"),
            "precincts_total": tru.get("precincts_total"),
            "provider": tru.get("provider"),
            "race_call_status": r.get("race_call_status"),
            "won": ",".join((r.get("outcome") or {}).get("won") or []),
            "gained": (r.get("outcome") or {}).get("gained"),
            "rating": r.get("rating"), "updated_at": r.get("updated_at"),
            "url": r.get("url"),
        })
        total = tru.get("total_votes") or 0
        for nyt_id, c in by_id.items():
            v = votes.get(nyt_id, {})
            # votes comes as {"total": n, "absentee_mail": n, ...}: the breakdown
            # is the same split the precinct files report in vote_types.
            vv = v.get("votes") or {}
            n = vv.get("total")
            cands.append({
                "nyt_race_id": r["nyt_id"], "state": st,
                "nyt_candidate_id": c.get("nyt_candidate_id"), "nyt_id": nyt_id,
                "name": " ".join(x for x in (c.get("first_name"), c.get("last_name")) if x)
                        or c.get("last_name") or "",
                "party": (c.get("party") or {}).get("nyt_id")
                         if isinstance(c.get("party"), dict) else c.get("party"),
                "incumbent": c.get("incumbent"),
                "votes": n, "percent": round(100 * n / total, 3) if n and total else None,
                "leader": v.get("leader"),
                "votes_by_type": ";".join(f"{k}={x}" for k, x in sorted(vv.items())
                                          if k != "total"),
            })
        for p in (r.get("precincts") or []):
            m = p.get("scrape_meta") or {}
            scrapes.append({
                "nyt_race_id": r["nyt_id"], "state": st,
                "scraper_name": p.get("scraper_name"), "data_level": m.get("dataLevel"),
                "vote_types": m.get("voteTypes"), "scraped_at": m.get("scraped_at"),
                "geographies_total": m.get("geographiesTotal"),
                "geographies_reporting": m.get("geographiesReporting"),
                "total_votes": m.get("totalVotes"), "flagged": m.get("flagged"),
            })
    for name, rows in (("races", races), ("candidates", cands),
                       ("precinct_scrapers", scrapes)):
        if not rows:
            continue
        with open(os.path.join(OUT, f"{name}.csv"), "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        print(f"{name}.csv: {len(rows)} rows")
    print("results updated", d["resultsMeta"]["resultsUpdatedAt"])


if __name__ == "__main__":
    main()
