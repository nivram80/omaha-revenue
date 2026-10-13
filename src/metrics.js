// What gets measured, how it is scaled, and what colour it wears.
//
// Phase 1 metrics are all non-negative magnitudes, so they take the sequential
// blue ramp. The diverging pair is defined here already because phase 3's net
// revenue is a polarity metric and will need it; its poles were picked by
// running the dataviz validator rather than by eye - teal-green vs orange-red
// clears CVD separation at dE 10.0, where the obvious green/magenta pairing
// scores 1.6 and fails outright.

export const RAMP_SEQUENTIAL = [
  [0.0, "#0d366b"],
  [0.15, "#184f95"],
  [0.3, "#256abf"],
  [0.45, "#3987e5"],
  [0.6, "#5598e7"],
  [0.75, "#86b6ef"],
  [0.88, "#b7d3f6"],
  [1.0, "#cde2fb"],
];

export const RAMP_DIVERGING = [
  [0.0, "#e0562e"],
  [0.35, "#a8492f"],
  [0.5, "#383835"],
  [0.65, "#0d7a5d"],
  [1.0, "#0fa87f"],
];

// Applied to magnitude only; buildMetric puts the sign back. A signed metric
// needs sign(v)*f(|v|) or a subsidised parcel would extrude upward.
export const TRANSFORMS = {
  linear: { label: "Linear", fn: (v) => v },
  sqrt: { label: "Square root", fn: (v) => Math.sqrt(v) },
  log: { label: "Logarithmic", fn: (v) => Math.log1p(v) },
};

// Below this, "per acre" is not a meaningful quantity. Douglas County records
// condominium units and common-area slivers as parcels with almost no land -
// the smallest is 0.0002 acres, nine square feet - so dividing by area turns a
// routine $824 flat charge into -$4.8M per acre and flattens the real map
// beneath it. These parcels are still present and still counted in the absolute
// metrics; only the per-acre views leave them out.
const MIN_ACRES = 0.01;

/**
 * Which slice of the city's books a parcel is judged against.
 *
 * A basis charges only some cost pots, so it credits only the slice of property
 * tax that funds them. Without that, "infrastructure only" would weigh every
 * parcel's whole tax bill against a third of the spending and show the entire
 * city comfortably in the black. Credit fractions are computed in
 * build/05_costs.py from the adopted budget and arrive in the manifest.
 *
 * The renewal liability is deliberately left uncredited, which is why the
 * citywide shortfall lands on the infrastructure basis: that is what it is.
 */
export const BASES = {
  full: {
    label: "Everything tax and sewer fees buy",
    short: "Full cost basis",
    blurb:
      "City property tax and the estimated sewer bill, against their full " +
      "allocated share of police, fire, parks, general government, streets " +
      "and the sewer system. This is the whole bill.",
    note:
      "Sewer is 40% of this basis, police, fire, parks and library 38%, " +
      "streets 14% and general government 8%. The people-driven share means " +
      "per acre it still weighs population density against assessed value.",
  },
  infrastructure: {
    label: "Infrastructure only",
    short: "Infrastructure basis",
    blurb:
      "The share of property tax that funds streets, plus the sewer bill, " +
      "against what each parcel's frontage costs to maintain and replace and " +
      "its share of the sewer system. This is the question value-per-acre " +
      "analysis usually poses.",
    note:
      "Police, fire and general government are excluded on both sides, so " +
      "this measures land use rather than how many people live on it.",
  },
  services: {
    label: "Services only",
    short: "Services basis",
    blurb:
      "The complement: police, fire, parks, library and general government, " +
      "against the share of property tax that funds them. Balances citywide " +
      "by construction, so it shows purely who pays more than their share.",
    note:
      "Demand is modelled from residents and employees, so this is close to a " +
      "map of people per acre against value per acre.",
  },
};

export function costUnder(d, i) {
  const b = d.basis;
  let cost = 0;
  if (b.pots.includes("frontage")) cost += d.cFrontage[i];
  if (b.pots.includes("people")) cost += d.cPeople[i];
  if (b.pots.includes("flat")) cost += d.cFlat[i];
  if (b.pots.includes("sewer")) cost += d.cSewer[i];
  return cost;
}

