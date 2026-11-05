#!/bin/sh
# Pull the latest precinct numbers from the Times and leave them in the repo.
#
#     sh refresh.sh                 # every state, write the files, do not commit
#     sh refresh.sh GA TX
#     sh refresh.sh --commit        # ... and commit them
#
# The Times rebuilds its precinct tiles once an hour, so there is nothing to
# gain by running this more often than that, and a cron entry on the hour is
# the whole of the "live feed": one request per state, the small files
# rewritten, the big ones untouched.
#
#     0 * * * * cd ~/maps && sh refresh.sh --commit >> /tmp/maps-refresh.log 2>&1
#
# Only elections/2026/data/votes/*.json and meta.json move. The geometry under
# data/precincts/ is not rebuilt and does not need to be -- precinct lines do
# not change while the count runs, and rebuilding them needs the Census
# counties that the projection fit is pinned against, which is a slower and
# much rarer job (build/build.sh).
#
# Committing each refresh is the point as much as the refresh is: the history
# of data/votes/ is then a record of how the count actually moved, hour by
# hour, which is not something the Times keeps for you and not something you
# can reconstruct afterwards.
set -eu
cd "$(dirname "$0")"

COMMIT=no
STATES=""
for a in "$@"; do
  case "$a" in
    --commit) COMMIT=yes ;;
    *) STATES="$STATES $a" ;;
  esac
done

WORK=build/scraper
# With no states named, refresh the ones already here rather than letting the
# scraper rediscover them: that probe walks 35 states back through 48 hourly
# builds looking for tilesets, which is a lot of requests to answer a question
# the data directory already answers.
if [ -z "$STATES" ]; then
  STATES=$(ls elections/2026/data/votes 2>/dev/null | sed -n 's/^\([A-Z][A-Z]\)\.json$/\1/p')
fi
python3 -I "$WORK/fetch.py" --votes-only $STATES
python3 -I "$WORK/results.py"
python3 -I build/votes.py "$WORK" $STATES
python3 -I build/meta.py "$WORK"

[ "$COMMIT" = yes ] || { echo "(not committed; pass --commit)"; exit 0; }

git add elections/2026/data/votes elections/2026/data/meta.json
git diff --cached --quiet && { echo "nothing changed since the last refresh"; exit 0; }
# The Times's build hour, not ours: two refreshes inside one hour are the same
# numbers, and the message should say which build they came from.
V=$(python3 -I -c "import json,glob,os; f=sorted(glob.glob('elections/2026/data/votes/*.json'))[0]; print(json.load(open(f))['vintage'])")
git commit -q -m "Precinct votes, Times build $V"
echo "committed: $(git log -1 --format=%s)"
