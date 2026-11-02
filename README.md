# Omaha Revenue Map

A 3D fiscal-geography map of Omaha, Nebraska, in the spirit of Urban3's
Revenue Modeling. Every parcel the City of Omaha taxes is drawn at its true
footprint and extruded by how much value it carries per acre.

**Phases 1–3 complete.** Parcels above the ground plane pay more in city property
tax, sewer fees and street money than their streets, sewers and services cost;
parcels below it do not, and show red on the ground when seen from above. See
[PLAN.md](PLAN.md) for the full plan.

## Run it

```sh
python3 -m http.server 8181
open http://127.0.0.1:8181/
```

Needs WebGL2. The committed build artifacts under `data/out/` are all it reads,
so no build step is required just to look at it.

Drag to pan · shift-drag (or right-drag) to orbit · scroll to zoom toward the
cursor · click a parcel to pin it · `/` to find an address or parcel ID · `r` to
reset the view · `f` (or **Show losses on top**) to flip a net metric so losses
rise and gains hang below, with north still up · `?` for the legend notes. A pinned parcel shows its lot on the
county's 2025 aerial imagery (fetched live from dcgis.org), with links to its
assessor record, which has the assessor's photo, and to Google Street View.

The **cost basis** control at top right is the one worth playing with: it decides
which half of the city's books each parcel is judged against, and it changes the
map completely. The map opens on **Infrastructure only**: streets and sewers
against the tax, fees and street money that pay for them, leaving police, fire
and the other services out.

**Cost estimates**, in the title card, are for anyone who does not price streets
for a living: a Low / Typical / High switch for street pavement, bridges and
signals, sewer mains and sewer plants, and a switch for whether fuel, wheel and
sales tax count toward streets. Typical is the default. Each setting is just a
set of values in the detailed panel, defined in `config/parameters.json`.

**Balance sheet**, under the cost basis, is one year of the city's streets,
sewers and services as a statement: every cost and income line, worked down to
its inputs (lane-miles by street type, each budget line, each part of the sewer
system, each kind of sewer bill). It is priced live, so the cost estimate
switches and edits move it.

**Assumptions and sources**, under the cost basis, starts with a year of the
city's streets, sewers and services as cost and income bars, and a chart of how
far each switch moves the gap. Then it lists every number behind the costs, and
lets you edit any of them. Each column and value has an **i** beside it, on
hover, keyboard focus or tap, saying what it means, how it was worked out and
where it came from, with links; an orange **i** marks an estimate. Police, fire
and the other services are shown line by line from the budget, read-only. The
map re-prices all 165,615 parcels as you type; edits are kept in your browser
only. A pinned parcel's **How this is calculated** shows its own costs as
quantity × rate: lane-feet of street in front of it, feet of sewer main, its
sewer bill.

## Rebuild the data

```sh
python3 build/01_fetch.py        # ~2 min, 173 MB -> data/raw/parcels.ndjson
python3 build/02_levies.py       # -> config/levies.json
python3 build/04_fetch_infra.py  # ~3 min, streets, signals, address points, sewer, bridges
python3 build/05_costs.py        # ~60 s -> data/interim/costs.ndjson
python3 build/03_build.py        # ~5 s  -> data/out/*
```

`03_build.py` runs last: it folds the cost model into the binary, and works
without it (revenue-only map) if `05_costs.py` has not been run.

`01_fetch.py` is resumable — it records finished batches and skips them on a
re-run. Delete `data/raw/fetch_state.json` to start over.

## What it shows

| | |
|---|---|
| Parcels | 165,615 (163,601 in the six Omaha tax districts + 2,014 in TIF districts) |
| Assessed value | $56.0B |
| Modelled city property tax | **$246.2M** |
| Implied by the city's own budget | $246.6M — a **0.13%** gap |
| Tax year | 2025 (assessments as of 2025-12-31, payable 2026) |
| City of Omaha levy | 0.43994 per $100 |

