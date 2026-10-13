#!/usr/bin/env python3
"""Pull Douglas County parcels from the Nebraska statewide parcel layer.

Strategy: ask for every OBJECTID first, then request features in explicit id
batches. Offset pagination on a 216k-row layer drifts when the server's sort is
unstable and gives no way to resume; id batches are exact, resumable, and let a
failed batch retry on its own.

Geometry comes back as EPSG:4326. That is the canonical store — Web Mercator for
rendering and a local planar frame for phase-2 frontage are both derived from it.
The layer's native SR is 3857, which is ~33% off on distance at Omaha's latitude,
so it is never used for measurement.

Output: data/raw/parcels.ndjson, one feature per line.
Re-running resumes: batches already on disk are skipped.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SERVICE = (
    "https://gis.ne.gov/Enterprise/rest/services/"
    "StatewideParcelsExternal/FeatureServer/0/query"
)
COUNTY = "055"  # Douglas
BATCH = 500  # ids per request; keeps responses near 0.5 MB

FIELDS = [
    "Parcel_ID",
    "Total_Assessed_Value",
    "Land_Value",
    "Improvements_Value",
    "GIS_Acres",
    "Acres_Deeded",
    "Classification_Code",
    "Property_Parcel_Type",
    "Property_SubClass",
    "TAXDIST",
    "Zoning",
    "ImpSF",
    "BuildingYear",
    "Situs_Address",
    "Ph_City",
    "Sales_Date",
    "Sales_Value",
]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(RAW, "parcels.ndjson")
IDS = os.path.join(RAW, "objectids.json")
STATE = os.path.join(RAW, "fetch_state.json")


def post(params, tries=5):
    """POST a query. Batches of ids blow past any sane URL length."""
    body = urllib.parse.urlencode(params).encode()
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                SERVICE,
                data=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "omaha-revenue/0.1",
                },
            )
            with urllib.request.urlopen(req, timeout=180) as r:
                payload = json.loads(r.read())
            # ArcGIS reports failures with HTTP 200 and an error object.
            if "error" in payload:
                raise RuntimeError(payload["error"])
            return payload
        except Exception as exc:  # noqa: BLE001 - retry anything transient
            last = exc
            if attempt < tries - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"query failed after {tries} tries: {last}")


def fetch_objectids():
    if os.path.exists(IDS):
        with open(IDS) as f:
            return json.load(f)
    print("fetching objectids ...", flush=True)
    payload = post(
        {
            "where": f"County_ID='{COUNTY}'",
            "returnIdsOnly": "true",
            "f": "json",
        }
    )
    oids = sorted(payload["objectIds"])
    with open(IDS, "w") as f:
        json.dump(oids, f)
    print(f"  {len(oids):,} objectids", flush=True)
    return oids


def load_state():
    if os.path.exists(STATE):
        with open(STATE) as f:
            return json.load(f)
    return {"done": 0}


def main():
    os.makedirs(RAW, exist_ok=True)
    oids = fetch_objectids()
    batches = [oids[i : i + BATCH] for i in range(0, len(oids), BATCH)]
    state = load_state()
    start = state["done"]

    if start >= len(batches):
        print(f"already complete: {len(batches)} batches")
        return

    if start:
        print(f"resuming at batch {start}/{len(batches)}", flush=True)

    mode = "a" if start else "w"
    written = 0
    t0 = time.time()

    with open(OUT, mode) as out:
        for i in range(start, len(batches)):
            payload = post(
                {
                    "objectIds": ",".join(str(o) for o in batches[i]),
                    "outFields": ",".join(FIELDS),
                    "returnGeometry": "true",
                    "outSR": "4326",
                    "f": "json",
                }
            )
            for feat in payload.get("features", []):
                rings = (feat.get("geometry") or {}).get("rings")
                if not rings:
                    continue  # a handful of rows carry attributes but no shape
                rec = feat["attributes"]
                rec["rings"] = rings
                out.write(json.dumps(rec, separators=(",", ":")) + "\n")
                written += 1
            out.flush()
            with open(STATE, "w") as f:
                json.dump({"done": i + 1}, f)

            if (i + 1) % 20 == 0 or i + 1 == len(batches):
                pct = 100 * (i + 1) / len(batches)
                rate = (i + 1 - start) / max(time.time() - t0, 1e-6)
                eta = (len(batches) - i - 1) / max(rate, 1e-6)
                print(
                    f"  batch {i + 1}/{len(batches)} ({pct:.1f}%) "
                    f"{written:,} features  eta {eta / 60:.1f}m",
                    flush=True,
                )

    size = os.path.getsize(OUT) / 1e6
    print(f"done: {written:,} features this run, {size:.0f} MB at {OUT}")


if __name__ == "__main__":
    sys.exit(main())
