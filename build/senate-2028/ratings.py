"""A first cut at 2028 ratings, from the two results already in the data set.

This is arithmetic, not a forecast. Nobody has filed, no polling exists, and
the rule below knows nothing about who runs, who retires or what the national
environment does by 2028. It exists to give the map a starting classification
that can be argued with, and every rating carries the number it came from.

The rule
--------
Each seat gets a lean in margin points, positive Republican:

    lean = 0.65 * (2024 presidential margin) + 0.35 * (2022 Senate margin)

The presidential margin carries more weight because it is the cleaner measure
of a state's partisan ground: one election, one pair of candidates, held on the
same day everywhere. A Senate margin is the state's lean plus whatever the two
candidates were worth, which is exactly what a 2028 rating cannot yet know.
Keeping it at 35 percent lets a seat like Wisconsin, where both races were
close, differ from one where only the presidential race was.

Four seats use the presidential margin alone, because their 2022 Senate margin
does not measure what it looks like:

    AK  ranked choice, and the two leading candidates were both Republicans
    UT  no Democrat on the ballot; the challenger was an independent
    GA  the November round only; the seat was settled in a December runoff
    LA  an all-party primary with the Democratic vote split several ways

Then the seat is pulled four points toward the party that holds it. Senate
incumbents run ahead of their party's baseline more often than not, and four
points is a modest reading of that. It is applied to the party rather than the
person on purpose: in 2028 the holder may not be the candidate.

    HOLD = 4

Bands on the adjusted figure, which is what the rating names:

    under 5     Toss Up
    5 to 10     Lean
    10 to 20    Likely
    20 and over Solid

Cook's seven category names are used so this map reads against the others on
the site: Solid / Likely / Lean / Toss Up, Democrat or Republican. The bands
themselves are mine -- Cook does not publish numeric thresholds -- so a rating
here is not Cook's rating of the same seat.

What the rule deliberately ignores
----------------------------------
Ohio and Florida were both contested again in the November 2026 specials, and
those results are better evidence than anything here — Sherrod Brown (D) took
the Ohio seat and Ashley Moody (R) held Florida. The rule uses 2022 and 2024
only, as asked, so Ohio in particular comes out of it looking more Republican
than a rating written by hand would. Both are flagged in `basis`.
"""

PRES_WEIGHT = 0.65
SEN_WEIGHT = 0.35
HOLD = 4.0
BANDS = [(5, "Toss Up"), (10, "Lean"), (20, "Likely"), (float("inf"), "Solid")]

# Seats whose 2022 Senate margin is not a two-party margin.
PRES_ONLY = {
    "AK": "ranked choice, both leading candidates Republican",
    "UT": "no Democrat on the ballot",
    "GA": "November round only; decided in a December runoff",
    "LA": "all-party primary, Democratic vote split",
}

# Seats where a later election is better evidence than the rule's inputs.
SUPERSEDED = {
    "OH": "Sherrod Brown (D) won the November 2026 special for this seat",
    "FL": "Ashley Moody (R) won the November 2026 special for this seat",
}


def rate(abbr, pres24_margin, sen22_margin, incumbent_party):
    """-> (rating, lean, adjusted lean, basis). Margins are Republican minus
    Democratic, so a positive number is a Republican lead."""
    if abbr in PRES_ONLY:
        lean = pres24_margin
        basis = "2024 president only: " + PRES_ONLY[abbr]
    else:
        lean = PRES_WEIGHT * pres24_margin + SEN_WEIGHT * sen22_margin
        basis = "65 percent 2024 president, 35 percent 2022 Senate"

    adjusted = lean + (HOLD if incumbent_party == "R" else -HOLD)
    basis += "; %s points toward the %s hold" % (
        int(HOLD), "Republican" if incumbent_party == "R" else "Democratic")
    if abbr in SUPERSEDED:
        basis += ". Not counted: " + SUPERSEDED[abbr]

    for edge, name in BANDS:
        if abs(adjusted) < edge:
            break
    party = "Republican" if adjusted > 0 else "Democrat"
    rating = name if name == "Toss Up" else "%s %s" % (name, party)
    return rating, round(lean, 2), round(adjusted, 2), basis


# Display order, Democratic to Republican, as Cook prints them.
ORDER = ["Solid Democrat", "Likely Democrat", "Lean Democrat", "Toss Up",
         "Lean Republican", "Likely Republican", "Solid Republican"]

# Short labels, as the other maps on the site print them.
SHORT = {"Solid Democrat": "Solid D", "Likely Democrat": "Likely D",
         "Lean Democrat": "Lean D", "Toss Up": "Toss-up",
         "Lean Republican": "Lean R", "Likely Republican": "Likely R",
         "Solid Republican": "Solid R"}
