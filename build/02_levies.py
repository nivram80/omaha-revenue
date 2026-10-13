#!/usr/bin/env python3
"""Parse the Nebraska DOR consolidated tax district report for Douglas County.

The report is the authority on what each taxing body levies in each district. We
want one number out of it per district: the City of Omaha's own levy, which is
what the map treats as revenue.

xlsx is a zip of XML, so stdlib handles it - no openpyxl.

Output: config/levies.json
"""

import json
import os
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

URL = (
    "https://revenue.nebraska.gov/sites/default/files/doc/pad/research/"
    "valuation/2026/Excel/28Douglas.xlsx"
)
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
XLSX = os.path.join(ROOT, "data", "raw", "28Douglas.xlsx")
OUT = os.path.join(ROOT, "config", "levies.json")

# A district is "Omaha" if the city itself levies in it. Everything else is a
# SID, another municipality, or unincorporated county.
CITY_FUND = "OMAHA CITY"
# TIF districts sit inside the city but divert their increment to a
# redeveloper, so city revenue computed from full assessed value is overstated.
TIF_FUND = "REDEVELOP OMAHA"


def download():
    if os.path.exists(XLSX):
        return
    os.makedirs(os.path.dirname(XLSX), exist_ok=True)
    print(f"downloading {URL}", flush=True)
    req = urllib.request.Request(URL, headers={"User-Agent": "omaha-revenue/0.1"})
    with urllib.request.urlopen(req, timeout=120) as r, open(XLSX, "wb") as f:
        f.write(r.read())


def read_sheet(path):
    z = zipfile.ZipFile(path)
    shared = [
        "".join(t.text or "" for t in si.iter(NS + "t"))
        for si in ET.fromstring(z.read("xl/sharedStrings.xml"))
    ]
    sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    for row in sheet.iter(NS + "row"):
        vals = []
        for cell in row:
            v = cell.find(NS + "v")
            val = "" if v is None else v.text
            if cell.get("t") == "s":
                val = shared[int(val)]
            vals.append(val)
        yield vals


def main():
    download()
    rows = list(read_sheet(XLSX))
    header, body = rows[0], rows[1:]
    col = {name: i for i, name in enumerate(header)}

    districts = {}
    for row in body:
        # TAXDIST arrives zero-padded here ('0100') but unpadded from the parcel
        # layer ('100'). Normalise to 4 chars on both sides or the join silently
        # drops 110k parcels.
        code = row[col["TAX_DIST"]].strip().zfill(4)
        d = districts.setdefault(
            code,
            {
                "code": code,
                "consolidated": 0.0,
                "city_levy": 0.0,
                "is_omaha": False,
                "is_tif": False,
                "funds": {},
            },
        )
        fund = row[col["FUND_NAME_DESC"]].strip()
        subfund = row[col["SUBFUND_DESCRIPTION"]].strip()
        levy = float(row[col["SUBFUND_LEVY"]] or 0)

        d["consolidated"] = float(row[col["CONSOLIDATED_LEVY_RATE"]] or 0)
        d["funds"][subfund] = levy
        if fund == CITY_FUND:
            d["is_omaha"] = True
            d["city_levy"] += levy
        if fund.startswith(TIF_FUND):
            d["is_tif"] = True

    tax_year = body[0][col["TAXYEAR"]]
    core = sorted(c for c, d in districts.items() if d["is_omaha"])
    tif = sorted(c for c, d in districts.items() if d["is_tif"])

    rates = {round(districts[c]["city_levy"], 5) for c in core}
    if len(rates) != 1:
        print(f"warning: city levy is not uniform across districts: {rates}")

    out = {
        "tax_year": tax_year,
        "source": URL,
        "city_levy_per_100": round(districts[core[0]]["city_levy"], 5),
        "omaha_districts": core,
        "tif_districts": tif,
        "districts": districts,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)

    print(f"tax year {tax_year}: {len(districts)} districts")
    print(f"  city of omaha levy   {out['city_levy_per_100']} per $100")
    print(f"  omaha core districts {core}")
    print(f"  omaha TIF districts  {len(tif)}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    sys.exit(main())