That gap is the check that matters. The 2026 budget books $123,425,531 of
property tax to the General Fund, and the General levy is 22.022¢ of the 43.994¢
total — so the city's own documents imply $246.6M of total property tax. Summing
it parcel by parcel gives $246.2M.

## The cost model

No jurisdiction publishes infrastructure cost per property — building that model
*is* the product. Every assumption lives in `config/` where it can be argued
with.

**Two kinds of cost.** Streets and sewers are priced at what they cost to keep
up over their lives: rebuilding and resurfacing every street, renewing every
pipe, bridge, signal, plant and pump station, plus the city's actual day-to-day
upkeep. That does not depend on what the budget happens to spend, so the map can
show a gap. Police, fire, parks and general government are allocated from the
2026 adopted budget and balance by construction. All figures here are at the
Typical estimates.

| | $/yr | priced as | charged by |
|---|---|---|---|
| Street pavement | $205.8M | rebuild per lane-foot ÷ life, plus resurfacing ÷ interval | frontage |
| Street upkeep | $76.8M | 2026 operating spend: patching, snow, sweeping, signals, lights | frontage, per lane-foot |
| Bridges and signals | $16.2M | 142 city bridges at $280/sf over 75 yr; 972 signals at $400K over 30 yr | the street they sit on |
| Sewer mains along lots | $44.3M | half relined, half replaced by diameter over 75 yr, plus cleaning | frontage |
| Rest of the sewer system | $152.4M | large mains, trunks, plants, pump stations, CSO works, operations | sewer bill (flow) |
| Services | $188.2M | 2026 General Fund × the 21.9% property tax funds, plus levy funds | people, parcels |

Income is city property tax ($246.2M), estimated sewer bills ($157.2M), and
**street money that is not property tax** ($125.3M): the fuel and wheel taxes
in the Street Allocation Fund, and the 78% of the General Fund's street spending
that sales tax and other revenue pay for. No parcel pays that directly, so it
is credited to every street in proportion to its cost: it covers 41.9% of every
parcel's street bill.

**Streets** come from Public Works' own inventory (DOGIS
`Streets_For_Public_Works_CCSM`): 2,212 centerline miles, 5,064 lane-miles.
It carries lane counts, so everything is priced by the lane-foot — a six-lane
arterial costs three times a two-lane street, and divided roads, drawn once per
direction, are counted once.

| class | rebuild $/lane-ft | life (low – high cost) | resurface $/lane-ft (overlay / concrete) | interval (low – high cost) |
|---|---|---|---|---|
| Local | 270 | 60 yr (80 – 50) | 37 / 15 | 18 yr (20 – 15) |
| Collector | 320 | 55 yr (70 – 45) | 37 / 30 | 15 yr (17 – 13) |
| Minor arterial | 360 | 50 yr (60 – 40) | 37 / 60 | 10 yr (12 – 8) |
| Major arterial | 400 | 50 yr (60 – 40) | 37 / 60 | 10 yr (12 – 8) |

The anchors are Omaha's: the 2026 183rd & Wright concrete reconstruction bid
($452/ft for two lanes, plus 20% engineering), the 2026 CIP's 84th St
reconstruction ($1,770/ft for five lanes), the 2025 resurfacing program ($28.6M
for 150 lane-miles) and the city maintenance engineer's resurfacing intervals.
Collector and major-arterial rebuild costs and all the rebuild lives are
estimates; well-maintained city streets average 50–60 years before
reconstruction (Golden Valley, MN), and Omaha still runs 1950s–70s concrete. The
network's replacement value comes to $8.0B. Resurfacing alone
comes to $61.4M a year, close to the $75M the city said in 2019 it needed for
"250 lane miles every year". Unimproved and substandard streets carry upkeep but
no renewal, because their owners pay to bring them up to standard (OMC 26-47).
Sidewalks are not charged: abutting owners repair them (OMC 26-41 to 26-44).

