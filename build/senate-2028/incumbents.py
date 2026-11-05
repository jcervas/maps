"""Class III senators — the 34 seats on the ballot in November 2028.

Roster from senate.gov's Class III page (https://www.senate.gov/senators/Class_III.htm),
read November 4, 2026, with one correction the page had not yet absorbed: Ohio's
November 3, 2026 special election, which Sherrod Brown (D) won over appointed
Senator Jon Husted (R).
"""

# state, abbr, senator, party, assumed office, how they got the seat
CLASS_III = [
    ("Alabama",        "AL", "Katie Britt",            "R", 2023, "elected 2022"),
    ("Alaska",         "AK", "Lisa Murkowski",         "R", 2002, "elected 2022 (ranked choice)"),
    ("Arizona",        "AZ", "Mark Kelly",             "D", 2020, "elected 2022"),
    ("Arkansas",       "AR", "John Boozman",           "R", 2011, "elected 2022"),
    ("California",     "CA", "Alex Padilla",           "D", 2021, "elected 2022"),
    ("Colorado",       "CO", "Michael Bennet",         "D", 2009, "elected 2022"),
    ("Connecticut",    "CT", "Richard Blumenthal",     "D", 2011, "elected 2022"),
    ("Florida",        "FL", "Ashley Moody",           "R", 2025, "appointed 2025; won 2026 special"),
    ("Georgia",        "GA", "Raphael Warnock",        "D", 2021, "elected 2022"),
    ("Hawaii",         "HI", "Brian Schatz",           "D", 2012, "elected 2022"),
    ("Idaho",          "ID", "Mike Crapo",             "R", 1999, "elected 2022"),
    ("Illinois",       "IL", "Tammy Duckworth",        "D", 2017, "elected 2022"),
    ("Indiana",        "IN", "Todd Young",             "R", 2017, "elected 2022"),
    ("Iowa",           "IA", "Chuck Grassley",         "R", 1981, "elected 2022"),
    ("Kansas",         "KS", "Jerry Moran",            "R", 2011, "elected 2022"),
    ("Kentucky",       "KY", "Rand Paul",              "R", 2011, "elected 2022"),
    ("Louisiana",      "LA", "John Kennedy",           "R", 2017, "elected 2022"),
    ("Maryland",       "MD", "Chris Van Hollen",       "D", 2017, "elected 2022"),
    ("Missouri",       "MO", "Eric Schmitt",           "R", 2023, "elected 2022"),
    ("Nevada",         "NV", "Catherine Cortez Masto", "D", 2017, "elected 2022"),
    ("New Hampshire",  "NH", "Maggie Hassan",          "D", 2017, "elected 2022"),
    ("New York",       "NY", "Chuck Schumer",          "D", 1999, "elected 2022"),
    ("North Carolina", "NC", "Ted Budd",               "R", 2023, "elected 2022"),
    ("North Dakota",   "ND", "John Hoeven",            "R", 2011, "elected 2022"),
    ("Ohio",           "OH", "Sherrod Brown",          "D", 2026, "won 2026 special"),
    ("Oklahoma",       "OK", "James Lankford",         "R", 2015, "elected 2022"),
    ("Oregon",         "OR", "Ron Wyden",              "D", 1996, "elected 2022"),
    ("Pennsylvania",   "PA", "John Fetterman",         "D", 2023, "elected 2022"),
    ("South Carolina", "SC", "Tim Scott",              "R", 2013, "elected 2022"),
    ("South Dakota",   "SD", "John Thune",             "R", 2005, "elected 2022"),
    ("Utah",           "UT", "Mike Lee",               "R", 2011, "elected 2022"),
    ("Vermont",        "VT", "Peter Welch",            "D", 2023, "elected 2022"),
    ("Washington",     "WA", "Patty Murray",           "D", 1993, "elected 2022"),
    ("Wisconsin",      "WI", "Ron Johnson",            "R", 2011, "elected 2022"),
]

