#!/bin/sh
# Copy the magic wall into magic-wall/ (the site's /maps/magic-wall/), and
# optionally commit and push it.
#
#     sh build/magic-wall/publish.sh              # copy only
#     sh build/magic-wall/publish.sh --push       # ... commit and push if anything changed
#     sh build/magic-wall/publish.sh --every 3600 # ... and again every hour, until stopped
#
# Run --every from a terminal, beside the poller, not from launchd: on
# November 6 the precinct LaunchAgent could not read this Drive checkout at
# all ("not a git repo" every hour), and a terminal can.
#
# What goes up is the wall itself and the data it reads -- results, registry,
# baselines, geography, the manifest and the calls. What does not:
#   * geo/precincts-2024 -- 462 MB of the Times's precinct shapes; the
#     Precincts button simply does not appear without them;
#   * replay/, logs/, exports/, scripts/, adapters/, jobs/, docs/, data/raw/ --
#     the pipeline and its working files, not the page.
# The Times's and AP's results are published with credit, by the user's
# decision of November 6 (the same one made for elections/2026); every race
# names its source on the page.
#
# The copy's manifest.json carries "published": {"at", "every"}, so the page
# reports the copy's age rather than raising "poller stopped?" at an hour-old
# heartbeat (data/freshness.js).
set -eu
cd "$(dirname "$0")/../.."
WALL="${MAGIC_WALL:-../magic-wall}"
[ -d "$WALL" ] || WALL="$HOME/magic-wall-live"
[ -f "$WALL/index.html" ] || { echo "no magic-wall at $WALL (set MAGIC_WALL)"; exit 1; }
DEST=magic-wall

PUSH=no
EVERY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --push) PUSH=yes ;;
    --every) PUSH=yes; EVERY="$2"; shift ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
  shift
done

copy() {
  mkdir -p "$DEST"
  # Trailing slashes: copy the contents. --delete keeps the copy an exact
  # mirror of what is listed, so a file the wall drops goes away here too.
  rsync -a --delete \
    --exclude '.DS_Store' --exclude '*.tmp' --exclude '.tmp.drive*' --exclude '__pycache__' \
    --exclude 'geo/precincts-2024/' --exclude 'data/raw/' \
    --include 'index.html' --include 'shell.js' --include 'wall.css' \
    --include 'calls.json' --include 'overrides.json' --include 'presets.json' \
    --include 'apps/***' --include 'core/***' --include 'geo/***' \
    --include 'baselines/***' --include 'registry/***' --include 'results/***' \
    --include 'data/' --include 'data/*.js' --include 'data/reference/***' \
    --exclude '*' \
    "$WALL/" "$DEST/"
  # Front matter on the copy only, so the /maps/ index lists it (order: in
  # _config.yml); the wall's own index.html stays plain HTML for its local
  # server. layout: null passes the page through untouched.
  python3 -I - "$DEST/index.html" <<'EOF'
import sys
p = sys.argv[1]
html = open(p, encoding="utf-8").read()
if not html.startswith("---\n"):
    fm = """---
layout: null
title: "Magic Wall: 2026 Election Results"
description: "Live 2026 results for the U.S. House, Senate, governors, secretaries of state and the Pennsylvania and West Virginia legislatures, by county and district, from each state's own election site, with The New York Times and the AP where a state has no feed."
summary: "Every 2026 House, Senate, governor and secretary of state race by county and district, built for election night: margins, swing, ratings, calls and seat counts."
permalink: /magic-wall/
---
"""
    open(p, "w", encoding="utf-8").write(fm + html)
EOF
  python3 -I - "$WALL/manifest.json" "$DEST/manifest.json" "$EVERY" <<'EOF'
import json, sys
from datetime import datetime, timezone
src, dst, every = sys.argv[1], sys.argv[2], int(sys.argv[3]) or 3600
m = json.load(open(src))
m["published"] = {"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "every": every}
tmp = dst + ".part"
json.dump(m, open(tmp, "w"), separators=(",", ":"))
__import__("os").replace(tmp, dst)
EOF
  echo "$(date '+%H:%M:%S')  copied: $(du -sh "$DEST" | cut -f1)"
}

publish() {
  [ "$PUSH" = yes ] || return 0
  git add -A "$DEST"
  # manifest.json alone (its publish stamp) is not news.
  if git diff --cached --quiet -- "$DEST" ':!magic-wall/manifest.json'; then
    git reset -q -- "$DEST"
    echo "$(date '+%H:%M:%S')  no new results"
    return 0
  fi
  git commit -q -m "Magic wall: results as of $(date '+%Y-%m-%d %H:%M %Z')"
  git push -q && echo "$(date '+%H:%M:%S')  pushed $(git log -1 --format=%h)"
}

while :; do
  copy
  publish || echo "$(date '+%H:%M:%S')  publish failed; will retry next round"
  [ "$EVERY" -gt 0 ] || break
  sleep "$EVERY"
done