/** The slice of city property tax the active basis credits. */
export function taxUnder(d, i) {
  return d.assessed[i] * d.levy * d.basis.credit;
}

/** Sewer is not property tax: a basis that counts its cost counts the bill. */
export function sewerFeeUnder(d, i) {
  return d.basis.pots.includes("sewer") ? d.sewerFee[i] : 0;
}

export function revenueUnder(d, i) {
  return taxUnder(d, i) + sewerFeeUnder(d, i);
}

/** Net dollars a year for a parcel, under the active basis. */
function netUnder(d, i) {
  return revenueUnder(d, i) - costUnder(d, i);
}

export const METRICS = {
  net_per_acre: {
    label: "Net city revenue per acre",
    short: "Net / acre",
    unit: "$/acre/yr",
    diverging: true,
    needsCost: true,
    blurb:
      "City property tax and sewer bill the parcel pays, minus its allocated " +
      "share of what they buy and of any street renewal the city is not " +
      "funding. Above the plane the parcel carries itself; below it, the rest " +
      "of the city makes up the difference.",
    compute: (d, i) => (d.acres[i] >= MIN_ACRES ? netUnder(d, i) / d.acres[i] : 0),
  },
  net: {
    label: "Net city revenue",
    short: "Net / parcel",
    unit: "$/yr",
    diverging: true,
    needsCost: true,
    blurb:
      "The same figure without area normalisation - actual dollars a year. " +
      "Large-footprint parcels dominate here and vanish in the per-acre view.",
    compute: (d, i) => netUnder(d, i),
  },
  frontage_per_acre: {
    label: "Street frontage per acre",
    short: "Frontage / acre",
    unit: "ft/acre",
    needsCost: true,
    blurb:
      "Feet of city-maintained street each acre leans on. This is the cost " +
      "driver itself, with no dollars attached: the higher it is, the more " +
      "pavement and pipe the parcel needs per unit of land.",
    compute: (d, i) => (d.acres[i] >= MIN_ACRES ? d.frontage[i] / d.acres[i] : 0),
  },
  value_per_acre: {
    label: "Assessed value per acre",
    short: "Value / acre",
    unit: "$/acre",
    blurb:
      "What each parcel is worth per unit of land it occupies. The classic " +
      "value-per-acre view: it asks how productively a site uses the ground " +
      "it sits on, not how expensive it is.",
    compute: (d, i) => (d.acres[i] >= MIN_ACRES ? d.assessed[i] / d.acres[i] : 0),
  },
  tax_per_acre: {
    label: "City property tax per acre",
    short: "City tax / acre",
    unit: "$/acre/yr",
    blurb:
      "Assessed value per acre run through the City of Omaha levy. This is " +
      "the revenue side of the fiscal model - what the city actually collects " +
      "from each acre, before any cost is allocated against it.",
    compute: (d, i) =>
      d.acres[i] >= MIN_ACRES ? (d.assessed[i] * d.levy) / d.acres[i] : 0,
  },
  assessed: {
    label: "Total assessed value",
    short: "Assessed value",
    unit: "$",
    blurb:
      "Raw assessed value, with no area normalisation. Useful as a contrast: " +
      "big suburban parcels dominate this view and vanish in the per-acre one.",
    compute: (d, i) => d.assessed[i],
  },
};

/**
 * Build the RG32F texture payload the renderer samples.
 *   r = height fraction, signed (1.0 == full height; the tail runs past it)
 *   g = colour position, 0..1
 *
 * Height and colour use different scales because they answer different
 * questions and this distribution punishes trying to do both at once.
 *
 *   Height is a value scale, so magnitude stays honest - a parcel twice as tall
 *   really is worth (transformed) twice as much. Linear is the default, so
 *   height reads directly as dollars; square root and log are there to
 *   compress the ~80x extreme-to-median ratio. Normalising at the 99.9th
 *   percentile of magnitude keeps one outlier from flattening everything
 *   beneath it.
 *
 *   Colour is a quantile scale. On a value scale the median parcel lands at 64%
 *   of a sequential ramp and the whole city reads as one shade. Ranking spreads
 *   the ramp evenly by construction, which is standard for skewed choropleths -
 *   the legend labels the breaks, so the non-linearity is stated, not hidden.
 *   Signed metrics rank each side separately against the diverging ramp, so the
 *   neutral midpoint always sits exactly at zero rather than at the median.
 */
