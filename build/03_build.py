#!/usr/bin/env python3
"""Turn raw parcels into the binary the renderer reads.

What happens here:
  1. join the levy table and keep only parcels the City of Omaha actually taxes
  2. project WGS84 -> Web Mercator
  3. simplify boundaries (Douglas-Peucker, tolerance in ground metres)
  4. bridge interior rings into their outer ring so the browser only ever sees
     simple polygons and its triangulator can stay ~80 lines
  5. bucket parcels into a spatial grid, quantise each cell to uint16
  6. write one binary blob plus a lazily-loaded attribute sidecar

Output: data/out/parcels.bin, data/out/attrs.json, data/out/manifest.json
"""

import array
import json
import math
import os
import struct
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "raw", "parcels.ndjson")
COSTS = os.path.join(ROOT, "data", "interim", "costs.ndjson")
COST_SUMMARY = os.path.join(ROOT, "data", "interim", "cost_summary.json")
LEVIES = os.path.join(ROOT, "config", "levies.json")
OUTDIR = os.path.join(ROOT, "data", "out")

R = 6378137.0
SIMPLIFY_M = 0.5  # ground metres
CELL_M = 3000.0  # mercator metres; ~150 cells over Omaha
U16 = 65535

# Nebraska PAD property type -> our coarse class byte. The map only needs enough
# categories to filter and colour by; the full 12-digit classification code is
# kept in the attribute sidecar.
CLASS_BY_TYPE = {
    "01": 1,  # residential
    "02": 2,  # recreational
    "03": 3,  # commercial
    "04": 4,  # industrial
    "05": 5,  # agricultural
    "06": 6,  # mineral
    "07": 6,
    "10": 7,  # exempt
    "11": 7,  # exempt
}
CLASS_NAMES = {
    0: "Unknown",
    1: "Residential",
    2: "Recreational",
    3: "Commercial",
    4: "Industrial",
    5: "Agricultural",
    6: "Other",
    7: "Exempt",
}

FLAG_TIF = 1 << 0
FLAG_EXEMPT = 1 << 1


def merc(lon, lat):
    lat = max(min(lat, 85.05), -85.05)
    return (
        R * math.radians(lon),
        R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)),
    )


def signed_area(ring):
    """Shoelace on a flat [x0,y0,x1,y1,...] ring. CCW is positive.

    Esri winds outer rings clockwise and holes counter-clockwise, so a positive
    area here means the ring is a hole.
    """
    total = 0.0
    n = len(ring)
    for i in range(0, n, 2):
        j = (i + 2) % n
        total += ring[i] * ring[j + 1] - ring[j] * ring[i + 1]
    return total / 2


