# Omaha Revenue Map

A 3D fiscal-geography map of Omaha, Nebraska, in the spirit of Urban3's
Revenue Modeling. Every parcel the City of Omaha taxes is drawn at its true
footprint and extruded by how much value it carries per acre.

**Phases 1–3 complete.** Parcels above the ground plane pay more in city property
tax and sewer fees than the services and infrastructure allocated to them cost;
parcels below it do not. See [PLAN.md](PLAN.md) for the full plan.

## Run it

```sh
python3 -m http.server 8181
open http://127.0.0.1:8181/
```

Needs WebGL2. The committed build artifacts under `data/out/` are all it reads,
so no build step is required just to look at it.

Drag to pan · shift-drag (or right-drag) to orbit · scroll to zoom toward the
cursor · click a parcel to pin it · `/` to find an address or parcel ID · `r` to
reset the view · `?` for the legend notes. A pinned parcel shows its lot on the
county's 2025 aerial imagery (fetched live from dcgis.org), with links to its
assessor record, which has the assessor's photo, and to Google Street View.

The **cost basis** control at top right is the one worth playing with: it decides
which half of the city's books each parcel is judged against, and it changes the
map completely.

## Rebuild the data

```sh
python3 build/01_fetch.py        # ~2 min, 173 MB -> data/raw/parcels.ndjson
python3 build/02_levies.py       # -> config/levies.json
python3 build/04_fetch_infra.py  # ~3 min, streets + address points + sewer
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
*is* the product. Every dollar comes from the 2026 adopted budget; every
assumption lives in `config/` where it can be argued with.

**Cost basis.** Revenue is city property tax only, so the cost side must match
that scope. Property tax is just **21.9% of the General Fund** — the rest is
sales tax, restaurant tax and fees. Charging the whole $562.8M GF against
$246.2M of property tax would put every parcel underwater for arithmetic reasons
unrelated to land use. So each parcel is charged its share of *what property tax
actually buys*: GF appropriations scaled by 0.21931, plus the other three levy
funds at their statutory rates. The four funds reconcile to 43.994¢ — the same
rate joined from the NE DOR table — and the build fails if they stop matching.

| Allocator | Pot | Share | Driver |
|---|---|---|---|
| people | $145.6M | 59.1% | residents + employees (employees at 0.4×) |
| frontage | $58.2M | 23.6% | street frontage × neighbourhood-street renewal cost, plus a per-foot share of the through-road premium |
| parcels | $31.4M | 12.7% | flat per parcel |
| residents | $11.2M | 4.6% | residents only |

**Renewal liability.** $82.8M/yr of street replacement (cost per foot ÷ service
life), against the $126.6M the city already sets aside via the Street
Allocation Fund and street preservation bonds — so on these assumptions there is
**no unfunded street renewal**. The model used to report a $27.5M shortfall, but
that came entirely from adding $72M/yr of sewer pipe renewal while counting none
of the sewer fees that pay for it. Whether all $126.6M is really available for
rebuilding, rather than plowing and patching, is worth checking.

**Frontage** is measured without a spatial engine: a uniform grid over 221K
street edges plus point-segment distance. A parcel's frontage is the *span of
street its footprint covers*, not the length of its own boundary sitting near
the kerb — the first formulation counted side and rear lot lines and closed at
3.22× street length instead of ~2×. The current one closes at **1.86×** with a
median of **70 ft** per parcel, which is a normal Omaha lot. There is
deliberately no parallelism test: on a cul-de-sac the lot lines are radial to
the arc, and filtering on orientation would zero out exactly the parcels the
analysis is about.

**Cul-de-sacs** need their own rule. A centerline stops in the middle of the
bulb, so every point on a bulb lot's curved front projects onto the same spot —
the end of the line — and a span along the street measures zero. 4,857 houses
were charged nothing for streets that way. Beyond the 3,577 dead ends the model
now measures the angle a lot sweeps around the end of the line, times the
radius of its front: the length of its curved frontage. 8,961 parcels are
measured that way (median 36 ft), and parcels with no street within reach fall
from 6,805 to 3,660 (2.2%). Each foot of bulb frontage also adds half a foot of
street, because the bulb's pavement is not in the centerline either.

**Through roads.** Arterials and collectors carry traffic from across the city,
so the parcels lining one are charged what their frontage would cost as a
neighbourhood street. The premium for the bigger road — $22.7M of the $82.8M
renewal — is pooled and spread over every foot of frontage in the city. That
moves $11.7M/yr: 23,134 parcels on through roads pay less (median $190), and
138,613 others pay more (median $51). The **Share arterial cost citywide**
checkbox under the cost basis switches between this and charging each road's
full cost to its own frontage; both are built, and the citywide total is the
same either way. `network_share.enabled` in `config/assumptions.json` sets
which one the map opens on and which one `costs.ndjson` totals use.

**Sewer** is paid by sewer use fees, not property tax — the Sewer Revenue Fund is
an enterprise fund, and M.U.D. bills the fee on the City's behalf. So it is
counted on both sides. Income is each parcel's estimated 2026 bill: $46.34 a
month plus $3.958 per CCF, at 6 CCF a month per house (M.U.D.'s own sample),
4 per apartment, and 1 per modelled employee for everything else — $841 a year
for a house, $161.4M across the city (the budget's $231.9M also covers
customers outside it). Cost is the renewal of the local mains under the streets
a parcel fronts ($47.1M/yr, split by frontage like streets), plus a share of
everything else — treatment, trunk lines, the CSO program, operations — in
proportion to the bill. Sewer breaks even citywide by assumption, so it moves
money between parcels without changing the total. Pipes are priced by diameter
($100/ft + $12.50 per inch), because the layer's `LINE_TYPE` is not a size:
`Collector` mains are 8-inch, the smallest public pipe.

**Dwelling units** come from address points, except for the account types the
assessor calls multi-family, where two separate problems bite. DOGIS averages
only 2.8 address points across those parcels, so a 200-unit tower reads as three
dwellings; and `BLDG_SF` is the floor area of *building #1 only*, while 12% of
multi-family parcels have more than one building and one has 214 — a 37-acre
garden complex was reading as 35 units at $1.6M apiece. Multi-family units are
therefore `BLDG_SF × NUMBLDGS / 1250`. That lands at **213,641 dwellings against
a census count near 216,000 (99%)**, with multi-family at 32% of the stock.

**Household size is split by tenure** — 2.62 owner, 2.02 renter. The citywide
2.42 average overstated apartment population by ~17%, and with 59% of allocated
property-tax cost people-driven, that error landed squarely on the density
comparison.

## What the model says

49% of parcels are net-negative. Median net per acre by assessor account type:

| | median $/acre |
|---|---|
| Industrial | +$282 |
| Residential | +$235 |
| Commercial | −$280 |
| Apartments (Multiple Comm) | −$931 |
| Multi-family (Multiple Res) | −$878 |
| Exempt (government) | −$2,821 |

Downtown towers are strongly positive: 1601 Dodge St nets +$364K/yr, 1001 Cass
+$284K, 1917 S 67th +$293K.

## The cost-basis switch

The map has three bases, switchable in the browser with no rebuild — the cost
components are stored per parcel and recombined at render time.

A basis charges only some cost pots, so it credits only the slice of property
tax that funds them. Without that, "infrastructure only" would weigh every
parcel's whole tax bill against a quarter of the spending and show the entire
city comfortably in the black. Sewer is not property tax, so a basis that
includes it credits the sewer bill in full. Any street renewal liability is
deliberately left uncredited, so a shortfall would land on the infrastructure
basis — on current assumptions there is none.

| basis | credited revenue | cost | citywide net |
|---|---|---|---|
| Everything tax and sewer fees buy | $246.2M tax + $161.4M sewer | $407.8M | −$0.2M |
| Infrastructure only | $58.1M tax (23.6%) + $161.4M sewer | $219.6M | −$0.04M |
| Services only | $188.1M tax (76.4%) | $188.2M | −$0.1M |

All three balance by construction, so the map shows purely who pays more or
less than their share. Median net per acre under each:

| | full | infrastructure | services |
|---|---|---|---|
| industrial | +$282 | −$109 | +$604 |
| commercial | −$280 | −$402 | +$273 |
| single-family | +$235 | +$813 | −$208 |
| apartments | −$906 | **+$699** | −$1,349 |
| exempt (government) | −$2,821 | −$1,154 | −$1,055 |

**Read the apartment rows carefully — the cost basis, not density, is doing the
work.** Of the property-tax-funded cost, people-driven services are 59% and
streets 24%, so the full basis is closer to "people per acre versus value per
acre" than to "infrastructure per acre versus value per acre". Dividing a
per-capita cost by acres structurally penalises anything dense.

Switch to the infrastructure basis and apartments come out ahead of houses — in
aggregate +$1,295/acre against single-family's +$158. They use **9.3 ft of
street per resident against single-family's 40.8**, 4.4× less pavement and pipe
per person.

What pulls them negative on the full basis is revenue: an apartment unit is
assessed near half a house and uses less water, so it yields $347 per resident
($213 tax + $134 sewer) against a house's $799 ($457 + $342), while costing
$403 against $764.

## Data sources

| What | Where |
|---|---|
| Parcel geometry + assessed values | [Nebraska statewide parcel layer](https://gis.ne.gov/Enterprise/rest/services/StatewideParcelsExternal/FeatureServer/0) (open ArcGIS REST, no key) |
| Levy rates by tax district | [NE DOR consolidated tax districts, Douglas County](https://revenue.nebraska.gov/PAD/research-statistical-reports/consolidated-tax-districts-and-rates-county-reports) |
| City budget | 2026 Adopted Budget, recovered via the [Wayback Machine](https://web.archive.org/web/20260224042616/https://finance.cityofomaha.org/images/Finance/Budget/2026/2026_Adopted_Budget_Web.pdf) — cityofomaha.org returns 403 to scripted requests |
| Streets, sewer, address points | [DOGIS open data](https://data.dogis.org/) — 34,299 city-maintained street segments, 76,637 city sewer mains, 224,007 address points |

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
src/        lit-html shell, metric definitions and scales, address search
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

- **The cost side is a model, not a measurement.** Totals are pinned to the
  adopted budget, but the split between allocators is a modelling choice.
- **The people/frontage split is the dominant lever**, which is why it is a
  control rather than a constant. At 59/24 the full basis mostly measures
  population density against value; the infrastructure basis removes that and
  measures land use. Neither is more correct — they answer different questions,
  and the switch makes the difference visible instead of buried in a config file.
- **Replacement costs are industry ballparks**, flagged ESTIMATE in
  `assumptions.json`, not Omaha bid tabs. The renewal liability is a
  straight-line sinking-fund approximation, not a pavement management system.
- **Police and fire are allocated per capita.** Omaha publishes geocoded police
  incident data; allocating by actual calls for service would be better, and is
  in the same catalog already being fetched.
- **2.2% of parcels have no street within reach** and carry no frontage cost —
  landlocked, river, and interior parcels, and lots on private drives.
- **Sewer bills are estimated.** Water use per property is not public, so the
  bill uses 6 CCF a month per house, 4 per apartment and 1 per employee. Storm
  and sanitary mains are not distinguished in the source layer; both are
  counted.
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
- **Sales tax is excluded**, per the scoping decision. $265M of city revenue is
  unallocated, so retail parcels look worse than they do on the city's books.
- **Hover picking stalls the GPU** on `readPixels`. Fine at the 22 Hz throttle;
  if it ever matters, move to an async PBO readback.
