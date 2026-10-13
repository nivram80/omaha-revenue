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

  allocate  Each row of config/budget.csv is spread across parcels in
            proportion to that row's allocator, then scaled to the share of
            spending that property tax actually funds. Through roads are
            charged to their frontage at neighbourhood-street cost; the premium
            is shared over every foot of frontage in the city. Street cost is
            also written the other way - each road's full cost to its own
            frontage - so the map can switch between them.

  liability The street renewal the city does not budget for, less what it
            already sets aside. This is off-budget by definition, which is
            exactly why it belongs in the picture.

  sewer     Paid by sewer fees, not property tax, so counted on both sides: an
            estimated sewer bill as income, and a share of the system as cost -
            the local mains along the lot plus a flow-proportional share of
            everything else.

Output: data/interim/costs.ndjson, one row per parcel.
"""

import csv
import json
import math
import os
import sys
import time
from collections import defaultdict

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
        """Nearest street within reach, as (segment, distance along segment, bulb).

        Returning the arc position is what makes honest frontage possible: a
        parcel's frontage is the span of street its footprint covers, not the
        length of its own boundary that happens to sit near the kerb.

        bulb is None, or the (x, y) of a dead end the point lies beyond. Every
        such point projects to the same arc position - the end of the line - so
        the caller measures those by angle around the dead end instead.
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
                        best = (seg, arc + t * math.sqrt(den), bulb)
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


def pipe_rate(rec, cfg):
    """Annual renewal cost per foot of one sewer main, priced by diameter."""
    diameter = rec.get("LINE_HEIGHT_DIAMETER") or 0
    try:
        diameter = float(diameter)
    except (TypeError, ValueError):
        diameter = 0.0
    if diameter <= 0:
        diameter = cfg["default_diameter_in"].get(rec.get("LINE_TYPE"), 12)
    cost = cfg["cost_base_per_ft"] + cfg["cost_per_inch_diameter"] * diameter
    return cost / cfg["service_life_years"]


