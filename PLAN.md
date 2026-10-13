# Omaha Revenue Map — Build Plan

A 3D fiscal-geography map of Omaha, NE, in the spirit of Urban3's Revenue Modeling
("Economic MRI"). Each parcel is extruded as a prism whose signed height is the
**net annual dollars per acre** the parcel returns to the City of Omaha:

- **Up, green** — parcel generates more city revenue than it consumes in allocated city cost.
- **Down, red** — parcel consumes more than it generates; the rest of the city subsidizes it.

Scope decisions (locked):

| Decision | Choice |
|---|---|
| Revenue | City of Omaha only (0.43994 / $100 levy) |
| Height metric | Net dollars **per acre** |
| Extent | Omaha city limits only |
| Cost model | Full frontage-based allocation |

Stack: vendored lit-html + raw WebGL2 + raw CSS. **No npm at runtime or build time.**
Build pipeline is Python 3 (stdlib) + the DuckDB CLI with its spatial extension
(single binary, no package manager).

---

## 1. Data sources (all verified live, 2026-09-22)

### 1.1 Parcels + assessed values — Nebraska statewide parcel layer

```
https://gis.ne.gov/Enterprise/rest/services/StatewideParcelsExternal/FeatureServer/0
```

Open ArcGIS REST, no key. `maxRecordCount=2000`, `supportsPagination=true`.

| Fact | Value |
|---|---|
| Douglas County (`County_ID='055'`) | 216,651 parcels |
| Omaha city tax districts | 163,601 parcels · 85,688 ac · $53.6B assessed |
| Omaha TIF districts | 2,014 parcels · $2.4B assessed |
| Exempt / $0 value inside Omaha | 5,729 parcels · 21,175 ac |
| Assessment vintage | `CAMAUpdate` = 2025-12-31 (TY2025 → 2026 bills) |

Fields used: `Parcel_ID`, `Total_Assessed_Value`, `Land_Value`, `Improvements_Value`,
`GIS_Acres`, `Classification_Code` (NE PAD 12-digit), `Property_Parcel_Type`,
`Property_SubClass`, `TAXDIST`, `Zoning`, `ImpSF`, `BuildingYear`, `Sales_Date`,
`Sales_Value`, + polygon geometry.

**Gotcha — `TAXDIST` is not zero-padded.** Values come back as `'100'`, `'1730'`.
The levy table uses `'0100'`, `'1730'`. Zero-pad to 4 on the join.

**Gotcha — native SR is EPSG:3857.** Web Mercator at lat 41.26 has a ~1.33× scale
distortion, so areas and lengths computed in it are wrong. The pipeline requests
`outSR=4326` and treats lon/lat as the canonical store: Web Mercator for
rendering is a five-line closed form from it, and phase 2's frontage work
projects to a planar frame at that point. (An earlier draft of this plan called
for fetching in EPSG:26852 directly; 4326 turned out simpler and keeps one
canonical geometry rather than two.)

### 1.2 Levy rates — NE Dept of Revenue Consolidated Tax Districts

```
https://revenue.nebraska.gov/sites/default/files/doc/pad/research/valuation/2026/Excel/28Douglas.xlsx
```

TY2025, 6,578 rows, one per (tax district × subfund). Parse with `zipfile` +
`xml.etree` — no openpyxl needed. Columns: `TAX_DIST`, `FUND_NAME_DESC`,
`SUBFUND_DESCRIPTION`, `SUBFUND_LEVY`, `FUND_TOTAL`, `CONSOLIDATED_LEVY_RATE`.

**City of Omaha levy = 0.43994 per $100** (`OMAHA CITY GENERAL` 0.22622 +
`OMAHA CITY BOND` 0.21372), identical in all six Omaha districts.

| District | School | Consolidated levy | Parcels | Assessed |
|---|---|---|---|---|
| 0100 | OPS 001 | 2.05683 | 110,409 | $29.23B |
| 1730 | Elkhorn 010 | 2.01671 | 29,422 | $11.86B |
| 6600 | Westside 066 | 2.00103 | 10,954 | $4.98B |
| 1001 | Millard 017 | 1.87798 | 8,954 | $5.55B |
| 5403 | Ralston 054 | 2.08086 | 3,380 | $1.75B |
| 5945 | Bennington 059 | 2.28471 | — | — |

Omaha city is only ~21% of a typical bill; OPS is ~55%. That ratio is worth
surfacing in the UI — it is the reason a "city subsidy" framing surprises people.

