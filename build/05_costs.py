#!/usr/bin/env python3
"""Allocate the City of Omaha's costs to parcels.

Four stages:

  frontage  Every parcel boundary is sampled and each sample attributed to the
            nearest city-maintained street centerline. No spatial engine: a
            uniform grid over street edges plus point-segment distance. See
            config/assumptions.json for why there is deliberately no
            parallelism test, and for how cul-de-sac bulbs are measured.

  demand    Address points per PIN give dwelling units; building square feet
            over a per-class intensity gives employees.

  streets   What the existing street network really costs a year, independent
            of what the budget spends on it: rebuilding and resurfacing every
            city street over its life, the city's actual day-to-day upkeep
            (patching, snow, sweeping, signals, lights) spread per square foot
            of pavement, and the replacement of bridges and signals. Through
            roads are charged to their frontage at neighbourhood-street cost;
            the premium is shared over every foot of frontage in the city.
            Street cost is also written the other way - each road's full cost
            to its own frontage - so the map can switch between them.

  sewer     The same for the sewer system: renewal and cleaning of the mains
            along each lot, plus a flow-proportional share of trunk lines,
            treatment plants, pump stations, the CSO works and operations.
            Set against an estimated sewer bill.

  services  Each police, fire, parks and general-government row of
            config/budget.csv is spread across parcels in proportion to its
            allocator, scaled to the share of spending property tax funds.

Output: data/interim/costs.ndjson, one row per parcel.
"""

import csv
import json
from array import array
import math
import os
import sys
import time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pricing  # noqa: E402
from pricing import (  # noqa: E402
    ASSET_DIMS, CC, DECK, NONE, NQ, OV, SIG_O, SIG_T, items_total,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
INTERIM = os.path.join(ROOT, "data", "interim")
CONFIG = os.path.join(ROOT, "config")

CLASS_BY_TYPE = {
    "01": "Residential", "02": "Recreational", "03": "Commercial",
    "04": "Industrial", "05": "Agricultural", "06": "Other", "07": "Other",
    "10": "Exempt", "11": "Exempt",
}


def load_config():
    with open(os.path.join(CONFIG, "assumptions.json")) as f:
        a = json.load(f)
    with open(os.path.join(CONFIG, "levies.json")) as f:
        lv = json.load(f)
    rows = []
    with open(os.path.join(CONFIG, "budget.csv")) as f:
        for row in csv.DictReader(l for l in f if not l.startswith("#")):
            row["amount"] = float(row["amount"])
            rows.append(row)
    return a, lv, rows


# ---- projection -------------------------------------------------------------

class Frame:
    """Local planar frame in feet. Conformal enough over a 30 km city."""

    def __init__(self, cfg):
        self.lat0 = cfg["origin_lat"]
        self.lon0 = cfg["origin_lon"]
        self.kx = cfg["ft_per_deg_lon"]
        self.ky = cfg["ft_per_deg_lat"]

    def __call__(self, lon, lat):
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)


# ---- geometry ---------------------------------------------------------------

def seg_distance2(px, py, ax, ay, bx, by):
    """Squared distance from a point to a segment."""
    dx, dy = bx - ax, by - ay
    den = dx * dx + dy * dy
    if den <= 0:
        return (px - ax) ** 2 + (py - ay) ** 2
    t = ((px - ax) * dx + (py - ay) * dy) / den
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    ex, ey = ax + t * dx - px, ay + t * dy - py
    return ex * ex + ey * ey


class EdgeGrid:
    """Uniform grid over street edges. Cheaper than an R-tree to build, and
    street edges are short and evenly spread, which is the case it suits."""

    def __init__(self, cell):
        self.cell = cell
        self.bins = defaultdict(list)
        # (ax, ay, bx, by, segment_index, max_offset, arc_at_a)
        # arc_at_a is distance along the whole segment to this edge's start, so
        # a match can be reported as a position *along the street*.
        self.edges = []
        # (edge_index, 0 or 1) -> reach, for an edge vertex that is a dead end:
        # 0 is the edge's a-vertex, 1 its b-vertex.
        self.dead = {}

    def add(self, ax, ay, bx, by, seg, offset, arc):
        i = len(self.edges)
        self.edges.append((ax, ay, bx, by, seg, offset, arc))
        c = self.cell
        x0, x1 = sorted((ax, bx))
        y0, y1 = sorted((ay, by))
        for gx in range(int(math.floor(x0 / c)), int(math.floor(x1 / c)) + 1):
            for gy in range(int(math.floor(y0 / c)), int(math.floor(y1 / c)) + 1):
                self.bins[(gx, gy)].append(i)
        return i

    def touches(self, px, py, seg, tol):
        """Whether any street other than seg passes within tol of a point."""
        c = self.cell
        gx, gy = int(math.floor(px / c)), int(math.floor(py / c))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in self.bins.get((gx + dx, gy + dy), ()):
                    ax, ay, bx, by, other, _, _ = self.edges[i]
                    if other != seg and seg_distance2(px, py, ax, ay, bx, by) <= tol * tol:
                        return True
        return False

    def nearest(self, px, py):
        """Nearest street within reach, as (segment, distance along segment,
        bulb, side, distance from the centerline).

        Returning the arc position is what makes honest frontage possible: a
        parcel's frontage is the span of street its footprint covers, not the
        length of its own boundary that happens to sit near the kerb.

        bulb is None, or the (x, y) of a dead end the point lies beyond. Every
        such point projects to the same arc position - the end of the line - so
        the caller measures those by angle around the dead end instead.

        side is +1 or -1 for which side of the street the point is on, so lots
        across the street from each other are never compared.
        """
        c = self.cell
        gx, gy = int(math.floor(px / c)), int(math.floor(py / c))
        best_d2, best = None, None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in self.bins.get((gx + dx, gy + dy), ()):
                    ax, ay, bx, by, seg, off, arc = self.edges[i]
                    ex, ey = bx - ax, by - ay
                    den = ex * ex + ey * ey
                    t = 0.0 if den <= 0 else ((px - ax) * ex + (py - ay) * ey) / den
                    end = None
                    if t <= 0:
                        t, end = 0.0, 0
                    elif t >= 1:
                        t, end = 1.0, 1
                    qx, qy = ax + t * ex - px, ay + t * ey - py
                    d2 = qx * qx + qy * qy
                    reach = self.dead.get((i, end)) if end is not None else None
                    if d2 > (reach or off) ** 2:
                        continue
                    if best_d2 is None or d2 < best_d2:
                        best_d2 = d2
                        bulb = None
                        if reach is not None:
                            bulb = (ax, ay) if end == 0 else (bx, by)
                        side = 1 if ex * (py - ay) - ey * (px - ax) >= 0 else -1
                        best = (seg, arc + t * math.sqrt(den), bulb, side, math.sqrt(d2))
        return best

    def nearest_segment(self, px, py, reach, rank):
        """Segment within reach with the highest rank(), nearest first among
        equals; rank None excludes a segment. Class offsets are ignored. Only
        the 3x3 block of cells is searched, so reach must not exceed the cell
        size."""
        c = self.cell
        gx, gy = int(math.floor(px / c)), int(math.floor(py / c))
        best_key, best = None, None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in self.bins.get((gx + dx, gy + dy), ()):
                    ax, ay, bx, by, seg, _, _ = self.edges[i]
                    r = rank(seg)
                    if r is None:
                        continue
                    d2 = seg_distance2(px, py, ax, ay, bx, by)
                    if d2 > reach * reach:
                        continue
                    key = (-r, d2)
                    if best_key is None or key < best_key:
                        best_key, best = key, seg
        return best


