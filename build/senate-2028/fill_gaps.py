#!/usr/bin/env python3
"""County-level 2022 Senate returns for the seven states the local files miss.

magic-wall's 2022 files are statewide-only for AK, ID, IN and MO, and town-tier
for CT, NH and VT. This fetches each state's own certified returns and writes

    elections/2028/data/sen2022_filled.json
      {abbr: {"source": str, "tier": "county"|"district",
              "units": {unit_id: {"name", "dem", "rep", "other", "total"}},
              "statewide": {"dem", "rep", "other", "total"}}}

Units are five-digit county FIPS, except Alaska, which reports by state house
district and gets ids 02001..02040 — the same ids the 2024 presidential county
file uses for Alaska, so the two join.

Downloads are cached in build/senate-2028/cache/ so a rerun costs nothing.
"""
import csv
import io
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))        # build/senate-2028
REPO = os.path.dirname(os.path.dirname(HERE))            # the maps repo
GH = os.path.dirname(REPO)
MW = os.path.join(GH, "magic-wall")
CACHE = os.path.join(HERE, "cache")
OUT = os.path.join(REPO, "elections", "2028", "data")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0 Safari/537.36")


def get(url, name, post=None, headers=None):
    """Fetch once, then serve from build/senate-2028/cache/."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return open(path, "rb").read()
    h = {"User-Agent": UA}
    h.update(headers or {})
    data = post.encode() if isinstance(post, str) else post
    req = urllib.request.Request(url, data=data, headers=h,
                                 method="POST" if data is not None else "GET")
    with urllib.request.urlopen(req, timeout=180) as r:
        blob = r.read()
    with open(path, "wb") as f:
        f.write(blob)
    return blob


# ------------------------------------------------------------------ geography
def county_index():
    """{(state, normalized county name): fips} from the county topology."""
    topo = json.load(open(os.path.join(MW, "geo", "counties.topojson")))
    idx = {}
    for g in topo["objects"]["counties"]["geometries"]:
        p = g["properties"]
        idx[(p["state"], norm(p["name"]))] = p["id"]
    return idx


def norm(s):
    s = (s or "").lower()
    s = s.replace("saint ", "st ").replace("sainte ", "ste ")
    s = re.sub(r"\b(county|parish|borough|census area|city and borough|"
               r"municipality|planning region)\b", " ", s)
    s = re.sub(r"[^a-z0-9]+", "", s)
    return s


MANUAL = {
    ("MO", "stlouiscity"): "29510",
    ("MO", "kansascity"): "29095",
    ("MO", "stlouis"): "29189",
    ("MO", "stlouiscounty"): "29189",
    ("IN", "laporte"): "18091",
    ("NY", "manhattan"): "36061",
    ("NY", "newyork"): "36061",
    ("NY", "brooklyn"): "36047",
    ("NY", "kings"): "36047",
    ("NY", "staten"): "36085",
    ("NY", "statenisland"): "36085",
    ("NY", "richmond"): "36085",
    ("NY", "queens"): "36081",
    ("NY", "bronx"): "36005",
    ("ID", "kootenai"): "16055",
    ("SD", "oglalalakota"): "46102",
    ("SD", "shannon"): "46102",
    ("CT", "capitol"): "09110",
    ("CT", "greaterbridgeport"): "09120",
    ("CT", "lowerconnecticutrivervalley"): "09130",
    ("CT", "naugatuckvalley"): "09140",
    ("CT", "northeastern"): "09150",
    ("CT", "northwesthills"): "09160",
    ("CT", "southcentral"): "09170",
    ("CT", "southeastern"): "09180",
    ("CT", "western"): "09190",
}


def fips_of(idx, state, name):
    k = (state, norm(name))
    if k in MANUAL:
        return MANUAL[k]
    if k in idx:
        return idx[k]
    raise KeyError("%s: no county for %r (%s)" % (state, name, k[1]))


# -------------------------------------------------------------------- parties
SUFFIXES = {"jr", "sr", "ii", "iii", "iv"}


def party_map(abbr):
    """{normalized last name: 'dem'|'rep'|other} from the 2022 race registry."""
    reg = json.load(open(os.path.join(MW, "registry", "races_2022.json")))
    for race in reg["races"]:
        if race["office"] == "senate" and race["state"] == abbr and not race["special"]:
            out = {}
            for c in race["candidates"]:
                last = re.sub(r"[^a-z]", "", c["name"].split()[-1].lower())
                if last in SUFFIXES:
                    last = re.sub(r"[^a-z]", "", c["name"].split()[-2].lower())
                out[last] = c["party"]
            return out
    return {}


def bucket(votes_by_cand, parties, tally=None):
    """votes_by_cand: {display name: votes} -> dem/rep/other.

    `tally`, when given, collects the statewide per-candidate totals."""
    d = r = o = 0
    for name, v in votes_by_cand.items():
        tokens = [re.sub(r"[^a-z]", "", t.lower()) for t in (name or "").replace(",", " ").split()]
        tokens = [t for t in tokens if t and t not in SUFFIXES]
        p = None
        # Names arrive as "Todd Young", "Chesbro, Patricia R." and
        # "Thomas M. McDermott, Jr.": try every token against the registry.
        for t in reversed(tokens):
            if t in parties:
                p = parties[t]
                break
        if tally is not None and name:
            row = tally.setdefault(name, {"party": p or "other", "votes": 0})
            row["votes"] += v
        if p == "dem":
            d += v
        elif p == "rep":
            r += v
        else:
            o += v
    return d, r, o


def pack(units, tier, source, tally=None):
    sw = {"dem": 0, "rep": 0, "other": 0, "total": 0}
    for u in units.values():
        for k in ("dem", "rep", "other", "total"):
            sw[k] += u[k]
    cands = sorted(({"name": n, "party": t["party"], "votes": t["votes"]}
                    for n, t in (tally or {}).items()),
                   key=lambda c: -c["votes"])
    return {"source": source, "tier": tier, "units": units,
            "statewide": sw, "candidates": cands}


# ------------------------------------------------------------------ the states
def alaska(idx):
    """Division of Elections precinct export, summed to the 40 house districts."""
    url = ("https://elections.alaska.gov/results/22GENR/"
           "Results_per_Precinct_2022_11_30T14_17_52_To%20Excel.txt")
    text = get(url, "ak_precinct_2022.txt").decode("utf-16-le", "replace").lstrip("﻿")
    lines = text.replace("\r", "").split("\n")
    start = next(i for i, l in enumerate(lines) if l.startswith("U.S. Senator"))
    header = [h.strip().strip('"') for h in lines[start + 1].split("\t")]
    parties = party_map("AK")
    units, tally = {}, {}
    for line in lines[start + 2:]:
        cells = line.split("\t")
        label = cells[0].strip()
        if not label:
            break
        m = re.match(r"^(\d\d)-", label) or re.match(r"^District\s+(\d+)\s*-", label)
        if not m:
            continue                      # HD99 federal overseas absentee: no geography
        dist = int(m.group(1))
        fips = "02%03d" % dist
        u = units.setdefault(fips, {"name": "State House District %d" % dist,
                                    "dem": 0, "rep": 0, "other": 0, "total": 0})
        row = {}
        for name, cell in zip(header[1:], cells[1:]):
            row[name.split(" - ")[0]] = int(cell.replace(",", "") or 0) if cell.strip() else 0
        d, r, o = bucket(row, parties, tally)
        u["dem"] += d
        u["rep"] += r
        u["other"] += o
        u["total"] += d + r + o
    return pack(units, "district",
                "Alaska Division of Elections, 2022 general per-precinct export, "
                "summed to house districts (first-choice votes)", tally)


def civera(host, tenant, contest_id, name):
    q = """query G($contestId: Int!) {
      contestGranularData(contestId: $contestId, voteChannels: false, splitParty: false) {
        candidates { candidateId displayName partyId nVotes
                     candidate { pseudocandidate } }
        divisions { children { division { displayName }
                               granularRow { candidateId votes } } } } }"""
    body = json.dumps({"query": q, "variables": {"contestId": contest_id}})
    blob = get(host + "/api/graphql_pr", name, post=body,
               headers={"Content-Type": "application/json", "X-Elstats-Tenant": tenant})
    d = json.loads(blob)
    if d.get("errors"):
        raise RuntimeError(json.dumps(d["errors"])[:300])
    return d["data"]["contestGranularData"]


def connecticut(idx):
    """Certified town returns from electionhistory.ct.gov, rolled to the nine
    planning regions with the Census 2023 county-subdivision gazetteer."""
    g = civera("https://electionhistory.ct.gov", "ct", 34715, "ct_sen_2022.json")
    real = {c["candidateId"]: c.get("displayName") or ""
            for c in g["candidates"] if not (c.get("candidate") or {}).get("pseudocandidate")}
    parties = party_map("CT")
    parties.setdefault("levy", "rep")
    parties.setdefault("blumenthal", "dem")

    town2pr = ct_crosswalk()
    units, tally = {}, {}
    for child in g["divisions"]["children"]:
        town = child["division"]["displayName"]
        # The archive spells towns "City/Town of Andover".
        pr = town2pr.get(norm(re.sub(r"^(City/Town|Town|City) of\s+", "", town)))
        if pr is None:
            raise KeyError("CT: no planning region for town %r" % town)
        row = {}
        for cell in child["granularRow"]:
            if cell["candidateId"] in real:
                row[real[cell["candidateId"]]] = row.get(real[cell["candidateId"]], 0) \
                    + int(cell.get("votes") or 0)
        d, r, o = bucket(row, parties, tally)
        u = units.setdefault(pr, {"name": pr_name(pr), "dem": 0, "rep": 0,
                                  "other": 0, "total": 0})
        u["dem"] += d
        u["rep"] += r
        u["other"] += o
        u["total"] += d + r + o
    return pack(units, "county",
                "Connecticut certified returns by town (electionhistory.ct.gov, "
                "contest 34715), rolled up to planning regions with the Census "
                "2023 county-subdivision gazetteer", tally)


PR_NAMES = {"09110": "Capitol", "09120": "Greater Bridgeport",
            "09130": "Lower Connecticut River Valley", "09140": "Naugatuck Valley",
            "09150": "Northeastern Connecticut", "09160": "Northwest Hills",
            "09170": "South Central Connecticut", "09180": "Southeastern Connecticut",
            "09190": "Western Connecticut"}


def pr_name(fips):
    return PR_NAMES.get(fips, fips)


def ct_crosswalk():
    """{normalized town name: planning-region fips} from the 2023 gazetteer."""
    import zipfile
    url = ("https://www2.census.gov/geo/docs/maps-data/data/gazetteer/"
           "2023_Gazetteer/2023_Gaz_cousubs_national.zip")
    blob = get(url, "gaz_cousubs_2023.zip")
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        raw = z.read(z.namelist()[0]).decode("latin-1")
    out = {}
    for line in raw.split("\n")[1:]:
        cells = line.split("\t")
        if len(cells) < 4 or cells[0].strip() != "CT":
            continue
        geoid = cells[1].strip()
        name = re.sub(r"\s+(town|city|borough)$", "", cells[3].strip())
        out[norm(name)] = geoid[:5]
    return out


def idaho(idx):
    """The Secretary of State's canvass app, contest 17248."""
    blob = get("https://canvass.sos.idaho.gov/contests/view/17248.json", "id_sen_2022.json")
    d = json.loads(blob)["output"]
    cands = {c["id"]: c["display_name"] for c in d["Candidate"]
             if c["is_pseudocandidate"] == "0"}
    divs = {row["Division"]["id"]: row["Division"]
            for row in d["DivisionList"] if row["Division"]["division_type_name"] == "County"}
    parties = party_map("ID")
    units, tally = {}, {}
    for row in d["ResultsTable"]:
        did = str(row["ccd"]["division_id"])
        if did not in divs:
            continue
        name = divs[did]["name"]
        votes = {cands[cid[4:]]: cell["n_votes"]
                 for cid, cell in row.items()
                 if cid.startswith("ccd_") and cid[4:] in cands}
        d_, r_, o_ = bucket(votes, parties, tally)
        units[fips_of(idx, "ID", name)] = {"name": name, "dem": d_, "rep": r_,
                                           "other": o_, "total": d_ + r_ + o_}
    return pack(units, "county",
                "Idaho Secretary of State canvass (canvass.sos.idaho.gov, contest 17248)", tally)


