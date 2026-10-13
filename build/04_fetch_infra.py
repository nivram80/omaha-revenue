#!/usr/bin/env python3
"""Pull the infrastructure layers the cost model allocates against.

Three datasets, from DOGIS (Douglas-Omaha GIS):

  streets   Frontage is computed against these. Only classes the City actually
            maintains: expressways and ramps are state/interstate and go to a
            citywide pool instead of to the parcels they happen to run past.

  address   Attributes only, no geometry. Every address point carries the PIN
            of the parcel it sits on (99.3% populated), so dwelling-unit counts
            are a group-by rather than a point-in-polygon join.

  sewer     City-owned mains only. Used to weight the sewer share of frontage
            cost by how much pipe actually sits under each street.

Output: data/raw/{streets,address_points,sewer}.ndjson
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from arcgis import fetch_layer  # noqa: E402

DOGIS = "https://dcgis.org/server/rest/services"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")

# Classes the City of Omaha maintains. Expressway and Ramp are NDOT; Private is
# nobody's public obligation; Other is unclassified and too mixed to trust.
CITY_ROAD_CLASSES = ("Local", "Collector", "Minor Arterial", "Major Arterial")

# Mains, not service connections. Inlet Lead is the stub from a storm inlet to
# the main and Private is on-lot plumbing - neither is a city renewal liability.
SEWER_TYPES = (
    "Sewer", "Collector", "Interceptor", "Outfall", "Force Main",
    "Siphon", "Diversion Line", "Future Interceptor",
)


def quoted(values):
    return ",".join("'" + v.replace("'", "''") + "'" for v in values)


def main():
    os.makedirs(RAW, exist_ok=True)
    print("fetching infrastructure layers", flush=True)

    fetch_layer(
        service=f"{DOGIS}/vector/Street_Centerlines/FeatureServer/0",
        where=f"ROADCLASS IN ({quoted(CITY_ROAD_CLASSES)})",
        fields=["OBJECTID", "CENTERLINEID", "FULLNAME", "ROADCLASS", "MUNICIPALITY", "ONEWAYDIR"],
        out_path=os.path.join(RAW, "streets.ndjson"),
        geometry=True,
        geom_key="paths",
        batch=400,
        label="streets",
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

    print("done")


if __name__ == "__main__":
    sys.exit(main())