**Bridges** are the 142 the city owns in the FHWA National Bridge Inventory
(1.13M sf of deck), at FHWA's 2025 Nebraska replacement cost of $280/sf over
AASHTO's 75-year design life. **Signals** are the 972 active ones in DOGIS, at
an estimated $400K per intersection ($150K for pedestrian signals and beacons)
over 30 years, Omaha's median age at rebuild. Both attach to the street they
sit on; signals to the biggest road at the intersection.

**Through roads.** Arterials and collectors carry traffic from across the city,
so the parcels lining one are charged what a two-lane neighbourhood street would
cost there. The premium — extra lanes, signals and bridges, $79.6M a year — is
pooled with $21.6M for city streets no parcel fronts (freeways, park roads,
bridge spans) and spread over every foot of frontage in the city, about $5.20 a
foot. The **Share arterial cost citywide** checkbox under the cost basis
switches between this and charging each road's full cost to its own frontage;
both are built, and the citywide total is the same either way.
`network_share.enabled` in `config/assumptions.json` sets which one the map
opens on.

**Frontage** is measured without a spatial engine: a uniform grid over 135K
street edges plus point-segment distance. A parcel's frontage is the *span of
street its footprint covers*, not the length of its own boundary sitting near
the kerb — the first formulation counted side and rear lot lines and closed at
3.22× street length instead of ~2×. The current one closes at **1.74×**, with a
median of **66 ft** for a house. There is deliberately no parallelism test: on
a cul-de-sac the lot lines are radial to the arc, and filtering on orientation
would zero out exactly the parcels the analysis is about. There is an
**occlusion test** instead: along each side of a street, a parcel fronts it
only where no other parcel sits more than 20 ft closer. Arterials reach 88–105 ft
for their wide rights-of-way, so without it the two lots behind a corner lot
were charged for its side street as well, each taking a third of it. A lot line
within 15 ft of a centerline hides nothing, because there the centerline is
drawn off the street (Sprague St near 96th runs ~40 ft into the north row).

**Cul-de-sacs** need their own rule. A centerline stops in the middle of the
bulb, so every point on a bulb lot's curved front projects onto the same spot —
the end of the line — and a span along the street measures zero; thousands of
houses were charged nothing for streets that way. Beyond the 2,394 dead ends
the model instead measures the angle a lot sweeps around the end of the line,
times the radius of its front: the length of its curved frontage. 7,589 parcels
are measured that way. Each foot of bulb frontage also adds half a foot of
street, because the bulb's pavement is not in the centerline either.