def indiana(idx):
    """The Election Division's historical ENR, one request per county."""
    topo = json.load(open(os.path.join(MW, "geo", "counties.topojson")))
    names = sorted(g["properties"]["name"] for g in topo["objects"]["counties"]["geometries"]
                   if g["properties"]["state"] == "IN")
    parties = party_map("IN")
    units, tally = {}, {}
    for name in names:
        form = urllib.parse.urlencode({
            "year": "2022", "candidateName": "", "pageNumber": "1", "sortBy": "",
            "sortDir": "", "electionType": "General", "county": name,
            "office": "US Senator", "party": "", "filterCandidateName": "",
            "filterElectionType": "false"})
        blob = get("https://indianavoters.in.gov/ENRHistorical/GetElectionData",
                   "in_%s.json" % norm(name), post=form,
                   headers={"Content-Type": "application/x-www-form-urlencoded",
                            "X-Requested-With": "XMLHttpRequest"})
        rows = json.loads(blob)
        votes = {}
        for row in rows:
            if row.get("Office") != "US Senator":
                continue
            votes[row["CandidateName"]] = votes.get(row["CandidateName"], 0) + (row["Votes"] or 0)
        if not votes:
            raise RuntimeError("IN: no rows for %s" % name)
        d_, r_, o_ = bucket(votes, parties, tally)
        units[fips_of(idx, "IN", name)] = {"name": name, "dem": d_, "rep": r_,
                                           "other": o_, "total": d_ + r_ + o_}
    return pack(units, "county",
                "Indiana Election Division historical results "
                "(indianavoters.in.gov/ENRHistorical), by county", tally)


