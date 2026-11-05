# How the media markets map is built

`../index.html` is a 1.2 MB generated file. Everything needed to regenerate it
lives here. Jekyll ignores directories beginning with `_`, so nothing in this
folder is published.

The map answers one question: **television markets and congressional districts
are drawn by different people for different reasons, so how badly do they cut
across each other?** Everything below exists to get a county-level crosswalk
honest enough to answer that.

## Layout

```
_build/
  build/page.head.html   <- title, fonts, CDN tags, the whole <style> block
  build/page.body.html   <- markup, wrapped in .mm-root / .mm-wrap
  build/page.js          <- all the d3
  *.py, *.sh             <- pipeline, in the order below
  *.json                 <- derived data, committed (see "What is committed")
```

**`build/page.*` are the source files. Edit those, never `../index.html`.**
The three are concatenated with the data blobs into a single page; editing the
output directly means the next `make_site.py` run silently reverts you. This
happened once during development and cost an hour: a patch applied to an
in-memory copy looked like it had worked, but was never written to any file on
disk, so the districts rendered as black blobs with no stylesheet behind them.
The assertions at the top of `assemble.py` exist because of that afternoon.

## Rebuilding the page (the common case)

Everything this needs is committed. No downloads.

```sh
cd _build
python3 make_site.py                 # -> build/index.html, build/map.css
cp build/index.html build/map.css ..
```

`make_site.py` emits the Jekyll fragment: front matter, a `<link>` to
`map.css`, the d3/topojson CDN tags, the body, then the five data blobs and
the script. It asserts that the only Liquid in the entire 1.2 MB output is the
one `relative_url` call it put there itself -- a stray `{{` inside the data
would otherwise be evaluated at build time and corrupt the page.

Two keys in the front matter do different jobs:

- `description` -> the page's `<meta name="description">`
- `summary`     -> the card text on `/maps/`

`/maps/index.html` reads `{{ m.summary | default: m.description }}`, so the
other map pages, which have no `summary`, are unaffected.

Sibling outputs, same sources:

```sh
python3 assemble.py     # -> media-markets.html   (standalone, CDN libs)
python3 make_local.py   # -> media-markets.local.html, then copy to ../standalone.html
python3 thumb.py        # -> thumb.svg            (needs fetch.sh; see below)
```

`make_local.py` inlines d3 and topojson so the file works with no network at
all. `thumb.py` projects the DMA outlines to Albers in pure Python -- no d3, no
browser. Watch the y-axis: Albers y grows north, SVG y grows down, hence the
`(y1-y)*k+oy` flip. Getting that wrong renders the country upside down, which
looks surprisingly plausible at thumbnail size.

## Re-deriving the data (the rare case)

```sh
cd _build
./fetch.sh              # ~8 MB of third-party sources, none committed
python3 build.py        # county -> DMA crosswalk      -> crosswalk.json
python3 agg2.py         # population + 2024 vote by DMA -> dma_data.json
python3 minify_topo.py  # -> dma.topo.json, states.topo.json
./topo.sh               # three district cycles, one topology -> cdall.topo.json
python3 cdcycle.py 2022 # -> cd_dma_2022.json   (slow: shapely over ~3k counties)
python3 cdcycle.py 2024
python3 cdcycle.py 2026
python3 cdall.py        # folds the three cycles -> cd_layer.json
```

`topo.sh` and `cdcycle.py` read the 2022/2024/2026 district lines from
`createMaps/national/output/` -- your own files, not Census. They already carry
`TotalPop` and `Margin2024Pres`, which is why no separate district-level join
is needed. Override the location with `SRCD=...`.

### Why there is a crosswalk at all

No public county -> DMA table is both current and redistributable. The one
exploitable fact is that **Nielsen builds markets from whole counties**, so the
crosswalk can be derived geometrically: take each county's
`representative_point()` and find which DMA polygon contains it (`STRtree` for
the index, `make_valid` for the handful of self-intersecting rings). All 3,107
lower-48 counties resolve. The 123 unmatched entries are Alaska, Hawaii and the
territories, which the boundary file does not cover.

### Three traps, all of which produced plausible-looking wrong answers

**Connecticut, ~3.6 M people, silently missing.** Connecticut replaced its
counties with nine planning regions (FIPS 09110-09190) in 2022. The 2020-2024
population file uses the new codes; the DMA boundary file and the vote file
still use legacy counties 09001-09015. Neither join errors -- Connecticut just
evaporates. `agg2.py` handles it by taking the 2020 legacy-county populations
and scaling them to the 2024 state total (a factor of about 1.033). The
geometry resolves on its own, because planning-region boundaries still follow
town lines inside the same DMAs.

**Palm Springs, CA shows no data.** Nielsen splits Riverside County between two
markets. A whole-county crosswalk cannot represent that, so Palm Springs comes
out empty. This is a real limit of the method, not a bug, and the page says so
rather than showing a zero.

**District populations by area are nonsense.** Apportioning county population
to districts by overlap area gave CA-35 a population of 73,451 -- it has about
760,000. Dense urban districts occupy very little area. `cdcycle.py` instead
runs **iterative proportional fitting** on the district x county overlap matrix
against both known margins (district populations and county populations), 300
iterations, seeded by area share.

A residual of about 11% survives in the fast-growing Northern Virginia and
Maryland suburbs. That is not solver failure: district populations are 2020
census counts and county populations are 2024 estimates, so the two margins
genuinely disagree about how many people live there. IPF cannot reconcile a
real contradiction. The page therefore uses these numbers only as **shares**
within a district, never as population counts, which makes the vintage conflict
cancel out.

## What is committed, and why

Committed: the authored sources, the scripts, and the six derived JSON files
(~1.3 MB) that the assembly steps read. That combination makes the common case
-- change some copy, restyle something, rebuild -- work offline in about two
seconds.

Not committed: the ~8 MB of third-party downloads, `nodeenv/`, and the
intermediate per-cycle files. `fetch.sh` reproduces all of them, with the
source URL and a note on each.

Superseded scripts from development are deliberately left out: `agg.py`
(replaced by `agg2.py`), `cdx.py` and `cd26.py` (replaced by the
year-parameterized `cdcycle.py`), `cdstats.py` (single-cycle, replaced by
`cdall.py`), and `mkharness.py` (a local preview harness, only needed because
Jekyll does not run in this environment).

## CSS namespacing

`map.css` is served inside the site's own stylesheet, so everything is scoped
under `.mm-root` and every custom property is prefixed `--mm-`. Before this was
integrated, all 45 class names and every token were checked against
`css/site.css`: one class collided (`.wrap`) and three tokens did (`--ink`,
`--line`, `--muted`). `make_site.py` asserts that no bare `body{` rule and no
unnamespaced `.wrap` can reach the output.

The tail of `map.css` aliases the `--mm-*` tokens onto the site's own, so the
map follows the site palette and its light/dark toggle for free. Tokens with no
host equivalent (`--mm-dem`, `--mm-nodata`, `--mm-faint`, `--mm-line2`) keep
their own values, which already flip under `[data-theme="dark"]`.
