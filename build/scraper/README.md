# NYT 2026 Senate precincts

Precinct geographies and live precinct votes behind the Times's
[Detailed Maps of the 2026 Senate Election Results](https://www.nytimes.com/interactive/2026/11/03/us/elections/results-senate-precinct-maps.html).

    python3 fetch.py            # geography + votes, every state the Times tiles
    python3 fetch.py GA TX      # just these
    python3 results.py          # all 35 races statewide, and the candidate ids
    sh refresh.sh               # the numbers again, shapes untouched

## Where it comes from

The page itself is behind DataDome and will not answer `curl`, but nothing it
loads is: every file below is plain, unauthenticated static01.nyt.com.

| What | URL |
| --- | --- |
| Precincts + votes, per state, rebuilt hourly | `…/2026-midterm-precinct-map/pub/precincts_votes-<YYYYMMDD_HH>-<ST>.pmtiles` |
| Precinct outlines only (static) | `…/2026-midterm-precinct-map/<ST>_precinct_outline.pmtiles` |
| Statewide + county results, all 35 Senate races | `…/elections-assets/pages/data/2026-11-03/results-senate.json` |
| County results feed (60 s) | `…/pages/data/feeds/67880e0c-…/sen-county-data/2026-11-03.json` |

`<YYYYMMDD_HH>` is a UTC hour and there is no manifest naming the current one,
so `fetch.py` walks back from the present hour until a build answers. Old hours
stay up for about a day, which is also how far back you can go.

The Times tiles only the states whose precinct returns it has parsed — eleven
of the thirty-five Senate races, not all of them. `results-senate.json` lists
the scraper runs behind each race under `races[].precincts`, including the
precinct and vote-type counts, which is the honest measure of how complete a
state is.

## The projection

The archives are tiled in a per-state Albers equal-area conic and then handed
to tippecanoe as `--projection=EPSG:3857`, so what comes out is projected
meters wearing a Web Mercator label — Georgia's "longitude" runs −1.96 to 2.02.
The Times does not publish the projection.

`georef.py` fits it: dissolve the precincts to counties, pair those against the
Census 500k counties by FIPS, least-squares a spherical Albers (`lon_0`,
`lat_0`, `lat_1`, `lat_2`) plus a scale and an origin shift onto the centroids,
trimming the counties the Times does not cover whole, then invert. The fitted
parameters and their residuals are written to `out/fits.json`.

Scale gets one more turn. The `area_km2` the Times puts on every precinct is
measured off its own unprojected geometry and owes nothing to the Census, and
Albers being equal-area, a shape covering A square metres of the globe covers
A·(s/R)² of the archive — so the median of recovered-over-stated area reads the
scale error straight off. A free fit is out by 0.02% in Georgia and 0.01% in
Iowa but 0.22% in Michigan and 0.17% in Florida, where a county centroid is
only as good as the agreement about where the water starts. Pinning the scale
there and fitting again fixes that, and pulls the county residuals down with it
(Florida 173 m → 124 m). `out/fits.json` keeps the free-fit ratio as the
honest reading of how far off each state was.

Three independent checks, none of them part of any fit:

* **Ohio**, 3,171 precincts whose name survives from the Times's own 2024 WGS84
  precinct file: median centroid 77 m apart. North Carolina 121 m on 358,
  Georgia 137 m on 1,885. What is left is redistricting between the two
  elections, not the projection.
* **Texas** against a build of the same precincts from the state's own files:
  the state's west and east edges land 68 m and 43 m apart.
* Every state's recovered extent is its real extent — Georgia −85.599 to
  −80.841, Nebraska −104.062 to −95.311.

Alaska is the one weak state. It reports by state house district, which the
Times writes as a county FIPS that does not exist ("02036-36-700" is district
36), so the fit pairs on districts from `geo/state-house.topojson` instead,
skipping district 37 — the Aleutians straddle the antimeridian and its centroid
lands in the middle of the Pacific. That gets the median district residual from
5.3 km to 1.1 km, which is good enough to draw and not good enough to join on.
Alaska's geometry also runs past −180 into the eastern hemisphere rather than
wrapping, which keeps the Aleutians in one piece.

## Output

    out/geo/<ST>.geojson        precincts, WGS84, votes joined
    out/votes/<ST>.csv          the same numbers, no shapes
    out/fits.json               fitted projection, residuals and area check per state
    out/races.csv               all 35 Senate races statewide
    out/candidates.csv          candidate ids, which is what dem_c / rep_c join to
    out/precinct_scrapers.csv   what the Times has parsed, race by race
    raw/                        the .pmtiles as downloaded, and their zoom-12 dump

Eleven states: AK, FL, GA, IA, MI, NC, NE, OH, SC, TX, VA — 41,087 precincts,
32.0 million votes as of the 2026-11-05 00:00 UTC build. The other twenty-four
Senate races have no precinct tiles; `out/precinct_scrapers.csv` shows which of
them the Times is nonetheless scraping precincts for.

Per precinct: `geoid` (`13055-LYERLY (1484)`: county FIPS, then the state's own
precinct name), `county_fips`, `fid_name` (the county), `votes`, `dem_votes`,
`rep_votes`, `ind_votes`, `other_votes`, `winner`, `win_margin`,
`voter_density`, `area_km2`, the four `*_c` NYT candidate ids, `vote_types`
(which kinds of ballot are in the count yet) and the `vintage` the numbers came
from. A precinct with no returns yet is present with zero votes.

`vote_types` is worth reading before trusting a margin: a precinct whose count
is `early_in_person` only is not a precinct that voted that way.

## Terms

The data is The New York Times's, under its Computational Use of Data
Agreement: non-commercial use, and anything public drawn from it has to credit
The New York Times. One request per state per refresh; the tiles only change
on the hour.