**Sewer** is paid by sewer use fees, not property tax — the Sewer Revenue Fund is
an enterprise fund, and M.U.D. bills the fee on the City's behalf. So it is
counted on both sides. Income is each parcel's estimated 2026 bill: $46.34 a
month plus $3.958 per CCF, at 6 CCF a month per house (M.U.D.'s own sample),
4 per apartment, and 1 per modelled employee for everything else — $841 a year
for a house, $157.2M across the city. Address points count as dwellings only
where the assessor has a building, so vacant lots and the land-only strips
beside row houses get no bill. Cost has two parts:

- *Mains along the lot* (18 inches and under): renewal is half lining from
  inside, at an estimated $12 per inch of diameter per foot over 50 years
  (Lawrence, KS paid about $4 an inch in 2019), and half open-cut replacement at
  $150 + $35 per inch per foot over 75 years (Carollo's 2024 unit cost study
  plus engineering; Omaha's design manual gives gravity pipe 50–100 years); plus
  cleaning and repair at the city's $16.2M a year spread per foot. Split by
  frontage like streets.
- *Everything else*, shared by bill: mains wider than 18 inches — a 72-inch storm
  drain under a side street drains a watershed, not the block — trunk lines,
  treatment plants ($1.6B replacement over 40 years), pump stations ($270M over
  33), the CSO storage basin and force main ($260M over 42), and $53.0M of
  operations. Omaha publishes no replacement values for plants, pump stations
  or CSO works, so those three are estimates from capacity and peer costs.
  Systemwide items are scaled to the city's share: modelled city fees over the
  $231.9M the system collects.

**The maintenance gap.** On the infrastructure basis, streets and sewers cost
$495.5M a year against $340.6M of income (the 23.6% of property tax that funds
them today, $157.2M of sewer fees and $125.3M of street money): **−$155M a
year**. That is not a bill that comes due: it is renewal the city would do if
every street and pipe were rebuilt when it wore out. In 2026 the city is
borrowing $83.5M for streets, repaid from future property tax and so not
counted as income. The rest is maintenance that is not happening.

The first version of this model showed −$355M. It counted only property tax and
sewer fees against streets, leaving out $125M a year of street money the city
does have, and priced the soft inputs at the expensive end: 40–50 year street
lives and no sewer lining. Those settings are still there, as High and
Street taxes: Left out (−$394M together).

**Editing it.** Values live in `config/assumptions.json`; their labels,
derivations and sources in `config/parameters.json`. `05_costs.py` measures
quantities (lane-feet by class and surface, bridge deck, signals, feet and
inch-feet of main, sewer-bill drivers) and `build/pricing.py` turns them into
dollars. Pricing is linear in the quantities, so the map ships them in
`data/out/model.bin` and `src/model.js` — a port of `pricing.py` — re-prices
in the browser. At the defaults it reproduces the build's totals.

**What moves it.** From Typical, one switch at a time:

| switch | Low | Typical | High |
|---|---|---|---|
| Street pavement | −$115M | −$155M | −$201M |
| Sewer mains | −$123M | −$155M | −$199M |
| Sewer plants | −$142M | −$155M | −$172M |
| Bridges and signals | −$152M | −$155M | −$161M |
| Street taxes (counted / left out) | | −$155M | −$280M |

Everything Low comes to **−$68M a year**; everything High, **−$268M**. No setting
the sources support closes the gap.

**Dwelling units** come from address points, except for the account types the
assessor calls multi-family, where two separate problems bite. DOGIS averages
only 2.8 address points across those parcels, so a 200-unit tower reads as three
dwellings; and `BLDG_SF` is the floor area of *building #1 only*, while 12% of
multi-family parcels have more than one building and one has 214 — a 37-acre
garden complex was reading as 35 units at $1.6M apiece. Multi-family units are
therefore `BLDG_SF × NUMBLDGS / 1250`. That lands at **208,559 dwellings against
a census count near 216,000 (97%)**, with multi-family at 33% of the stock.
Address points on parcels with no building (vacant lots, and the land-only
strips the county records beside row houses) are not dwellings; counting them
added 5,082 phantom homes with their own sewer bills.

**Household size is split by tenure** — 2.62 owner, 2.02 renter. The citywide
2.42 average overstated apartment population by ~17%, and with 59% of allocated
property-tax cost people-driven, that error landed squarely on the density
comparison.

## What the model says

85% of parcels are net-negative on the full basis at the Typical estimates.
Median net per acre by assessor account type:

| | median $/acre |
|---|---|
| Industrial | −$644 |
| Commercial | −$2,437 |
| Residential | −$3,253 |
| Apartments (Multiple Comm, Multiple Res) | −$4,861 |
| Exempt (government) | −$4,924 |

A typical house costs about $995 a year in streets and $985 in sewers, against
a $1,033 city tax bill, an $841 sewer bill and $417 of street money. Downtown
towers are strongly positive: 1601 Dodge St nets +$329K/yr, 1001 Cass +$262K,
1919 Aksarben Dr +$260K. (1917 S 67th St shows +$285K but sits in a TIF district,
so most of that tax goes to the redeveloper.)

## The cost-basis switch

The map has three bases, switchable in the browser with no rebuild — the cost
components are stored per parcel and recombined at render time.

A basis charges only some costs, so it credits only the slice of property tax
that funds them today: 23.6% for streets and sewers (Public Works plus their
share of debt service), 76.4% for services. Without that, "infrastructure only"
would weigh every parcel's whole tax bill against streets and sewers alone.
Sewer is not property tax, so a basis that includes it credits the sewer bill
in full; one that includes streets credits the street money that is not
property tax.

| basis | credited revenue | cost | citywide net |
|---|---|---|---|
| Everything tax and sewer fees buy | $246.2M tax + $157.2M sewer + $125.3M street money | $683.8M | −$155.0M |
| Infrastructure only | $58.1M tax (23.6%) + $157.2M sewer + $125.3M street money | $495.5M | −$154.9M |
| Services only | $188.1M tax (76.4%) | $188.2M | −$0.1M |

Services balance by construction; the whole gap is streets and sewers.
Median net per acre under each:

| | full | infrastructure | services |
|---|---|---|---|
| industrial | −$644 | −$1,380 | +$604 |
| commercial | −$2,437 | −$2,938 | +$273 |
| single-family | −$3,253 | −$2,622 | −$274 |
| apartments | −$4,861 | −$2,482 | −$1,417 |
| exempt (government) | −$4,924 | −$3,402 | −$1,055 |

**Per acre, density cuts both ways.** Apartments use **8.1 ft of street per
resident against single-family's 38.1**, so their streets and sewers cost $259
per resident against a house's $973. But an apartment unit is assessed near
half a house and uses less water, so it brings in $228 per resident on the
infrastructure basis against $677. In aggregate, apartments lose $899 an acre
on infrastructure and houses $2,507. On the services basis, where costs follow
people, the density penalty returns.

## Data sources

| What | Where |
|---|---|
| Parcel geometry + assessed values | [Nebraska statewide parcel layer](https://gis.ne.gov/Enterprise/rest/services/StatewideParcelsExternal/FeatureServer/0) (open ArcGIS REST, no key) |
| Levy rates by tax district | [NE DOR consolidated tax districts, Douglas County](https://revenue.nebraska.gov/PAD/research-statistical-reports/consolidated-tax-districts-and-rates-county-reports) |
| City budget | 2026 Adopted Budget, recovered via the [Wayback Machine](https://web.archive.org/web/20260224042616/https://finance.cityofomaha.org/images/Finance/Budget/2026/2026_Adopted_Budget_Web.pdf) — cityofomaha.org returns 403 to scripted requests |
| Streets, signals, sewer, address points | [DOGIS open data](https://data.dogis.org/) — Public Works' 24,406 street segments with lane counts, 972 active signals, 76,637 city sewer mains, 224,007 address points |
| Bridges | [FHWA National Bridge Inventory](https://www.fhwa.dot.gov/bridge/nbi/ascii.cfm), Nebraska 2025 — 142 city-owned structures |
| Unit costs | Omaha bid tabulations and council agendas, the 2026 CIP, FHWA bridge unit costs, Omaha's sewer design manual, peer studies — cited beside each value in `config/assumptions.json` |

Two things bite when joining these and are handled in the pipeline:

- **`TAXDIST` is unpadded** in the parcel layer (`'100'`) and zero-padded in the
  levy table (`'0100'`). Normalising only one side silently drops 110k parcels.
- **The parcel layer's native SR is EPSG:3857.** Web Mercator is ~33% off on
  distance at Omaha's latitude, so everything is fetched as EPSG:4326 and
  measurement never touches the native projection.

## How it is built

No npm, at runtime or build time. The build pipeline is Python 3 standard
library only; the app is raw WebGL2 with [lit-html](vendor/lit-html.js)
vendored as a single 7.5 KB ESM file for the UI.

```
build/      python pipeline: fetch -> join -> simplify -> quantise -> binary
src/gl/     WebGL2 renderer, orbit camera, GPU picking
src/workers/mesh.js   outline -> prism triangulation, off the main thread
src/data/   binary parser
src/        lit-html shell, metric definitions and scales, address search,
            model.js (re-pricing from edited assumptions)
vendor/     lit-html
data/out/   build artifacts the app loads
```

**Geometry.** 1.84M raw vertices simplify to 881K (Douglas-Peucker, 0.5 m
ground tolerance) and pack into a **7.5 MB** binary: outlines quantised to
uint16 within a 3 km spatial grid, 103 cells. Interior rings are bridged into
their outer ring at build time so the browser's triangulator can stay ~80 lines.

**Rendering.** A worker expands outlines into prisms — 2 vertices and 9 indices
per outline point, about 2.6M triangles — because shipping that triangulated
would be ~300 MB. One indexed draw call per cell. Height and colour are read
from an RG32F texture keyed by parcel index, so switching metric or scale is a
1.3 MB texture upload rather than a geometry rebuild. Hover picking renders
parcel ids to an R32UI target scissored to a single pixel.

**Scales.** Height and colour deliberately differ, because value per acre runs
from a $1.15M median to a $98M maximum:

- *Height* is a value scale (linear by default, so height reads directly as
  dollars; square root and logarithmic compress the 81× max-to-median ratio),
  normalised at the 99.9th percentile so one outlier cannot flatten the city.
- *Colour* is a quantile scale. On a value scale the median parcel lands at 64%
  of the ramp and the whole city reads as one shade. The legend labels the
  breaks, so the non-linearity is stated rather than hidden.

The palette is the validated default from the `dataviz` skill. Phase 3's
diverging pair (`#0fa87f` ↔ `#e0562e`) was chosen by running that skill's
validator: it clears CVD separation at ΔE 10.0, where the intuitive
green/magenta pairing scores 1.6 and fails outright.

## Known limits

- **The cost side is a model, not a measurement.** Street and sewer costs are
  straight-line lifecycle estimates — replacement value over life — not a
  pavement or asset management system. Services are pinned to the adopted
  budget, but the split between allocators is a modelling choice.
- **Unit costs rest on a handful of Omaha bids** and, for the treatment plants,
  pump stations and CSO works, on capacity and peer costs, because Omaha
  publishes no replacement values. Values marked ESTIMATE in `assumptions.json`
  are judgement, and the Low and High settings around them are ranges, not
  confidence intervals. Rebuild lives and how much sewer is relined move the
  total most; see *What moves it* above.
- **Police and fire are allocated per capita.** Omaha publishes geocoded police
  incident data; allocating by actual calls for service would be better, and is
  in the same catalog already being fetched.
- **3.8% of parcels have no city street within reach** and carry no street
  cost — landlocked, river, and interior parcels, and lots on private drives
  and on streets Public Works does not maintain.
- **Sewer bills are estimated.** Water use per property is not public, so the
  bill uses 6 CCF a month per house, 4 per apartment and 1 per employee. Storm
  and sanitary mains are not distinguished in the source layer; both are
  counted, and storm drains wider than 18 inches are shared by sewer bill,
  which tracks water use rather than runoff. Modelled fees reach $157.2M of the
  roughly $185M the city's customers likely pay (about 20% of the $231.9M
  system comes from outside the city), so the sewer side scales shared costs
  down to match.
- **Who pays for through roads is a choice.** Spreading the premium per foot of
  frontage is neutral on land use; spreading it by trips (people and jobs) or by
  value would move it toward denser or richer areas instead.
- **Per-acre views drop parcels under 0.01 acres.** Douglas County records condo
  units as near-zero-area parcels; the smallest is nine square feet, and dividing
  a routine flat charge by that yields −$4.8M/acre. They remain in the absolute
  metrics.
- **TIF parcels are shown at full value.** 2,014 parcels divert their increment
  to a redeveloper; per-parcel base value is not published. They are flagged in
  the inspector and the overstatement is called out there.
- **Exempt parcels** (5,729 of them, 21,175 acres — parks, schools, the airport,
  government) sit flat at zero. Correct, but it is a category difference, not a
  deficiency, and the UI says so.
- **Sales tax counts only where it pays for streets.** The rest, about $265M of
  city revenue, is unallocated per the scoping decision, so retail parcels look
  worse than they do on the city's books. Street money is credited pro rata to
  street cost; crediting it by residents and jobs instead, who pay fuel and
  wheel taxes, would favour denser areas.
- **Hover picking stalls the GPU** on `readPixels`. Fine at the 22 Hz throttle;
  if it ever matters, move to an async PBO readback.