# Seats where the person on the 2028 ballot is not the person the voters chose in 2022.
SEAT_NOTES = {
    "FL": ("Marco Rubio (R) won in 2022 and resigned in January 2025 to become secretary "
           "of state. Ashley Moody (R) was appointed, then won the November 3, 2026 "
           "special election for the rest of the term."),
    "OH": ("JD Vance (R) won in 2022 and resigned in January 2025 to become vice "
           "president. Jon Husted (R) was appointed, then lost the November 3, 2026 "
           "special election to Sherrod Brown (D), who holds the seat into 2028."),
    "AK": ("Alaska reports both races by state house district rather than by borough, so "
           "its forty rows are districts, not counties. Murkowski won the 2022 race on "
           "ranked-choice tabulation; the figures here are first-choice votes, and the "
           "two leading candidates were both Republicans, so the two-party margin means "
           "nothing. The 1,426 federal overseas absentee votes (HD99) belong to no "
           "district and are left out."),
    "CT": ("County-equivalent rows are the nine planning regions. Connecticut reports by "
           "town, so the 2022 Senate figures are town returns from the state's election "
           "archive, rolled up with the Census 2023 county-subdivision gazetteer."),
    "NH": ("New Hampshire reports by town; the 2022 Senate figures are town returns "
           "summed to counties."),
    "VT": ("Vermont reports by town; the 2022 Senate figures come from the Secretary of "
           "State's federal-office workbook, summed to counties."),
    "GA": ("The 2022 figures are the November 8 general election, where nobody cleared 50 "
           "percent. Warnock won the December 6 runoff 1,820,148 to 1,719,483 "
           "(51.4 to 48.6 percent); that round is not in this data set."),
    "LA": ("Louisiana's November 2022 all-party primary, which Kennedy won outright. "
           "Several Democrats split the Democratic vote."),
    "MO": ("Missouri runs Kansas City's elections through a separate board; its votes are "
           "added back into Jackson County here."),
    "HI": ("Kalawao County reports no separate vote; its handful of voters are counted "
           "with Maui, so Hawaii has four rows, not five."),
    "SC": ("The county figures sum to about 6,000 votes more than the statewide total "
           "carried in the source file; the county rows are the fuller count."),
    "AZ": ("The county figures sum to about 3,400 votes more than the statewide total "
           "carried in the source file."),
    "UT": ("Democrats did not field a candidate; independent Evan McMullin was the main "
           "challenger, so the Democratic column is zero."),
}


# The state feeds spell some names oddly ("FETTERMAN, JOHN K", "jd-vance",
# "herschel-junior-walker"); these are keyed on the candidate slug in
# magic-wall/registry/races_2022.json.
NAME_FIXES = {
    "joe-o-dea": "Joe O'Dea",
    "mcdermott-bob": "Bob McDermott",
    "thomas-m-mcdermott-jr": "Thomas McDermott Jr.",
    "gary-chambers-jr": "Gary Chambers Jr.",
    "jd-vance": "JD Vance",
    "evan-mcmullin": "Evan McMullin",
    "herschel-junior-walker": "Herschel Walker",
    "charles-e-schumer": "Chuck Schumer",
    "fetterman-john-k": "John Fetterman",
    "oz-mehmet-c": "Mehmet Oz",
    "john-r-thune": "John Thune",
    "raphael-warnock-i": "Raphael Warnock",
    "kelly-c-tshibaka": "Kelly Tshibaka",
    "adam-paul-laxalt": "Adam Laxalt",
    "mark-p-meuser": "Mark Meuser",
    "brian-l-bengs": "Brian Bengs",
    "donald-c-bolduc": "Don Bolduc",
    "leora-r-levy": "Leora Levy",
    "mark-r-holland": "Mark Holland",
    "wyden-ron": "Ron Wyden",
    "perkins-jo-rae": "Jo Rae Perkins",
    "schatz-brian": "Brian Schatz",
}

# Who holds the chamber the 2028 class will sit in. Control and the split were
# two different facts with two different levels of certainty; now that 33 of
# the 35 races on the 2026 ballot are settled, both can be stated, as long as
# the two still counting are stated separately rather than folded in.
#
# 54 and 44 is the settled count across all three classes, and it is what the
# AP, NBC News, CBS News and CNN all report. The remaining two, Mississippi and
# Alaska, both lead Democratic, so the plausible range is 54-44 to 56-44.
#
# Checked November 5, 2026.
CHAMBER_CONTROL = {
    "party": "Democratic",
    "called": "November 4, 2026",
    "uncalled": ["Alaska", "Mississippi"],
    "note": ("Democrats passed 51 on November 4. The two races still being "
             "counted, Alaska and Mississippi, decide the size of the majority "
             "but not who holds it."),
    "source": "NBC News, CBS News and CNN, checked November 5, 2026",
}