def simplify(ring, tol):
    """Douglas-Peucker on a closed flat ring. Iterative: some parcels run to
    1790 vertices and recursion depth is not worth the risk."""
    n = len(ring) // 2
    if n < 5:
        return ring
    keep = bytearray(n)
    keep[0] = keep[n - 1] = 1
    tol2 = tol * tol
    stack = [(0, n - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        ax, ay = ring[lo * 2], ring[lo * 2 + 1]
        bx, by = ring[hi * 2], ring[hi * 2 + 1]
        dx, dy = bx - ax, by - ay
        den = dx * dx + dy * dy
        worst, worst_i = -1.0, -1
        for i in range(lo + 1, hi):
            px, py = ring[i * 2], ring[i * 2 + 1]
            if den > 0:
                t = ((px - ax) * dx + (py - ay) * dy) / den
                t = 0.0 if t < 0 else (1.0 if t > 1 else t)
                ex, ey = ax + t * dx - px, ay + t * dy - py
            else:
                ex, ey = ax - px, ay - py
            d2 = ex * ex + ey * ey
            if d2 > worst:
                worst, worst_i = d2, i
        if worst > tol2:
            keep[worst_i] = 1
            stack.append((lo, worst_i))
            stack.append((worst_i, hi))
    out = array.array("d")
    for i in range(n):
        if keep[i]:
            out.append(ring[i * 2])
            out.append(ring[i * 2 + 1])
    return out


def point_in_ring(x, y, ring):
    inside = False
    n = len(ring) // 2
    j = n - 1
    for i in range(n):
        xi, yi = ring[i * 2], ring[i * 2 + 1]
        xj, yj = ring[j * 2], ring[j * 2 + 1]
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def bridge_hole(outer, hole):
    """Splice a hole into its outer ring with a two-sided bridge.

    Earcut's approach: take the hole's rightmost vertex, shoot a ray at +x, and
    cut into the outer vertex whose edge that ray hits first. Good enough here -
    parcel holes are rare and simple, nothing like a landmass with fjords.
    """
    hn = len(hole) // 2
    hi = max(range(hn), key=lambda i: hole[i * 2])
    hx, hy = hole[hi * 2], hole[hi * 2 + 1]

    best_x, best_i = -math.inf, -1
    n = len(outer) // 2
    for i in range(n):
        j = (i + 1) % n
        ax, ay = outer[i * 2], outer[i * 2 + 1]
        bx, by = outer[j * 2], outer[j * 2 + 1]
        if (ay > hy) == (by > hy):
            continue
        x = ax + (hy - ay) / (by - ay) * (bx - ax)
        if hx <= x < math.inf and x > best_x:
            # pick the endpoint further right; it is reachable from the cut
            best_x, best_i = x, i if ax > bx else j
    if best_i < 0:
        return outer  # degenerate; drop the hole rather than corrupt the ring

    merged = array.array("d")
    for i in range(best_i + 1):
        merged.append(outer[i * 2])
        merged.append(outer[i * 2 + 1])
    for k in range(hn + 1):
        i = (hi + k) % hn
        merged.append(hole[i * 2])
        merged.append(hole[i * 2 + 1])
    for i in range(best_i, n):
        merged.append(outer[i * 2])
        merged.append(outer[i * 2 + 1])
    return merged


def prepare(rings, tol):
    """Esri rings -> list of simple, hole-free, projected rings."""
    outers, holes = [], []
    for raw in rings:
        flat = array.array("d")
        for lon, lat in raw:
            x, y = merc(lon, lat)
            flat.append(x)
            flat.append(y)
        # drop the repeated closing vertex; we close implicitly
        if len(flat) >= 4 and flat[0] == flat[-2] and flat[1] == flat[-1]:
            flat = flat[:-2]
        if len(flat) < 6:
            continue
        flat = simplify(flat, tol)
        if len(flat) < 6:
            continue
        (holes if signed_area(flat) > 0 else outers).append(flat)

    if not outers:
        return []
    for hole in holes:
        hx, hy = hole[0], hole[1]
        target = next(
            (o for o in outers if point_in_ring(hx, hy, o)),
            outers[0] if len(outers) == 1 else None,
        )
        if target is None:
            continue
        outers[outers.index(target)] = bridge_hole(target, hole)
    return outers


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    with open(LEVIES) as f:
        levies = json.load(f)
    city_levy = levies["city_levy_per_100"] / 100.0
    keep_districts = set(levies["omaha_districts"]) | set(levies["tif_districts"])
    tif_districts = set(levies["tif_districts"])

    # Mercator is conformal, so one scale factor converts a ground tolerance to
    # a projected one. At Omaha's latitude that is about 1.33x.
    tol = SIMPLIFY_M / math.cos(math.radians(41.26))

    # Phase 2 output, if it has been built. Without it the map is revenue-only.
    costs = {}
    cost_summary = None
    if os.path.exists(COSTS):
        with open(COSTS) as f:
            for line in f:
                c = json.loads(line)
                costs[c["pin"]] = c
        with open(COST_SUMMARY) as f:
            cost_summary = json.load(f)
        print(f"cost model: {len(costs):,} parcels", flush=True)
    else:
        print("cost model: not built (run 05_costs.py) - revenue only", flush=True)

    print("pass 1: filter + extent", flush=True)
    minx = miny = math.inf
    maxx = maxy = -math.inf
    kept = 0
    skipped = Counter()
    with open(SRC) as f:
        for line in f:
            rec = json.loads(line)
            dist = (rec.get("TAXDIST") or "").strip().zfill(4)
            if dist not in keep_districts:
                skipped["outside omaha"] += 1
                continue
            acres = rec.get("GIS_Acres") or 0
            if acres <= 0:
                skipped["no area"] += 1
                continue
            kept += 1
            for ring in rec["rings"]:
                for lon, lat in ring:
                    x, y = merc(lon, lat)
                    minx, maxx = min(minx, x), max(maxx, x)
                    miny, maxy = min(miny, y), max(maxy, y)
    print(f"  kept {kept:,}  skipped {dict(skipped)}")
    print(f"  extent {(maxx - minx) / 1000:.1f} x {(maxy - miny) / 1000:.1f} km")

    cols = max(1, int(math.ceil((maxx - minx) / CELL_M)))
    rows = max(1, int(math.ceil((maxy - miny) / CELL_M)))
    print(f"  grid {cols} x {rows} = {cols * rows} cells")

    cells = {}

    def cell_for(x, y):
        cx = min(cols - 1, int((x - minx) / CELL_M))
        cy = min(rows - 1, int((y - miny) / CELL_M))
        key = cy * cols + cx
        c = cells.get(key)
        if c is None:
            c = cells[key] = {
                "coords": array.array("d"),
                "ring_start": array.array("I", [0]),
                "parcel_ring_start": array.array("I", [0]),
                "assessed": array.array("f"),
                "acres": array.array("f"),
                "c_frontage_shared": array.array("f"),
                "c_frontage_own": array.array("f"),
                "c_people": array.array("f"),
                "c_flat": array.array("f"),
                "frontage": array.array("f"),
                "sewer_fee": array.array("f"),
                "c_sewer": array.array("f"),
                "cls": bytearray(),
                "flags": bytearray(),
                "attrs": [],
            }
        return c

    print("pass 2: geometry", flush=True)
    ring_hist = Counter()
    vtot = 0
    vraw = 0
    dropped = 0
    with open(SRC) as f:
        for line in f:
            rec = json.loads(line)
            dist = (rec.get("TAXDIST") or "").strip().zfill(4)
            if dist not in keep_districts:
                continue
            acres = rec.get("GIS_Acres") or 0
            if acres <= 0:
                continue
            vraw += sum(len(r) for r in rec["rings"])
            polys = prepare(rec["rings"], tol)
            if not polys:
                dropped += 1
                continue
            ring_hist[len(polys)] += 1

            cx = sum(p[0] for p in polys) / len(polys)
            cy = sum(p[1] for p in polys) / len(polys)
            c = cell_for(cx, cy)

            for ring in polys:
                c["coords"].extend(ring)
                c["ring_start"].append(len(c["coords"]) // 2)
                vtot += len(ring) // 2
            c["parcel_ring_start"].append(len(c["ring_start"]) - 1)

            assessed = float(rec.get("Total_Assessed_Value") or 0)
            ptype = (rec.get("Property_Parcel_Type") or "").strip()
            cls = CLASS_BY_TYPE.get(ptype, 0)
            flags = 0
            if dist in tif_districts:
                flags |= FLAG_TIF
            if assessed <= 0:
                flags |= FLAG_EXEMPT

            cost = costs.get(rec.get("Parcel_ID") or "")
            c["assessed"].append(assessed)
            c["acres"].append(float(acres))
            # Both street-cost variants: the map's through-road toggle picks one.
            c["c_frontage_shared"].append(float(cost["c_frontage_shared"]) if cost else 0.0)
            c["c_frontage_own"].append(float(cost["c_frontage_own"]) if cost else 0.0)
            c["c_people"].append(float(cost["c_people"]) if cost else 0.0)
            c["c_flat"].append(float(cost["c_flat"]) if cost else 0.0)
            c["frontage"].append(float(cost["frontage_ft"]) if cost else 0.0)
            c["sewer_fee"].append(float(cost.get("sewer_fee", 0.0)) if cost else 0.0)
            c["c_sewer"].append(float(cost.get("c_sewer", 0.0)) if cost else 0.0)
            c["cls"].append(cls)
            c["flags"].append(flags)
            parts = (cost or {}).get("parts", {})
            c["attrs"].append(
                [
                    rec.get("Parcel_ID") or "",
                    (rec.get("Situs_Address") or "").strip(),
                    dist,
                    int(rec.get("BuildingYear") or 0) if str(rec.get("BuildingYear") or "").isdigit() else 0,
                    float(rec.get("ImpSF") or 0),
                    rec.get("Classification_Code") or "",
                    round((cost or {}).get("revenue", 0.0)),
                    round((cost or {}).get("cost_total", 0.0)),
                    round((cost or {}).get("residents", 0.0), 1),
                    round((cost or {}).get("employees", 0.0), 1),
                    # cost breakdown, fixed order: frontage, people, residents, acres, parcels
                    [round(parts.get(k, 0.0)) for k in
                     ("frontage", "people", "residents", "acres", "parcels")],
                    # sewer, fixed order: estimated bill, local pipes, shared
                    [round((cost or {}).get(k, 0.0)) for k in
                     ("sewer_fee", "sewer_pipes", "sewer_shared")],
                ]
            )

    print(f"  vertices {vraw:,} -> {vtot:,} ({100 * vtot / vraw:.0f}% kept)")
    print(f"  rings/parcel {dict(sorted(ring_hist.items())[:5])}  dropped {dropped}")

    # ---- encode -------------------------------------------------------------
    order = sorted(cells)
    blocks = []
    directory = []
    attrs = []
    first_parcel = 0

    for key in order:
        c = cells[key]
        n = len(c["assessed"])
        coords = c["coords"]
        cminx = min(coords[0::2])
        cmaxx = max(coords[0::2])
        cminy = min(coords[1::2])
        cmaxy = max(coords[1::2])
        sx = max(cmaxx - cminx, 1e-6) / U16
        sy = max(cmaxy - cminy, 1e-6) / U16

        q = array.array("H", bytes(len(coords) * 2))
        for i in range(0, len(coords), 2):
            q[i] = int(round((coords[i] - cminx) / sx))
            q[i + 1] = int(round((coords[i + 1] - cminy) / sy))

        body = b"".join(
            [
                struct.pack("<II", len(c["ring_start"]) - 1, len(coords) // 2),
                c["parcel_ring_start"].tobytes(),
                c["ring_start"].tobytes(),
                q.tobytes(),
                c["assessed"].tobytes(),
                c["acres"].tobytes(),
                c["c_frontage_shared"].tobytes(),
                c["c_frontage_own"].tobytes(),
                c["c_people"].tobytes(),
                c["c_flat"].tobytes(),
                c["frontage"].tobytes(),
                c["sewer_fee"].tobytes(),
                c["c_sewer"].tobytes(),
                bytes(c["cls"]),
                bytes(c["flags"]),
            ]
        )
        pad = (-len(body)) % 4
        body += b"\0" * pad

        directory.append(
            struct.pack("<ddddIII", cminx, cminy, sx, sy, first_parcel, n, len(body))
        )
        blocks.append(body)
        attrs.extend(c["attrs"])
        first_parcel += n

    header = struct.pack(
        "<4sIIIdddd",
        b"OMRV",
        5,
        len(order),
        first_parcel,
        minx,
        miny,
        maxx,
        maxy,
    )
    blob = header + b"".join(directory) + b"".join(blocks)

    out_bin = os.path.join(OUTDIR, "parcels.bin")
    with open(out_bin, "wb") as f:
        f.write(blob)

    with open(os.path.join(OUTDIR, "attrs.json"), "w") as f:
        json.dump(attrs, f, separators=(",", ":"))

    total_assessed = sum(sum(cells[k]["assessed"]) for k in order)
    total_acres = sum(sum(cells[k]["acres"]) for k in order)
    manifest = {
        "tax_year": levies["tax_year"],
        "city_levy_per_100": levies["city_levy_per_100"],
        "parcels": first_parcel,
        "cells": len(order),
        "vertices": vtot,
        "bbox_merc": [minx, miny, maxx, maxy],
        "total_assessed": total_assessed,
        "total_acres": total_acres,
        "estimated_city_property_tax": total_assessed * city_levy,
        "class_names": CLASS_NAMES,
        "cost_model": cost_summary,
        "flags": {"tif": FLAG_TIF, "exempt": FLAG_EXEMPT},
        "sources": {
            "parcels": "Nebraska statewide parcel layer (gis.ne.gov)",
            "levies": levies["source"],
        },
    }
    with open(os.path.join(OUTDIR, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)

    print(f"\n{first_parcel:,} parcels in {len(order)} cells")
    print(f"  assessed  ${total_assessed / 1e9:.1f}B over {total_acres:,.0f} acres")
    print(f"  city tax  ${total_assessed * city_levy / 1e6:.1f}M")
    print(f"  binary    {len(blob) / 1e6:.1f} MB")


if __name__ == "__main__":
    sys.exit(main())