def bulb_frontage(points, min_radius):
    """Frontage around a dead end, from (angle, distance) samples about it.

    The angle a lot sweeps around the end of the centerline, times the radius of
    its nearest point, is the length of its curved front line. A pie-shaped
    bulb lot's side lines are radial, so they add distance but not angle and
    the sweep stays the width of the front.
    """
    if len(points) < 2:
        return 0.0
    angles = sorted(a for a, _ in points)
    gaps = [angles[k + 1] - angles[k] for k in range(len(angles) - 1)]
    gaps.append(angles[0] + 2 * math.pi - angles[-1])
    sweep = 2 * math.pi - max(gaps)
    return sweep * max(min(d for _, d in points), min_radius)


def pipe_diameter(rec, cfg):
    """A main's diameter in inches, or its type's median where it is missing."""
    diameter = rec.get("LINE_HEIGHT_DIAMETER") or 0
    try:
        diameter = float(diameter)
    except (TypeError, ValueError):
        diameter = 0.0
    if diameter <= 0:
        diameter = cfg["default_diameter_in"].get(rec.get("LINE_TYPE"), 12)
    return diameter


def load_streets(frame, cfg, st):
    """Public Works street segments and their edges in the grid, with dead ends
    marked.

    Renewal cost is priced later, once cul-de-sac bulbs have been measured:
    the bulb's pavement is not in the centerline length. Freeways are priced
    but kept out of the grid: no lot takes access from one, so none fronts it.
    """
    offsets = cfg["max_offset_ft"]
    class_map = st["class_map"]
    no_frontage = set(st["no_frontage_classes"])
    grid = EdgeGrid(cfg["grid_cell_ft"])
    seg = {"class": [], "len": [], "lanes": [], "surface": [], "city": []}
    # Per segment: (first edge, its start point), (last edge, its end point)
    ends = []
    path = os.path.join(RAW, "pw_streets.ndjson")

    with open(path) as f:
        for line in f:
            rec = json.loads(line)
            cls = class_map.get(rec.get("mapa_classification") or "", "Local")
            off = offsets.get(cls, 60)
            frontable = cls not in no_frontage
            i_seg = len(seg["class"])
            total = 0.0
            first = last = None
            for part in rec["geom"]:
                pts = [frame(lon, lat) for lon, lat in part]
                for k in range(len(pts) - 1):
                    (ax, ay), (bx, by) = pts[k], pts[k + 1]
                    length = math.hypot(bx - ax, by - ay)
                    # Chop long edges so grid bins stay tight.
                    n = max(1, int(length // 200))
                    for j in range(n if frontable else 0):
                        t0, t1 = j / n, (j + 1) / n
                        i = grid.add(ax + (bx - ax) * t0, ay + (by - ay) * t0,
                                     ax + (bx - ax) * t1, ay + (by - ay) * t1,
                                     i_seg, off, total + t0 * length)
                        if first is None:
                            first = (i, ax, ay)
                        last = (i, bx, by)
                    total += length
            seg["class"].append(cls)
            seg["len"].append(total)
            seg["lanes"].append(rec.get("lane_count") or rec.get("lanes_by_width")
                                or st["default_lanes"])
            seg["surface"].append(st["surface_kind"].get(rec.get("surface_type") or "", "overlay"))
            # Blank means maintained; only an explicit No is someone else's.
            seg["city"].append(rec.get("city_maintained") != "No")
            ends.append((first, last))

    # A dead end is a segment end no other street touches. Points beyond it
    # get the wider bulb reach and are measured around it, not along it.
    tol = cfg["dead_end_tolerance_ft"]
    reach = cfg["bulb_reach_ft"]
    dead = 0
    for s, (first, last) in enumerate(ends):
        if first is None:
            continue
        for vertex, (i, x, y) in ((0, first), (1, last)):
            if not grid.touches(x, y, s, tol):
                grid.dead[(i, vertex)] = max(reach, grid.edges[i][5])
                dead += 1
    return grid, seg, dead


def load_sewer(frame, grid, cfg, n_segments):
    """Sewer mains as feet and inch-feet (feet x diameter), which is all the
    pricing needs: local mains on the street segment they run under,
    everything else in shared lots.

    Trunk lines (interceptors, outfalls, force mains...) carry flow from whole
    basins, so the street they happen to run under is not who they serve. The
    same goes for any main wider than local_max_diameter_in: a 72-inch storm
    drain under a side street carries rain from a whole watershed. Mains not
    under any street - rear-lot easements - cannot be attributed to a frontage
    either. All of these are shared by flow.
    """
    trunk_types = set(cfg["trunk_types"])
    local_max = cfg["local_max_diameter_in"]
    local = ([0.0] * n_segments, [0.0] * n_segments)
    big = ([0.0] * n_segments, [0.0] * n_segments)
    shared = {"trunk": [0.0, 0.0], "off_street": [0.0, 0.0]}
    path = os.path.join(RAW, "sewer.ndjson")

    with open(path) as f:
        for line in f:
            rec = json.loads(line)
            diameter = pipe_diameter(rec, cfg)
            is_trunk = rec.get("LINE_TYPE") in trunk_types
            is_big = diameter > local_max
            for part in rec["geom"]:
                pts = [frame(lon, lat) for lon, lat in part]
                for k in range(len(pts) - 1):
                    (ax, ay), (bx, by) = pts[k], pts[k + 1]
                    length = math.hypot(bx - ax, by - ay)
                    if length <= 0:
                        continue
                    hit = None if is_trunk else grid.nearest((ax + bx) / 2, (ay + by) / 2)
                    if hit is None:
                        lot = shared["trunk" if is_trunk else "off_street"]
                        lot[0] += length
                        lot[1] += length * diameter
                        continue
                    ft, ft_in = big if is_big else local
                    ft[hit[0]] += length
                    ft_in[hit[0]] += length * diameter
    return local, big, shared


def load_points(name):
    """Point assets written by 04_fetch_infra.py, as dicts with lon and lat.
    Missing file means the layer was not fetched; the caller says so."""
    path = os.path.join(RAW, name)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return [json.loads(line) for line in f]


def main():
    os.makedirs(INTERIM, exist_ok=True)
    assumptions, levies, budget_rows = load_config()
    frame = Frame(assumptions["projection"])
    gf = assumptions["general_fund"]
    st = assumptions["streets"]

    # budget.csv must reconcile to the real levy or the cost basis is fiction.
    levy_cents = sum(r["amount"] for r in budget_rows if r["unit"] == "levy_cents")
    expect = gf["total_levy_cents"] - gf["levy_cents"]
    if abs(levy_cents - expect) > 1e-6:
        raise SystemExit(
            f"budget.csv levy_cents rows sum to {levy_cents}, expected {expect} "
            f"({gf['total_levy_cents']} total levy minus {gf['levy_cents']} general)"
        )

    keep = set(levies["omaha_districts"]) | set(levies["tif_districts"])
    city_levy = levies["city_levy_per_100"] / 100.0

    sewer_cfg = assumptions["sewer"]

    t0 = time.time()
    print("loading streets", flush=True)
    grid, segs, dead_ends = load_streets(frame, assumptions["frontage"], st)
    seg_class, seg_len = segs["class"], segs["len"]
    print(f"  {len(seg_class):,} segments, {sum(seg_len)/5280:,.0f} centerline miles, "
          f"{len(grid.edges):,} indexed edges, {dead_ends:,} dead ends  "
          f"[{time.time()-t0:.0f}s]", flush=True)

    print("assigning sewer mains to streets", flush=True)
    (seg_pipe_ft, seg_pipe_in), (seg_big_ft, seg_big_in), sewer_shared_runs = load_sewer(
        frame, grid, sewer_cfg["pipe"], len(seg_class))
    print(f"  {sum(seg_pipe_ft)/5280:,.0f} miles of local main placed, "
          f"{sum(seg_big_ft)/5280:,.0f} of large mains, "
          f"{sewer_shared_runs['trunk'][0]/5280:,.0f} of trunk lines and "
          f"{sewer_shared_runs['off_street'][0]/5280:,.0f} off the street grid  "
          f"[{time.time()-t0:.0f}s]", flush=True)

    print("counting address points", flush=True)
    addr = defaultdict(int)
    with open(os.path.join(RAW, "address_points.ndjson")) as f:
        for line in f:
            rec = json.loads(line)
            if rec.get("STATUS") == "Pending":
                continue
            if rec.get("POINTTYPE") in ("Utility Asset", "Other"):
                continue
            addr[rec["PIN"]] += 1

    # The assessor's own account type is the only reliable way to tell an
    # apartment tower from a house; the state layer's class code does not.
    acct = {}
    with open(os.path.join(RAW, "parcel_attrs.ndjson")) as f:
        for line in f:
            rec = json.loads(line)
            acct[rec.get("PIN")] = (
                (rec.get("DCAACCTYPE") or "").strip(),
                float(rec.get("BLDG_SF") or 0),
                max(float(rec.get("NUMBLDGS") or 0), 1.0),
            )
    print(f"  {len(addr):,} parcels with addresses, {len(acct):,} with account type "
          f"[{time.time()-t0:.0f}s]", flush=True)

    # ---- pass 1: frontage ---------------------------------------------------
    print("measuring frontage", flush=True)
    sample_ft = assumptions["frontage"]["sample_ft"]
    demand = assumptions["demand"]
    hh_owner = demand["household_size_owner"]
    hh_renter = demand["household_size_renter"]
    sf_emp = demand["sf_per_employee_by_account"]
    single_accts = set(demand["dwelling"]["single_family_accounts"])
    multi_accts = set(demand["dwelling"]["multi_family_accounts"])
    sf_per_dwelling = demand["dwelling"]["sf_per_dwelling"]
    bulb_min_radius = assumptions["frontage"]["bulb_min_radius_ft"]

    parcels = []
    # (segment, side) -> (arc, distance, parcel index) of every boundary sample
    # that reached a straight stretch of street.
    fronts = {}
    seg_front = defaultdict(float)
    seg_bulb = defaultdict(float)
    no_frontage = 0
    on_bulb = 0

    with open(os.path.join(RAW, "parcels.ndjson")) as f:
        for line in f:
            rec = json.loads(line)
            dist = (rec.get("TAXDIST") or "").strip().zfill(4)
            if dist not in keep:
                continue
            acres = rec.get("GIS_Acres") or 0
            if acres <= 0:
                continue

            # Track the span of each street the parcel's boundary reaches, not
            # the boundary length near it: a shallow lot's side lines also sit
            # within the offset, and counting them inflated total frontage to
            # 3.22x the street length (it should close at ~2x, both kerbs).
            # Samples along straight streets wait for the occlusion test after
            # this loop; dead ends are measured around the bulb here.
            pid = len(parcels)
            # Points beyond a dead end, as (angle, distance) about it.
            bulbs = defaultdict(list)
            for ring in rec["rings"]:
                pts = [frame(lon, lat) for lon, lat in ring]
                for k in range(len(pts) - 1):
                    (ax, ay), (bx, by) = pts[k], pts[k + 1]
                    length = math.hypot(bx - ax, by - ay)
                    if length <= 0:
                        continue
                    n = max(1, int(round(length / sample_ft)))
                    for j in range(n + 1):  # endpoints included
                        t = j / n
                        x, y = ax + (bx - ax) * t, ay + (by - ay) * t
                        hit = grid.nearest(x, y)
                        if hit is None:
                            continue
                        seg, arc, bulb, side, d = hit
                        if bulb is not None:
                            dx, dy = x - bulb[0], y - bulb[1]
                            bulbs[(seg, bulb)].append(
                                (math.atan2(dy, dx), math.hypot(dx, dy)))
                            continue
                        g = fronts.get((seg, side))
                        if g is None:
                            g = fronts[(seg, side)] = (array("d"), array("d"), array("l"))
                        g[0].append(arc)
                        g[1].append(d)
                        g[2].append(pid)

            hits = {}
            bulb_ft = 0.0
            for (seg, _), samples in bulbs.items():
                ft = bulb_frontage(samples, bulb_min_radius)
                if ft > 0:
                    hits[seg] = hits.get(seg, 0.0) + ft
                    seg_bulb[seg] += ft
                    bulb_ft += ft
            if bulb_ft > 0:
                on_bulb += 1

            pin = rec.get("Parcel_ID") or ""
            cls = CLASS_BY_TYPE.get((rec.get("Property_Parcel_Type") or "").strip(), "Other")
            account, bldg_sf, n_bldgs = acct.get(pin, ("", 0.0, 1.0))
            if bldg_sf <= 0:
                bldg_sf = float(rec.get("ImpSF") or 0)
            # Vacant lots carry address points too, and so do the land-only
            # strips beside row houses, so points count as dwellings only where
            # the assessor has a building. Otherwise a $1,900 strip beside a
            # townhouse reads as three homes with three sewer bills.
            built = bldg_sf > 0 or float(rec.get("Improvements_Value") or 0) > 0
            points = addr.get(pin, 0) if built else 0

            if account in single_accts:
                n_units = max(1, points) if (points or bldg_sf > 0) else 0
                residents = n_units * hh_owner
            elif account in multi_accts:
                # BLDG_SF is building #1 only, so scale by the building count.
                floor = bldg_sf * n_bldgs
                n_units = max(points, int(floor / sf_per_dwelling)) if floor > 0 else points
                residents = n_units * hh_renter
            else:
                n_units = 0
                residents = 0.0

            if n_units > 0:
                employees = 0.0
            else:
                per = sf_emp.get(account, sf_emp["_default"])
                employees = bldg_sf / per if bldg_sf > 0 else 0.0

            # Estimated annual sewer bill. Houses and duplexes are metered per
            # unit; a multi-family complex per building; anything else is one
            # account whose flow scales with the people working there. Exempt
            # institutions pay sewer fees too - a fee is not a tax.
            # ccf_kind indexes pricing.USAGE: house unit, apartment unit, employee.
            if account in multi_accts and n_units > 0:
                accounts, ccf_count, ccf_kind = n_bldgs, n_units, 1
            elif n_units > 0:
                accounts, ccf_count, ccf_kind = n_units, n_units, 0
            elif employees > 0:
                accounts, ccf_count, ccf_kind = 1, employees, 2
            else:
                accounts, ccf_count, ccf_kind = 0, 0.0, 0
            if not sewer_cfg["enabled"]:
                accounts, ccf_count = 0, 0.0

            parcels.append({
                "pin": pin,
                "account": account,
                "assessed": float(rec.get("Total_Assessed_Value") or 0),
                "acres": float(acres),
                "cls": cls,
                "units": n_units,
                "residents": residents,
                "employees": employees,
                "frontage_ft": 0.0,  # set by the occlusion test below
                "bulb_ft": bulb_ft,
                "hits": hits,
                "fee_accounts": float(accounts),
                "fee_ccf_count": float(ccf_count),
                "fee_ccf_kind": ccf_kind,
                "sewer_fee": pricing.sewer_fee(assumptions, accounts, ccf_count, ccf_kind),
            })

    # A parcel fronts a street only where no other parcel stands between it
    # and the street. Arterials reach 88-105 ft for their wide rights-of-way,
    # so without this the lots behind a corner lot - 75 ft back, with the corner
    # lot in between - were charged for the side street too, each taking a
    # share of it from the corner lot. Along each side of each street, a sample
    # counts only if no other parcel has one within occlude_window_ft of it
    # along the street that sits more than occlude_depth_ft closer. A lot line
    # nearer the centerline than occlude_min_ft would be in the pavement, so it
    # means the centerline is drawn off the street there: it hides nothing.
    window = assumptions["frontage"]["occlude_window_ft"]
    depth = assumptions["frontage"]["occlude_depth_ft"]
    floor = assumptions["frontage"]["occlude_min_ft"]
    spans = [{} for _ in parcels]
    samples = hidden = 0
    for (seg, _), (arcs, dists, pids) in fronts.items():
        order = sorted(range(len(arcs)), key=arcs.__getitem__)
        lo = 0
        for i in order:
            a, d, pid = arcs[i], dists[i], pids[i]
            samples += 1
            while arcs[order[lo]] < a - window:
                lo += 1
            j = lo
            behind = False
            while j < len(order) and arcs[order[j]] <= a + window:
                o = order[j]
                if pids[o] != pid and floor <= dists[o] < d - depth:
                    behind = True
                    break
                j += 1
            if behind:
                hidden += 1
                continue
            s0, s1 = spans[pid].get(seg, (a, a))
            spans[pid][seg] = (min(s0, a), max(s1, a))
    for p, span in zip(parcels, spans):
        for seg, (s0, s1) in span.items():
            ft = min(s1 - s0, seg_len[seg])
            if ft > 0:
                p["hits"][seg] = p["hits"].get(seg, 0.0) + ft
        p["frontage_ft"] = sum(p["hits"].values())
        if p["frontage_ft"] <= 0:
            no_frontage += 1
        for seg, ft in p["hits"].items():
            seg_front[seg] += ft
    print(f"  {hidden:,} of {samples:,} street samples sit behind another parcel", flush=True)

    print(f"  {len(parcels):,} parcels, {no_frontage:,} with no street within reach "
          f"({100*no_frontage/max(len(parcels),1):.1f}%), {on_bulb:,} measured around "
          f"a cul-de-sac or dead end  [{time.time()-t0:.0f}s]", flush=True)

    # ---- street quantities per segment --------------------------------------
    # Each city-maintained segment is measured, not priced: a vector of
    # lane-feet by class and surface, bridge deck and signals (pricing.py lays
    # it out). pricing.street_rates turns that into dollars - rebuild over life
    # plus resurfacing over interval, the city's actual upkeep per lane-foot,
    # and replacement over life for bridges and signals - so the map can
    # re-price it when a value is edited. Unimproved and substandard streets
    # are measured as upkeep only: their owners pay to bring them up to
    # standard. None of this is scaled to what the budget spends.
    #
    # Bulb pavement is not in the centerline, so each foot of bulb frontage
    # adds bulb_centerline_share of a foot of street - the ratio of a street
    # with lots on both sides. A city street nobody fronts (a freeway, a road
    # past a park, a bridge span) still costs the city, so it goes to a
    # citywide pool spread per foot of frontage. Arterials and collectors are
    # measured twice: as they are, and as the two-lane neighbourhood street of
    # the same length that the parcels lining them would otherwise need. The
    # difference is the through-road premium.
    n_seg = len(seg_class)
    network = st["network_share"]
    local_cls = network["local_class"]
    is_city = segs["city"]
    lanes = segs["lanes"]
    surface = segs["surface"]
    cls_index = {c: i for i, c in enumerate(pricing.CLASSES)}
    local_lanes = st["default_lanes"]
    bulb_share = assumptions["frontage"]["bulb_centerline_share"]

    def lane_vector(cls, kind, lane_feet, q):
        if kind == "none":
            q[NONE] += lane_feet
        else:
            q[(OV if kind == "overlay" else CC) + cls_index[cls]] += lane_feet

    seg_q = {}
    for s in range(n_seg):
        if not is_city[s]:
            continue
        q = [0.0] * NQ
        L = seg_len[s] + bulb_share * seg_bulb.get(s, 0.0)
        lane_vector(seg_class[s], surface[s], L * lanes[s], q)
        seg_q[s] = q

    # Bridges and signals snap to a city street within reach - signals to the
    # biggest road at the intersection, bridges to the nearest. One that finds
    # none is still the city's, and goes to the citywide pool.
    class_rank = {c: r for r, c in enumerate(st["class_rank"])}
    unplaced = [0.0] * NQ
    asset_counts = {}
    for kind in ("bridges", "signals"):
        acfg = st[kind]
        pts = load_points(acfg["file"])
        if pts is None:
            raise SystemExit(f"data/raw/{acfg['file']} missing: run build/04_fetch_infra.py")
        if kind == "signals":
            rank = lambda s: class_rank.get(seg_class[s], 0) if is_city[s] else None  # noqa: E731
        else:
            rank = lambda s: 0 if is_city[s] else None  # noqa: E731
        placed = 0
        for rec in pts:
            if kind == "bridges":
                dim, amount = DECK, rec["deck_sf"]
            else:
                dim, amount = (SIG_T if rec.get("type") == "TRAFFIC" else SIG_O), 1.0
            x, y = frame(rec["lon"], rec["lat"])
            s = grid.nearest_segment(x, y, acfg["snap_ft"], rank)
            if s is None:
                unplaced[dim] += amount
            else:
                seg_q[s][dim] += amount
                placed += 1
        asset_counts[kind] = {"count": len(pts), "placed": placed}
        print(f"  {kind:8s} {len(pts):,}, {100 * placed / max(len(pts), 1):.0f}% placed "
              f"on a city street", flush=True)

    # Through roads as the neighbourhood street their lots would need.
    seg_q_local = {}
    for s, q in seg_q.items():
        if seg_class[s] == local_cls:
            seg_q_local[s] = q
        else:
            ql = [0.0] * NQ
            L = seg_len[s] + bulb_share * seg_bulb.get(s, 0.0)
            lane_vector(local_cls, surface[s], L * min(lanes[s], local_lanes), ql)
            seg_q_local[s] = ql

    city_q = [sum(q[k] for q in seg_q.values()) + unplaced[k] for k in range(NQ)]
    city_lane_ft = pricing.lane_ft(city_q)
    rates = pricing.street_rates(assumptions, city_lane_ft)
    city_miles = sum(seg_len[s] for s in seg_q) / 5280
    unfronted_miles = sum(seg_len[s] for s in seg_q if seg_front.get(s, 0.0) <= 0) / 5280
    other_miles = sum(seg_len[s] for s in seg_front if seg_front[s] > 0 and not is_city[s]) / 5280
    print(f"  {city_lane_ft/5280:,.0f} city lane-miles; upkeep "
          f"${rates[1] * 5280:,.0f} per lane-mile a year", flush=True)

    # ---- weights ------------------------------------------------------------
    ew = demand["employee_service_weight"]
    raw_residents = sum(p["residents"] for p in parcels)
    target = demand["target_population"]
    calib = target / raw_residents if raw_residents > 0 else 1.0
    total_units = sum(p["units"] for p in parcels)
    mf_units = sum(p["units"] for p in parcels if p["account"] in multi_accts)
    census_units = demand["census_housing_units"]
    print(f"  dwelling units {total_units:,} vs census {census_units:,} "
          f"({100 * total_units / census_units:.0f}%); multi-family {mf_units:,} "
          f"({100 * mf_units / max(total_units, 1):.0f}%)", flush=True)
    print(f"  residents {raw_residents:,.0f} -> {target:,} (x{calib:.3f})", flush=True)
    frontage_total = sum(p["frontage_ft"] for p in parcels)

    for p in parcels:
        p["residents"] *= calib
        p["people"] = p["residents"] + ew * p["employees"]
        # Each parcel's share of what it fronts, by frontage, in two variants.
        # Own: each road as it is. Shared: each road as a neighbourhood street,
        # the premium going to the pool.
        own = [0.0] * NQ
        shared = [0.0] * NQ
        pipe_ft = pipe_in = 0.0
        for seg, ft in p["hits"].items():
            share = ft / seg_front[seg]
            pipe_ft += seg_pipe_ft[seg] * share
            pipe_in += seg_pipe_in[seg] * share
            if seg in seg_q:
                qo, ql = seg_q[seg], seg_q_local[seg]
                for k in range(NQ):
                    own[k] += qo[k] * share
                    shared[k] += ql[k] * share
        p["q_own"] = own
        p["q_shared"] = shared
        p["pipe_ft"] = pipe_ft if sewer_cfg["enabled"] else 0.0
        p["pipe_ft_in"] = pipe_in if sewer_cfg["enabled"] else 0.0

    # What the parcels do not front - unfronted streets, unplaced assets and,
    # when shared, the through-road premium - is priced from what is left of
    # the city's quantities and spread per foot of frontage.
    pools = {}
    for key in ("own", "shared"):
        rest = [city_q[k] - sum(p["q_" + key][k] for p in parcels) for k in range(NQ)]
        pools[key] = {"q": rest, "dollars": sum(pricing.street_parts(rest, rates))}
    premium_pool = pools["shared"]["dollars"] - pools["own"]["dollars"]
    for p in parcels:
        per_ft = p["frontage_ft"] / frontage_total if frontage_total > 0 else 0.0
        for key in ("own", "shared"):
            parts = list(pricing.street_parts(p["q_" + key], rates))
            p["streets_" + key] = parts + [pools[key]["dollars"] * per_ft]
        p["c_frontage_own"] = sum(p["streets_own"])
        p["c_frontage_shared"] = sum(p["streets_shared"])
        p["c_frontage"] = p["c_frontage_shared"] if network["enabled"] else p["c_frontage_own"]
    street_parts = pricing.street_parts(city_q, rates)

    # ---- sewer --------------------------------------------------------------
    # Mains along the lot are the parcel's own; everything else is shared in
    # proportion to each parcel's bill, i.e. its flow (pricing.sewer_pool).
    seg_fronted = [seg_front.get(s, 0.0) > 0 for s in range(n_seg)]
    mains = {
        "big_ft": sum(seg_big_ft), "big_ft_in": sum(seg_big_in),
        "unfronted_ft": sum(f for f, fr in zip(seg_pipe_ft, seg_fronted) if not fr),
        "unfronted_ft_in": sum(f for f, fr in zip(seg_pipe_in, seg_fronted) if not fr),
        "trunk_ft": sewer_shared_runs["trunk"][0], "trunk_ft_in": sewer_shared_runs["trunk"][1],
        "off_street_ft": sewer_shared_runs["off_street"][0],
        "off_street_ft_in": sewer_shared_runs["off_street"][1],
    }
    mains["total_ft"] = (sum(seg_pipe_ft) + mains["big_ft"] + mains["trunk_ft"]
                         + mains["off_street_ft"])
    sewer_fees = sum(p["sewer_fee"] for p in parcels)
    sewer_pool, clean_rate, in_city, sewer_pool_parts = pricing.sewer_pool(
        assumptions, mains, sewer_fees)
    for p in parcels:
        p["sewer_pipes"] = pricing.pipe_renewal(assumptions, p["pipe_ft"], p["pipe_ft_in"])
        p["sewer_pipe_upkeep"] = p["pipe_ft"] * clean_rate
        p["sewer_shared"] = sewer_pool * p["sewer_fee"] / sewer_fees if sewer_fees > 0 else 0.0
        p["c_sewer"] = p["sewer_pipes"] + p["sewer_pipe_upkeep"] + p["sewer_shared"]

    totals = {
        "people": sum(p["people"] for p in parcels),
        "residents": sum(p["residents"] for p in parcels),
        "acres": sum(p["acres"] for p in parcels),
        "parcels": float(len(parcels)),
    }
    assessed_total = sum(p["assessed"] for p in parcels)
    property_tax = assessed_total * city_levy

    # ---- allocate -----------------------------------------------------------
    gf_share = gf["property_tax_revenue"] / gf["total_appropriation"]
    buckets = defaultdict(float)
    for row in budget_rows:
        if row["unit"] == "dollars":
            amount = row["amount"] * gf_share
        else:
            # cents per $100 of assessed value: /100 for the rate, /100 again
            # for the per-$100 basis.
            amount = assessed_total * row["amount"] / 10000.0
        buckets[row["allocator"]] += amount
    service_buckets = dict(buckets)
    # The frontage rows - Public Works and the street and sewer share of debt
    # service - are what property tax puts into infrastructure today. They set
    # the infrastructure credit below; the cost charged is the lifecycle cost
    # above, not this.
    tax_to_infrastructure = buckets.pop("frontage", 0.0)
    service_total = sum(buckets.values())
    # Fuel and wheel taxes and the sales-tax share of General Fund street
    # spending pay the same share of every street's cost (pricing.street_credit).
    street_total = sum(p["c_frontage"] for p in parcels)
    street_credit = pricing.street_credit(assumptions, street_total)

    for p in parcels:
        parts = {"frontage": p["c_frontage"]}
        for allocator, pot in buckets.items():
            share = 1.0 if allocator == "parcels" else p.get(allocator, 0.0)
            denom = totals[allocator]
            parts[allocator] = pot * (share / denom) if denom > 0 else 0.0
        p["cost_parts"] = parts
        p["cost_total"] = sum(parts.values())
        # Four groups, because the cost-basis switch selects among them:
        #   frontage = streets: pavement, upkeep, bridges and signals
        #   people   = police, fire, parks, library - demand-driven
        #   flat     = general government and areal services
        #   sewer    = sewer system, set against the sewer fee
        p["c_people"] = parts.get("people", 0.0) + parts.get("residents", 0.0)
        p["c_flat"] = parts.get("parcels", 0.0) + parts.get("acres", 0.0)
        p["revenue"] = p["assessed"] * city_levy
        p["street_credit"] = street_credit * p["c_frontage"]
        p["net"] = (p["revenue"] + p["sewer_fee"] + p["street_credit"]
                    - p["cost_total"] - p["c_sewer"])

    # ---- report + write -----------------------------------------------------
    sewer_cost = sum(p["c_sewer"] for p in parcels)
    bulb_miles = sum(seg_bulb.values()) / 5280
    fronted_miles = sum(seg_len[s] for s in seg_q if seg_front.get(s, 0.0) > 0) / 5280
    print()
    print(f"  city streets       {city_miles:,.0f} centerline miles, {fronted_miles:,.0f} "
          f"fronted, {unfronted_miles:,.0f} fronted by no parcel (pooled); "
          f"{other_miles:,.0f} miles of non-city street fronted (not charged)")
    print(f"  frontage closure   {frontage_total / (fronted_miles * 5280):.2f}x street "
          f"length (~2x is both kerbs); {bulb_miles:,.0f} miles of it around dead ends")
    print(f"  streets            ${street_total/1e6:,.1f}M/yr: pavement "
          f"${street_parts[0]/1e6:,.1f}M, upkeep ${street_parts[1]/1e6:,.1f}M, "
          f"bridges and signals ${street_parts[2]/1e6:,.1f}M")
    print(f"    through-road premium ${premium_pool/1e6:,.1f}M, unfronted streets and "
          f"unplaced assets ${pools['own']['dollars']/1e6:,.1f}M"
          + ("" if network["enabled"] else "  (premium not shared)"))
    print(f"  sewer              ${sewer_cost/1e6:,.1f}M/yr: mains along lots "
          f"${sum(p['sewer_pipes'] for p in parcels)/1e6:,.1f}M renewal + "
          f"${sum(p['sewer_pipe_upkeep'] for p in parcels)/1e6:,.1f}M cleaning, "
          f"shared ${sewer_pool/1e6:,.1f}M")
    print(f"    shared, city share {in_city:.3f} where systemwide: " + ", ".join(
        f"{k} ${v/1e6:,.1f}M" for k, v in sewer_pool_parts.items()))
    print(f"  sewer fees         ${sewer_fees/1e6:,.1f}M modelled (budget: "
          f"${sewer_cfg['fee_revenue_systemwide']/1e6:,.1f}M systemwide)")
    print(f"  assessed           ${assessed_total/1e9:,.1f}B")
    print(f"  property tax       ${property_tax/1e6:,.1f}M, of which "
          f"${tax_to_infrastructure/1e6:,.1f}M funds infrastructure")
    print(f"  other street money ${street_credit * street_total/1e6:,.1f}M: "
          f"{100 * street_credit:.1f}% of every street's cost")
    print(f"  service cost       ${service_total/1e6:,.1f}M  "
          f"(GF x {gf_share:.4f} + levy funds)")
    print(f"  citywide net       ${sum(p['net'] for p in parcels)/1e6:,.1f}M")
    print(f"  residents modelled {totals['residents']:,.0f}  "
          f"employees {sum(p['employees'] for p in parcels):,.0f}")
    neg = sum(1 for p in parcels if p["net"] < 0)
    print(f"  parcels net-negative {neg:,} of {len(parcels):,} "
          f"({100*neg/len(parcels):.1f}%)")

    out = os.path.join(INTERIM, "costs.ndjson")
    with open(out, "w") as f:
        for p in parcels:
            f.write(json.dumps({
                "pin": p["pin"],
                "c_frontage": round(p["c_frontage"], 2),
                "c_frontage_shared": round(p["c_frontage_shared"], 2),
                "c_frontage_own": round(p["c_frontage_own"], 2),
                "streets_shared": [round(v, 2) for v in p["streets_shared"]],
                "streets_own": [round(v, 2) for v in p["streets_own"]],
                "c_people": round(p["c_people"], 2),
                "c_flat": round(p["c_flat"], 2),
                "c_sewer": round(p["c_sewer"], 2),
                "sewer_fee": round(p["sewer_fee"], 2),
                "sewer_pipes": round(p["sewer_pipes"], 2),
                "sewer_pipe_upkeep": round(p["sewer_pipe_upkeep"], 2),
                "sewer_shared": round(p["sewer_shared"], 2),
                # Quantities, for re-pricing in the browser (pricing.py).
                "q_own": [round(v, 2) for v in p["q_own"]],
                "q_shared": [round(v, 2) for v in p["q_shared"]],
                "pipe_ft": round(p["pipe_ft"], 2),
                "pipe_ft_in": round(p["pipe_ft_in"], 1),
                "fee_accounts": p["fee_accounts"],
                "fee_ccf_count": round(p["fee_ccf_count"], 3),
                "fee_ccf_kind": p["fee_ccf_kind"],
                "frontage_ft": round(p["frontage_ft"], 1),
                "bulb_ft": round(p["bulb_ft"], 1),
                "units": p["units"],
                "residents": round(p["residents"], 2),
                "employees": round(p["employees"], 2),
                "revenue": round(p["revenue"], 2),
                "street_credit": round(p["street_credit"], 2),
                "cost_total": round(p["cost_total"], 2),
                "net": round(p["net"], 2),
                "parts": {k: round(v, 2) for k, v in p["cost_parts"].items()},
            }, separators=(",", ":")) + "\n")

    # A basis charges only some costs, so it credits only the slice of
    # property tax that funds them - otherwise "infrastructure only" would
    # weigh every parcel's whole tax bill against streets and sewers alone.
    # The credit is the share of property-tax spending that goes to each
    # group today. Services cost exactly what property tax gives them, so that
    # basis balances; streets and sewers cost what they cost, so any gap shows
    # up on the bases that include them. Sewer is not property tax: a basis
    # that includes it credits the sewer bill in full, and one that includes
    # streets credits the street money that is not property tax.
    svc_groups = {
        "frontage": service_buckets.get("frontage", 0.0),
        "people": service_buckets.get("people", 0.0) + service_buckets.get("residents", 0.0),
        "flat": service_buckets.get("parcels", 0.0) + service_buckets.get("acres", 0.0),
    }
    svc_all = sum(svc_groups.values()) or 1.0
    pot_cost = {
        "frontage": street_total,
        "people": svc_groups["people"],
        "flat": svc_groups["flat"],
        "sewer": sewer_cost,
    }
    sewer_pot = ["sewer"] if sewer_cfg["enabled"] else []
    bases = {
        "full": {"pots": ["frontage", "people", "flat"] + sewer_pot},
        "infrastructure": {"pots": ["frontage"] + sewer_pot},
        "services": {"pots": ["people", "flat"]},
    }
    for name, b in bases.items():
        b["credit"] = sum(svc_groups[k] for k in b["pots"] if k != "sewer") / svc_all
        b["cost"] = sum(pot_cost[k] for k in b["pots"])
        b["tax_revenue"] = property_tax * b["credit"]
        b["sewer_revenue"] = sewer_fees if "sewer" in b["pots"] else 0.0
        b["street_revenue"] = street_credit * street_total if "frontage" in b["pots"] else 0.0
        b["revenue"] = b["tax_revenue"] + b["sewer_revenue"] + b["street_revenue"]
        b["net"] = b["revenue"] - b["cost"]

    print("\n  cost bases:")
    for name, b in bases.items():
        print("    %-15s credit %.3f of tax + $%5.1fM sewer fees + $%5.1fM street money"
              "  ->  $%6.1fM revenue vs $%6.1fM cost  net $%+7.1fM" % (
                  name, b["credit"], b["sewer_revenue"] / 1e6, b["street_revenue"] / 1e6,
                  b["revenue"] / 1e6, b["cost"] / 1e6, b["net"] / 1e6))
    summary = {
        "bases": bases,
        "service_groups": svc_groups,
        "assessed_total": assessed_total,
        "property_tax": property_tax,
        "service_cost": service_total,
        "gf_share": gf_share,
        "parcels": len(parcels),
        "no_frontage": no_frontage,
        "on_bulb": on_bulb,
        "frontage_closure": frontage_total / (fronted_miles * 5280),
        "network_premium": premium_pool,
        "network_share_enabled": network["enabled"],
        "streets": {
            "total": street_total,
            "pavement": street_parts[0],
            "upkeep": street_parts[1],
            "bridges_signals": street_parts[2],
            "assets": asset_counts,
            "citywide_pool": pools["own"]["dollars"],
            "city_miles": city_miles,
            "fronted_miles": fronted_miles,
            "unfronted_miles": unfronted_miles,
            "tax_credited": tax_to_infrastructure,
            # Street money that is not property tax, credited pro rata to
            # every street's cost.
            "other_funding": items_total(st["other_street_funding"]["items"]),
            "credit_share": street_credit,
        },
        "sewer": {
            "enabled": sewer_cfg["enabled"],
            "fees": sewer_fees,
            "cost": sewer_cost,
            "local_pipes": sum(p["sewer_pipes"] for p in parcels),
            "local_upkeep": sum(p["sewer_pipe_upkeep"] for p in parcels),
            "shared": sewer_pool,
            "in_city_share": in_city,
            "pool_parts": sewer_pool_parts,
        },
        # Everything the map needs to re-price the city from edited values,
        # beside each parcel's own quantities (src/model.js). check is what
        # the re-pricing must reproduce at the default values.
        "model": {
            "frontage_total": frontage_total,
            "city_q": city_q,
            "pool_q": {k: v["q"] for k, v in pools.items()},
            "mains": mains,
            "check": {
                "streets_own": sum(p["c_frontage_own"] for p in parcels),
                "streets_shared": sum(p["c_frontage_shared"] for p in parcels),
                "sewer": sewer_cost,
                "fees": sewer_fees,
            },
        },
    }
    with open(os.path.join(INTERIM, "cost_summary.json"), "w") as f:
        json.dump(summary, f, indent=1)
    print(f"\nwrote {out}  [{time.time()-t0:.0f}s]")


if __name__ == "__main__":
    sys.exit(main())