**Validation:** $53.6B × 0.0043994 = **$235.7M** vs. the City's budgeted
$244.6M property tax revenue. Including the TIF districts, as the built
pipeline does, the total is $56.0B → **$246.2M**, a 0.7% gap. Model confirmed.

### 1.3 TIF districts

288 `REDEVELOP OMAHA nnn` consolidated districts (codes in the 2200–2600 range),
2,014 parcels, $2.4B assessed. These parcels are physically inside Omaha and
**must be included in the extract** or downtown will have holes.

Their increment above base value is diverted to the redeveloper, not the city, for
up to 15 years. Per-parcel base value is not published. Handling:

- v1: include at full value, flag `is_tif=true`, show a UI toggle that renders them
  hatched with a "TIF — city revenue overstated" note in the inspector.
- Refinement: NE DOR publishes a statewide TIF annual report with base and excess
  value **per project**; apportion project base across its parcels by current-value
  share. Optional phase 4 work.

### 1.4 Infrastructure geometry — DOGIS (Douglas-Omaha GIS)

Catalog: `https://data.dogis.org/api/feed/dcat-us/1.1.json` (109 datasets).
Service root: `https://dcgis.org/server/rest/services`

| Layer | Endpoint | Count |
|---|---|---|
| Street centerlines | `vector/Street_Centerlines/FeatureServer/0` | 36,292 |
| Sewer lines (sanitary + storm) | `Sewer/Sewer_Network_Public/FeatureServer/1` | 150,018 |
| Sewer nodes | `Sewer/Sewer_Network_Public/FeatureServer/0` | — |
| Parcels (bldg attributes) | `vector/Parcels_public/FeatureServer/0` | 217,178 |
| Address points | `vector/Address_Points/FeatureServer/0` | — |
| Building footprints 2022 | `Hosted/2022_Building_Footprints/FeatureServer/0` | LiDAR-derived |
| City limits | `Hosted/City_Limits_(source)_view/FeatureServer/0` | — |
| Census blocks 2020 | (in catalog) | for low-zoom LOD |

Street centerlines by class — the denominator for the frontage cost model:

| ROADCLASS | Segments |
|---|---|
| Local | 27,938 |
| Minor Arterial | 2,554 |
| Collector | 2,331 |
| Major Arterial | 1,476 |
| Private | 666 |
| Ramp | 607 |
| Expressway | 449 |
| Other | 270 |

Sewer lines carry `LINE_TYPE`, `LINE_HEIGHT_DIAMETER`, `OWNER`, `SMA`,
`LIFECYCLE_STATUS` — enough to cost by diameter class.

`Parcels_public` adds `BLDG_SF`, `BLDG_DESC`, `NUMBLDGS`, `BLDG_STORY`, `QUALITY`,
`CONDITION`, `BLDG_YRBLT`, `DCAACCTYPE`. Join on `PIN` ↔ `Parcel_ID`.

### 1.5 Budget

City of Omaha FY2026: ~$1.8B total, ~$600M General Fund, $265M sales and use tax,
$244.6M property tax.

`cityofomaha.org` and `finance.cityofomaha.org` sit behind Akamai and return 403 to
any scripted request, so the adopted budget PDF must be **downloaded by hand** and
transcribed into `config/budget.csv`. Cross-check against the Nebraska Auditor of
Public Accounts political-subdivision budget database, which is machine-queryable.

### 1.6 Explicitly out of scope

- **MUD** (water, gas) and **OPPD** (electric) — separate political subdivisions,
  ratepayer-funded. Not city revenue, not city cost.
- **Metro Transit** — separate 0.10 levy (`OMAHA TRANS AUTH`), not city general fund.
- `Cityworks/Sewer_Stormwater_Costs` — only 437 work orders and no geometry link.
  Not a usable cost source; keep for sanity-checking per-foot maintenance rates.

---

## 2. The model

### 2.1 Revenue

```
revenue_city = Total_Assessed_Value × 0.0043994
```

Sales tax is excluded by decision. This means a retail-heavy parcel looks worse
than it does on the city's actual books — **state this in the UI**, do not bury it.

### 2.2 Cost allocation

Every line item in `config/budget.csv` is tagged with an allocator:

| Allocator | Applies to | Basis |
|---|---|---|
| `frontage` | Street maintenance, resurfacing, plowing, sweeping, lighting, signals | Parcel's share of adjacent street-segment length |
| `sewer` | Sanitary + storm sewer O&M, CSO program debt | Frontage share weighted by adjacent main diameter |
| `residents` | Police, fire, EMS, libraries, parks, recreation | Estimated residents |
| `employees` | Police (commercial calls), fire inspection | Estimated employees |
| `people` | Blended residents + employees | Sum of the two |
| `acres` | Stormwater quantity, mowing, general land services | Parcel acreage |
| `parcels` | Mayor, council, finance, HR, legal, IT | Flat per parcel |
| `exclude` | Enterprise funds with their own revenue (airport, golf) | — |