def missouri(idx):
    """The Secretary of State's official-results PDF, read with pdftotext."""
    url = ("https://www.sos.mo.gov/CMSImages/ElectionResultsStatistics/"
           "ActualResults-November82022.pdf")
    pdf = os.path.join(CACHE, "mo_official_2022.pdf")
    get(url, "mo_official_2022.pdf")
    text = subprocess.run(["pdftotext", "-layout", "-f", "1", "-l", "6", pdf, "-"],
                          capture_output=True, text=True, check=True).stdout
    parties = party_map("MO")
    # The Senate table's columns, in the order the PDF prints them.
    cols = ["Eric Schmitt", "Trudy Busch Valentine", "Jonathan Dine", "Paul Venable",
            "Nathan V. Mooney", "Theo Brown Sr", "David Kirk"]
    units, tally = {}, {}
    started = False
    for line in text.split("\n"):
        if "United States Senator" in line:
            started = True
            continue
        if not started:
            continue
        if re.search(r"(State Auditor|OFFICIAL RESULTS|Missouri Office)", line):
            if units:
                started = False
            continue
        m = re.match(r"^\s{0,3}([A-Za-z][A-Za-z.' ]+?)\s{2,}((?:[\d,]+\s+){6}[\d,]+)\s*$", line)
        if not m:
            continue
        name, nums = m.group(1).strip(), m.group(2).split()
        if name.lower() in ("total", "totals"):
            started = False
            continue
        votes = dict(zip(cols, [int(n.replace(",", "")) for n in nums]))
        d_, r_, o_ = bucket(votes, parties, tally)
        fips = fips_of(idx, "MO", name)
        u = units.setdefault(fips, {"name": name, "dem": 0, "rep": 0,
                                    "other": 0, "total": 0})
        if fips == "29095":
            u["name"] = "Jackson"
        u["dem"] += d_
        u["rep"] += r_
        u["other"] += o_
        u["total"] += d_ + r_ + o_
    if len(units) != 115:
        raise RuntimeError("MO: parsed %d counties, expected 115" % len(units))
    return pack(units, "county",
                "Missouri Secretary of State, official results of the November 8, "
                "2022 general election (ActualResults-November82022.pdf)", tally)


