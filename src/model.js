// Re-prices streets and sewers in the browser when an assumption is edited.
//
// build/05_costs.py measures what each parcel fronts and uses - lane-feet of
// street by class and surface, bridge deck, signals, feet and inch-feet of
// sewer main, what drives its sewer bill - and build/pricing.py turns those
// quantities into dollars. This is a line-for-line port of pricing.py; keep
// the two in step. At the default values it reproduces the build's totals,
// which the manifest carries as model.check.
//
// data/out/model.bin, written by build/03_build.py:
//   'OMQM' | u32 version | u32 parcelCount | u32 fieldCount
//   | f32 column per field (names in manifest.model.fields) | u8 ccfKind[n]

export const CLASSES = ["Local", "Collector", "Minor Arterial", "Major Arterial", "Freeway"];
const NC = CLASSES.length;
const OV = 0;
const CC = NC;
const NONE = 2 * NC;
const DECK = NONE + 1;
const SIG_T = NONE + 2;
const SIG_O = NONE + 3;
const NQ = NONE + 4;
const USAGE = ["single_family_unit", "multi_family_unit", "per_employee"];
export const USAGE_LABELS = ["house", "apartment", "employee"];

// Which quantity dimension each model.bin column feeds, per street variant.
const OWN_DIMS = [0, 1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13];
const SHARED_DIMS = [0, 5, 10, 11, 12, 13];