# ---------------------------------------------------------------- Class II
# The 33 seats decided on November 3, 2026. They are holdovers for the 2028
# map: nobody votes on them again until 2032, so whatever these rows say is
# two thirds of the chamber the 2028 class walks into.
#
# Winners and margins are the AP count carried in magic-wall's results/ tree,
# read November 5, 2026. magic-wall's own calls.json is not the authority for
# which races are settled — it only holds the ten calls the election-night wall
# needed — so `called` comes from published reporting instead: the AP, NBC,
# CBS and CNN all have every race but Mississippi and Alaska decided.
#
# The two open ones are genuinely open, not merely slow:
#
#   MS  Colom (D) ahead by about 43 votes with affidavit ballots outstanding.
#       No automatic recount in Mississippi; a challenger has to ask a court.
#   AK  Peltola (D) ahead on first choices but under 50 percent, so the seat
#       goes to ranked-choice tabulation, scheduled for November 18.
#
# Both lead Democratic, so a map that counts them is 21 D; one that counts
# only settled seats is 19 D. The page shows the settled figure and names the
# other two, which is the same separation CHAMBER_CONTROL makes.
#
# state, abbr, winner, party, called, margin (points, leader over runner-up)
CLASS_II = [
    ("Alabama",        "AL", "Barry Moore",          "R", True,   9.4),
    ("Alaska",         "AK", "Mary Peltola",         "D", False,  0.3),
    ("Arkansas",       "AR", "Tom Cotton",           "R", True,  11.9),
    ("Colorado",       "CO", "John Hickenlooper",    "D", True,  24.0),
    ("Delaware",       "DE", "Chris Coons",          "D", True,  27.1),
    ("Georgia",        "GA", "Jon Ossoff",           "D", True,  18.1),
    ("Idaho",          "ID", "Jim Risch",            "R", True,  23.0),
    ("Illinois",       "IL", "Juliana Stratton",     "D", True,  31.4),
    ("Iowa",           "IA", "Josh Turek",           "D", True,   4.1),
    ("Kansas",         "KS", "Adam Hamilton",        "D", True,   5.0),
    ("Kentucky",       "KY", "Andy Barr",            "R", True,  12.1),
    ("Louisiana",      "LA", "Julia Letlow",         "R", True,   1.8),
    ("Maine",          "ME", "Troy Jackson",         "D", True,   6.9),
    ("Massachusetts",  "MA", "Ed Markey",            "D", True,  31.0),
    ("Michigan",       "MI", "Abdul El-Sayed",       "D", True,  11.7),
    ("Minnesota",      "MN", "Peggy Flanagan",       "D", True,  10.1),
    ("Mississippi",    "MS", "Scott Colom",          "D", False,  0.1),
    ("Montana",        "MT", "Kurt Alme",            "R", True,  11.1),
    ("Nebraska",       "NE", "Pete Ricketts",        "R", True,   6.8),
    ("New Hampshire",  "NH", "Chris Pappas",         "D", True,  15.2),
    ("New Jersey",     "NJ", "Cory Booker",          "D", True,  26.8),
    ("New Mexico",     "NM", "Ben Ray Lujan",        "D", True,  26.3),
    ("North Carolina", "NC", "Roy Cooper",           "D", True,  19.6),
    ("Oklahoma",       "OK", "Kevin Hern",           "R", True,  17.9),
    ("Oregon",         "OR", "Jeff Merkley",         "D", True,  16.5),
    ("Rhode Island",   "RI", "Jack Reed",            "D", True,  37.5),
    ("South Carolina", "SC", "Annie Andrews",        "D", True,   4.5),
    ("South Dakota",   "SD", "Mike Rounds",          "R", True,  21.0),
    ("Tennessee",      "TN", "Bill Hagerty",         "R", True,  12.2),
    ("Texas",          "TX", "James Talarico",       "D", True,  12.1),
    ("Virginia",       "VA", "Mark Warner",          "D", True,  22.6),
    ("West Virginia",  "WV", "Shelley Moore Capito", "R", True,  20.4),
    ("Wyoming",        "WY", "Harriet Hageman",      "R", True,  30.5),
]

# Seats whose 2026 result deserves a sentence of its own on the page.
CLASS_II_NOTES = {
    "AK": ("Peltola leads Sullivan on first choices but is under 50 percent, so "
           "the seat goes to ranked-choice tabulation on November 18."),
    "MS": ("Colom leads Hyde-Smith by roughly 43 votes with affidavit ballots "
           "outstanding. Mississippi has no automatic recount."),
    "LA": ("Cassidy lost renomination; Letlow held the seat for the Republicans "
           "by under two points."),
    "NE": "Ricketts beat the independent Dan Osborn, not a Democrat.",
    "MT": "Alme beat the independent Seth Bodnar, not a Democrat.",
}

# Who sits in the two uncounted seats today. The CLASS_II rows above carry the
# candidate leading, which for Mississippi and Alaska is not the same person --
# both are Republican-held and both have a Democrat narrowly ahead. The map
# outlines an undecided seat in the color of whoever holds it now, so it needs
# the holder, not the leader.
#
# From magic-wall data/reference/races_2026_seed.csv, which took them from the
# senate.gov roster.
CLASS_II_HELD_BY = {
    "AK": ("Dan Sullivan", "R"),
    "MS": ("Cindy Hyde-Smith", "R"),
}

CLASS_II_SOURCE = ("AP county returns as carried in magic-wall results/, read "
                   "November 5, 2026; which races are settled from the AP, NBC "
                   "News, CBS News and CNN the same day.")