def new_hampshire(idx):
    """OpenElections' transcription of the Secretary of State's town returns."""
    url = ("https://raw.githubusercontent.com/openelections/openelections-data-nh/"
           "master/2022/20221108__nh__general__us__senate__precinct.csv")
    text = get(url, "nh_sen_2022.csv").decode("utf-8")
    parties = party_map("NH")
    parties.setdefault("scatter", "other")
    units, tally = {}, {}
    for row in csv.DictReader(io.StringIO(text)):
        if not row.get("county"):
            continue
        fips = fips_of(idx, "NH", row["county"])
        u = units.setdefault(fips, {"name": row["county"], "dem": 0, "rep": 0,
                                    "other": 0, "total": 0})
        d_, r_, o_ = bucket({row["candidate"]: int(row["votes"] or 0)}, parties, tally)
        u["dem"] += d_
        u["rep"] += r_
        u["other"] += o_
        u["total"] += d_ + r_ + o_
    return pack(units, "county",
                "New Hampshire town returns from the Secretary of State, as "
                "transcribed by OpenElections", tally)


def vermont(idx):
    """The Secretary of State's 2022 federal-office workbook, Raw Data sheet."""
    import openpyxl
    url = ("https://outside.vermont.gov/dept/sos/Elections_Division/"
           "election_info_resources/elections_results_data/"
           "2022_general_election_federal_office_results.xlsx")
    get(url, "vt_federal_2022.xlsx")
    wb = openpyxl.load_workbook(os.path.join(CACHE, "vt_federal_2022.xlsx"),
                                data_only=True, read_only=True)
    ws = wb["Raw Data"]
    rows = ws.iter_rows(values_only=True)
    header = [str(h).strip() if h is not None else "" for h in next(rows)]
    col = {h: i for i, h in enumerate(header)}
    parties = party_map("VT")
    skip = {"BLANK_VOTES", "SPOILED_VOTES"}
    units, tally = {}, {}
    for r in rows:
        if not r or r[col["OFFICE"]] != "US SENATOR":
            continue
        name = (r[col["NAME_ON_BALLOT"]] or "").strip()
        if name in skip:
            continue
        votes = int(r[col["OFFICIAL_VOTE_CAST"]] or 0)
        fips = fips_of(idx, "VT", r[col["COUNTY"]])
        u = units.setdefault(fips, {"name": (r[col["COUNTY"]] or "").title(),
                                    "dem": 0, "rep": 0, "other": 0, "total": 0})
        d_, r_, o_ = bucket({name: votes}, parties, tally)
        u["dem"] += d_
        u["rep"] += r_
        u["other"] += o_
        u["total"] += d_ + r_ + o_
    wb.close()
    return pack(units, "county",
                "Vermont Secretary of State, 2022 general election federal office "
                "results workbook (Raw Data sheet), by town and county", tally)