def load_streets(frame, cfg):
    """Street segments and their edges in the grid, with dead ends marked.

    Renewal cost is priced later, once cul-de-sac bulbs have been measured:
    the bulb's pavement is not in the centerline length.
    """
    offsets = cfg["max_offset_ft"]
    grid = EdgeGrid(cfg["grid_cell_ft"])
    seg_class, seg_len = [], []
    # Per segment: (first edge, its start point), (last edge, its end point)
    ends = []
    path = os.path.join(RAW, "streets.ndjson")

    with open(path) as f:
        for line in f:
            rec = json.loads(line)
            cls = rec.get("ROADCLASS") or "Local"
            off = offsets.get(cls, 60)
            seg = len(seg_class)
            total = 0.0
            first = last = None
            for part in rec["geom"]:
                pts = [frame(lon, lat) for lon, lat in part]
                for k in range(len(pts) - 1):
                    (ax, ay), (bx, by) = pts[k], pts[k + 1]
                    length = math.hypot(bx - ax, by - ay)
                    # Chop long edges so grid bins stay tight.
                    n = max(1, int(length // 200))
                    for j in range(n):
                        t0, t1 = j / n, (j + 1) / n
                        i = grid.add(ax + (bx - ax) * t0, ay + (by - ay) * t0,
                                     ax + (bx - ax) * t1, ay + (by - ay) * t1,
                                     seg, off, total + t0 * length)
                        if first is None:
                            first = (i, ax, ay)
                        last = (i, bx, by)
                    total += length
            seg_class.append(cls)
            seg_len.append(total)
            ends.append((first, last))

    # A dead end is a segment end no other street touches. Points beyond it
    # get the wider bulb reach and are measured around it, not along it.
    tol = cfg["dead_end_tolerance_ft"]
    reach = cfg["bulb_reach_ft"]
    dead = 0
    for seg, (first, last) in enumerate(ends):
        if first is None:
            continue
        for vertex, (i, x, y) in ((0, first), (1, last)):
            if not grid.touches(x, y, seg, tol):
                grid.dead[(i, vertex)] = max(reach, grid.edges[i][5])
                dead += 1
    return grid, seg_class, seg_len, dead


def load_sewer(frame, grid, cfg, n_segments):
    """Annual sewer pipe renewal: local mains charged to the street segment
    they run under, everything else into the shared pool.

    Trunk lines (interceptors, outfalls, force mains...) carry flow from whole
    basins, so the street they happen to run under is not who they serve.
    Local mains that are not under any street - rear-lot easements - cannot be
    attributed to a frontage either. Both are shared by flow.
    """
    trunk_types = set(cfg["trunk_types"])
    seg_sewer = [0.0] * n_segments
    trunk = 0.0
    unassigned = 0.0
    path = os.path.join(RAW, "sewer.ndjson")

    with open(path) as f:
        for line in f:
            rec = json.loads(line)
            rate = pipe_rate(rec, cfg)
            is_trunk = rec.get("LINE_TYPE") in trunk_types
            for part in rec["geom"]:
                pts = [frame(lon, lat) for lon, lat in part]
                for k in range(len(pts) - 1):
                    (ax, ay), (bx, by) = pts[k], pts[k + 1]
                    length = math.hypot(bx - ax, by - ay)
                    if length <= 0:
                        continue
                    if is_trunk:
                        trunk += length * rate
                        continue
                    hit = grid.nearest((ax + bx) / 2, (ay + by) / 2)
                    if hit is None:
                        unassigned += length * rate
                    else:
                        seg_sewer[hit[0]] += length * rate
    return seg_sewer, trunk, unassigned


# ---- main -------------------------------------------------------------------

def main():
    os.makedirs(INTERIM, exist_ok=True)
    assumptions, levies, budget_rows = load_config()
    frame = Frame(assumptions["projection"])
    gf = assumptions["general_fund"]
    liability = assumptions["capital_liability"]

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
    grid, seg_class, seg_len, dead_ends = load_streets(frame, assumptions["frontage"])
    print(f"  {len(seg_class):,} segments, {sum(seg_len)/5280:,.0f} centerline miles, "
          f"{len(grid.edges):,} indexed edges, {dead_ends:,} dead ends  "
          f"[{time.time()-t0:.0f}s]", flush=True)

    print("assigning sewer mains to streets", flush=True)
    seg_sewer, sewer_trunk, sewer_orphan = load_sewer(
        frame, grid, sewer_cfg["pipe"], len(seg_class))
    print(f"  ${sum(seg_sewer)/1e6:.1f}M/yr local main renewal placed, "
          f"${sewer_trunk/1e6:.1f}M/yr trunk lines and "
          f"${sewer_orphan/1e6:.1f}M/yr unplaced mains shared  "
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
    fees = sewer_cfg["fees"]
    use = sewer_cfg["usage_ccf_per_month"]

    parcels = []
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
            span = {}
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
                        seg, arc, bulb = hit
                        if bulb is not None:
                            dx, dy = x - bulb[0], y - bulb[1]
                            bulbs[(seg, bulb)].append(
                                (math.atan2(dy, dx), math.hypot(dx, dy)))
                            continue
                        lo, hi = span.get(seg, (arc, arc))
                        span[seg] = (min(lo, arc), max(hi, arc))

            hits = {}
            for seg, (lo, hi) in span.items():
                ft = min(hi - lo, seg_len[seg])
                if ft > 0:
                    hits[seg] = ft
            bulb_ft = 0.0
            for (seg, _), samples in bulbs.items():
                ft = bulb_frontage(samples, bulb_min_radius)
                if ft > 0:
                    hits[seg] = hits.get(seg, 0.0) + ft
                    seg_bulb[seg] += ft
                    bulb_ft += ft
            if bulb_ft > 0:
                on_bulb += 1
            frontage = sum(hits.values())
            if frontage <= 0:
                no_frontage += 1
            for seg, ft in hits.items():
                seg_front[seg] += ft

            pin = rec.get("Parcel_ID") or ""
            cls = CLASS_BY_TYPE.get((rec.get("Property_Parcel_Type") or "").strip(), "Other")
            account, bldg_sf, n_bldgs = acct.get(pin, ("", 0.0, 1.0))
            if bldg_sf <= 0:
                bldg_sf = float(rec.get("ImpSF") or 0)
            points = addr.get(pin, 0)

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
            if account in multi_accts and n_units > 0:
                accounts, ccf = n_bldgs, n_units * use["multi_family_unit"]
            elif n_units > 0:
                accounts, ccf = n_units, n_units * use["single_family_unit"]
            elif employees > 0:
                accounts, ccf = 1, employees * use["per_employee"]
            else:
                accounts, ccf = 0, 0.0
            sewer_fee = 12 * (accounts * fees["customer_charge_monthly"]
                              + ccf * fees["flow_charge_per_ccf"])

            parcels.append({
                "pin": pin,
                "account": account,
                "assessed": float(rec.get("Total_Assessed_Value") or 0),
                "acres": float(acres),
                "cls": cls,
                "units": n_units,
                "residents": residents,
                "employees": employees,
                "frontage_ft": frontage,
                "bulb_ft": bulb_ft,
                "hits": dict(hits),
                "sewer_fee": sewer_fee if sewer_cfg["enabled"] else 0.0,
            })

    print(f"  {len(parcels):,} parcels, {no_frontage:,} with no street within reach "
          f"({100*no_frontage/max(len(parcels),1):.1f}%), {on_bulb:,} measured around "
          f"a cul-de-sac or dead end  [{time.time()-t0:.0f}s]", flush=True)

    # ---- street and pipe cost per segment -----------------------------------
    # Bulb pavement is not in the centerline, so each foot of bulb frontage
    # adds bulb_centerline_share of a foot of street - the ratio of a street
    # with lots on both sides. Arterials and collectors then split in two: the
    # cost of the same length of neighbourhood street, charged to the parcels
    # that front it, and the premium for being a through road, pooled.
    street = liability["street"]
    cost_ft, life = street["replace_cost_per_ft"], street["service_life_years"]
    network = street["network_share"]
    local_cls = network["local_class"]
    local_rate = cost_ft[local_cls] / life[local_cls]
    bulb_share = assumptions["frontage"]["bulb_centerline_share"]
    seg_renewal, seg_local = [], []
    for s, cls in enumerate(seg_class):
        rate = cost_ft.get(cls, cost_ft[local_cls]) / life.get(cls, life[local_cls])
        length = seg_len[s] + bulb_share * seg_bulb.get(s, 0.0)
        seg_renewal.append(length * rate)
        seg_local.append(length * min(rate, local_rate))

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
    # Only streets that Omaha parcels actually front. The street layer covers
    # the whole county, so summing every segment would charge Omaha for Valley,
    # Waterloo and the SIDs.
    fronted = [s for s in seg_front if seg_front[s] > 0]
    premium_pool = sum(seg_renewal[s] - seg_local[s] for s in fronted)
    frontage_total = sum(p["frontage_ft"] for p in parcels)

    for p in parcels:
        p["residents"] *= calib
        p["people"] = p["residents"] + ew * p["employees"]
        # Frontage weight is the parcel's share of the renewal cost of the
        # streets it actually fronts. Shared: priced as neighbourhood streets,
        # plus a per-foot share of the through-road premium. Own: each road at
        # its full cost. network_share picks which one the totals use; both
        # are written out. Pipes are the same split, but stay in real dollars:
        # they are charged against sewer fees, not against a property-tax pot.
        shared = own = 0.0
        pipes = 0.0
        for seg, ft in p["hits"].items():
            share = ft / seg_front[seg]
            shared += seg_local[seg] * share
            own += seg_renewal[seg] * share
            pipes += seg_sewer[seg] * share
        if frontage_total > 0:
            shared += premium_pool * p["frontage_ft"] / frontage_total
        p["frontage_shared"] = shared
        p["frontage_own"] = own
        p["frontage_weight"] = shared if network["enabled"] else own
        p["sewer_pipes"] = pipes if sewer_cfg["enabled"] else 0.0

    # Sewer breaks even citywide: whatever the fees do not spend on the local
    # pipes in front of lots - treatment, trunk lines, unplaced mains, the CSO
    # program, operations - is shared in proportion to each parcel's bill.
    sewer_fees = sum(p["sewer_fee"] for p in parcels)
    sewer_located = sum(p["sewer_pipes"] for p in parcels)
    if sewer_cfg["enabled"] and sewer_located > sewer_fees:
        raise SystemExit(
            f"modelled sewer fees ${sewer_fees/1e6:.1f}M do not cover the local "
            f"pipes they are charged with (${sewer_located/1e6:.1f}M)"
        )
    shared_rate = (sewer_fees - sewer_located) / sewer_fees if sewer_fees > 0 else 0.0
    for p in parcels:
        p["sewer_shared"] = p["sewer_fee"] * shared_rate
        p["c_sewer"] = p["sewer_pipes"] + p["sewer_shared"]

    totals = {
        "frontage": sum(p["frontage_weight"] for p in parcels),
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
    service_buckets = defaultdict(float)
    for row in budget_rows:
        if row["unit"] == "dollars":
            amount = row["amount"] * gf_share
        else:
            # cents per $100 of assessed value: /100 for the rate, /100 again
            # for the per-$100 basis.
            amount = assessed_total * row["amount"] / 10000.0
        buckets[row["allocator"]] += amount
        service_buckets[row["allocator"]] += amount
    service_total = sum(buckets.values())

    # Streets only: sewer renewal is paid from sewer fees, and is in the sewer
    # accounting above.
    gross_liability = sum(seg_renewal[s] for s in fronted)
    fronted_miles = sum(seg_len[s] for s in fronted) / 5280

    liability_total = 0.0
    if liability["enabled"]:
        liability_total = max(0.0, gross_liability - liability["already_funded_annual"])
        buckets["frontage"] += liability_total

    for p in parcels:
        cost = 0.0
        parts = {}
        for allocator, pot in buckets.items():
            share = p.get(allocator + "_weight", p.get(allocator, 0.0))
            if allocator == "parcels":
                share = 1.0
            denom = totals[allocator]
            v = pot * (share / denom) if denom > 0 else 0.0
            parts[allocator] = v
            cost += v
        p["cost_total"] = cost
        p["cost_parts"] = parts
        # Four groups, because the cost-basis switch selects among them:
        #   frontage = streets and the street renewal liability
        #   people   = police, fire, parks, library - demand-driven
        #   flat     = general government and areal services
        #   sewer    = sewer system share, set against the sewer fee
        p["c_frontage"] = parts.get("frontage", 0.0)
        p["c_people"] = parts.get("people", 0.0) + parts.get("residents", 0.0)
        p["c_flat"] = parts.get("parcels", 0.0) + parts.get("acres", 0.0)
        p["revenue"] = p["assessed"] * city_levy
        p["net"] = p["revenue"] + p["sewer_fee"] - cost - p["c_sewer"]

    # The same street pot under both keys, for the map's through-road toggle.
    # Each sums to the pot, so switching moves cost between parcels without
    # changing any citywide total.
    for key in ("shared", "own"):
        denom = sum(p["frontage_" + key] for p in parcels)
        for p in parcels:
            p["c_frontage_" + key] = (
                buckets["frontage"] * p["frontage_" + key] / denom if denom > 0 else 0.0
            )

    # ---- report + write -----------------------------------------------------
    bulb_miles = sum(seg_bulb.values()) / 5280
    print()
    print(f"  streets fronted    {len(fronted):,} of {len(seg_class):,} segments, "
          f"{fronted_miles:,.0f} of {sum(seg_len)/5280:,.0f} centerline miles")
    print(f"  frontage closure   {frontage_total / (fronted_miles * 5280):.2f}x street "
          f"length (~2x is both kerbs); {bulb_miles:,.0f} miles of it around "
          f"dead ends")
    print(f"  through-road premium ${premium_pool/1e6:,.1f}M/yr of "
          f"${gross_liability/1e6:,.1f}M street renewal shared citywide"
          + ("" if network["enabled"] else " (disabled)"))
    print(f"  assessed           ${assessed_total/1e9:,.1f}B")
    print(f"  property tax       ${property_tax/1e6:,.1f}M")
    print(f"  service cost       ${service_total/1e6:,.1f}M  "
          f"(GF x {gf_share:.4f} + levy funds)")
    print(f"  street renewal     ${gross_liability/1e6:,.1f}M/yr gross, "
          f"${liability['already_funded_annual']/1e6:,.1f}M already funded, "
          f"${liability_total/1e6:,.1f}M unfunded")
    print(f"  total cost         ${(service_total+liability_total)/1e6:,.1f}M")
    print(f"  sewer fees         ${sewer_fees/1e6:,.1f}M modelled (budget: $231.9M "
          f"systemwide, incl. customers outside the city)")
    print(f"    local pipes      ${sewer_located/1e6:,.1f}M/yr charged by frontage")
    print(f"    shared by flow   ${(sewer_fees-sewer_located)/1e6:,.1f}M/yr  (trunk "
          f"${sewer_trunk/1e6:,.1f}M + unplaced ${sewer_orphan/1e6:,.1f}M renewal, "
          f"treatment, CSO, operations)")
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
                "c_people": round(p["c_people"], 2),
                "c_flat": round(p["c_flat"], 2),
                "c_sewer": round(p["c_sewer"], 2),
                "sewer_fee": round(p["sewer_fee"], 2),
                "sewer_pipes": round(p["sewer_pipes"], 2),
                "sewer_shared": round(p["sewer_shared"], 2),
                "frontage_ft": round(p["frontage_ft"], 1),
                "bulb_ft": round(p["bulb_ft"], 1),
                "units": p["units"],
                "residents": round(p["residents"], 2),
                "employees": round(p["employees"], 2),
                "revenue": round(p["revenue"], 2),
                "cost_total": round(p["cost_total"], 2),
                "net": round(p["net"], 2),
                "parts": {k: round(v, 2) for k, v in p["cost_parts"].items()},
            }, separators=(",", ":")) + "\n")

    # A basis charges only some pots, so it must credit only the slice of
    # property tax that funds them - otherwise "infrastructure only" would
    # compare every parcel's whole tax bill against a third of the spending and
    # show the entire city comfortably in the black. The credit fraction is the
    # selected share of SERVICE spending; the renewal liability is deliberately
    # left uncredited, which is what puts the shortfall on the infrastructure
    # basis where it belongs. Sewer is not property tax at all: a basis that
    # includes it credits the sewer fee in full against the sewer cost.
    svc_groups = {
        "frontage": service_buckets.get("frontage", 0.0),
        "people": service_buckets.get("people", 0.0) + service_buckets.get("residents", 0.0),
        "flat": service_buckets.get("parcels", 0.0) + service_buckets.get("acres", 0.0),
    }
    svc_all = sum(svc_groups.values()) or 1.0
    sewer_pot = ["sewer"] if sewer_cfg["enabled"] else []
    bases = {
        "full": {"pots": ["frontage", "people", "flat"] + sewer_pot},
        "infrastructure": {"pots": ["frontage"] + sewer_pot},
        "services": {"pots": ["people", "flat"]},
    }
    sewer_cost = sum(p["c_sewer"] for p in parcels)
    for name, b in bases.items():
        b["credit"] = sum(svc_groups[k] for k in b["pots"] if k != "sewer") / svc_all
        b["cost"] = sum(
            (buckets.get("frontage", 0.0) if k == "frontage" else
             (buckets.get("people", 0.0) + buckets.get("residents", 0.0)) if k == "people" else
             sewer_cost if k == "sewer" else
             (buckets.get("parcels", 0.0) + buckets.get("acres", 0.0)))
            for k in b["pots"]
        )
        b["tax_revenue"] = property_tax * b["credit"]
        b["sewer_revenue"] = sewer_fees if "sewer" in b["pots"] else 0.0
        b["revenue"] = b["tax_revenue"] + b["sewer_revenue"]
        b["net"] = b["revenue"] - b["cost"]

    print("\n  cost bases:")
    for name, b in bases.items():
        print("    %-15s credit %.3f of tax + $%5.1fM sewer fees  ->  $%6.1fM revenue "
              "vs $%6.1fM cost  net $%+7.1fM" % (
                  name, b["credit"], b["sewer_revenue"] / 1e6, b["revenue"] / 1e6,
                  b["cost"] / 1e6, b["net"] / 1e6))

    summary = {
        "bases": bases,
        "service_groups": svc_groups,
        "assessed_total": assessed_total,
        "property_tax": property_tax,
        "service_cost": service_total,
        "liability_gross": gross_liability,
        "liability_unfunded": liability_total,
        "gf_share": gf_share,
        "street_miles_fronted": fronted_miles,
        "street_miles_total": sum(seg_len) / 5280,
        "buckets": dict(buckets),
        "parcels": len(parcels),
        "no_frontage": no_frontage,
        "on_bulb": on_bulb,
        "frontage_closure": frontage_total / (fronted_miles * 5280),
        "network_premium": premium_pool,
        "network_share_enabled": network["enabled"],
        "sewer": {
            "enabled": sewer_cfg["enabled"],
            "fees": sewer_fees,
            "local_pipes": sewer_located,
            "shared": sewer_fees - sewer_located,
            "trunk_renewal": sewer_trunk,
            "unplaced_renewal": sewer_orphan,
        },
        "capital_liability_enabled": liability["enabled"],
    }
    with open(os.path.join(INTERIM, "cost_summary.json"), "w") as f:
        json.dump(summary, f, indent=1)
    print(f"\nwrote {out}  [{time.time()-t0:.0f}s]")


if __name__ == "__main__":
    sys.exit(main())
