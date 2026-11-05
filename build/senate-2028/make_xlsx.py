#!/usr/bin/env python3
"""Pack the two CSVs into one workbook: States, Counties, Notes."""
import csv
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