def new_york(idx):
    """Certified county returns from the Board of Elections archive. The local
    file has 61 of 62 counties; this replaces the lot."""
    g = civera("https://results.elections.ny.gov", "ny", 4, "ny_sen_2022.json")
    real = {c["candidateId"]: c.get("displayName") or ""
            for c in g["candidates"] if not (c.get("candidate") or {}).get("pseudocandidate")}
    parties = party_map("NY")
    units, tally = {}, {}
    for child in g["divisions"]["children"]:
        name = child["division"]["displayName"]
        row = {}
        for cell in child["granularRow"]:
            cid = cell["candidateId"]
            if cid in real:
                row[real[cid]] = row.get(real[cid], 0) + int(cell.get("votes") or 0)
        d_, r_, o_ = bucket(row, parties, tally)
        fips = fips_of(idx, "NY", name)
        u = units.setdefault(fips, {"name": name, "dem": 0, "rep": 0,
                                    "other": 0, "total": 0})
        u["dem"] += d_
        u["rep"] += r_
        u["other"] += o_
        u["total"] += d_ + r_ + o_
    return pack(units, "county",
                "New York State Board of Elections certified results "
                "(results.elections.ny.gov, contest 4), by county", tally)


def south_dakota(idx):
    """The state canvassing board's certified report. The local file has 65 of
    66 counties -- Oglala Lakota is missing -- so this replaces the lot."""
    url = ("https://sdsos.gov/elections-voting/assets/Archive/2022%20Assets/"
           "2022Generalcanvassreport.pdf")
    pdf = os.path.join(CACHE, "sd_canvass_2022.pdf")
    get(url, "sd_canvass_2022.pdf")
    text = subprocess.run(["pdftotext", "-layout", "-f", "1", "-l", "4", pdf, "-"],
                          capture_output=True, text=True, check=True).stdout
    lines = text.split("\n")
    start = next(i for i, l in enumerate(lines) if "United States Senator" in l)
    # "County" sits on its own line; the names follow, each tagged " - DEM".
    head_i = next(i for i in range(start + 1, start + 5)
                  if lines[i].strip().startswith("County"))
    names_i = next(i for i in range(head_i + 1, head_i + 4) if " - " in lines[i])
    cols = [m.strip() for m in re.findall(r"([A-Za-z][A-Za-z.' ]*?)\s+-\s+[A-Z]{3}",
                                          lines[names_i])]
    parties = party_map("SD")
    units, tally = {}, {}
    for line in lines[names_i + 1:]:
        if re.search(r"(United States Representative|Governor|Total)", line):
            if units:
                break
            continue
        m = re.match(r"^\s*([A-Za-z][A-Za-z.' ]+?)\s{2,}((?:[\d,]+\s+){%d}[\d,]+)\s*$"
                     % (len(cols) - 1), line)
        if not m:
            continue
        name, nums = m.group(1).strip(), m.group(2).split()
        votes = dict(zip(cols, [int(n.replace(",", "")) for n in nums]))
        d_, r_, o_ = bucket(votes, parties, tally)
        units[fips_of(idx, "SD", name)] = {"name": name, "dem": d_, "rep": r_,
                                           "other": o_, "total": d_ + r_ + o_}
    if len(units) != 66:
        raise RuntimeError("SD: parsed %d counties, expected 66" % len(units))
    return pack(units, "county",
                "South Dakota State Board of Canvassers, certified report of the "
                "November 8, 2022 general election", tally)


STATES = {"AK": alaska, "CT": connecticut, "ID": idaho, "IN": indiana,
          "MO": missouri, "NH": new_hampshire, "NY": new_york, "SD": south_dakota,
          "VT": vermont}


def main():
    idx = county_index()
    want = [a.upper() for a in sys.argv[1:]] or sorted(STATES)
    out = {}
    path = os.path.join(OUT, "sen2022_filled.json")
    if os.path.exists(path):
        out = json.load(open(path))
    for ab in want:
        print("fetching %s ..." % ab, flush=True)
        block = STATES[ab](idx)
        out[ab] = block
        sw = block["statewide"]
        print("   %-3s %-9s units=%-3d  D %8d  R %8d  other %7d  total %9d"
              % (ab, block["tier"], len(block["units"]),
                 sw["dem"], sw["rep"], sw["other"], sw["total"]))
    os.makedirs(OUT, exist_ok=True)
    with open(path, "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    print("wrote", path)


if __name__ == "__main__":
    main()
