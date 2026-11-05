# 2026 Senate results by precinct

Eleven of the thirty-five Senate races, at the smallest unit the states report.
`index.html` is the page; everything it reads is under `data/`.

## Live, and kept

The two halves of the data move at completely different speeds, so they are
stored separately:

| | what | size | changes |
| --- | --- | --- | --- |
| `data/precincts/<ST>.topojson` | whole state, thinned | 38 MB all told | when a state redraws its precincts |
| `data/precincts/<ST>/<FIPS>.json` | one county, full detail | | " |
| `data/votes/<ST>.json` | the numbers | 2.0 MB all told | every hour, while the count runs |
| `data/meta.json` | races, candidates, bounds | 24 KB | every hour |

The page fetches a state's geometry and its votes side by side and joins them
on the `geoid`. So a refresh rewrites two megabytes, not forty, and the
geometry stays in the browser cache across them.

    sh ../../refresh.sh --commit        # from the repo root

One request per state, the small files rewritten, committed. That request is
not small — the votes live inside the tile archives, so a refresh pulls about
70 MB to write 2 MB — but it is eleven requests to a CDN, and nothing is kept.
On the hour is as often as it is worth running, because that is how often the
Times rebuilds:

    0 * * * * cd ~/maps && sh refresh.sh --commit >> /tmp/maps-refresh.log 2>&1

Committing every refresh is half the point. The Times publishes the current
count and nothing else; it keeps no archive of what the count was at nine
o'clock. The git history of `data/votes/` is that archive — precinct by
precinct, hour by hour, for as long as the job runs.

## Reading a precinct

    "13055-LYERLY (1484)": [786, 216, 570, 0, 0, 45, "R", 26, "am,ei,ed"]
                            votes dem  rep ind oth margin winner density types

`geoid` is the county FIPS, then the state's own name for the precinct.
`margin` is in points, negative toward the first-named candidate. `density` is
the Times's own 0–100 voter-density index, which is what the page's default
shading uses. `types` says which kinds of ballot are in the count so far, from
the key in the same file — a precinct reporting `ei` only is not a precinct
that voted early, it is a precinct that is not finished.

A precinct with no returns yet is present with zero votes and draws grey.
In Georgia that is 78 of 2,574.

## Where it comes from, and the projection

Everything traces to the Times's
[Detailed Maps of the 2026 Senate Election Results](https://www.nytimes.com/interactive/2026/11/03/us/elections/results-senate-precinct-maps.html),
whose per-state PMTiles archives carry the boundaries and the votes together.
The Times tiles each state in an Albers equal-area conic it does not publish
and hands tippecanoe `--projection=EPSG:3857`, so what comes out is projected
metres wearing a Web Mercator label — Georgia's "longitude" runs −1.96 to 2.02.

`build/scraper/` fits that projection against the Census 500k counties and
inverts it. The check is the `area_km2` the Times stamps on every precinct,
which is computed from its own unprojected geometry and never used in the fit:
measured on the WGS84 ellipsoid the recovered shapes come back within 0.05%.
Ohio's 3,171 precincts whose names survive from the Times's 2024 file land a
median 77 m from where that file puts them. `data/meta.json` carries the
fitted parameters and residuals per state under `fit_median_m`.

Alaska is the weak one: it reports by state house district, which the Times
writes as a county FIPS that does not exist, and the Aleutians straddle the
antimeridian. Median district residual 1.1 km — good enough to draw, not to
join on. Its geometry also runs past −180 rather than wrapping.

## Rebuilding

    sh build/build.sh <scraper dir>     # geometry; slow, and rarely needed
    python3 build/votes.py <scraper dir>
    python3 build/meta.py <scraper dir>

`build/build.sh` needs the Census counties the fit is pinned against, which
are not kept in the repo. `refresh.sh` needs none of that.

## Terms

The data is The New York Times's, under its Computational Use of Data
Agreement: non-commercial use, and anything public drawn from it credits
The New York Times, which the page does in its footer.
