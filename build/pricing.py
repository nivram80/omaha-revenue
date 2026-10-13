"""Turn measured quantities into dollars.

05_costs.py measures what each parcel fronts and uses: lane-feet of street by
class and surface, bridge deck, traffic signals, feet and inch-feet of sewer
main, and what drives its sewer bill. This module prices those quantities from
config/assumptions.json. src/model.js is a line-for-line port, so the map can
re-price every parcel when a value is edited in the browser. Keep the two in
step; the build checks them against each other only through the totals.

Every price here is linear in the quantities, which is what makes the browser
re-pricing exact: a citywide pool is priced from its own quantity vector, the
city total less what parcels front, rather than from dollars.
"""

CLASSES = ("Local", "Collector", "Minor Arterial", "Major Arterial", "Freeway")
NC = len(CLASSES)
OV = 0             # overlay (asphalt) lane-feet, by class: OV + class index
CC = NC            # concrete lane-feet, by class
NONE = 2 * NC      # unimproved lane-feet: upkeep, no renewal
DECK = NONE + 1    # bridge deck, square feet
SIG_T = NONE + 2   # traffic signals
SIG_O = NONE + 3   # pedestrian signals, beacons and the like
NQ = NONE + 4
LANE_DIMS = tuple(range(NONE + 1))
ASSET_DIMS = (DECK, SIG_T, SIG_O)

USAGE = ("single_family_unit", "multi_family_unit", "per_employee")
MAIN_KINDS = ("big", "unfronted", "trunk", "off_street")


def get(A, path):
    """A value from assumptions.json by "/"-separated path. Item labels contain
    dots ("M.U.D."), so dots cannot separate."""
    v = A
    for k in path.split("/"):
        v = v[k]
    return v


def items_total(items):
    """Sum a {label: dollars} table, skipping "_" commentary keys."""
    return sum(v for k, v in items.items() if not k.startswith("_"))


# ---- streets ----------------------------------------------------------------

def street_rates(A, city_lane_ft):
    """Dollars a year per unit of each quantity dimension, as three vectors:
    pavement renewal, upkeep and assets. Upkeep is the city's operating spend
    spread over every lane-foot it maintains."""
    pave = [0.0] * NQ
    for i, c in enumerate(CLASSES):
        rebuild = (get(A, f"streets/reconstruct_per_lane_ft/{c}")
                   / get(A, f"streets/reconstruct_life_years/{c}"))
        interval = get(A, f"streets/resurface_interval_years/{c}")
        pave[OV + i] = rebuild + get(A, f"streets/resurface_per_lane_ft/overlay/{c}") / interval
        pave[CC + i] = rebuild + get(A, f"streets/resurface_per_lane_ft/concrete/{c}") / interval
    upkeep = items_total(get(A, "streets/upkeep/items")) / city_lane_ft if city_lane_ft else 0.0
    asset = [0.0] * NQ
    asset[DECK] = get(A, "streets/bridges/cost_per_sf") / get(A, "streets/bridges/life_years")
    life = get(A, "streets/signals/life_years")
    asset[SIG_T] = get(A, "streets/signals/replace_cost/TRAFFIC") / life
    asset[SIG_O] = get(A, "streets/signals/replace_cost/_default") / life
    return pave, upkeep, asset


def street_parts(q, rates):
    """(pavement, upkeep, bridges and signals) for a quantity vector."""
    pave, upkeep, asset = rates
    return (
        sum(q[k] * pave[k] for k in LANE_DIMS),
        upkeep * sum(q[k] for k in LANE_DIMS),
        sum(q[k] * asset[k] for k in ASSET_DIMS),
    )


def lane_ft(q):
    return sum(q[k] for k in LANE_DIMS)


# ---- sewer ------------------------------------------------------------------

def sewer_fee(A, accounts, ccf_count, kind):
    """Annual bill: a customer charge per account and a flow charge per CCF,
    where CCF is a count (units or employees) times a usage per month."""
    fees = "sewer/fees/"
    usage = get(A, f"sewer/usage_ccf_per_month/{USAGE[kind]}") if ccf_count else 0.0
    return 12 * (accounts * get(A, fees + "customer_charge_monthly")
                 + ccf_count * usage * get(A, fees + "flow_charge_per_ccf"))


def pipe_renewal(A, ft, ft_in):
    """Replacement of pipe over its life: base + per-inch x diameter, per foot,
    so a run of mains prices from its feet and its feet x inches."""
    p = "sewer/pipe/"
    return ((ft * get(A, p + "cost_base_per_ft") + ft_in * get(A, p + "cost_per_inch_diameter"))
            / get(A, p + "service_life_years"))


def cleaning_rate(A, total_ft):
    return items_total(get(A, "sewer/pipe_upkeep/items")) / total_ft if total_ft else 0.0


def facilities_total(A):
    return sum(v["replacement_value"] / v["life_years"]
               for k, v in get(A, "sewer/facilities/items").items() if not k.startswith("_"))


def sewer_pool(A, mains, fees_total):
    """What the shared sewer system costs the city a year, and its parts.

    Mains wider than local, and local mains under streets no lot fronts, are
    the city's own. Trunk lines, mains off the street grid, plants, pump
    stations, CSO works and operations serve the whole sewershed, so only the
    city's share is charged: city fees over systemwide fee revenue."""
    clean = cleaning_rate(A, mains["total_ft"])

    def run(kind):
        ft, ft_in = mains[kind + "_ft"], mains[kind + "_ft_in"]
        return pipe_renewal(A, ft, ft_in) + clean * ft

    in_city = fees_total / get(A, "sewer/fee_revenue_systemwide")
    parts = {
        "large_mains": run("big"),
        "unfronted_mains": run("unfronted"),
        "trunk_lines": in_city * run("trunk"),
        "mains_off_street": in_city * run("off_street"),
        "operations": in_city * items_total(get(A, "sewer/operations/items")),
        "facilities": in_city * facilities_total(A),
    }
    return sum(parts.values()), clean, in_city, parts
