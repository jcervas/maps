#!/usr/bin/env python3
"""Precinct geographies and live precinct votes for the 2026 Senate races, from
the New York Times.

    python3 fetch.py                 # every state the Times has tiled
    python3 fetch.py GA TX           # just these
    python3 fetch.py --votes-only    # skip the geography, refresh the numbers

The Times draws its precinct maps (results-senate-precinct-maps.html) from one
PMTiles archive per state, rebuilt on the hour:

    .../2026-midterm-precinct-map/pub/precincts_votes-<YYYYMMDD_HH>-<ST>.pmtiles

Zoom 12 carries the full precincts, each with the Senate race's votes on it:
geoid, dem/rep/ind/other votes, total, margin, winner and which vote types have
been counted. The archive is tiled in a per-state Albers that the Times does not
publish, so georef.py fits it against the Census counties and inverts it; the
geography written here is WGS84. Areas come back within 0.1% of the `area_km2`
the Times put on each precinct, which is the check that the fit is right.

The data is the Times's and is licensed for non-commercial use; anything drawn
from it has to credit The New York Times.

Writes, under out/:
    geo/<ST>.geojson     precincts in WGS84, votes joined
    votes/<ST>.csv       the same numbers without the shapes
    fits.json            the fitted projection and its residuals, per state
"""
import argparse, csv, datetime, json, os, subprocess, sys, urllib.request
from collections import defaultdict

import numpy as np
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef import fit, reproject

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "https://static01.nyt.com/projects/weather/basemaps/elections/2026-midterm-precinct-map"
PUB = BASE + "/pub/precincts_votes-{vintage}-{st}.pmtiles"
RESULTS = "https://static01.nyt.com/elections-assets/pages/data/2026-11-03/results-senate.json"
UA = "private election-results display, one request per state per refresh"
RAW = os.path.join(HERE, "raw")
OUT = os.path.join(HERE, "out")
COUNTIES = os.path.join(HERE, "counties.json")
AK_HOUSE = os.path.join(HERE, "ak_house.json")
FIELDS = ["geoid", "state", "fid_name", "votes", "dem_votes", "rep_votes", "ind_votes",
          "other_votes", "winner", "result", "win_margin", "voter_density", "area_km2",
          "dem_c", "rep_c", "ind_c", "other_c", "vote_types"]


def get(url, path=None, head=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA},
                                 method="HEAD" if head else "GET")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            if head:
                return r.status
            data = r.read()
    except Exception as e:
        return getattr(e, "code", 0) if head else None
    if path:
        open(path, "wb").write(data)
        return path
    return data