Plus `config/capital.csv` for the **replacement liability** — the number that
produces the dramatic result and the one Urban3 leans on hardest:

```
annual_liability = Σ (linear_feet × replacement_cost_per_ft) / service_life_years
```

by street class (local / collector / arterial) and by sewer diameter class.

All allocations are normalized so `Σ allocated == Σ budgeted`. The citywide net
therefore equals the city's actual surplus or deficit by construction. The map
shows **relative** subsidy — which is the honest claim.

### 2.3 Frontage computation (DuckDB spatial)

1. Buffer each street centerline by a class-dependent half-ROW
   (Local 30 ft, Collector 40 ft, Minor Arterial 45 ft, Major Arterial 50 ft).
2. `ST_Intersection(ST_Boundary(parcel), street_buffer)` → `frontage_ft` per
   (parcel, segment) pair.
3. Each segment's annual cost splits across its fronting parcels in proportion to
   `frontage_ft`.
4. Segments with no fronting parcels (expressways, ramps) and `ROADCLASS IN
   ('Expressway','Ramp')` — state- and interstate-maintained — go to a citywide
   pool allocated by `people`, or are excluded entirely. Make this a config flag.
5. `Private` roads are excluded: the city does not maintain them. Parcels fronting
   only private roads inherit cost from the nearest public segment their private
   road connects to.

Sewers follow streets closely enough that reusing the frontage share, weighted by
adjacent main diameter, is nearly as accurate as a separate proximity join and much
cheaper. Do that; keep the separate join as a validation check.

### 2.4 Demand proxies

- **`residents_est`** — count `Address_Points` falling inside each parcel (this layer
  deliberately includes apartment and ½ addresses, so it is a real dwelling-unit
  count) × average household size by `BLDG_DESC` class.
- **`employees_est`** — `BLDG_SF` ÷ SF-per-employee by class: office 250,
  retail 500, industrial 1,000, warehouse 2,000.

### 2.5 Outputs per parcel

```
revenue_city, cost_frontage, cost_sewer, cost_people, cost_acres, cost_flat,
cost_capital, cost_total, net, net_per_acre, value_per_acre, is_tif, class, acres
```

`value_per_acre` is emitted too — it powers a second map mode that needs no cost
model at all, and it is Urban3's signature view.

---

## 3. Rendering

### 3.1 Geometry budget (measured, not guessed)

From a live 2,000-parcel sample of district 0100:

| Metric | Value |
|---|---|
| Vertices per parcel | median 7 · mean 20.8 · p90 32 · p99 265 · max 1,790 |
| Total outline vertices, Omaha | ~3.4M |
| Quantized outline buffer | ~14 MB |
| Triangulated prisms | ~7–10M triangles |

Prism triangle count per parcel with *v* vertices: `(v−2)` cap + `2v` walls ≈ `3v`.
Triangulated meshes are **built in a Worker at load time**, never shipped — shipping
them would be ~300 MB.

### 3.2 Tiles

Quad-tiled at z10 / z12 / z14. At z ≤ 11, aggregate to 2020 census blocks so the
city-wide view stays under a few hundred thousand triangles. Per-tile binary:

```
header { tileX, tileY, zoom, originX, originY, scale, parcelCount, vertexCount }
int16   ringCoords[]        // tile-local quantized XY
uint32  ringOffsets[]
uint32  parcelRingOffsets[]
float32 netPerAcre[]
float32 valuePerAcre[]
uint32  parcelId[]
uint8   classCode[]
uint8   flags[]             // bit0 = is_tif, bit1 = exempt
```

### 3.3 WebGL2

One merged draw call per tile. No Three.js, no MapLibre, no deck.gl — MapLibre's
`fill-extrusion` cannot render below the ground plane, which is the whole point here.

- **Camera** — perspective orbit + pan, pitch clamp that permits going *below* the
  horizon so the negative prisms are readable from underneath.
- **Ground plane** — translucent, at z = 0, drawn last with alpha. Street network,
  water, and the city boundary are drawn on it from our own vectors. **No raster
  basemap**, so there is no external runtime dependency of any kind.
