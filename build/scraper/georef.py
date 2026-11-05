"""Recover WGS84 from the NYT's per-state precinct tiles.

The Times tiles each state in its own Albers equal-area conic and then hands
tippecanoe --projection=EPSG:3857, so the coordinates that come out of the
.pmtiles are projected meters wearing a Web Mercator label. The projection is
not published anywhere, so it is fitted here: dissolve the precincts to
counties, match those counties against the Census 500k counties by FIPS, and
least-squares a spherical Albers (lon0, lat0, lat1, lat2) plus a scale and an
origin shift onto the pairs, trimming the counties the Times does not cover
whole. Inverting that fit puts the precincts back on the globe.
"""
import json, math
import numpy as np
from collections import defaultdict
from shapely.geometry import shape, mapping
from shapely.ops import unary_union, transform


def albers_fwd(lon, lat, lon0, lat0, lat1, lat2):
    r = math.pi / 180
    p1, p2, p0 = lat1 * r, lat2 * r, lat0 * r
    n = (math.sin(p1) + math.sin(p2)) / 2
    if abs(n) < 1e-9:
        return None
    C = math.cos(p1) ** 2 + 2 * n * math.sin(p1)
    if C - 2 * n * math.sin(p0) < 0:
        return None
    rho0 = math.sqrt(C - 2 * n * math.sin(p0)) / n
    v = C - 2 * n * np.sin(np.asarray(lat) * r)
    if np.any(v < 0):
        return None
    rho = np.sqrt(v) / n
    th = n * ((np.asarray(lon) - lon0) * r)
    return rho * np.sin(th), rho0 - rho * np.cos(th)


def albers_inv(X, Y, p, s, tx, ty):
    lon0, lat0, lat1, lat2 = p
    r = math.pi / 180
    p1, p2, p0 = lat1 * r, lat2 * r, lat0 * r
    n = (math.sin(p1) + math.sin(p2)) / 2
    C = math.cos(p1) ** 2 + 2 * n * math.sin(p1)
    rho0 = math.sqrt(C - 2 * n * math.sin(p0)) / n
    u = (np.asarray(X) - tx) / s
    v = (np.asarray(Y) - ty) / s
    d = rho0 - v
    rho = np.hypot(u, d) * np.sign(n)
    th = np.arctan2(u, d)
    lat = np.arcsin(np.clip((C - rho ** 2 * n ** 2) / (2 * n), -1, 1)) / r
    lon = lon0 + (th / n) / r
    return lon, lat


def _solve(p, lon, lat, X, Y, scale=None):
    """Least-squares the scale and origin shift onto one set of conic parameters.

    With `scale` given -- read off the Times's own area_km2, which fixes it
    exactly, Albers being equal-area -- only the shift is free, and the
    coastline disagreements that pull a county centroid around can no longer
    pull the scale with it.
    """
    o = albers_fwd(lon, lat, *p)
    if o is None:
        return None
    u, v = o
    n = len(u)
    b = np.concatenate([X, Y])
    if scale is None:
        M = np.zeros((2 * n, 3))
        M[:n, 0] = u; M[:n, 1] = 1
        M[n:, 0] = v; M[n:, 2] = 1
        sol, *_ = np.linalg.lstsq(M, b, rcond=None)
        return M @ sol - b, sol
    tx = float(np.mean(X - scale * u))
    ty = float(np.mean(Y - scale * v))
    res = np.concatenate([scale * u + tx - X, scale * v + ty - Y])
    return res, np.array([scale, tx, ty])


def _cost(p, lon, lat, X, Y, scale=None):
    r = _solve(p, lon, lat, X, Y, scale)
    return 1e18 if r is None else float(np.sum(r[0] ** 2))


def _refine(p0, step, lon, lat, X, Y, scale=None):
    p = list(p0); c = _cost(p, lon, lat, X, Y, scale); s = list(step)
    for _ in range(800):
        improved = False
        for i in range(4):
            for d in (1, -1):
                q = list(p); q[i] += d * s[i]
                cq = _cost(q, lon, lat, X, Y, scale)
                if cq < c:
                    p, c, improved = q, cq, True
        if not improved:
            s = [x / 2 for x in s]
            if max(s) < 1e-11:
                break
    return p


def fit(pairs, seed=None, scale=None):
    """pairs: {key: ((lon, lat), (X, Y))}. Returns (params, scale, tx, ty, report)."""
    keys = sorted(pairs)
    lon = np.array([pairs[k][0][0] for k in keys])
    lat = np.array([pairs[k][0][1] for k in keys])
    X = np.array([pairs[k][1][0] for k in keys])
    Y = np.array([pairs[k][1][1] for k in keys])
    if seed is None:
        seed = [float(lon.mean()), float(lat.mean()),
                float(lat.min() + (lat.max() - lat.min()) / 6),
                float(lat.max() - (lat.max() - lat.min()) / 6)]
    keep = np.ones(len(keys), bool)
    p = seed
    for it in range(6):
        p = _refine(p, [0.5 if it == 0 else 0.05] * 4, lon[keep], lat[keep], X[keep], Y[keep], scale)
        res, sol = _solve(p, lon, lat, X, Y, scale)
        n = len(keys)
        d = np.hypot(res[:n], res[n:])
        if it < 5:
            keep = d <= max(np.percentile(d[keep], 75), 1.0)
            if keep.sum() < 8:
                keep = d <= np.percentile(d, 75)
    res, sol = _solve(p, lon, lat, X, Y, scale)
    n = len(keys)
    d = np.hypot(res[:n], res[n:])
    report = {"scale_from_area": scale is not None, "n_control": n, "n_kept": int(keep.sum()),
              "median_m": float(np.median(d[keep])), "p90_m": float(np.percentile(d[keep], 90)),
              "params": {"lon_0": p[0], "lat_0": p[1], "lat_1": p[2], "lat_2": p[3],
                         "scale": float(sol[0]), "x_0": float(sol[1]), "y_0": float(sol[2])}}
    return p, float(sol[0]), float(sol[1]), float(sol[2]), report


def dissolve(features, key):
    out = {}
    g = defaultdict(list)
    for f in features:
        g[key(f)].append(shape(f["geometry"]).buffer(0))
    for k, v in g.items():
        out[k] = unary_union(v)
    return out


def reproject(geom, p, s, tx, ty):
    def t(x, y, z=None):
        lon, lat = albers_inv(np.asarray(x), np.asarray(y), p, s, tx, ty)
        return lon, lat
    return transform(t, geom)
