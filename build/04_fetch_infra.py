#!/usr/bin/env python3
"""Pull the infrastructure layers the cost model allocates against.

From DOGIS (Douglas-Omaha GIS):

  streets   Public Works' own street inventory: every street the City
            maintains, with its class, lane count and surface. Frontage is
            measured against these, and each one is priced by the lane-foot.
            Divided roads are drawn once per direction, each with its own
            lanes, which is why lanes and not centerline feet carry the cost.

  signals   Active traffic signals, as points.

  address   Attributes only, no geometry. Every address point carries the PIN
            of the parcel it sits on (99.3% populated), so dwelling-unit counts
            are a group-by rather than a point-in-polygon join.

  sewer     City-owned mains only. Used to weight the sewer share of frontage
            cost by how much pipe actually sits under each street.

And from the FHWA National Bridge Inventory:

  bridges   Every structure the City of Omaha owns (owner code 04, place
            37000), with its location and deck area.

Output: data/raw/{pw_streets,signals,address_points,sewer,bridges}.ndjson
"""

import csv
import io
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from arcgis import fetch_layer  # noqa: E402

DOGIS = "https://dcgis.org/server/rest/services"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")

# Mains, not service connections. Inlet Lead is the stub from a storm inlet to
# the main and Private is on-lot plumbing - neither is a city renewal liability.
SEWER_TYPES = (
    "Sewer", "Collector", "Interceptor", "Outfall", "Force Main",
    "Siphon", "Diversion Line", "Future Interceptor",
)


# The NBI is published once a year per state; the newest file first.
NBI_URLS = (
    "https://www.fhwa.dot.gov/bridge/nbi/2025/delimited/NE25.txt",
    "https://www.fhwa.dot.gov/bridge/nbi/2024/delimited/NE24.txt",
)
SQM_TO_SQFT = 10.763910416709722


def quoted(values):
    return ",".join("'" + v.replace("'", "''") + "'" for v in values)


def dms(value, deg_digits):
    """NBI coordinates are DDMMSSss (latitude) and DDDMMSSss (longitude)."""
    v = value.strip()
    if not v.isdigit() or int(v) == 0:
        return None
    v = v.zfill(deg_digits + 6)
    return (int(v[:deg_digits]) + int(v[deg_digits:deg_digits + 2]) / 60
            + int(v[deg_digits + 2:]) / 360000)


def fetch_bridges(out_path):
    """City-owned bridges in Omaha from the Nebraska NBI file. DECK_AREA is
    FHWA's own deck area in square metres, culverts included."""
    for url in NBI_URLS:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "omaha-revenue/0.2"})
            with urllib.request.urlopen(req, timeout=120) as r:
                text = r.read().decode("latin-1")
            break
        except Exception as exc:  # noqa: BLE001 - fall back to last year's file
            print(f"  {url}: {exc}", flush=True)
    else:
        raise SystemExit("no NBI file could be downloaded")
    rows = csv.reader(io.StringIO(text), quotechar="'")
    header = next(rows)
    n = 0
    with open(out_path, "w") as f:
        for row in rows:
            if len(row) != len(header):
                continue
            r = {k: v.strip() for k, v in zip(header, row)}
            if (r["COUNTY_CODE_003"], r["PLACE_CODE_004"], r["OWNER_022"],
                    r["RECORD_TYPE_005A"]) != ("055", "37000", "04", "1"):
                continue
            lat, lon = dms(r["LAT_016"], 2), dms(r["LONG_017"], 3)
            if lat is None or lon is None:
                continue
            f.write(json.dumps({
                "id": r["STRUCTURE_NUMBER_008"],
                "lon": round(-lon, 6),
                "lat": round(lat, 6),
                "deck_sf": round(float(r["DECK_AREA"] or 0) * SQM_TO_SQFT, 1),
                "carried": r["FACILITY_CARRIED_007"],
                "crosses": r["FEATURES_DESC_006A"],
                "year_built": int(r["YEAR_BUILT_027"] or 0),
            }) + "\n")
            n += 1
    print(f"  bridges: {n} city-owned from {url.rsplit('/', 1)[1]}", flush=True)


def main():
    os.makedirs(RAW, exist_ok=True)
    print("fetching infrastructure layers", flush=True)

    fetch_layer(
        service=f"{DOGIS}/Hosted/Streets_For_Public_Works_CCSM/FeatureServer/0",
        where="1=1",
        fields=["objectid", "street_segment", "mapa_classification", "surface_type",
                "lane_count", "lanes_by_width", "dual_carriage", "city_maintained"],
        out_path=os.path.join(RAW, "pw_streets.ndjson"),
        geometry=True,
        geom_key="paths",
        batch=400,
        label="streets",
    )

    fetch_layer(
        service=f"{DOGIS}/Hosted/Noneditable_Signal_Intersections/FeatureServer/0",
        where="status = 'Active'",
        fields=["objectid", "location", "type", "year_built"],
        out_path=os.path.join(RAW, "signals.ndjson"),
        geometry=True,
        geom_key="point",
        batch=1000,
        label="signals",
    )

    fetch_layer(
        service=f"{DOGIS}/vector/Address_Points/FeatureServer/0",
        where="PIN IS NOT NULL AND PIN <> ''",
        fields=["OBJECTID", "PIN", "STATUS", "POINTTYPE", "ADDRCLASS", "UNITID"],
        out_path=os.path.join(RAW, "address_points.ndjson"),
        geometry=False,
        batch=2000,
        label="address",
    )

    fetch_layer(
        service=f"{DOGIS}/Sewer/Sewer_Network_Public/FeatureServer/1",
        where=f"OWNER = 'Omaha' AND LINE_TYPE IN ({quoted(SEWER_TYPES)})",
        fields=["OBJECTID", "LINE_TYPE", "LINE_HEIGHT_DIAMETER", "PLAN_LINE_LENGTH", "SMA"],
        out_path=os.path.join(RAW, "sewer.ndjson"),
        geometry=True,
        geom_key="paths",
        batch=600,
        label="sewer",
    )

    fetch_bridges(os.path.join(RAW, "bridges.ndjson"))

    print("done")


if __name__ == "__main__":
    sys.exit(main())