- **Prism vertex shader** — XY from tile-local `int16` plus a tile-origin uniform;
  Z from a per-parcel height attribute × a scale uniform × a base/top flag. For
  negative values swap the base and top so triangle winding stays consistent and
  backface culling keeps working.
- **Height scaling** — `sign(x) · sqrt(|x|)` or `sign(x) · log1p(|x|)`. The
  distribution is brutally skewed; raw linear makes downtown a needle and everything
  else a pancake. Expose the choice in the UI.
- **Color** — sign-symmetric diverging ramp. Green = net positive, red = net
  negative, per preference, but shifted to **teal-green ↔ magenta-red** so it stays
  readable for the ~8% of men with red-green color-vision deficiency. Add a slight
  vertical gradient on the walls for edge legibility.
- **Picking** — render parcel id into a second color attachment (`R32UI`),
  `readPixels` a 1×1 region on hover.
- **Target** — 60 fps on Apple silicon for the full 163k-prism view; degrade via
  tile LOD elsewhere.

### 3.4 Layout

```
index.html
src/
  app.js                lit-html shell + state store
  ui/legend.js          diverging ramp + scale readout
  ui/inspector.js       per-parcel breakdown: revenue, each cost bucket, net
  ui/controls.js        map mode, height scale, class filters, TIF toggle
  ui/assumptions.js     live sliders over allocation weights (phase 4)
  gl/renderer.js        context, programs, camera, render loop
  gl/prisms.js          extruded-parcel program
  gl/lines.js           streets / water / boundary program
  gl/picking.js         id-buffer readback
  data/tiles.js         tile loader + LRU cache
  workers/build.js      binary → triangulated GPU buffers (earcut, hand-rolled)
vendor/
  lit-html.js           vendored ESM, pinned
data/tiles/             build artifacts
build/
  01_fetch.py           paginated ArcGIS extraction → GeoJSON
  02_levies.py          xlsx → levy table
  03_load.sql           DuckDB load + ST_MakeValid + area
  04_frontage.sql       street buffers → frontage_ft
  05_demand.sql         address points → units; BLDG_SF → employees
  06_allocate.py        budget.csv + capital.csv → per-parcel costs
  07_tile.py            simplify, reproject to 3857, quantize, emit binaries
config/
  budget.csv            hand-transcribed from the adopted budget PDF
  capital.csv           replacement cost per ft + service life by class
  assumptions.json      ROW widths, household sizes, SF-per-employee
```

---

## 4. Phases

1. ~~**Data spine** — fetch, DuckDB load, levy join, `value_per_acre`. Ship a
   static value-per-acre map with no cost model.~~ **Done.** 165,615 parcels,
   $56.0B assessed, $246.2M modelled city tax against $244.6M budgeted (0.7%).
   DuckDB turned out to be unnecessary here — phase 1 needs no spatial
   operations, so the pipeline is Python stdlib only. DuckDB arrives with the
   frontage work in phase 2. See README.md.
2. ~~**Cost model** — frontage, demand proxies, budget allocation, capital
   liability.~~ **Done.** The 2026 adopted budget was recovered from the Wayback
   Machine (cityofomaha.org 403s scripted requests). Frontage is hand-rolled per
   the earlier analysis and validated by closure against street length. DuckDB
   was never needed: the only geometry required was point-segment distance and a
   grid index.
3. ~~**Net revenue map** — signed prisms, diverging ramp, parcel inspector.~~
   **Done** alongside phase 2 — the renderer already supported signed heights.
4. **Refinements** — assumption sliders, TIF base apportionment, block-level LOD,
   comparison modes.

---

## 5. Known limitations (surface these in the UI, do not bury them)

- **Sales tax excluded.** $265M of city revenue is unallocated. Retail parcels look
  worse than they are on the city's actual books.
- **TIF base value is not published per parcel.** 2,014 parcels have overstated city
  revenue until the DOR project-level report is apportioned.
- **Right-of-way is not parcelized.** Streets themselves carry no revenue and appear
  as gaps. 21,175 exempt acres — parks, schools, the airport, government — carry no
  revenue by design and will read as uniformly negative. That is correct, but it is
  a category difference, not a policy failure, and the legend should say so.
- **Assessed ≠ taxable** for agricultural use-value parcels. The homestead exemption
  is state-reimbursed, so city revenue stays whole.
- **Frontage is approximate** for corner lots, flag lots, and parcels fronting only
  private drives.
- **The cost side is a model, not a measurement.** No jurisdiction publishes
  infrastructure cost per property — building that model *is* the product. Every
  assumption belongs in `config/`, visible and adjustable.