export async function loadModel(manifest) {
  const spec = manifest.model;
  const res = await fetch(`data/out/${spec.file}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${spec.file}: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
  if (magic !== "OMQM") throw new Error(`bad magic ${magic}`);
  const n = dv.getUint32(8, true);
  const nf = dv.getUint32(12, true);
  if (nf !== spec.fields.length) throw new Error("model.bin does not match the manifest");
  const cols = {};
  spec.fields.forEach((name, f) => {
    cols[name] = new Float32Array(buffer, 16 + f * n * 4, n);
  });
  const ccfKind = new Uint8Array(buffer, 16 + nf * n * 4, n);
  return {
    n,
    cols,
    ccfKind,
    own: OWN_DIMS.map((d) => cols[`own_${d}`]),
    shared: SHARED_DIMS.map((d) => cols[`shared_${d}`]),
    defaults: spec.assumptions,
    meta: spec.meta,
    city: manifest.cost_model.model,
    sum: sums(cols, ccfKind, n),
    priced: null,
  };
}

/** Citywide sums of the per-parcel sewer quantities, for cityTotals. */
function sums(cols, ccfKind, n) {
  const s = { pipeFt: 0, pipeFtIn: 0, accounts: 0, accountsBy: [0, 0, 0], count: [0, 0, 0] };
  for (let i = 0; i < n; i++) {
    s.pipeFt += cols.pipe_ft[i];
    s.pipeFtIn += cols.pipe_ft_in[i];
    s.accounts += cols.fee_accounts[i];
    s.accountsBy[ccfKind[i]] += cols.fee_accounts[i];
    s.count[ccfKind[i]] += cols.fee_ccf_count[i];
  }
  return s;
}

// ---- values -----------------------------------------------------------------

/** A value from assumptions.json by "/"-separated path. */
export function get(A, path) {
  let v = A;
  for (const k of path.split("/")) v = v?.[k];
  return v;
}

/** Defaults with edits applied: { path: value } over a deep copy. */
export function withEdits(defaults, edits) {
  const A = structuredClone(defaults);
  for (const [path, value] of Object.entries(edits)) {
    const keys = path.split("/");
    let o = A;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys[keys.length - 1]] = value;
  }
  return A;
}

function itemsTotal(items) {
  let t = 0;
  for (const [k, v] of Object.entries(items)) if (!k.startsWith("_")) t += v;
  return t;
}

// ---- streets ----------------------------------------------------------------

function laneFt(q) {
  let t = 0;
  for (let k = 0; k <= NONE; k++) t += q[k];
  return t;
}

function streetRates(A, cityLaneFt) {
  const pave = new Float64Array(NQ);
  CLASSES.forEach((c, i) => {
    const rebuild =
      get(A, `streets/reconstruct_per_lane_ft/${c}`) / get(A, `streets/reconstruct_life_years/${c}`);
    const interval = get(A, `streets/resurface_interval_years/${c}`);
    pave[OV + i] = rebuild + get(A, `streets/resurface_per_lane_ft/overlay/${c}`) / interval;
    pave[CC + i] = rebuild + get(A, `streets/resurface_per_lane_ft/concrete/${c}`) / interval;
  });
  const upkeep = cityLaneFt ? itemsTotal(get(A, "streets/upkeep/items")) / cityLaneFt : 0;
  const asset = new Float64Array(NQ);
  asset[DECK] = get(A, "streets/bridges/cost_per_sf") / get(A, "streets/bridges/life_years");
  const life = get(A, "streets/signals/life_years");
  asset[SIG_T] = get(A, "streets/signals/replace_cost/TRAFFIC") / life;
  asset[SIG_O] = get(A, "streets/signals/replace_cost/_default") / life;
  return { pave, upkeep, asset };
}

function streetParts(q, r) {
  let pave = 0;
  let lanes = 0;
  for (let k = 0; k <= NONE; k++) {
    pave += q[k] * r.pave[k];
    lanes += q[k];
  }
  return [pave, lanes * r.upkeep, q[DECK] * r.asset[DECK] + q[SIG_T] * r.asset[SIG_T] + q[SIG_O] * r.asset[SIG_O]];
}

// ---- sewer ------------------------------------------------------------------

function sewerFee(A, accounts, count, kind) {
  const usage = count ? get(A, `sewer/usage_ccf_per_month/${USAGE[kind]}`) : 0;
  return 12 * (accounts * get(A, "sewer/fees/customer_charge_monthly")
    + count * usage * get(A, "sewer/fees/flow_charge_per_ccf"));
}

export function pipeRenewal(A, ft, ftIn) {
  const replace = (ft * get(A, "sewer/pipe/cost_base_per_ft") + ftIn * get(A, "sewer/pipe/cost_per_inch_diameter"))
    / get(A, "sewer/pipe/service_life_years");
  const line = ftIn * get(A, "sewer/pipe/lining_cost_per_inch_diameter") / get(A, "sewer/pipe/lining_life_years");
  const lined = get(A, "sewer/pipe/lined_percent") / 100;
  return (1 - lined) * replace + lined * line;
}

function facilitiesTotal(A) {
  let t = 0;
  for (const [k, v] of Object.entries(get(A, "sewer/facilities/items"))) {
    if (!k.startsWith("_")) t += v.replacement_value / v.life_years;
  }
  return t;
}

function sewerPool(A, mains, feesTotal) {
  const clean = mains.total_ft ? itemsTotal(get(A, "sewer/pipe_upkeep/items")) / mains.total_ft : 0;
  const run = (kind) => pipeRenewal(A, mains[`${kind}_ft`], mains[`${kind}_ft_in`]) + clean * mains[`${kind}_ft`];
  const inCity = feesTotal / get(A, "sewer/fee_revenue_systemwide");
  const parts = {
    large_mains: run("big"),
    unfronted_mains: run("unfronted"),
    trunk_lines: inCity * run("trunk"),
    mains_off_street: inCity * run("off_street"),
    operations: inCity * itemsTotal(get(A, "sewer/operations/items")),
    facilities: inCity * facilitiesTotal(A),
  };
  return { total: Object.values(parts).reduce((a, b) => a + b, 0), clean, inCity, parts };
}

/** Street money that is not property tax, and the share of every street's cost it pays. */
function streetCredit(A, streetTotal) {
  const other = itemsTotal(get(A, "streets/other_street_funding/items"));
  return { other, share: streetTotal > 0 ? Math.min(other / streetTotal, 1) : 0 };
}

/**
 * Citywide totals under A without touching a parcel. Every price is linear in
 * the quantities, so the sum over parcels is the price of the summed
 * quantities: cheap enough to run for every cost estimate level at once.
 */
export function cityTotals(model, A) {
  const { city, sum } = model;
  const r = streetRates(A, laneFt(city.city_q));
  const [pavement, upkeep, assets] = streetParts(city.city_q, r);
  const streets = pavement + upkeep + assets;
  let fees = 12 * sum.accounts * get(A, "sewer/fees/customer_charge_monthly");
  USAGE.forEach((u, k) => {
    fees += 12 * sum.count[k] * get(A, `sewer/usage_ccf_per_month/${u}`) * get(A, "sewer/fees/flow_charge_per_ccf");
  });
  const sp = sewerPool(A, city.mains, fees);
  const localRenewal = pipeRenewal(A, sum.pipeFt, sum.pipeFtIn);
  const localClean = sum.pipeFt * sp.clean;
  const local = localRenewal + localClean;
  const p = sp.parts;
  const credit = streetCredit(A, streets);
  return {
    streets, pavement, upkeep, assets, fees,
    sewer: local + sp.total,
    mains: local + p.large_mains + p.unfronted_mains + p.trunk_lines + p.mains_off_street,
    plants: p.operations + p.facilities,
    otherStreet: credit.other,
    streetCredit: credit.share,
    // The parts, for the balance sheet.
    localRenewal, localClean, sewerParts: p, clean: sp.clean, inCity: sp.inCity,
  };
}

// ---- the whole city -----------------------------------------------------------

/**
 * Price every parcel under A, writing street and sewer costs and sewer bills
 * into data's arrays in place, and return citywide totals. Kept on the model
 * so the inspector can explain one parcel with the same numbers.
 */
export function priceAll(model, A, data) {
  const { n, cols, ccfKind, own, shared, city } = model;
  const r = streetRates(A, laneFt(city.city_q));
  const F = city.frontage_total;
  const pool = {
    own: streetParts(city.pool_q.own, r).reduce((a, b) => a + b, 0),
    shared: streetParts(city.pool_q.shared, r).reduce((a, b) => a + b, 0),
  };

  const q = new Float64Array(NQ);
  const totals = { streetsOwn: 0, streetsShared: 0, sewer: 0, fees: 0, pavement: 0, upkeep: 0, assets: 0 };
  const acc = cols.fee_accounts;
  const cnt = cols.fee_ccf_count;

  for (let i = 0; i < n; i++) {
    const perFt = F > 0 ? data.frontage[i] / F : 0;
    q.fill(0);
    for (let d = 0; d < OWN_DIMS.length; d++) q[OWN_DIMS[d]] = own[d][i];
    const po = streetParts(q, r);
    q.fill(0);
    for (let d = 0; d < SHARED_DIMS.length; d++) q[SHARED_DIMS[d]] = shared[d][i];
    const ps = streetParts(q, r);
    const cOwn = po[0] + po[1] + po[2] + pool.own * perFt;
    const cShared = ps[0] + ps[1] + ps[2] + pool.shared * perFt;
    data.cFrontageOwn[i] = cOwn;
    data.cFrontageShared[i] = cShared;
    totals.streetsOwn += cOwn;
    totals.streetsShared += cShared;
    const fee = sewerFee(A, acc[i], cnt[i], ccfKind[i]);
    data.sewerFee[i] = fee;
    totals.fees += fee;
  }

  const sp = sewerPool(A, city.mains, totals.fees);
  for (let i = 0; i < n; i++) {
    const ft = cols.pipe_ft[i];
    const c = pipeRenewal(A, ft, cols.pipe_ft_in[i]) + ft * sp.clean
      + (totals.fees > 0 ? sp.total * data.sewerFee[i] / totals.fees : 0);
    data.cSewer[i] = c;
    totals.sewer += c;
  }

  const [pavement, upkeep, assets] = streetParts(city.city_q, r);
  const credit = streetCredit(A, totals.streetsShared);
  Object.assign(totals, {
    pavement, upkeep, assets, sewerPool: sp.total, inCity: sp.inCity,
    otherStreet: credit.other, streetCredit: credit.share,
  });
  model.priced = { A, r, pool, sewer: sp, totals };
  return totals;
}

/**
 * One parcel's street and sewer costs as lines of quantity x rate, for the
 * inspector. Uses the prices from the last priceAll.
 */
export function explain(model, data, i, sharedArterials) {
  const { A, r, pool, sewer, totals } = model.priced;
  const { cols, ccfKind, city } = model;
  const dims = sharedArterials ? SHARED_DIMS : OWN_DIMS;
  const vec = sharedArterials ? model.shared : model.own;
  const q = new Float64Array(NQ);
  dims.forEach((d, k) => { q[d] = vec[k][i]; });

  const lanes = [];
  for (let c = 0; c < NC; c++) {
    for (const [base, surface] of [[OV, "asphalt"], [CC, "concrete"]]) {
      const lf = q[base + c];
      if (lf > 0.5) {
        lanes.push({ lf, label: `${CLASSES[c].toLowerCase()} street, ${surface}`, rate: r.pave[base + c], cost: lf * r.pave[base + c] });
      }
    }
  }
  const [pavement, upkeep, assets] = streetParts(q, r);
  const F = city.frontage_total;
  const poolRate = F > 0 ? (sharedArterials ? pool.shared : pool.own) / F : 0;

  const ft = cols.pipe_ft[i];
  const ftIn = cols.pipe_ft_in[i];
  const fee = data.sewerFee[i];
  const kind = ccfKind[i];
  return {
    streets: {
      lanes,
      laneFt: laneFt(q),
      pavement,
      upkeepRate: r.upkeep,
      upkeep,
      deck: q[DECK], deckRate: r.asset[DECK],
      signals: q[SIG_T], signalRate: r.asset[SIG_T],
      otherSignals: q[SIG_O], otherSignalRate: r.asset[SIG_O],
      assets,
      frontage: data.frontage[i], poolRate, pooled: data.frontage[i] * poolRate,
      creditShare: totals.streetCredit,
    },
    sewer: {
      pipeFt: ft,
      diameter: ft > 0 ? ftIn / ft : 0,
      renewal: pipeRenewal(A, ft, ftIn),
      renewalRate: ft > 0 ? pipeRenewal(A, ft, ftIn) / ft : 0,
      lined: get(A, "sewer/pipe/lined_percent"),
      cleanRate: sewer.clean,
      cleaning: ft * sewer.clean,
      fee,
      feesTotal: totals.fees,
      pool: sewer.total,
      shared: totals.fees > 0 ? sewer.total * fee / totals.fees : 0,
    },
    bill: {
      accounts: cols.fee_accounts[i],
      count: cols.fee_ccf_count[i],
      kind: USAGE_LABELS[kind],
      usage: get(A, `sewer/usage_ccf_per_month/${USAGE[kind]}`),
      customer: get(A, "sewer/fees/customer_charge_monthly"),
      flow: get(A, "sewer/fees/flow_charge_per_ccf"),
    },
  };
}
