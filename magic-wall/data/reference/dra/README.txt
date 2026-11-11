This download contains data as used in Dave's Redistricting App, aggregated to districts.
Created Wed Nov 11 2026 15:49:54 GMT-0500 (Eastern Standard Time)

The first two CSV column headings are ID and Label (of the districts).
Subsequent CSV column headings have the form <category>_<year>_<dataset>[_<optional modifier>]_<field>.

Categories
	-- T = Total Population
	-- V = Voting Age Population
	-- E = Election
	-- X = Custom Datasets

Demographic Datasets, including Modifiers (Persons)
	-- CENS = Total Population from the decennial census
	-- CENS_ADJ = Total Population from the decennial census, Adjusted for incarcerated persons
	-- ACS = Total Population from the 5-year American Community Survey estimate
	-- VAP = Voting Age Population with Race Combination categories from the decennial census
	-- VAP_NH = Voting Age Population with Non-Hispanic Race Alone categories from the decennial census
	-- CVAP = Citizen Voting Age Population based on the 5-year American Community Survey estimate

Demographic Field Names
	-- Total = Total persons
	-- White = White alone, not Hispanic
	-- Hispanic = All Hispanics regardless of race
	-- Black = Black alone or in combination with other races, including Hispanic
	-- Asian = Asian alone or in combination with other races, including Hispanic
	-- Native = American Indian and Alaska Native alone or in combination with other races, including Hispanic
	-- Pacific = Native Hawaiian and Pacific Islander alone or in combination with other races, including Hispanic
	-- BlackAlone = Black alone, not Hispanic
	-- AsianAlone = Asian alone, not Hispanic
	-- NativeAlone = American Indian and Alaska Native alone, not Hispanic
	-- PacificAlone = Native Hawaiian and Pacific Islander alone, not Hispanic
	-- OtherAlone = Other race alone, not Hispanic
	-- TwoOrMore = Two or more races, not Hispanic
	-- RemTwoOrMore = Remainder of two or more races, not Hispanic (for CVAP only because it does not include some race combinations already included other fields)

Election Datasets (Votes)
	-- COMP = DRA's Composite
	-- PRES = President
	-- SEN = U.S. Senator
	-- GOV = Governor
	-- AG = Attorney General
	-- AUD = Auditor
	-- LTG = Lieutenant Governor
	-- SOS = Secretary of State
	-- TREAS = Treasurer
	-- CMPTR = Comptroller
	-- undefined = Public Lands Commissioner
	-- SC* = State Supreme Court (with seat designation)
	-- CONG = U.S. Congress

Modifiers
	-- ROFF = Runoff election
	-- SPEC = Special election
	-- SPECROFF = Special Runoff election

Election Field Names
	-- Total = Total votes
	-- Dem = Democratic votes
	-- Rep = Republican votes


