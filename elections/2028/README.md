# 2028 — the Senate seats on the ballot

The 34 Class III seats, up November 7, 2028: the 2022 race that filled each one,
the 2024 presidential vote under it at county level, and the senator who holds it
now. Unlike `elections/2026`, this is a results-history map rather than a live
feed — none of it moves.

    index.html        the interactive map; fetches the three files below
    data/senate2028.json      state rows and county rows, packed for the page
    data/counties.topojson    county geometry, the 34 states only
    data/states.topojson      all 50 state outlines, for context
    data/class3_states.csv    34 rows, one per state
    data/class3_counties.csv  2,099 rows, one per county or equivalent
    data/sen2022_filled.json  2022 county returns pulled from nine states direct
    data/senate_2028_class3.xlsx  both tables plus a Notes sheet

Built by `build/senate-2028/`:

    python3 build/senate-2028/fill_gaps.py    # cached after the first run
    python3 build/senate-2028/build.py
    python3 build/senate-2028/make_xlsx.py

`incumbents.py` holds the roster and the per-state caveats by hand, and
`ratings.py` holds the rating rule; the other three are mechanical.

## Ratings

Each seat gets a lean in margin points, positive Republican:

    lean = 0.65 * (2024 presidential margin) + 0.35 * (2022 Senate margin)

then four points toward the party that holds it, with bands at 5, 10 and 20.
The categories are Cook's — Solid / Likely / Lean / Toss Up — so the map reads
against the others on this site, and the colors are the same palette
`redrawn-districts-2026` uses. **The thresholds are mine**, so a rating here is
not Cook's rating of that seat.

Four seats use the presidential margin alone, because their 2022 Senate margin
is not a two-party margin: Alaska (ranked choice, two Republicans leading),
Utah (no Democrat), Georgia (November round only) and Louisiana (all-party
primary). Ohio and Florida were contested again in the 2026 specials, which is
better evidence than anything the rule uses; both are flagged in
`rating_basis`, and Ohio in particular comes out redder than a hand-written
rating would. It is arithmetic on results already in, not a forecast.

## Sources

Nothing here comes from a wire service, so the whole directory is free to publish.

- **Class III roster** — senate.gov/senators/Class_III.htm, read November 4, 2026,
  with Ohio corrected for the November 3, 2026 special election (Sherrod Brown
  beat appointed Senator Jon Husted) and Florida for Ashley Moody's win.
- **2024 president by county** — `magic-wall/data/raw/mcgovern/2024_county_pres.csv`
  (tonmcg/US_County_Level_Election_Results_08-24).
- **2022 Senate, 25 states** — `magic-wall/results/2022-sen-*.json`, state
  election-office feeds, parties from `magic-wall/registry/races_2022.json`.
- **2022 Senate, the nine states those files could not cover** — fetched by
  `fill_gaps.py` from each state directly:

  | State | Source | What was missing |
  |---|---|---|
  | AK | Division of Elections precinct export, summed to house districts | statewide only |
  | CT | electionhistory.ct.gov contest 34715, towns rolled to planning regions | town tier |
  | ID | canvass.sos.idaho.gov contest 17248 | statewide only |
  | IN | indianavoters.in.gov/ENRHistorical, one call per county | statewide only |
  | MO | Secretary of State official-results PDF | statewide only |
  | NH | Secretary of State town returns via OpenElections | town tier |
  | NY | results.elections.ny.gov contest 4 | 61 of 62 counties |
  | SD | State Board of Canvassers certified report | 65 of 66 counties |
  | VT | Secretary of State federal-office workbook | town tier |

  All nine match their official statewide totals to the vote.

- **CT town → planning region** — Census 2023 county-subdivision gazetteer.
- **Geometry** — `magic-wall/geo/counties.topojson`, `geo/nation-states.topojson`,
  and, for Alaska's forty house districts, `geo/state-house.topojson`.

The build reads `../magic-wall` as a sibling of this repo.

## Conventions

Margins are Republican share minus Democratic share, so a positive number is a
Republican lead. `pres24_minus_sen22_margin` is how much more Republican a state
ran for president in 2024 than for Senate in 2022.

## What the data does not cover

- **Alaska** reports both races by state house district, not by borough, so its
  forty rows are districts and its unit ids are 02001–02040 — the same ids the
  2024 county file uses. Its 2022 figures are first-choice votes in a
  ranked-choice race whose top two candidates were both Republicans, so the
  two-party margin there means nothing. The 1,426 federal overseas absentee votes
  (HD99) belong to no district and are left out.
- **Georgia**'s 2022 numbers are the November general round. Warnock won the
  December 6 runoff 1,820,148 to 1,719,483; that round is not here.
- **Utah** had no Democratic candidate; independent Evan McMullin was the
  challenger, so the Democratic column is zero.
- **Missouri** runs Kansas City's elections through a separate board; those votes
  are added back into Jackson County.
- **Hawaii**'s Kalawao County reports no separate vote, so there are 4 rows, not 5.
- **`sen22_county_coverage_pct`** is the county rows over the statewide figure.
  It is 100 percent everywhere except eight states whose county and statewide
  numbers come from different rounds of the same feed: South Carolina (100.36),
  Arizona (100.13), Utah (100.07), Nevada (99.96), Kentucky (99.99) and, within a
  rounding point, Florida, Kansas and Oregon.
