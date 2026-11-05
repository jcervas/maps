#!/usr/bin/env python3
"""Pack the data into one workbook: States, Counties, Chamber, Notes."""
import csv
import json
import os
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

HERE = os.path.dirname(os.path.abspath(__file__))        # build/senate-2028
REPO = os.path.dirname(os.path.dirname(HERE))            # the maps repo
DATA = os.path.join(REPO, "elections", "2028", "data")

sys.path.insert(0, HERE)
from incumbents import SEAT_NOTES  # noqa: E402

HEAD = PatternFill("solid", fgColor="1F3864")
HEAD_FONT = Font(color="FFFFFF", bold=True)
INT_COLS = ("votes",)
PCT_COLS = ("pct", "margin")


def write_sheet(ws, path, freeze="C2", widths=None):
    rows = list(csv.reader(open(path)))
    header = rows[0]
    ws.append(header)
    for c in range(1, len(header) + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill = HEAD
        cell.font = HEAD_FONT
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    ws.row_dimensions[1].height = 30

    for r in rows[1:]:
        out = []
        for name, v in zip(header, r):
            if v == "":
                out.append(None)
            elif any(k in name for k in INT_COLS) or name == "in_office_since":
                out.append(int(v))
            elif any(k in name for k in PCT_COLS):
                out.append(float(v))
            else:
                out.append(v)
        ws.append(out)

    for i, name in enumerate(header, start=1):
        col = get_column_letter(i)
        if widths and name in widths:
            w = widths[name]
        elif any(k in name for k in INT_COLS):
            w = 13
        elif any(k in name for k in PCT_COLS):
            w = 10
        else:
            w = max(10, min(26, len(name) + 3))
        ws.column_dimensions[col].width = w
        if any(k in name for k in INT_COLS):
            fmt = "#,##0"
        elif any(k in name for k in PCT_COLS):
            fmt = '0.0"%"'
        else:
            fmt = None
        if fmt:
            for row in range(2, ws.max_row + 1):
                ws.cell(row=row, column=i).number_format = fmt

    ws.freeze_panes = freeze
    ws.auto_filter.ref = ws.dimensions


def chamber_sheet(wb):
    """All 100 seats, so the workbook answers the question the map answers: what
    the 2028 class walks into. Class I and the settled Class II seats are
    holdovers; Class III enters at its rating; the seven nobody can assign are
    marked as such rather than quietly handed to a side."""
    ch = json.load(open(os.path.join(DATA, "senate2028.json")))["chamber"]
    names = ch["state_names"]
    ws = wb.create_sheet("Chamber")
    ws.append(["state", "abbr", "class", "senator", "party", "caucus",
               "next_election", "status", "counts_for", "detail"])
    order = {1: 0, 2: 1, 3: 2}
    rows = sorted(ch["all_seats"],
                  key=lambda x: (x["abbr"], order[x["cls"]]))
    for x in rows:
        if x["cls"] == 3:
            status = "on the 2028 ballot"
            side = ("" if x["rating"] == "Toss Up"
                    else "D" if x["rating"].endswith("Democrat") else "R")
            detail = x["rating"]
        elif x["settled"]:
            status = "holdover"
            side = x["caucus"]
            detail = "won 2024" if x["cls"] == 1 else "won 2026"
        else:
            status = "2026 race still counting"
            side = ""
            detail = x.get("note", "")
        ws.append([names.get(x["abbr"], x["abbr"]), x["abbr"],
                   {1: "I", 2: "II", 3: "III"}[x["cls"]], x["senator"],
                   x["party"], x["caucus"], x["next"], status,
                   side or "undecided", detail])
    for i in range(1, 11):
        c = ws.cell(row=1, column=i)
        c.fill, c.font = HEAD, HEAD_FONT
    for col, w in {"A": 16, "D": 22, "H": 24, "I": 11, "J": 56}.items():
        ws.column_dimensions[col].width = w
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = ws.dimensions

    pr = ch["projection"]
    ws2 = wb.create_sheet("Projection")
    ws2["A1"] = "The 2029 Senate, counted from this data set"
    ws2["A1"].font = Font(bold=True, size=13)
    for row in [
        [],
        ["Settled holdovers (Class I + called Class II)",
         pr["settled_dem"], pr["settled_rep"]],
        ["Class III seats with a rating", pr["rated_dem"], pr["rated_rep"]],
        ["Subtotal", pr["floor_dem"], pr["floor_rep"]],
        [],
        ["Undecided", pr["open"]],
        ["  Class III toss-ups", len(pr["tossup"]), ", ".join(pr["tossup"])],
        ["  2026 races still counting", len(pr["pending"]),
         ", ".join(x["abbr"] for x in pr["pending"])],
        [],
        ["Democratic range", pr["floor_dem"], pr["ceiling_dem"]],
        ["Republican range", pr["floor_rep"], pr["ceiling_rep"]],
        [],
        ["Note", pr["note"]],
        ["Source", ch["source"]],
    ]:
        ws2.append(row)
    ws2.column_dimensions["A"].width = 44
    ws2.column_dimensions["B"].width = 100
    for r in range(1, ws2.max_row + 1):
        ws2.cell(row=r, column=2).alignment = Alignment(wrap_text=True,
                                                        vertical="top")


def main():
    wb = Workbook()
    ws = wb.active
    ws.title = "States"
    write_sheet(ws, os.path.join(DATA, "class3_states.csv"), freeze="C2",
                widths={"state": 16, "incumbent": 22, "seat_path": 30,
                        "sen22_winner": 22, "sen22_top1": 26, "sen22_top2": 26,
                        "note": 60})

    ws2 = wb.create_sheet("Counties")
    write_sheet(ws2, os.path.join(DATA, "class3_counties.csv"), freeze="E2",
                widths={"county": 26, "state": 16})

    chamber_sheet(wb)

    ws3 = wb.create_sheet("Notes")
    ws3.append(["Senate seats on the ballot in November 2028 (Class III)"])
    ws3["A1"].font = Font(bold=True, size=13)
    lines = [
        "",
        "Built November 4, 2026.",
        "",
        "Columns",
        "  incumbent / incumbent_party  the sitting senator for that seat today.",
        "  sen22_*                      the November 2022 election for this same seat.",
        "  pres24_*                     2024 presidential vote, summed from counties.",
        "  *_margin_pct                 Republican share minus Democratic share, so a "
        "positive number is a Republican lead.",
        "  pres24_minus_sen22_margin    how much more Republican the seat's state ran for "
        "president in 2024 than for Senate in 2022.",
        "",
        "Sources",
        "  Class III roster: senate.gov/senators/Class_III.htm, read November 4, 2026.",
        "  2024 president by county: tonmcg/US_County_Level_Election_Results_08-24.",
        "  2022 Senate: state election-office feeds collected in the magic-wall repo, "
        "with candidate parties from its 2022 race registry.",
        "  Ohio's incumbent reflects the November 3, 2026 special election "
        "(Sherrod Brown, D, defeated appointed Senator Jon Husted, R).",
        "  Class I: magic-wall data/reference/holdovers_2026.json, checked "
        "against the senate.gov roster.",
        "  Class II: the November 3, 2026 result, from AP county returns read "
        "November 5, 2026. Mississippi and Alaska were still being counted and "
        "are left out of every split on the Projection sheet.",
        "",
        "State notes",
    ]
    for line in lines:
        ws3.append([line])
    for ab in sorted(SEAT_NOTES):
        ws3.append(["  %s: %s" % (ab, SEAT_NOTES[ab])])
    ws3.column_dimensions["A"].width = 130
    for row in range(1, ws3.max_row + 1):
        ws3.cell(row=row, column=1).alignment = Alignment(wrap_text=True, vertical="top")

    out = os.path.join(DATA, "senate_2028_class3.xlsx")
    wb.save(out)
    print("wrote", out)


if __name__ == "__main__":
    main()