def latest_vintage(st, back=48, now=None):
    """The newest hourly build the Times still has up for this state."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    for h in range(back):
        v = (now - datetime.timedelta(hours=h)).strftime("%Y%m%d_%H")
        if get(PUB.format(vintage=v, st=st), head=True) == 200:
            return v
    return None


def tiles_to_geojson(pmtiles, out, zoom=12):
    subprocess.run(["ogr2ogr", "-f", "GeoJSON", out, pmtiles, "precincts",
                    "-oo", f"ZOOM_LEVEL={zoom}"], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return out


def dissolve_by(features, key):
    """Tippecanoe cuts a precinct at every tile edge; put it back together."""
    parts, props = defaultdict(list), {}
    for f in features:
        k = key(f)
        parts[k].append(shape(f["geometry"]).buffer(0))
        props.setdefault(k, f["properties"])
    return {k: unary_union(v) for k, v in parts.items()}, props


def control_geography(state):
    """What the fit pairs the Times's precincts against, and the key it pairs on.

    Everywhere but Alaska that is the Census 500k counties against the county
    FIPS the Times puts at the front of a precinct id. Alaska reports by state
    house district and the Times writes those as a county that does not exist
    ("02036-36-700" is district 36), so Alaska pairs on the district instead --
    matching it against counties would silently take the handful of real
    borough codes a district number happens to collide with.
    """
    if state == "AK":
        feats = json.load(open(AK_HOUSE))["features"]
        return ({f["properties"]["id"][3:].lstrip("0"): f for f in feats},
                lambda geoid: geoid.split("-")[1].lstrip("0"))
    feats = json.load(open(COUNTIES))["features"]
    return ({f["properties"]["id"]: f for f in feats
             if f["properties"]["state"] == state},
            lambda geoid: geoid[:5])


def build(st, votes_only=False, vintage=None):
    os.makedirs(RAW, exist_ok=True)
    os.makedirs(os.path.join(OUT, "geo"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "votes"), exist_ok=True)
    v = vintage or latest_vintage(st)
    if not v:
        return {"state": st, "error": "no tileset in the last 48 hours"}
    pm = os.path.join(RAW, f"{st}-{v}.pmtiles")
    if not os.path.exists(pm):
        if get(PUB.format(vintage=v, st=st), pm) is None:
            return {"state": st, "error": "download failed"}
    gj = os.path.join(RAW, f"{st}-{v}.z12.json")
    if not os.path.exists(gj):
        tiles_to_geojson(pm, gj)
    feats = json.load(open(gj))["features"]

    if votes_only:
        # The numbers are repeated on every tile a precinct falls in, so there is
        # nothing to dissolve: take one copy and leave the shapes alone.
        prec, props = {}, {}
        for f in feats:
            k = f["properties"].get("geoid") or ""
            props.setdefault(k, f["properties"])
            prec.setdefault(k, None)
    else:
        prec, props = dissolve_by(feats, lambda f: f["properties"].get("geoid") or "")
    prec.pop("", None)
    props.pop("", None)

    rows = []
    for geoid in sorted(prec):
        p = props[geoid]
        r = {k: p.get(k) for k in FIELDS}
        r["geoid"] = geoid
        r["county_fips"] = geoid[:5]
        r["vintage"] = v
        if isinstance(r.get("vote_types"), list):
            r["vote_types"] = ",".join(r["vote_types"])
        rows.append(r)
    with open(os.path.join(OUT, "votes", f"{st}.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["geoid", "county_fips", "state", "fid_name",
                                           "votes", "dem_votes", "rep_votes", "ind_votes",
                                           "other_votes", "winner", "result", "win_margin",
                                           "voter_density", "area_km2", "dem_c", "rep_c",
                                           "ind_c", "other_c", "vote_types", "vintage"])
        w.writeheader()
        w.writerows(rows)

    report = {"state": st, "vintage": v, "precincts": len(prec),
              "votes": sum(r["votes"] or 0 for r in rows)}
    if votes_only:
        return report

    # Fit the Times's per-state Albers against the Census counties, then invert.
    ref, key_of = control_geography(st)
    nyt_cty, _ = dissolve_by(feats, lambda f: key_of(f["properties"].get("geoid") or "-"))
    nyt_cty.pop("", None)
    true_cty = {k: shape(f["geometry"]).buffer(0) for k, f in ref.items()}
    # A shape straddling the antimeridian has a centroid out in the middle of
    # the Pacific: Alaska's district 37 runs the Aleutians from -179 to 180.
    true_cty = {k: g for k, g in true_cty.items() if g.bounds[2] - g.bounds[0] < 60}
    pairs = {k: ((true_cty[k].centroid.x, true_cty[k].centroid.y),
                 (nyt_cty[k].centroid.x, nyt_cty[k].centroid.y))
             for k in set(nyt_cty) & set(true_cty)}
    if len(pairs) < 6:
        return {**report, "error": f"only {len(pairs)} counties to fit on"}

    # Fit once with the scale free, and let the Times's own area_km2 -- measured
    # off the geometry it tiled, and nowhere near the Census -- say how far out
    # that scale is. Albers being equal-area, a shape covering A square metres
    # of the globe covers A*(s/R)^2 of the archive, so the median of
    # recovered-over-stated area is a direct reading of the scale error. Pinning
    # the scale there and fitting again keeps a ragged coastline from dragging
    # the scale along with the county centroids it drags, and the median shrugs
    # off the shoreline precincts whose stated area takes in open water
    # (Michigan's lakes, Florida's bays).
    p, s, tx, ty, fitrep = fit(pairs)
    ratios = sorted(ellipsoid_area(reproject(g, p, s, tx, ty)) / props[k]["area_km2"]
                    for k, g in prec.items() if props[k].get("area_km2"))
    free_ratio = ratios[len(ratios) // 2] if ratios else None
    if free_ratio:
        p, s, tx, ty, fitrep = fit(pairs, seed=[fitrep["params"][x] for x in
                                                ("lon_0", "lat_0", "lat_1", "lat_2")],
                                   scale=s * free_ratio ** 0.5)
    fitrep["area_ratio_free_fit"] = free_ratio

    by_id = {r["geoid"]: r for r in rows}
    out_feats, ratios = [], []
    for geoid in sorted(prec):
        g = reproject(prec[geoid], p, s, tx, ty)
        row = by_id[geoid]
        out_feats.append({"type": "Feature", "properties": row, "geometry": mapping(g)})
        a = row.get("area_km2")
        if a:
            ratios.append(ellipsoid_area(g) / a)
    json.dump({"type": "FeatureCollection", "features": out_feats},
              open(os.path.join(OUT, "geo", f"{st}.geojson"), "w"), separators=(",", ":"))
    fitrep["area_ratio_median"] = float(np.median(ratios)) if ratios else None
    return {**report, "fit": fitrep}


# WGS84, authalic: the sphere's own area runs 0.2% out across these latitudes,
# which is enough to look like a bad fit when it is only a bad yardstick.
_A, _F = 6378137.0, 1 / 298.257223563
_E2 = _F * (2 - _F)
_E = np.sqrt(_E2)
_RQ = _A * np.sqrt((1 + (1 - _E2) / _E * np.arctanh(_E)) / 2)
_QP = (1 - _E2) * (1 / (1 - _E2) - (1 / (2 * _E)) * np.log((1 - _E) / (1 + _E)))


def _authalic(phi):
    s = np.sin(phi)
    q = (1 - _E2) * (s / (1 - _E2 * s * s) - (1 / (2 * _E)) * np.log((1 - _E * s) / (1 + _E * s)))
    return np.arcsin(np.clip(q / _QP, -1, 1))


def ellipsoid_area(g):
    """km2 on the WGS84 ellipsoid: Lambert azimuthal equal-area about the centroid."""
    from shapely.ops import transform as T
    c = g.centroid
    lam0, phi0 = np.radians(c.x), _authalic(np.radians(c.y))

    def f(x, y, z=None):
        x, y = np.radians(np.asarray(x)), _authalic(np.radians(np.asarray(y)))
        k = np.sqrt(2 / np.clip(1 + np.sin(phi0) * np.sin(y) +
                                np.cos(phi0) * np.cos(y) * np.cos(x - lam0), 1e-12, None))
        return (_RQ * k * np.cos(y) * np.sin(x - lam0),
                _RQ * k * (np.cos(phi0) * np.sin(y) - np.sin(phi0) * np.cos(y) * np.cos(x - lam0)))
    return T(f, g).area / 1e6


def tiled_states(now=None):
    """Which states the Times has precinct tiles for, at the newest build."""
    d = json.loads(get(RESULTS))
    sens = [r["top_reporting_unit"]["state_postal"] for r in d["races"]]
    return [st for st in sens if latest_vintage(st, back=48, now=now)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("states", nargs="*")
    ap.add_argument("--votes-only", action="store_true")
    ap.add_argument("--vintage")
    a = ap.parse_args()
    states = a.states or tiled_states()
    fits = {}
    path = os.path.join(OUT, "fits.json")
    if os.path.exists(path):
        fits = json.load(open(path))
    for st in states:
        r = build(st, votes_only=a.votes_only, vintage=a.vintage)
        if "error" in r:
            print(f"{st}: {r['error']}", flush=True)
            continue
        # --votes-only knows nothing about the projection; keep the fit it last had.
        fits[st] = {**fits.get(st, {}), **r}
        os.makedirs(OUT, exist_ok=True)
        json.dump(fits, open(path, "w"), indent=1)
        f = r.get("fit", {})
        extra = ""
        if f:
            extra = (f" | fit {f['n_kept']}/{f['n_control']} counties,"
                     f" median {f['median_m']:.0f} m, area x{f['area_ratio_median']:.4f}"
                     f" (free fit x{f['area_ratio_free_fit']:.4f})")
        print(f"{st}: {r['precincts']:,} precincts, {r['votes']:,} votes, {r['vintage']}{extra}",
              flush=True)


if __name__ == "__main__":
    main()