export function buildMetric(data, metricId, transformId, visible) {
  const metric = METRICS[metricId];
  const T = TRANSFORMS[transformId].fn;
  const n = data.parcelCount;

  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = metric.compute(data, i);

  const shown = (i) => !visible || visible[data.cls[i]];

  const colorT = new Float32Array(n);
  let breaks;
  let magnitudes;

  if (metric.diverging) {
    const neg = [];
    const pos = [];
    for (let i = 0; i < n; i++) {
      if (!shown(i)) continue;
      if (raw[i] < 0) neg.push(i);
      else if (raw[i] > 0) pos.push(i);
    }
    neg.sort((a, b) => raw[a] - raw[b]); // most negative first
    pos.sort((a, b) => raw[a] - raw[b]);

    // Negatives fill the lower half of the ramp, positives the upper half, so
    // the neutral midpoint lands on zero for every metric and filter.
    for (let r = 0; r < neg.length; r++) {
      colorT[neg[r]] = neg.length > 1 ? 0.5 * (r / (neg.length - 1)) : 0.25;
    }
    for (let r = 0; r < pos.length; r++) {
      colorT[pos[r]] = 0.5 + 0.5 * ((r + 1) / pos.length);
    }

    const negAt = (p) => (neg.length ? raw[neg[Math.round(p * (neg.length - 1))]] : 0);
    const posAt = (p) => (pos.length ? raw[pos[Math.round(p * (pos.length - 1))]] : 0);
    breaks = [
      { frac: 0, value: negAt(0) },
      { frac: 0.25, value: negAt(0.5) },
      { frac: 0.5, value: 0 },
      { frac: 0.75, value: posAt(0.5) },
      { frac: 1, value: posAt(1) },
    ];
    magnitudes = { negCount: neg.length, posCount: pos.length };
  } else {
    const ranked = [];
    for (let i = 0; i < n; i++) if (shown(i) && raw[i] > 0) ranked.push(i);
    ranked.sort((a, b) => raw[a] - raw[b]);
    const m = ranked.length;
    for (let r = 0; r < m; r++) colorT[ranked[r]] = m > 1 ? r / (m - 1) : 1;
    const at = (p) => (m ? raw[ranked[Math.min(m - 1, Math.round(p * (m - 1)))]] : 0);
    breaks = [0, 0.25, 0.5, 0.75, 1].map((p) => ({ frac: p, value: at(p) }));
    magnitudes = { negCount: 0, posCount: m };
  }

  // Height reference: the 99.9th percentile of magnitude among shown parcels.
  const mags = [];
  for (let i = 0; i < n; i++) {
    if (shown(i) && raw[i] !== 0) mags.push(Math.abs(raw[i]));
  }
  mags.sort((a, b) => a - b);
  const magAt = (p) => (mags.length ? mags[Math.round(p * (mags.length - 1))] : 1);
  const heightRef = magAt(0.999) || 1;
  const tRef = T(heightRef) || 1;

  const tex = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    if (!shown(i) || raw[i] === 0) continue;
    const mag = Math.abs(raw[i]);
    tex[i * 2] = Math.sign(raw[i]) * (T(mag) / tRef);
    tex[i * 2 + 1] = colorT[i];
  }

  return {
    tex,
    raw,
    breaks,
    heightRef,
    diverging: !!metric.diverging,
    stats: {
      ...magnitudes,
      zero: n - magnitudes.negCount - magnitudes.posCount,
      p50: magAt(0.5),
      p999: heightRef,
      max: magAt(1),
      counted: magnitudes.negCount + magnitudes.posCount,
    },
  };
}

/** Legend labels sit at quantile breaks, so they need no scale inversion. */
export function legendTicks(current) {
  return current.breaks;
}

// The sign goes before the dollar sign: −$717, not $-717.
export function money(v) {
  const a = Math.abs(v);
  const sign = v < 0 && a >= 0.5 ? "−" : "";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}K`;
  return `${sign}$${Math.round(a)}`;
}

export function moneyFull(v) {
  const sign = v <= -0.5 ? "−" : "";
  return `${sign}$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;
}
