import { html, render, nothing } from "../vendor/lit-html.js";
import { Renderer } from "./gl/renderer.js";
import { loadParcels } from "./data/parcels.js";
import {
  METRICS, TRANSFORMS, BASES, RAMP_SEQUENTIAL, RAMP_DIVERGING,
  buildMetric, legendTicks, costUnder, revenueUnder, taxUnder, sewerFeeUnder, streetMoneyUnder,
  money, moneyFull,
} from "./metrics.js";
import { buildIndex, search } from "./search.js";
import {
  loadModel, priceAll, cityTotals, withEdits, explain, pipeRenewal, CLASSES, get as getParam,
} from "./model.js";
import { tip } from "./tip.js";

const CLASS_NAMES = {
  0: "Unknown", 1: "Residential", 2: "Recreational", 3: "Commercial",
  4: "Industrial", 5: "Agricultural", 6: "Other", 7: "Exempt",
};
// World metres at height fraction 1.0, before the exaggeration slider. Tuned
// against a 44 km-wide city: the median parcel lands near 400 m of fuzz and
// downtown tops out around 4 km.
const BASE_HEIGHT = 1500;

const FLAG_TIF = 1;
const FLAG_EXEMPT = 2;

// Douglas County's 2025 orthophoto, as a public Web Mercator tile cache - the
// same projection the parcels are stored in, so no reprojection is needed.
const AERIAL_TILES =
  "https://dcgis.org/server/rest/services/2025_Douglas_County_NE_Imagery/MapServer/tile";
const AERIAL_W = 242;
const AERIAL_H = 150;
const MERC = 20037508.342789244;
// The assessor's own photos sit behind short-lived signed links, so the panel
// links to the parcel's record on the county's Beacon site instead.
const ASSESSOR_RECORD =
  "https://beacon.schneidercorp.com/Application.aspx?AppID=1221&LayerID=37105&PageTypeID=4&KeyValue=";
// Edited assumptions, kept in this browser only: { "path/in/assumptions": value }.
const EDITS_KEY = "omaha-revenue:assumptions";

function loadEdits() {
  try {
    const e = JSON.parse(localStorage.getItem(EDITS_KEY));
    return e && typeof e === "object" ? e : {};
  } catch {
    return {};
  }
}

function saveEdits() {
  try {
    localStorage.setItem(EDITS_KEY, JSON.stringify(state.edits));
  } catch {
    // Private windows and blocked storage: edits last until reload.
  }
}

const state = {
  phase: "boot",
  progress: 0,
  note: "",
  metricId: "net_per_acre",
  basisId: "infrastructure",
  transformId: "linear",
  heightScale: 1,
  // Losses rise and gains hang below; only for signed metrics.
  flip: false,
  visible: Object.fromEntries(Object.keys(CLASS_NAMES).map((k) => [k, true])),
  hovered: -1,
  pinned: -1,
  pointer: { x: 0, y: 0 },
  manifest: null,
  hasCost: false,
  current: null,
  showHelp: false,
  // Through-road premium shared citywide, or each road charged in full to the
  // lots along it. Starts from config/assumptions.json via the manifest.
  shareArterials: true,
  query: "",
  results: [],
  active: 0,
  edits: loadEdits(),
  showAssumptions: false,
  modelReady: false,
  // Street and sewer totals and per-basis net, re-priced from the edits.
  totals: null,
  bases: null,
  // Citywide totals by group (model.cityTotals), for the cost estimate
  // switches and the Assumptions panel.
  city: null,
  // The assumptions the map is priced at now: defaults with the edits applied.
  A: null,
  showBalance: false,
  estimatesOpen: !matchMedia("(max-width: 860px)").matches,
};

let renderer = null;
let data = null;
let attrs = null;
let searchIndex = null;
let needsDraw = true;
let flight = null;
let model = null;
let defaultTotals = null;
let defaultCity = null;
let repriceTimer = null;
let asmReturn = null;

const hud = document.getElementById("hud");
const canvas = document.getElementById("scene");

function ui() {
  render(view(), hud);
}

function invalidate() {
  needsDraw = true;
}

// ---- data ------------------------------------------------------------------

async function boot() {
  try {
    state.phase = "loading";
    state.note = "manifest";
    ui();

    // no-cache revalidates rather than refetches: a rebuild must never be
    // read alongside a stale copy of one of its sibling files.
    state.manifest = await (await fetch("data/out/manifest.json", { cache: "no-cache" })).json();
    ui();

    state.note = "parcels";
    data = await loadParcels("data/out/parcels.bin", (p) => {
      state.progress = p * 0.5;
      ui();
    });
    data.levy = state.manifest.city_levy_per_100 / 100;
    state.hasCost = !!state.manifest.cost_model;
    if (!state.hasCost) state.metricId = "value_per_acre";
    else {
      state.shareArterials = state.manifest.cost_model.network_share_enabled !== false;
      data.streetCredit = state.manifest.cost_model.streets?.credit_share || 0;
      applyStreets();
      applyBasis();
    }

    renderer = new Renderer(canvas);
    renderer.setExtent(data.bbox);
    renderer.height = BASE_HEIGHT * state.heightScale;
    applyMetric();

    state.note = "building geometry";
    ui();
    await buildMeshes();

    state.phase = "ready";
    ui();
    invalidate();

    // The inspector needs these; nothing on screen does. Fetch after paint.
    fetch("data/out/attrs.json", { cache: "no-cache" })
      .then((r) => r.json())
      .then((a) => { attrs = a; searchIndex = buildIndex(a); ui(); })
      .catch(() => {});
    // Quantities for re-pricing when an assumption is edited, and for
    // explaining a parcel's costs line by line.
    if (state.hasCost && state.manifest.model) {
      loadModel(state.manifest)
        .then((m) => { model = m; reprice(); state.modelReady = true; ui(); })
        .catch((err) => console.warn("cost model:", err.message));
    }
  } catch (err) {
    state.phase = "error";
    state.note = err.message;
    ui();
    throw err;
  }
}

function buildMeshes() {
  return new Promise((resolve, reject) => {
    const worker = new Worker("src/workers/mesh.js", { type: "module" });
    // Copy each view out of the shared 6.5 MB buffer before posting. A
    // TypedArray view is structured-cloned by cloning its WHOLE backing
    // buffer, so posting the views directly would ship the entire file 103
    // times over.
    const transfer = [];
    const payload = data.cells.map((c) => {
      const coords = c.coords.slice();
      const ringStart = c.ringStart.slice();
      const parcelRingStart = c.parcelRingStart.slice();
      transfer.push(coords.buffer, ringStart.buffer, parcelRingStart.buffer);
      return {
        vertexCount: c.vertexCount,
        parcelCount: c.parcelCount,
        firstParcel: c.firstParcel,
        coords, ringStart, parcelRingStart,
      };
    });

    let done = 0;
    worker.onmessage = (e) => {
      if (e.data.type === "cell") {
        renderer.addCell(data.cells[e.data.index], e.data.mesh);
        done++;
        state.progress = 0.5 + 0.5 * (done / data.cells.length);
        if (done % 8 === 0) { ui(); invalidate(); }
      } else {
        worker.terminate();
        resolve();
      }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage({ cells: payload }, transfer);
  });
}

function applyBasis() {
  // The manifest carries each basis's pot list and credit fraction; metrics.js
  // carries the prose. Merge so a basis change is a single object swap.
  const m = (state.bases || state.manifest.cost_model.bases)[state.basisId];
  data.basis = { ...BASES[state.basisId], ...m };
}

// ---- assumptions -----------------------------------------------------------

/** Re-price every parcel's streets and sewers from the current edits. */
function reprice() {
  const defaults = model.defaults;
  // Drop edits to values a rebuild has since removed.
  for (const p of Object.keys(state.edits)) {
    if (typeof getParam(defaults, p) !== "number") delete state.edits[p];
  }
  if (!defaultTotals) {
    defaultTotals = priceAll(model, defaults, data);
    defaultCity = cityTotals(model, defaults);
    const check = model.city.check;
    const off = Math.abs(defaultTotals.sewer / check.sewer - 1)
      + Math.abs(defaultTotals.streetsShared / check.streets_shared - 1);
    if (off > 1e-3) console.warn("re-pricing does not reproduce the build", defaultTotals, check);
  }
  const A = editCount() ? withEdits(defaults, state.edits) : defaults;
  state.totals = priceAll(model, A, data);
  state.city = cityTotals(model, A);
  state.A = A;
  data.streetCredit = state.totals.streetCredit;
  state.bases = basesFrom(state.totals);
  applyStreets();
  applyBasis();
  applyMetric();
  ui();
}

/** Each basis's citywide cost, income and net at the given street and sewer totals. */
function basesFrom(t) {
  const c = state.manifest.cost_model;
  const pot = {
    frontage: t.streetsShared,
    people: c.service_groups.people,
    flat: c.service_groups.flat,
    sewer: t.sewer,
  };
  return Object.fromEntries(Object.entries(c.bases).map(([id, b]) => {
    const cost = b.pots.reduce((sum, k) => sum + pot[k], 0);
    const sewerRevenue = b.pots.includes("sewer") ? t.fees : 0;
    const streetRevenue = b.pots.includes("frontage") ? t.streetCredit * t.streetsShared : 0;
    const revenue = b.tax_revenue + sewerRevenue + streetRevenue;
    return [id, {
      ...b, cost, sewer_revenue: sewerRevenue, street_revenue: streetRevenue, revenue, net: revenue - cost,
    }];
  }));
}

/**
 * The whole city's books from cityTotals: every cost and every income, which
 * is the full basis. Services balance, so its net is the street and sewer gap.
 */
function ledgerFrom(c) {
  const cm = state.manifest.cost_model;
  const services = cm.service_groups.people + cm.service_groups.flat;
  const streetMoney = Math.min(c.otherStreet, c.streets);
  const income = cm.property_tax + c.fees + streetMoney;
  const cost = c.streets + c.sewer + services;
  return { services, streetMoney, income, cost, net: income - cost };
}

function paramValue(path) {
  return path in state.edits ? state.edits[path] : getParam(state.manifest.model.assumptions, path);
}

function setParam(path, raw, { positive = false, max = Infinity } = {}) {
  if (String(raw).trim() === "") return;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > max || (positive && v === 0)) return;
  if (v === getParam(state.manifest.model.assumptions, path)) delete state.edits[path];
  else state.edits[path] = v;
  saveEdits();
  clearTimeout(repriceTimer);
  repriceTimer = setTimeout(reprice, 250);
}

function resetEdits(paths) {
  for (const p of paths || Object.keys(state.edits)) delete state.edits[p];
  saveEdits();
  if (model) reprice();
  else ui();
}

/** Open the Assumptions panel, at one group's section if given, and move focus into it. */
function openAssumptions(section) {
  if (!state.showAssumptions && !state.showBalance) asmReturn = document.activeElement;
  state.showBalance = false;
  state.showAssumptions = true;
  ui();
  goTo(section);
}

function closeAssumptions() {
  state.showAssumptions = false;
  ui();
  if (asmReturn?.isConnected) asmReturn.focus();
  asmReturn = null;
}

function openBalance() {
  if (!state.showAssumptions && !state.showBalance) asmReturn = document.activeElement;
  state.showAssumptions = false;
  state.showBalance = true;
  ui();
  document.getElementById("bs-title")?.focus({ preventScroll: true });
}

function closeBalance() {
  state.showBalance = false;
  ui();
  if (asmReturn?.isConnected) asmReturn.focus();
  asmReturn = null;
}

/** Scroll the Assumptions panel to a section and focus its heading. */
function goTo(section) {
  const el = document.getElementById(section ? `asm-${section}` : "asm-title");
  const heading = el?.matches("h1, h2") ? el : el?.querySelector("h2");
  if (!heading) return;
  if (section) el.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  heading.focus({ preventScroll: true });
}

// ---- cost estimates ------------------------------------------------------------
//
// A group's quick levels (config/parameters.json) are sets of values in
// assumptions.json; the level without values is the defaults. Picking one
// writes its values as edits, so the Assumptions panel always shows exactly
// what a level means, and editing any of the group's values there by hand
// turns its switch to custom.

function quickGroups() {
  return state.manifest.model ? state.manifest.model.meta.groups.filter((g) => g.quick) : [];
}

function defaultValue(path) {
  return getParam(state.manifest.model.assumptions, path);
}

function levelPaths(g) {
  return [...new Set(g.quick.levels.flatMap((l) => Object.keys(l.values || {})))];
}

function levelValue(level, path) {
  return level.values && path in level.values ? level.values[path] : defaultValue(path);
}

function levelEdits(g, level) {
  return Object.fromEntries(levelPaths(g).map((p) => [p, levelValue(level, p)]));
}

/** The level the group's values match, or null when any of them is custom. */
function currentLevel(g) {
  const paths = levelPaths(g);
  if (groupPaths(g).some((p) => !paths.includes(p) && p in state.edits)) return null;
  return g.quick.levels.find((l) => paths.every((p) => paramValue(p) === levelValue(l, p))) || null;
}

function applyLevel(g, level) {
  for (const [p, v] of Object.entries(levelEdits(g, level))) {
    if (v === defaultValue(p)) delete state.edits[p];
    else state.edits[p] = v;
  }
  saveEdits();
  if (model) reprice();
  else ui();
}

/** Edits that no cost estimate level accounts for: values typed in by hand. */
function customCount() {
  const explained = new Set();
  for (const g of quickGroups()) {
    if (currentLevel(g)) levelPaths(g).forEach((p) => explained.add(p));
  }
  return Object.keys(state.edits).filter((p) => !explained.has(p)).length;
}

/** A group's dollars a year at the current values, or null before the model loads. */
function groupTotal(id) {
  const c = state.city;
  if (!c) return null;
  const by = {
    pavement: c.pavement, upkeep: c.upkeep, assets: c.assets, pipes: c.mains,
    system: c.plants, bills: c.fees, street_funding: Math.min(c.otherStreet, c.streets),
  };
  return id in by ? by[id] : null;
}

/** A sliding switch between a group's levels. None is lit when its values are custom. */
function levelSwitch(g, where) {
  const levels = g.quick.levels;
  const current = currentLevel(g);
  const at = levels.indexOf(current);
  return html`<div class="seg ${at < 0 ? "custom" : ""}" role="radiogroup"
      aria-label=${`${g.quick.label} estimate`} style="--n:${levels.length};--at:${Math.max(at, 0)}">
    <i class="seg-thumb" aria-hidden="true"></i>
    ${levels.map((l) => html`<label class="seg-opt ${l === current ? "on" : ""}">
      <input type="radio" name=${`${where}-${g.id}`} .checked=${l === current}
        ?disabled=${!state.modelReady} @change=${() => applyLevel(g, l)} />
      <span>${l.label}</span>
    </label>`)}
  </div>`;
}

function levelsTip(g, where) {
  return tip(`${where}-levels-${g.id}`, `${g.quick.label} estimates`, html`
    ${g.quick.levels.map((l) => html`<p><b>${l.label}.</b> ${l.text}</p>`)}
    <p class="tip-foot">Each setting fills in values under Assumptions and sources.</p>`);
}

function estimates() {
  const groups = quickGroups();
  if (!groups.length) return nothing;
  const open = state.estimatesOpen;
  return html`<section class="estimates">
    <div class="est-top">
      <button class="est-toggle" aria-expanded=${open ? "true" : "false"} aria-controls="est-body"
        @click=${() => { state.estimatesOpen = !open; ui(); }}>Cost estimates</button>
      ${tip("estimates", "cost estimates", html`<p>No one knows exactly what keeping a
        city's streets and sewers costs. Each switch picks a low, typical or high estimate
        for one part of it, and the map re-prices every parcel.</p>
        <p>Typical is the default. Low and High are the cheap and expensive ends of what
        the sources support.</p>`)}
    </div>
    <div id="est-body" class="est-body" ?hidden=${!open}>
      ${groups.map((g) => {
        const v = groupTotal(g.id);
        const custom = state.modelReady && !currentLevel(g);
        return html`<div class="est">
          <span class="est-name">${g.quick.label}${levelsTip(g, "q")}</span>
          <span class="est-val">${custom ? html`<em>custom</em> · ` : nothing}${v == null ? "" :
            `${g.kind === "income" && v >= 0.5 ? "+" : ""}${money(v)} a year`}</span>
          ${levelSwitch(g, "q")}
        </div>`;
      })}
      <button class="link" @click=${() => openAssumptions()}>Every number behind these</button>
    </div>
  </section>`;
}

function applyStreets() {
  data.cFrontage = state.shareArterials ? data.cFrontageShared : data.cFrontageOwn;
}

function ramp() {
  return METRICS[state.metricId].diverging ? RAMP_DIVERGING : RAMP_SEQUENTIAL;
}

function applyMetric() {
  const visible = {};
  for (const k of Object.keys(CLASS_NAMES)) visible[k] = state.visible[k];
  state.current = buildMetric(data, state.metricId, state.transformId, visible);
  renderer.flip = state.flip && state.current.diverging;
  renderer.setRamp(ramp());
  renderer.setMetric(state.current.tex, data.parcelCount);
  invalidate();
}

// ---- interaction -----------------------------------------------------------

function attachInput() {
  let drag = null;
  const cam = renderer.camera;

  // Map convention: drag pans, right-drag (or shift/ctrl-drag) orbits.
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    flight = null;
    renderer.updateMatrices();
    drag = {
      x0: e.clientX, y0: e.clientY,
      x: e.clientX, y: e.clientY,
      orbit: e.button === 2 || e.shiftKey || e.ctrlKey,
      target: cam.target.slice(),
      ground: renderer.screenToGround(e.clientX, e.clientY),
    };
  });

  canvas.addEventListener("pointermove", (e) => {
    state.pointer = { x: e.clientX, y: e.clientY };
    if (!drag) {
      queueHover(e.clientX, e.clientY);
      return;
    }

    if (drag.orbit) {
      cam.azimuth += (e.clientX - drag.x) * 0.005;
      cam.elevation = clamp(cam.elevation - (e.clientY - drag.y) * 0.005, -0.32, 1.48);
      drag.x = e.clientX;
      drag.y = e.clientY;
    } else if (drag.ground) {
      // Keep the grabbed ground point under the cursor. Unproject with the
      // camera where the drag started, so the offset is exact, not chased.
      cam.target = drag.target.slice();
      renderer.updateMatrices();
      const now = renderer.screenToGround(e.clientX, e.clientY);
      if (now) {
        cam.target[0] = drag.target[0] - (now[0] - drag.ground[0]);
        cam.target[1] = drag.target[1] - (now[1] - drag.ground[1]);
        clampTarget();
      }
    }
    invalidate();
  });

  const end = (e) => {
    if (drag && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 3) {
      pin(state.hovered);
    }
    drag = null;
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", () => { drag = null; });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // Zoom toward whatever is under the cursor, not the middle of the screen.
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    flight = null;
    renderer.updateMatrices();
    const before = renderer.screenToGround(e.clientX, e.clientY);
    cam.distance = clamp(cam.distance * Math.exp(e.deltaY * 0.0015), 400, 160000);
    if (before) {
      renderer.updateMatrices();
      const after = renderer.screenToGround(e.clientX, e.clientY);
      if (after) {
        cam.target[0] += before[0] - after[0];
        cam.target[1] += before[1] - after[1];
        clampTarget();
      }
    }
    invalidate();
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === "Escape") {
      if (state.showAssumptions) { closeAssumptions(); return; }
      if (state.showBalance) { closeBalance(); return; }
      state.showHelp = false; pin(-1);
    }
    if (e.key === "?") { state.showHelp = !state.showHelp; ui(); }
    if (e.key === "/") { e.preventDefault(); document.getElementById("find")?.focus(); }
    if (e.key === "r" || e.key === "R") { flight = null; renderer.frameExtent(); invalidate(); }
    if ((e.key === "f" || e.key === "F") && METRICS[state.metricId].diverging) setFlip(!state.flip);
  });

  window.addEventListener("resize", invalidate);
}

/** Keep the view over the city: the target can't wander past its edges. */
function clampTarget() {
  const t = renderer.camera.target;
  const [w, h] = renderer.extent;
  t[0] = clamp(t[0], -w * 0.6, w * 0.6);
  t[1] = clamp(t[1], -h * 0.6, h * 0.6);
}

function setFlip(on) {
  state.flip = on;
  renderer.flip = on && state.current.diverging;
  invalidate();
  ui();
}

function pin(id) {
  state.pinned = id;
  renderer.selected = id;
  invalidate();
  ui();
}

// ---- search ----------------------------------------------------------------

/** A parcel's outline rings and bounds in Web Mercator metres. */
function parcelShape(id) {
  const cell = data.cells.find((c) => id >= c.firstParcel && id < c.firstParcel + c.parcelCount);
  const p = id - cell.firstParcel;
  const rings = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let r = cell.parcelRingStart[p]; r < cell.parcelRingStart[p + 1]; r++) {
    const ring = [];
    for (let v = cell.ringStart[r]; v < cell.ringStart[r + 1]; v++) {
      const x = cell.originX + cell.coords[v * 2] * cell.scaleX;
      const y = cell.originY + cell.coords[v * 2 + 1] * cell.scaleY;
      ring.push([x, y]);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    rings.push(ring);
  }
  return { rings, x0, y0, x1, y1 };
}

/** Scene-relative centre and size of a parcel. */
function parcelCenter(id) {
  const s = parcelShape(id);
  return {
    x: (s.x0 + s.x1) / 2 - renderer.center[0],
    y: (s.y0 + s.y1) / 2 - renderer.center[1],
    size: Math.max(s.x1 - s.x0, s.y1 - s.y0),
  };
}

function choose(id) {
  state.results = [];
  const input = document.getElementById("find");
  if (input) {
    input.value = attrs[id][1] || attrs[id][0];
    input.blur();
  }
  state.query = input ? input.value : "";
  pin(id);
  // Aim at the top of its prism, from steeply above: tall neighbours would
  // hide it from a low angle.
  const c = parcelCenter(id);
  const top = Math.max(state.current.tex[id * 2] * renderer.height * (renderer.flip ? -1 : 1), 0);
  flyTo({
    x: c.x, y: c.y, z: top,
    distance: clamp(c.size * 10, 3000, 12000),
    elevation: Math.max(renderer.camera.elevation, 1.2),
  });
}

function onSearchKey(e) {
  const n = state.results.length;
  if (e.key === "ArrowDown" && n) { e.preventDefault(); state.active = (state.active + 1) % n; ui(); }
  else if (e.key === "ArrowUp" && n) { e.preventDefault(); state.active = (state.active - 1 + n) % n; ui(); }
  else if (e.key === "Enter" && n) { e.preventDefault(); choose(state.results[state.active]); }
  else if (e.key === "Escape") { state.results = []; e.target.blur(); ui(); }
}

// ---- camera flight ---------------------------------------------------------

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function flyTo(to) {
  const cam = renderer.camera;
  flight = {
    start: performance.now(),
    from: {
      x: cam.target[0], y: cam.target[1], z: cam.target[2],
      distance: cam.distance, elevation: cam.elevation,
    },
    to,
  };
  if (reduceMotion) stepFlight(Infinity);
  invalidate();
}

function stepFlight(now) {
  const { start, from, to } = flight;
  const t = Math.min((now - start) / 900, 1);
  const k = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  const cam = renderer.camera;
  cam.target[0] = from.x + (to.x - from.x) * k;
  cam.target[1] = from.y + (to.y - from.y) * k;
  cam.target[2] = from.z + (to.z - from.z) * k;
  // Distance moves in log space so a 40 km -> 2 km zoom doesn't rush the end.
  cam.distance = Math.exp(Math.log(from.distance) + (Math.log(to.distance) - Math.log(from.distance)) * k);
  cam.elevation = from.elevation + (to.elevation - from.elevation) * k;
  if (t >= 1) flight = null;
  needsDraw = true;
}

let hoverPending = null;
let hoverAt = 0;
function queueHover(x, y) {
  hoverPending = [x, y];
  const now = performance.now();
  if (now - hoverAt < 45) return;
  hoverAt = now;
  const [hx, hy] = hoverPending;
  const id = renderer.pickAt(hx, hy);
  if (id !== state.hovered) {
    state.hovered = id;
    canvas.style.cursor = id >= 0 ? "pointer" : "grab";
    ui();
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ---- render loop -----------------------------------------------------------

function frame() {
  if (flight) stepFlight(performance.now());
  if (renderer && needsDraw) {
    renderer.resize();
    renderer.render();
    needsDraw = false;
  }
  requestAnimationFrame(frame);
}

// ---- views -----------------------------------------------------------------

function view() {
  if (state.phase === "error") {
    return html`<div class="overlay"><div class="card err">
      <h1>Could not start</h1><p>${state.note}</p>
    </div></div>`;
  }
  if (state.phase !== "ready") {
    return html`<div class="overlay"><div class="card loading">
      <h1>Omaha</h1>
      <p class="sub">Assessed value per acre</p>
      <div class="bar"><i style="width:${(state.progress * 100).toFixed(0)}%"></i></div>
      <p class="note">${state.note}</p>
    </div></div>`;
  }
  return html`
    ${titleCard()}
    ${searchBox()}
    ${controls()}
    ${legend()}
    ${inspector()}
    ${state.showHelp ? helpCard() : nothing}
    ${state.showAssumptions ? assumptionsCard() : nothing}
    ${state.showBalance ? balanceCard() : nothing}
  `;
}

function titleCard() {
  const m = state.manifest;
  const c = m.cost_model;
  const b = c && data.basis ? data.basis : null;
  const metric = METRICS[state.metricId];
  return html`
    <div class="panel title">
      <h1>Omaha <span>${metric.short}</span></h1>
      <p class="blurb">${
        state.hasCost && METRICS[state.metricId].needsCost
          ? BASES[state.basisId].blurb
          : metric.blurb}</p>
      <dl class="stats">
        <div><dt>Parcels</dt><dd>${m.parcels.toLocaleString()}</dd></div>
        <div><dt>${!b ? "City tax" : b.credit < 0.999 ? "Income credited" : "Income"}</dt>
          <dd>${money(b ? b.revenue : m.estimated_city_property_tax)}</dd></div>
        ${b ? html`<div><dt>Cost</dt><dd>${money(b.cost)}</dd></div>`
            : html`<div><dt>Assessed</dt><dd>${money(m.total_assessed)}</dd></div>`}
      </dl>
      ${b ? gapNote(b) : nothing}
      ${b && (b.pots.includes("frontage") || b.pots.includes("sewer")) ? estimates() : nothing}
      ${customCount() ? html`<p class="edited-note">
        Using ${customCount()} custom ${customCount() === 1 ? "value" : "values"}.
        <button class="link inline" @click=${() => openAssumptions()}>review</button>
        <button class="link inline" @click=${() => resetEdits()}>reset all</button>
      </p>` : nothing}
      <p class="src">
        Tax year ${m.tax_year} · levy ${m.city_levy_per_100}/$100 ·
        Nebraska statewide parcels + NE DOR levy tables
        <button class="link" @click=${() => { state.showHelp = true; ui(); }}>
          how to read this
        </button>
      </p>
    </div>`;
}

/** The citywide net under the basis, and what it does and does not mean. */
function gapNote(b) {
  const small = Math.abs(b.net) < b.revenue * 0.01;
  if (small) {
    return html`<p class="shortfall flat">This basis balances citywide
      (<b>${money(b.net)}</b>), so the map shows purely who pays more or less than
      their share.</p>`;
  }
  if (b.net > 0) {
    return html`<p class="shortfall flat">Citywide surplus <b>${money(b.net)}</b> a
      year: at these estimates the tax, fees and street money cover what streets and
      sewers cost to keep up.</p>`;
  }
  return html`<p class="shortfall">Maintenance gap <b>${money(b.net)}</b> a year:
    what keeping streets and sewers renewed on schedule costs, beyond the tax, fees
    and street money that pay for them.
    ${tip("gap", "the maintenance gap", html`<p>This is not a bill that comes due each
      year. It is what renewal would cost if every street and pipe were rebuilt when
      it wore out. The city covers the difference by borrowing, and by letting
      streets and pipes wear out faster than it replaces them, which is a cost
      handed to later years.</p>
      <p><button class="link inline" style="margin:0" @click=${openBalance}>Open the balance
        sheet</button> to see every cost and income line behind it.</p>`)}
  </p>`;
}

function searchBox() {
  const ready = !!searchIndex;
  const r = state.results;
  return html`
    <div class="panel search">
      <input id="find" type="search" autocomplete="off" spellcheck="false"
        aria-label="Find an address or parcel ID"
        placeholder=${ready ? "Find an address or parcel ID  ( / )" : "Loading addresses…"}
        ?disabled=${!ready}
        @input=${(e) => {
          state.query = e.target.value;
          state.results = state.query.trim() ? search(searchIndex, state.query) : [];
          state.active = 0;
          ui();
        }}
        @focus=${(e) => {
          if (e.target.value.trim()) {
            state.results = search(searchIndex, e.target.value);
            ui();
          }
        }}
        @blur=${() => { state.results = []; ui(); }}
        @keydown=${onSearchKey} />
      ${r.length ? html`<ul class="results" role="listbox">
        ${r.map((id, k) => html`<li role="option" aria-selected=${k === state.active}
            class=${k === state.active ? "on" : ""}
            @pointerdown=${(e) => { e.preventDefault(); choose(id); }}
            @pointerenter=${() => { state.active = k; ui(); }}>
          <b>${attrs[id][1] || "No situs address"}</b>
          <span>${attrs[id][0]} · ${CLASS_NAMES[data.cls[id]]} · ${moneyFull(data.assessed[id])}</span>
        </li>`)}
      </ul>` : nothing}
      ${ready && state.query.trim() && !r.length && document.activeElement?.id === "find"
        ? html`<p class="no-match">No match</p>` : nothing}
    </div>`;
}

function controls() {
  return html`
    <div class="panel controls">
      ${state.hasCost ? html`
        <fieldset class="basis">
          <legend>Cost basis</legend>
          ${Object.entries(BASES).map(([id, b]) => html`
            <label class="radio ${id === state.basisId ? "on" : ""}">
              <input type="radio" name="basis" ?checked=${id === state.basisId}
                @change=${() => {
                  state.basisId = id;
                  applyBasis();
                  applyMetric();
                  ui();
                }} />
              <span>${b.label}</span>
            </label>`)}
          <p class="basis-note">${BASES[state.basisId].note}</p>
          ${data.basis.pots.includes("frontage") ? html`
            <label class="chk toggle">
              <input type="checkbox" ?checked=${state.shareArterials}
                @change=${(e) => {
                  state.shareArterials = e.target.checked;
                  applyStreets();
                  applyMetric();
                  ui();
                }} />
              <span>Share arterial cost citywide</span>
            </label>
            <p class="basis-note">${state.shareArterials
              ? "Lots on an arterial or collector pay what a two-lane " +
                "neighbourhood street would cost there. The extra lanes, signals " +
                "and bridges are split over every foot of street frontage in " +
                "the city."
              : "Each road's full cost goes to the lots along it, so homes on " +
                "arterials and collectors pay for the whole road."}</p>` : nothing}
          ${state.manifest.model ? html`<button class="asm-open" @click=${() => openAssumptions()}>
            Assumptions and sources${customCount() ? html` <b>${customCount()} custom</b>` : nothing}
          </button>
          <button class="asm-open bs-open" @click=${openBalance}>Balance sheet</button>` : nothing}
        </fieldset>` : nothing}

      <label class="field">
        <span>Metric</span>
        <select @change=${(e) => { state.metricId = e.target.value; applyMetric(); ui(); }}>
          ${Object.entries(METRICS)
            .filter(([, m]) => !m.needsCost || state.hasCost)
            .map(([id, m]) => html`
              <option value=${id} ?selected=${id === state.metricId}>${m.label}</option>`)}
        </select>
      </label>

      <label class="field">
        <span>Height scale</span>
        <select @change=${(e) => { state.transformId = e.target.value; applyMetric(); ui(); }}>
          ${Object.entries(TRANSFORMS).map(([id, t]) => html`
            <option value=${id} ?selected=${id === state.transformId}>${t.label}</option>`)}
        </select>
      </label>

      <label class="field">
        <span>Exaggeration <b>${state.heightScale.toFixed(1)}×</b></span>
        <input type="range" min="0.2" max="4" step="0.1" .value=${String(state.heightScale)}
          @input=${(e) => {
            state.heightScale = Number(e.target.value);
            renderer.height = BASE_HEIGHT * state.heightScale;
            invalidate(); ui();
          }} />
      </label>

      ${METRICS[state.metricId].diverging ? html`<label class="chk">
        <input type="checkbox" ?checked=${state.flip}
          @change=${(e) => setFlip(e.target.checked)} />
        <span>Show losses on top <kbd>f</kbd></span>
      </label>` : nothing}

      <fieldset class="classes">
        <legend>Property class</legend>
        ${Object.entries(CLASS_NAMES)
          .filter(([k]) => k !== "0" && k !== "6")
          .map(([k, name]) => html`
            <label class="chk">
              <input type="checkbox" ?checked=${state.visible[k]}
                @change=${(e) => {
                  state.visible[k] = e.target.checked;
                  applyMetric(); ui();
                }} />
              <span>${name}</span>
            </label>`)}
      </fieldset>
    </div>`;
}

function legend() {
  const { stats } = state.current;
  const ticks = legendTicks(state.current);
  const unit = METRICS[state.metricId].unit;
  const stops = ramp().map(([p, c]) => `${c} ${(p * 100).toFixed(0)}%`).join(",");
  return html`
    <div class="panel legend">
      <div class="lgd-title">${METRICS[state.metricId].short} <em>${unit}</em></div>
      <div class="ramp" style="background:linear-gradient(90deg,${stops})"></div>
      <div class="ticks">
        ${ticks.map((t) => html`<span style="left:${(t.frac * 100).toFixed(1)}%">
          ${money(t.value)}</span>`)}
      </div>
      <p class="lgd-note">
        ${state.current.diverging
          ? html`Colour ranks each side of zero separately, so the neutral
              midpoint is exactly break-even:
              <b>${stats.negCount.toLocaleString()}</b> parcels below
              (${(100 * stats.negCount / Math.max(stats.counted, 1)).toFixed(0)}%),
              <b>${stats.posCount.toLocaleString()}</b> above.`
          : html`Colour is a quantile scale — each band holds a quarter of the
              ${stats.counted.toLocaleString()} valued parcels.`}
        ${renderer.flip ? html`<b>Flipped:</b> losses rise and gains hang below. ` : nothing}
        Height is a value scale, full at the 99.9th percentile of magnitude
        (${money(stats.p999)}); the extremes overshoot, to ${money(stats.max)}.
      </p>
    </div>`;
}

function inspector() {
  const id = state.pinned >= 0 ? state.pinned : state.hovered;
  if (id < 0 || id >= data.parcelCount) return nothing;

  const a = attrs ? attrs[id] : null;
  const assessed = data.assessed[id];
  const acres = data.acres[id];
  const flags = data.flags[id];
  const value = state.current.raw[id];
  const pinned = state.pinned >= 0;

  // attrs layout, set by build/03_build.py:
  // 0 pin, 1 address, 2 tax district, 3 year built, 4 improved sf,
  // 5 classification code, 6 revenue, 7 cost, 8 residents, 9 employees,
  // 10 [frontage, people, residents, acres, parcels] cost breakdown.
  // Streets and sewers are explained from the re-priced model instead.
  const parts = a ? a[10] : null;
  const ex = state.hasCost && model?.priced ? explain(model, data, id, state.shareArterials) : null;
  const tax = state.hasCost ? taxUnder(data, id) : null;
  const fee = state.hasCost ? sewerFeeUnder(data, id) : 0;
  const streetMoney = state.hasCost ? streetMoneyUnder(data, id) : 0;
  const revenue = state.hasCost ? revenueUnder(data, id) : null;
  const cost = state.hasCost ? costUnder(data, id) : null;
  const net = state.hasCost ? revenue - cost : 0;
  const pots = state.hasCost ? data.basis.pots : [];

  const style = pinned
    ? nothing
    : `left:${Math.min(state.pointer.x + 18, innerWidth - 300)}px;top:${
        Math.min(state.pointer.y + 18, innerHeight - 390)}px`;

  return html`
    <div class="panel inspect ${pinned ? "pinned" : "float"}" style=${style}>
      ${pinned ? html`<button class="close"
        @click=${() => pin(-1)}>×</button>` : nothing}
      <div class="addr">${a ? (a[1] || "No situs address") : "…"}</div>
      <div class="pin">${a ? a[0] : ""} · ${CLASS_NAMES[data.cls[id]]}</div>
      ${pinned && a ? aerial(id, a[0]) : nothing}

      <dl class="rows">
        <div><dt>${METRICS[state.metricId].short}</dt>
          <dd class="big ${state.current.diverging ? (value < 0 ? "neg" : "pos") : ""}">
            ${moneyFull(value)}</dd></div>
        <div><dt>Area</dt><dd>${acres.toFixed(acres < 1 ? 3 : 2)} ac</dd></div>
        <div><dt>Assessed value</dt><dd>${moneyFull(assessed)}</dd></div>
        ${data.frontage[id] ? html`<div><dt>Street frontage</dt>
          <dd>${Math.round(data.frontage[id]).toLocaleString()} ft</dd></div>` : nothing}
      </dl>

      ${state.hasCost && a ? html`
        <div class="ledger">
          <div class="led-row">
            <span>${data.basis.credit < 0.999
              ? `City tax: the ${(data.basis.credit * 100).toFixed(0)}% for ${data.basis.pots.includes("frontage") ? "streets and sewers" : "services"}`
              : "City of Omaha property tax"}${pinned ? taxTip(id, a) : nothing}</span>
            <b class="pos">${moneyFull(tax)}</b></div>
          ${pots.includes("sewer") ? html`<div class="led-row">
            <span>Sewer bill (est.)</span>
            <b class="pos">${moneyFull(fee)}</b></div>` : nothing}
          ${streetMoney >= 0.5 ? html`<div class="led-row">
            <span>Fuel, wheel and sales tax for its streets</span>
            <b class="pos">${moneyFull(streetMoney)}</b></div>` : nothing}
          <div class="led-row"><span>Allocated cost</span>
            <b class="neg">−${moneyFull(cost)}</b></div>
          ${parts ? html`<ul class="breakdown">
            ${pots.includes("frontage") ? html`<li class="grp">
              <span>Streets</span><i>${moneyFull(data.cFrontage[id])}</i></li>
            ${ex ? html`
            <li class="sub"><span>Rebuild and resurface</span><i>${moneyFull(ex.streets.pavement)}</i></li>
            <li class="sub"><span>Upkeep: patching, snow, signals, lights</span>
              <i>${moneyFull(ex.streets.upkeep)}</i></li>
            ${ex.streets.assets >= 0.5 ? html`<li class="sub"><span>Bridges and signals</span>
              <i>${moneyFull(ex.streets.assets)}</i></li>` : nothing}
            <li class="sub"><span>${state.shareArterials
              ? "Share of arterials, bridges, unfronted streets"
              : "Share of bridges and unfronted streets"}</span>
              <i>${moneyFull(ex.streets.pooled)}</i></li>` : nothing}` : nothing}
            ${pots.includes("sewer") ? html`<li class="grp">
              <span>Sewer</span><i>${moneyFull(data.cSewer[id])}</i></li>
            ${ex ? html`
            <li class="sub"><span>Renew mains along the lot</span><i>${moneyFull(ex.sewer.renewal)}</i></li>
            <li class="sub"><span>Clean and repair them</span><i>${moneyFull(ex.sewer.cleaning)}</i></li>
            <li class="sub"><span>Plants, trunk lines, operations</span><i>${moneyFull(ex.sewer.shared)}</i></li>` : nothing}` : nothing}
            ${pots.includes("people") ? html`<li>
              <span>Police, fire, benefits</span><i>${moneyFull(parts[1])}</i></li>
            <li><span>Parks, library</span><i>${moneyFull(parts[2])}</i></li>` : nothing}
            ${pots.includes("flat") ? html`<li>
              <span>General government</span><i>${moneyFull(parts[4] + parts[3])}</i></li>` : nothing}
          </ul>` : nothing}
          <div class="led-row total"><span>Net per year</span>
            <b class=${net < 0 ? "neg" : "pos"}>${moneyFull(net)}</b></div>
          ${a[8] || a[9] ? html`<p class="who">
            ${a[8] ? `${a[8].toFixed(0)} residents` : ""}${a[8] && a[9] ? " · " : ""}${
              a[9] ? `${a[9].toFixed(0)} jobs` : ""} modelled
          </p>` : nothing}
          ${pinned && ex && (pots.includes("frontage") || pots.includes("sewer"))
            ? workings(ex, pots, id) : nothing}
        </div>` : nothing}

      ${flags & FLAG_TIF ? html`<p class="warn">
        In a TIF district — the city receives only the base valuation, so the
        revenue shown here is overstated.</p>` : nothing}
      ${flags & FLAG_EXEMPT ? html`<p class="warn">
        Tax exempt. It generates no city property tax by design, so it can only
        show as a cost. That is a category difference, not a deficiency.</p>` : nothing}
      ${pinned ? nothing : html`<p class="hint">Click to pin</p>`}
    </div>`;
}

/** The city's levy as a part of the whole tax bill the assessor shows. */
function taxTip(id, a) {
  const split = state.manifest.district_levies?.[a[2]];
  if (!split) return nothing;
  const [total, city, schools, county, other] = split;
  const v = data.assessed[id] / 100;
  const credit = data.basis.credit;
  const infra = data.basis.pots.includes("frontage");
  const share = credit < 0.999 ? html`<p>This view counts only the
      ${(credit * 100).toFixed(1)}% of city property tax that pays for
      ${infra ? "streets and sewers today: Public Works and street and sewer debt"
        : "police, fire, parks and general government"}.
      That is ${moneyFull(v * city * credit)} of this parcel's ${moneyFull(v * city)}.
      The other ${moneyFull(v * city * (1 - credit))} pays for
      ${infra ? "police, fire, parks and general government" : "streets and sewers"},
      which this view leaves out on both sides.</p>` : nothing;
  const body = data.flags[id] & FLAG_TIF
    ? html`<p>This parcel is in a TIF district, where the whole ${total} levy per $100 on
        the increase in its value goes to the redeveloper. The map counts the city's
        ${state.manifest.city_levy_per_100} as if it did not.</p>`
    : html`${share}<p>The City of Omaha's levy is ${city} of the ${total} per $100
        in this tax district: ${moneyFull(v * city)} of a ${moneyFull(v * total)} bill.</p>
      <p>The rest goes to schools (${moneyFull(v * schools)}), Douglas County
        (${moneyFull(v * county)}) and transit, the community college and the NRD
        (${moneyFull(v * other)}). They pay for their own services, not city streets
        or sewers.</p>
      <p>The assessor's tax amount is lower: it is after Nebraska's property tax credits,
        which the state funds, so the city still receives its full levy.</p>`;
  return tip(`tax-${id}`, "the city's share of the tax bill", body);
}

/** The lot from above, outlined, with links out to the assessor and Street View. */
function aerial(id, pin) {
  const s = parcelShape(id);
  const cx = (s.x0 + s.x1) / 2;
  const cy = (s.y0 + s.y1) / 2;
  // Fit the lot in about two thirds of the frame. Tiles come from one level
  // finer, drawn at half size, so they stay sharp on high-DPI screens.
  const fit = Math.max((s.x1 - s.x0) / (AERIAL_W * 0.65), (s.y1 - s.y0) / (AERIAL_H * 0.65), 0.15);
  const z = clamp(Math.floor(Math.log2((2 * MERC) / 256 / fit)), 12, 20);
  const res = (2 * MERC) / 256 / 2 ** z;
  const left = (cx + MERC) / res - AERIAL_W / 2;
  const top = (MERC - cy) / res - AERIAL_H / 2;
  const T = 128;
  const tiles = [];
  for (let ty = Math.floor(top / T); ty * T < top + AERIAL_H; ty++) {
    for (let tx = Math.floor(left / T); tx * T < left + AERIAL_W; tx++) {
      tiles.push({ tx, ty, x: tx * T - left, y: ty * T - top });
    }
  }
  const d = s.rings.map((ring) => "M" + ring.map(([x, y]) =>
    `${((x + MERC) / res - left).toFixed(1)} ${((MERC - y) / res - top).toFixed(1)}`
  ).join("L") + "Z").join("");

  const lon = (cx / MERC) * 180;
  const lat = (2 * Math.atan(Math.exp(cy / 6378137)) - Math.PI / 2) * (180 / Math.PI);
  return html`
    <div class="aerial" style="height:${AERIAL_H}px">
      ${tiles.map((t) => html`<img alt="" draggable="false"
        src="${AERIAL_TILES}/${z + 1}/${t.ty}/${t.tx}"
        style="left:${t.x.toFixed(1)}px;top:${t.y.toFixed(1)}px"
        @error=${(e) => { e.target.style.visibility = "hidden"; }} />`)}
      <svg width=${AERIAL_W} height=${AERIAL_H}><path d=${d} /></svg>
      <span>2025 aerial · Douglas County GIS</span>
    </div>
    <div class="links">
      <a href="${ASSESSOR_RECORD}${pin}" target="_blank" rel="noopener">Assessor record &amp; photo ↗</a>
      <a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lon.toFixed(6)}"
        target="_blank" rel="noopener">Street View ↗</a>
    </div>`;
}

function editCount() {
  return Object.keys(state.edits).length;
}

const fixed2 = (v) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = (v) => Math.round(v).toLocaleString("en-US");

/** One parcel's street and sewer costs as quantity x rate, line by line. */
function workings(ex, pots, id) {
  const st = ex.streets;
  const sw = ex.sewer;
  const b = ex.bill;
  const line = (label, value) => html`<div class="w-row"><span>${label}</span><i>${moneyFull(value)}</i></div>`;
  return html`
    <details class="workings">
      <summary>How this is calculated</summary>
      ${pots.includes("frontage") ? html`
        <h4>Streets</h4>
        ${st.lanes.map((l) => line(`${whole(l.lf)} lane-ft of ${l.label} × $${fixed2(l.rate)} rebuild and resurface`, l.cost))}
        ${line(`${whole(st.laneFt)} lane-ft × $${fixed2(st.upkeepRate)} upkeep`, st.upkeep)}
        ${st.deck >= 1 ? line(`${whole(st.deck)} sq ft of bridge deck × $${fixed2(st.deckRate)}`, st.deck * st.deckRate) : nothing}
        ${st.signals >= 0.01 ? line(`${fixed2(st.signals)} traffic signals × $${whole(st.signalRate)}`, st.signals * st.signalRate) : nothing}
        ${st.otherSignals >= 0.01 ? line(`${fixed2(st.otherSignals)} other signals × $${whole(st.otherSignalRate)}`, st.otherSignals * st.otherSignalRate) : nothing}
        ${line(`${whole(st.frontage)} ft of frontage × $${fixed2(st.poolRate)} citywide share`, st.pooled)}
        ${st.creditShare > 0 ? line(`Fuel, wheel and sales tax pay ${(100 * st.creditShare).toFixed(1)}% of
          that ${moneyFull(data.cFrontage[id])}`, st.creditShare * data.cFrontage[id]) : nothing}
        <p class="w-note">Lane-feet are this lot's share of the street in front:
          frontage times lanes, split with the lots across the street${state.shareArterials
            ? ", and priced as a two-lane neighbourhood street on arterials" : ""}.
          Rates are dollars a year per lane-foot.</p>` : nothing}
      ${pots.includes("sewer") ? html`
        <h4>Sewer</h4>
        ${sw.pipeFt >= 1 ? line(`${whole(sw.pipeFt)} ft of ${Math.round(sw.diameter)}-inch main × $${fixed2(sw.renewalRate)} renewal, ${whole(sw.lined)}% by lining`, sw.renewal) : nothing}
        ${sw.pipeFt >= 1 ? line(`${whole(sw.pipeFt)} ft × $${fixed2(sw.cleanRate)} cleaning`, sw.cleaning) : nothing}
        ${line(`${moneyFull(sw.fee)} bill ÷ ${money(sw.feesTotal)} of city bills × ${money(sw.pool)} shared system`, sw.shared)}
        <h4>Sewer bill</h4>
        ${line(`12 × ($${b.customer} × ${whole(b.accounts)} ${b.accounts === 1 ? "account" : "accounts"}
          + ${Number.isInteger(b.count) ? whole(b.count) : fixed2(b.count)} ${b.kind}${b.count === 1 ? "" : "s"} × ${b.usage} CCF × $${b.flow})`, sw.fee)}` : nothing}
      <button class="link" @click=${() => openAssumptions()}>
        Where these rates come from</button>
    </details>`;
}

const POSITIVE_UNITS = new Set(["years"]);

function paramInput(p, label) {
  const defaults = state.manifest.model.assumptions;
  const d = getParam(defaults, p.path);
  const v = paramValue(p.path);
  const edited = p.path in state.edits;
  const positive = POSITIVE_UNITS.has(p.unit) || p.path === "sewer/fee_revenue_systemwide";
  const max = p.unit === "%" ? 100 : Infinity;
  return html`<input type="number" class="num ${edited ? "edited" : ""}" step="any" min="0"
    max=${p.unit === "%" ? "100" : nothing}
    .value=${String(v)} ?disabled=${!state.modelReady} aria-label=${label}
    title=${edited ? `Default: ${d.toLocaleString("en-US")}` : ""}
    @input=${(e) => setParam(p.path, e.target.value, { positive, max })} />`;
}

function paramHint(p) {
  const d = getParam(state.manifest.model.assumptions, p.path);
  const v = paramValue(p.path);
  const big = p.unit.startsWith("$") && v >= 10000 ? money(v) : "";
  return html`<span class="hint">${big}${p.path in state.edits
    ? html`${big ? " · " : ""}was ${p.unit.startsWith("$") && d >= 10000 ? money(d) : d.toLocaleString("en-US")}
      <button class="reset" aria-label="Reset to ${d.toLocaleString("en-US")}" title="Reset"
        @click=${() => resetEdits([p.path])}>↺</button>` : nothing}</span>`;
}

function sourceLinks(ids, sources) {
  if (!ids || !ids.length) return nothing;
  return html`<span class="srcs">${ids.map((id, k) => html`${k ? "; " : ""}<a href=${sources[id].url}
    target="_blank" rel="noopener">${sources[id].title}</a>`)}</span>`;
}

/** Notes from parameters.json as a tip's body: text, an estimate tag, source links. */
function notesBody(notes) {
  const sources = state.manifest.model.meta.sources;
  return notes.map((n) => html`<p>${n.estimate ? html`<span class="tag">estimate</span>` : nothing}${n.text}
    ${sourceLinks(n.sources, sources)}</p>`);
}

function infoTip(key, label, notes) {
  if (!notes || !notes.length) return nothing;
  return tip(key, label, notesBody(notes), { estimate: notes.some((n) => n.estimate) });
}

function groupPaths(g) {
  if (g.params) return g.params.map((p) => p.path);
  return g.table.rows.flatMap((row) => g.table.cols.map((c) => c.path.replace("{row}", row)));
}

const was = (now, then) => (then != null && Math.abs(now - then) > 0.5
  ? html` <em>was ${money(then)}</em>` : nothing);

function assumptionsCard() {
  const meta = state.manifest.model.meta;
  const c = state.manifest.cost_model;
  return html`
    <div class="overlay soft" @click=${closeAssumptions}>
      <div class="card asm" @click=${(e) => e.stopPropagation()}>
        <div class="asm-head">
          <h1 id="asm-title" tabindex="-1">Assumptions and sources</h1>
          <button class="close" aria-label="Close" @click=${closeAssumptions}>×</button>
        </div>
        <p class="asm-intro">Every number behind the map: what it is, how it was worked
          out, and where it came from. Hover over or tab to an
          <span class="tip-btn demo" aria-hidden="true">i</span> to see what a value
          means and its sources; an <span class="tip-btn tip-est demo" aria-hidden="true">i</span>
          marks an estimate. Edit any value and the map re-prices all
          ${state.manifest.parcels.toLocaleString()} parcels. Edits stay in this browser.</p>
        ${state.city ? html`${ledger()}${movers()}` : html`<p class="note">Loading the cost model…</p>`}
        ${editCount() ? html`<button class="link" @click=${() => resetEdits()}>
          ${editCount() === 1 ? "Reset the edit" : `Reset all ${editCount()} edits`}</button>` : nothing}
        ${meta.groups.map((g) => groupSection(g))}
        ${meta.services && meta.budget ? servicesSection(meta, c) : nothing}
        ${fixedSection(meta, c)}
        <details class="asm-sources">
          <summary>All ${Object.keys(meta.sources).length} sources</summary>
          <ul>${Object.values(meta.sources).map((s) => html`<li>
            <a href=${s.url} target="_blank" rel="noopener">${s.title}</a></li>`)}</ul>
        </details>
      </div>
    </div>`;
}

/** Every cost and income line for a year, as bars on one scale, and the gap between. */
function ledger() {
  const c = state.city;
  const L = ledgerFrom(c);
  const D = defaultCity ? ledgerFrom(defaultCity) : null;
  const cm = state.manifest.cost_model;
  const costs = [
    ["pavement", "Street pavement", c.pavement],
    ["upkeep", "Street upkeep", c.upkeep],
    ["assets", "Bridges and signals", c.assets],
    ["pipes", "Sewer mains", c.mains],
    ["system", "Sewer plants and operations", c.plants],
    ["services", "Police, fire, parks, government", L.services],
  ];
  const income = [
    ["fixed", "City property tax", cm.property_tax],
    ["bills", "Sewer bills", c.fees],
    ["street_funding", "Fuel, wheel and sales tax for streets", L.streetMoney],
  ];
  const max = Math.max(...costs.map((r) => r[2]), ...income.map((r) => r[2]));
  const rows = (list, kind) => list.map(([id, label, v]) => html`<li>
    <button class="led-link" @click=${() => goTo(id)}>${label}</button>
    <span class="led-track"><span class="led-bar ${kind}" style="width:${(100 * v / max).toFixed(1)}%"></span></span>
    <b>${money(v)}</b></li>`);
  return html`<section class="money" aria-labelledby="money-h">
    <h2 id="money-h">A year of streets, sewers and services</h2>
    <div class="money-cols">
      <div><h3>Cost <b>${money(L.cost)}</b>${was(L.cost, D?.cost)}</h3><ul>${rows(costs, "cost")}</ul></div>
      <div><h3>Income <b>${money(L.income)}</b>${was(L.income, D?.income)}</h3><ul>${rows(income, "income")}</ul></div>
    </div>
    <p class="money-net">${L.net < 0 ? "Maintenance gap" : "Surplus"}
      <b class=${L.net < 0 ? "neg" : "pos"}>${money(L.net)}</b> a year${was(L.net, D?.net)}.
      Fuel, wheel and sales tax pay ${(100 * c.streetCredit).toFixed(0)}% of every street's cost.
      Services balance by construction, so the gap is all streets and sewers.
      <button class="link inline" @click=${openBalance}>See the balance sheet</button></p>
  </section>`;
}

/** How far each cost estimate switch moves the gap, with every other value as it is. */
/**
 * The citywide gap at each level of each cost estimate switch, with every
 * other value as it is now. Biggest spread first.
 */
function moverRows() {
  const rows = quickGroups().map((g) => {
    const current = currentLevel(g);
    const points = g.quick.levels.map((level) => {
      const A = withEdits(model.defaults, { ...state.edits, ...levelEdits(g, level) });
      return { level, net: ledgerFrom(cityTotals(model, A)).net, on: level === current };
    });
    const nets = points.map((p) => p.net);
    return { g, points, lo: Math.min(...nets), hi: Math.max(...nets) };
  });
  return rows.sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo));
}

function movers() {
  const rows = moverRows();
  if (!rows.length) return nothing;
  const now = ledgerFrom(state.city).net;
  const lo = Math.min(now, ...rows.map((r) => r.lo));
  const hi = Math.max(now, ...rows.map((r) => r.hi));
  const x = (v) => (100 * (v - lo)) / (hi - lo || 1);
  return html`<section class="movers" aria-labelledby="movers-h">
    <h2 id="movers-h">What moves the gap</h2>
    <p class="mv-note">The citywide gap at each setting of a cost estimate switch, with every
      other value as it is now. Biggest first; the ringed dot is the current setting.</p>
    <ul>${rows.map(({ g, points, lo: a, hi: b }) => html`<li>
      <button class="led-link" @click=${() => goTo(g.id)}>${g.quick.label}</button>
      <span class="mv-track" role="img"
        aria-label=${points.map((p) => `${p.level.label} ${money(p.net)}`).join(", ")}>
        <span class="mv-now" style="left:${x(now).toFixed(2)}%"></span>
        <span class="mv-range" style="left:${x(a).toFixed(2)}%;width:${(x(b) - x(a)).toFixed(2)}%"></span>
        ${points.map((p) => html`<span class="mv-dot ${p.on ? "on" : ""}" style="left:${x(p.net).toFixed(2)}%"
          title="${p.level.label}: ${money(p.net)}"></span>`)}
      </span>
      <span class="mv-vals">${money(a)} to ${money(b)}</span>
    </li>`)}</ul>
  </section>`;
}

function groupSection(g) {
  const total = groupTotal(g.id);
  const paths = groupPaths(g);
  const level = g.quick ? currentLevel(g) : null;
  return html`<section class="asm-group" id=${`asm-${g.id}`}>
    <header>
      <h2 tabindex="-1">${g.title}</h2>
      ${infoTip(`about-${g.id}`, g.title, g.about)}
      ${total != null ? html`<span class="asm-sum ${g.kind}">${g.kind === "income" ? "+" : ""}${money(total)} a year</span>` : nothing}
      ${paths.some((p) => p in state.edits) ? html`<button class="link inline"
        @click=${() => resetEdits(paths)}>reset section</button>` : nothing}
    </header>
    ${g.quick ? html`<div class="asm-level">
      ${levelSwitch(g, "asm")}
      <p>${level ? level.text : "Custom values: set below."}</p>
    </div>` : nothing}
    <p class="asm-what">${g.what}</p>
    <p class="asm-how">${g.how}</p>
    ${g.table ? html`
      <div class="asm-table-wrap"><table class="asm-table">
        <thead><tr><td></td>${g.table.cols.map((col, k) => html`
          <th scope="col"><span class="th-l">${col.label}${infoTip(`${g.id}-col-${k}`, col.label, col.info)}</span>
            <small>${col.unit}</small></th>`)}</tr></thead>
        <tbody>${g.table.rows.map((row) => html`<tr>
          <th scope="row">${row}</th>
          ${g.table.cols.map((col) => {
            const p = { path: col.path.replace("{row}", row), unit: col.unit };
            return html`<td>${paramInput(p, `${row} ${col.label}, ${col.unit}`)}</td>`;
          })}
        </tr>`)}</tbody>
      </table></div>` : html`
      <div class="asm-params">${g.params.map((p, k) => html`
        <div class="asm-param">
          <span class="lbl">${p.label}${infoTip(`${g.id}-p-${k}`, p.label, p.info)}</span>
          ${paramInput(p, `${p.label}, ${p.unit}`)}
          <span class="unit">${p.unit}</span>
          ${paramHint(p)}
        </div>`)}</div>`}
  </section>`;
}

const ALLOCATORS = {
  people: "People", residents: "Residents", parcels: "Per parcel", acres: "Area",
  frontage: "Streets (credit)",
};

/** The services side, read-only: each budget line and what property tax pays of it. */
function servicesSection(meta, c) {
  const s = meta.services;
  const rows = meta.budget.map((r) => ({
    ...r,
    paid: r.unit === "dollars" ? r.amount * c.gf_share : (c.assessed_total * r.amount) / 10000,
  }));
  const total = rows.filter((r) => r.allocator !== "frontage").reduce((a, r) => a + r.paid, 0);
  return html`<section class="asm-group" id="asm-services">
    <header>
      <h2 tabindex="-1">${s.title}</h2>
      <span class="asm-sum cost">${money(total)} a year</span>
    </header>
    <p class="asm-what">${s.what}</p>
    <p class="asm-how">${s.how}</p>
    <div class="asm-table-wrap"><table class="asm-table svc">
      <thead><tr><th scope="col">Budget line</th>${s.cols.map((col, k) => html`
        <th scope="col"><span class="th-l">${col.label}${infoTip(`svc-col-${k}`, col.label, col.info)}</span></th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr class=${r.allocator === "frontage" ? "credit" : ""}>
        <th scope="row">${r.item}</th>
        <td>${r.unit === "dollars" ? money(r.amount) : `${r.amount}¢ levy`}</td>
        <td>${money(r.paid)}</td>
        <td>${ALLOCATORS[r.allocator] || r.allocator}</td>
      </tr>`)}</tbody>
    </table></div>
  </section>`;
}

function fixedSection(meta, c) {
  return html`<section class="asm-group" id="asm-fixed">
    <header>
      <h2 tabindex="-1">Fixed in the build</h2>
      ${tip("about-fixed", "values fixed in the build", html`<p>These change what is
        measured rather than what it costs, so changing them means editing
        <code>config/assumptions.json</code> or <code>config/budget.csv</code> and
        re-running <code>build/05_costs.py</code>.</p>`)}
    </header>
    <dl class="fixed">${meta.fixed.map((f, k) => html`<div>
      <dt>${f.label}${infoTip(`fixed-${k}`, f.label, [{ text: f.how, sources: f.sources, estimate: f.estimate }])}</dt>
      <dd>${fixedValue(f, c)}</dd>
    </div>`)}</dl>
  </section>`;
}

function fixedValue(f, c) {
  if (f.path === "_credit") return `${(c.bases.infrastructure.credit * 100).toFixed(1)}%`;
  if (f.path === "_services") return `${money(c.service_cost)} a year`;
  if (f.path === "_levy") return `${state.manifest.city_levy_per_100} per $100 · ${money(c.property_tax)} a year`;
  return `${getParam(state.manifest.model.assumptions, f.path)} ${f.unit || ""}`.trim();
}

// ---- balance sheet ---------------------------------------------------------------
//
// One year of the city's books, worked down to its inputs and priced live
// from the current values, so the cost estimate switches and edits move it.

const m1 = (v) => `${v <= -0.05e6 ? "−" : ""}$${(Math.abs(v) / 1e6).toFixed(1)}M`;
const n0 = (v) => Math.round(v).toLocaleString("en-US");
const usd = (v) => `$${Number(v).toLocaleString("en-US")}`;

function balanceCard() {
  return html`
    <div class="overlay soft" @click=${closeBalance}>
      <div class="card asm bs" @click=${(e) => e.stopPropagation()}>
        <div class="asm-head">
          <h1 id="bs-title" tabindex="-1">Balance sheet</h1>
          <button class="close" aria-label="Close" @click=${closeBalance}>×</button>
        </div>
        ${state.city && state.A ? balanceBody() : html`<p class="note">Loading the cost model…</p>`}
      </div>
    </div>`;
}

/** Scroll the balance sheet to one of its sections. */
function bsGo(id) {
  document.getElementById(`bs-${id}`)?.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
}

function balanceBody() {
  const A = state.A;
  const c = state.city;
  const L = ledgerFrom(c);
  const cm = state.manifest.cost_model;
  const meta = state.manifest.model.meta;
  const q = cm.model.city_q;
  const mains = cm.model.mains;
  const sum = model.sum;
  const g = (p) => getParam(A, p);
  const items = (p) => Object.entries(g(p)).filter(([k]) => !k.startsWith("_"));
  const infra = state.bases.infrastructure;

  // Streets: each class's lane-feet, asphalt then concrete, in the city's quantity vector.
  const nc = CLASSES.length;
  const pave = CLASSES.map((cls, i) => {
    const lf = q[i] + q[nc + i];
    const rb = g(`streets/reconstruct_per_lane_ft/${cls}`);
    const life = g(`streets/reconstruct_life_years/${cls}`);
    const every = g(`streets/resurface_interval_years/${cls}`);
    const ov = g(`streets/resurface_per_lane_ft/overlay/${cls}`);
    const cc = g(`streets/resurface_per_lane_ft/concrete/${cls}`);
    return { cls, lf, rb, life, every, ov, cc, rebuild: (lf * rb) / life, resurf: (q[i] * ov + q[nc + i] * cc) / every };
  });
  const unimproved = q[2 * nc];
  const laneFt = q.slice(0, 2 * nc + 1).reduce((a, b) => a + b, 0);
  const rebuild = pave.reduce((a, r) => a + r.rebuild, 0);
  const resurf = pave.reduce((a, r) => a + r.resurf, 0);
  const upkeep = items("streets/upkeep/items").sort((a, b) => b[1] - a[1]);
  const [deck, signals, peds] = [q[2 * nc + 1], q[2 * nc + 2], q[2 * nc + 3]];
  const sigLife = g("streets/signals/life_years");

  // Sewers.
  const run = (k) => {
    const ft = mains[`${k}_ft`];
    return { mi: ft / 5280, inch: mains[`${k}_ft_in`] / ft, renewal: pipeRenewal(A, ft, mains[`${k}_ft_in`]), clean: c.clean * ft };
  };
  const big = run("big");
  const trunk = run("trunk");
  const off = run("off_street");
  const p = c.sewerParts;
  const pct = `${(100 * c.inCity).toFixed(1)}%`;
  const ops = items("sewer/operations/items").sort((a, b) => b[1] - a[1]);
  const opsTotal = ops.reduce((a, [, v]) => a + v, 0);
  const fac = items("sewer/facilities/items");
  const facTotal = fac.reduce((a, [, v]) => a + v.replacement_value / v.life_years, 0);
  const shared = p.trunk_lines + p.mains_off_street + p.operations + p.facilities;
  const lined = g("sewer/pipe/lined_percent");

  // Services and property tax.
  const gf = cm.gf_share;
  const rows = meta.budget.map((r) => ({
    ...r, paid: r.unit === "dollars" ? r.amount * gf : (cm.assessed_total * r.amount) / 10000,
  }));
  const svc = rows.filter((r) => r.allocator !== "frontage").sort((a, b) => b.paid - a.paid);
  const toStreets = rows.filter((r) => r.allocator === "frontage");
  const svcTotal = svc.reduce((a, r) => a + r.paid, 0);
  const streetsTax = toStreets.reduce((a, r) => a + r.paid, 0);
  const credit = cm.bases.infrastructure.credit;

  // Sewer bills, by who is billed.
  const cust = g("sewer/fees/customer_charge_monthly");
  const flow = g("sewer/fees/flow_charge_per_ccf");
  const use = ["single_family_unit", "multi_family_unit", "per_employee"].map((u) => g(`sewer/usage_ccf_per_month/${u}`));
  const bill = (k) => 12 * (sum.accountsBy[k] * cust + sum.count[k] * use[k] * flow);
  const streetMoney = items("streets/other_street_funding/items");

  const settings = quickGroups().map((qg) => `${qg.quick.label}: ${currentLevel(qg)?.label ?? "custom"}`);
  const est = html`<span class="bs-est">est.</span>`;
  const row = (label, value, cls = "", how = nothing) => html`<tr class=${cls}>
    <td>${label}</td>${how === nothing ? nothing : html`<td class="how">${how}</td>`}<td class="n">${value}</td></tr>`;

  return html`
    <p class="asm-intro">One year of the city's streets, sewers and services, worked down to
      the numbers behind each line. It is priced at the map's current settings, so the cost
      estimate switches and any edits change it.</p>
    <p class="bs-settings">${settings.join(" · ")}${customCount() ? ` · ${customCount()} custom values` : ""}</p>
    <dl class="bs-figs">
      <div class="cost"><dt>Cost</dt><dd>${m1(L.cost)}</dd></div>
      <div class="income"><dt>Income</dt><dd>${m1(L.income)}</dd></div>
      <div class="gap"><dt>${L.net < 0 ? "Gap" : "Surplus"}</dt><dd>${m1(L.net)}</dd></div>
    </dl>
    <p class="bs-note"><b>Infrastructure only</b> leaves police, fire, parks and general
      government out of both columns: cost ${m1(infra.cost)}, income ${m1(infra.revenue)},
      ${infra.net < 0 ? "gap" : "surplus"} ${m1(infra.net)}.</p>

    <section class="bs-sec" id="bs-statement">
      <h2>The statement</h2>
      <div class="bs-wrap"><table class="bs-table">
        <tbody>
          <tr class="head"><td colspan="2">Cost</td></tr>
          ${row(html`<button class="led-link" @click=${() => bsGo("streets")}>Streets</button>`, m1(c.streets), "grp")}
          ${row("Pavement: rebuilding and resurfacing", m1(c.pavement), "sub")}
          ${row("Upkeep: patching, snow, sweeping, signals, lights", m1(c.upkeep), "sub")}
          ${row("Bridges and traffic signals", m1(c.assets), "sub")}
          ${row(html`<button class="led-link" @click=${() => bsGo("sewers")}>Sewers</button>`, m1(c.sewer), "grp")}
          ${row("Mains along lots, renewal and cleaning", m1(c.localRenewal + c.localClean), "sub")}
          ${row("Large mains, over 18 inches", m1(p.large_mains), "sub")}
          ${row("Mains under streets no parcel fronts", m1(p.unfronted_mains), "sub")}
          ${row("City's share of trunk lines, plants, pump stations and operations", m1(shared), "sub")}
          ${row(html`<button class="led-link" @click=${() => bsGo("services")}>Police, fire, parks and general government</button>`, m1(L.services), "grp")}
          ${row("Total cost", m1(L.cost), "tot")}
          <tr class="head"><td colspan="2">Income</td></tr>
          ${row(html`<button class="led-link" @click=${() => bsGo("tax")}>City property tax</button>`, m1(cm.property_tax), "grp")}
          ${row(`The part that pays for streets and sewers (${(100 * credit).toFixed(1)}%)`, m1(cm.property_tax * credit), "sub")}
          ${row(`The part that pays for services (${(100 * (1 - credit)).toFixed(1)}%)`, m1(cm.property_tax * (1 - credit)), "sub")}
          ${row(html`<button class="led-link" @click=${() => bsGo("bills")}>Sewer bills</button>`, m1(c.fees), "grp")}
          ${row(html`<button class="led-link" @click=${() => bsGo("street-money")}>Fuel, wheel and sales tax for streets</button>`, m1(L.streetMoney), "grp")}
          ${row("Total income", m1(L.income), "tot")}
          ${row(L.net < 0 ? "Gap: what keeping it all up costs beyond the money for it" : "Surplus", m1(L.net), "gapline")}
        </tbody>
      </table></div>
      <p class="bs-note">Streets and sewers are priced at what it takes to keep them up over
        their lives: rebuild each street and pipe when it wears out, plus the city's actual
        day-to-day upkeep. That is more than the city spends today, which is why there is a
        gap. Services are priced at what the budget spends, so they balance. Lines may not add
        exactly because of rounding.</p>
    </section>

    <section class="bs-sec" id="bs-streets">
      <h2>Streets <span>${m1(c.streets)}</span></h2>
      <p>From Public Works' own street inventory: ${n0(laneFt / 5280)} lane-miles of city
        street, priced per lane-foot, one foot of one lane.</p>
      <h3>Pavement: rebuilding and resurfacing <span>${m1(c.pavement)}</span></h3>
      <p>Each lane-foot costs, per year, its rebuild cost divided by the years between
        rebuilds, plus its resurfacing cost divided by the years between resurfacings. Asphalt
        streets get a mill-and-overlay; concrete gets panel and joint repair.</p>
      <div class="bs-wrap"><table class="bs-table wide">
        <thead><tr><th>Street type</th><th class="n">Lane-miles</th><th>Rebuild</th><th>Resurface</th>
          <th class="n">Rebuild a year</th><th class="n">Resurface a year</th></tr></thead>
        <tbody>
          ${pave.map((r) => html`<tr>
            <td>${r.cls}</td><td class="n">${n0(r.lf / 5280)}</td>
            <td class="how">${usd(r.rb)} a lane-ft every ${r.life} yr ${est}</td>
            <td class="how">asphalt ${usd(r.ov)}, concrete ${usd(r.cc)}, every ${r.every} yr</td>
            <td class="n">${m1(r.rebuild)}</td><td class="n">${m1(r.resurf)}</td></tr>`)}
          <tr><td>Unimproved</td><td class="n">${n0(unimproved / 5280)}</td>
            <td class="how" colspan="2">no rebuild: owners pay to bring them up to standard</td>
            <td class="n">—</td><td class="n">—</td></tr>
          <tr class="tot"><td>Total</td><td class="n">${n0(laneFt / 5280)}</td><td></td><td></td>
            <td class="n">${m1(rebuild)}</td><td class="n">${m1(resurf)}</td></tr>
        </tbody>
      </table></div>
      <h3>Upkeep <span>${m1(c.upkeep)}</span></h3>
      <p>The city's 2026 budget for running its streets, spread evenly over every lane-foot:
        $${(c.upkeep / laneFt).toFixed(2)} a lane-foot a year.</p>
      <div class="bs-wrap"><table class="bs-table">
        <tbody>
          ${upkeep.map(([k, v]) => row(k, m1(v)))}
          ${row("Total", m1(c.upkeep), "tot")}
        </tbody>
      </table></div>
      <h3>Bridges and traffic signals <span>${m1(c.assets)}</span></h3>
      <div class="bs-wrap"><table class="bs-table">
        <tbody>
          ${row("City bridges", m1((deck * g("streets/bridges/cost_per_sf")) / g("streets/bridges/life_years")), "",
            html`${n0(deck)} sq ft of deck × ${usd(g("streets/bridges/cost_per_sf"))} a sq ft ÷ ${g("streets/bridges/life_years")} yr`)}
          ${row(`${n0(signals)} signalized intersections`, m1((signals * g("streets/signals/replace_cost/TRAFFIC")) / sigLife), "",
            html`× ${usd(g("streets/signals/replace_cost/TRAFFIC"))} to rebuild ${est} ÷ ${sigLife} yr`)}
          ${row(`${n0(peds)} pedestrian signals and beacons`, m1((peds * g("streets/signals/replace_cost/_default")) / sigLife), "",
            html`× ${usd(g("streets/signals/replace_cost/_default"))} ${est} ÷ ${sigLife} yr`)}
          ${row("Total", m1(c.assets), "tot", "")}
        </tbody>
      </table></div>
    </section>

    <section class="bs-sec" id="bs-sewers">
      <h2>Sewers <span>${m1(c.sewer)}</span></h2>
      <p>${n0(mains.total_ft / 5280)} miles of city-owned main, the treatment plants, pump
        stations and CSO works. Renewal is ${lined}% lining pipe from inside ${est}
        (${usd(g("sewer/pipe/lining_cost_per_inch_diameter"))} per inch of diameter per foot,
        every ${g("sewer/pipe/lining_life_years")} years) and ${100 - lined}% digging it up and
        replacing it (${usd(g("sewer/pipe/cost_base_per_ft"))} + ${usd(g("sewer/pipe/cost_per_inch_diameter"))}
        per inch per foot, every ${g("sewer/pipe/service_life_years")} years).</p>
      <p>The plants, trunk lines and operations also serve Bellevue, Papillion, La Vista,
        Ralston and others. Omaha's own sewer bills (${m1(c.fees)}) are ${pct} of the
        ${m1(g("sewer/fee_revenue_systemwide"))} the system collects, so the shared parts are
        charged at ${pct}.</p>
      <div class="bs-wrap"><table class="bs-table wide">
        <tbody>
          ${row("Mains along lots, 18 inches and under", m1(c.localRenewal + c.localClean), "grp", "")}
          ${row("Renewal", m1(c.localRenewal), "sub", `${n0(sum.pipeFt / 5280)} miles, average ${(sum.pipeFtIn / sum.pipeFt).toFixed(1)} inches`)}
          ${row("Cleaning and repair", m1(c.localClean), "sub",
            `${m1(items("sewer/pipe_upkeep/items").reduce((a, [, v]) => a + v, 0))} budget ÷ ${n0(mains.total_ft / 5280)} miles of main = $${c.clean.toFixed(2)} a foot`)}
          ${row("Large mains, over 18 inches", m1(p.large_mains), "grp",
            `${n0(big.mi)} miles, average ${big.inch.toFixed(0)} inches: renewal ${m1(big.renewal)} + cleaning ${m1(big.clean)}`)}
          ${row("Mains under streets no parcel fronts", m1(p.unfronted_mains), "grp", "")}
          ${row(`Shared with neighbouring cities, at ${pct}`, m1(shared), "grp", "")}
          ${row("Trunk lines", m1(p.trunk_lines), "sub", `${n0(trunk.mi)} miles: ${m1(trunk.renewal + trunk.clean)} × ${pct}`)}
          ${row("Mains off the street grid", m1(p.mains_off_street), "sub", `${n0(off.mi)} miles: ${m1(off.renewal + off.clean)} × ${pct}`)}
          ${row("Operations", m1(p.operations), "sub",
            html`${ops.map(([k, v]) => `${k.replace(/\s*\(\d+\)$/, "")} ${m1(v)}`).join("; ")}: ${m1(opsTotal)} × ${pct}`)}
          ${row("Plants, pump stations, CSO works", m1(p.facilities), "sub",
            html`${fac.map(([k, v]) => `${k}: ${money(v.replacement_value)} ÷ ${v.life_years} yr`).join("; ")} ${est} = ${m1(facTotal)} × ${pct}`)}
          ${row("Total", m1(c.sewer), "tot", "")}
        </tbody>
      </table></div>
    </section>

    <section class="bs-sec" id="bs-services">
      <h2>Police, fire, parks and general government <span>${m1(svcTotal)}</span></h2>
      <p>Charged at the share property tax pays for. Property tax is
        ${(100 * gf).toFixed(1)}% of the General Fund, so each General Fund line counts at that
        share; the debt, redevelopment and judgment levies are property tax outright.</p>
      <div class="bs-wrap"><table class="bs-table">
        <thead><tr><th>2026 budget line</th><th class="n">Budget</th><th class="n">Property tax pays</th></tr></thead>
        <tbody>
          ${svc.map((r) => html`<tr><td>${r.item}</td>
            <td class="n">${r.unit === "dollars" ? m1(r.amount) : `${r.amount}¢ levy`}</td>
            <td class="n">${m1(r.paid)}</td></tr>`)}
          <tr class="tot"><td>Total</td><td></td><td class="n">${m1(svcTotal)}</td></tr>
        </tbody>
      </table></div>
    </section>

    <section class="bs-sec" id="bs-tax">
      <h2>City property tax <span>${m1(cm.property_tax)}</span></h2>
      <p>${m1(cm.assessed_total)} of assessed value × the City of Omaha's levy of
        ${state.manifest.city_levy_per_100} per $100. Only the city's part of each tax bill:
        schools, Douglas County, transit, the community college and the NRD levy their own.</p>
      <div class="bs-wrap"><table class="bs-table">
        <tbody>
          ${row("Streets and sewers", m1(streetsTax), "grp")}
          ${toStreets.map((r) => row(r.unit === "dollars"
            ? `${r.item}, General Fund: ${m1(r.amount)} × ${(100 * gf).toFixed(1)}%`
            : html`${r.item}, ${r.amount}¢ ${est}`, m1(r.paid), "sub"))}
          ${row("Police, fire, parks and general government (above)", m1(svcTotal), "grp")}
          ${row("Property-tax-funded spending", m1(streetsTax + svcTotal), "tot")}
        </tbody>
      </table></div>
      <p class="bs-note">Streets and sewers get ${(100 * credit).toFixed(1)}% of that spending,
        so they are credited ${(100 * credit).toFixed(1)}% of the ${m1(cm.property_tax)} actually
        collected: ${m1(cm.property_tax * credit)}. The street and sewer bond levy assumes 45% of
        the debt levy repays street and sewer bonds; that split has not been checked against
        the budget's debt schedule.</p>
    </section>

    <section class="bs-sec" id="bs-bills">
      <h2>Sewer bills <span>${m1(c.fees)}</span></h2>
      <p>M.U.D.'s 2026 Omaha rates: ${usd(cust)} a month per account, plus ${usd(flow)} per CCF
        (748 gallons) of water. Water use per property isn't public, so it is estimated.</p>
      <div class="bs-wrap"><table class="bs-table wide">
        <tbody>
          ${row(`${n0(sum.accountsBy[0])} houses and duplex units`, m1(bill(0)), "",
            `12 × (${usd(cust)} + ${use[0]} CCF × ${usd(flow)}) = ${moneyFull(12 * (cust + use[0] * flow))} each`)}
          ${row(`${n0(sum.count[1])} apartments in ${n0(sum.accountsBy[1])} buildings`, m1(bill(1)), "",
            html`one account per building, ${use[1]} CCF per apartment ${est}`)}
          ${row(`${n0(sum.accountsBy[2])} businesses and institutions`, m1(bill(2)), "",
            html`one account each, ${use[2]} CCF per estimated worker ${est}`)}
          ${row("Total", m1(c.fees), "tot", "")}
        </tbody>
      </table></div>
    </section>

    <section class="bs-sec" id="bs-street-money">
      <h2>Fuel, wheel and sales tax for streets <span>${m1(L.streetMoney)}</span></h2>
      <p>Money the city has for streets that isn't property tax. No parcel pays it directly,
        so on the map it covers the same share of every parcel's street cost:
        ${(100 * c.streetCredit).toFixed(1)}%.</p>
      <div class="bs-wrap"><table class="bs-table">
        <tbody>
          ${streetMoney.map(([k, v]) => row(k, m1(v)))}
          ${row("Total", m1(c.otherStreet), "tot")}
        </tbody>
      </table></div>
      <p class="bs-note">Borrowing isn't counted: bonds are repaid from the debt levy, which is
        already in property tax.</p>
    </section>

    <section class="bs-sec" id="bs-soft">
      <h2>The numbers to question first</h2>
      <p>Lines marked ${est} are judgement, not Omaha figures. The switches, biggest first,
        and the gap at each end of their range with everything else as it is now:</p>
      <ul class="bs-flags">
        ${moverRows().map((r) => html`<li><b>${r.g.quick.label}</b>: ${m1(r.lo)} to ${m1(r.hi)}.
          <button class="link inline" @click=${() => openAssumptions(r.g.id)}>See the values</button></li>`)}
        <li><b>Worker estimates for business sewer bills</b> come from floor area at office
          density, which overstates warehouses and parking garages. This moves who pays more
          than the total.</li>
        <li><b>The 45% of the debt levy</b> assumed to repay street and sewer bonds moves money
          between the two property tax lines, not the total.</li>
      </ul>
    </section>`;
}

function helpCard() {
  return html`
    <div class="overlay soft" @click=${() => { state.showHelp = false; ui(); }}>
      <div class="card help" @click=${(e) => e.stopPropagation()}>
        <h1>How to read this</h1>
        <p>
          Every parcel in the City of Omaha is drawn at its true footprint and
          extruded by <b>what it returns per acre</b>. A small downtown lot can
          out-produce a thirty-acre site several times over — that gap is the
          entire point of the view, and it disappears if you look at totals
          instead of density.
        </p>
        <p>
          Parcels above the plane pay more in city property tax, sewer fees
          and street money than the services and infrastructure allocated to
          them cost. Parcels below it do not, and the rest of the city covers
          the difference. Seen from above they show red on the ground. Tick
          <b>Show losses on top</b>, or press <kbd>f</kbd>, to flip the map so
          the losses rise instead and the gains hang below, with north still up.
        </p>
        <p>
          Height is linear by default: twice the dollars, twice as tall.
          Values run from a median around ${money(state.current.stats.p50)} to
          a maximum near ${money(state.current.stats.max)}, so a few parcels
          tower over the rest. Square root and logarithmic squeeze those
          extremes down.
        </p>
        <p class="caveat">
          The cost side is a <b>model</b>, not a measurement — no city publishes
          infrastructure cost per property. Streets and sewers are priced at what
          they cost to keep up over their lives, not what the budget spends on
          them; police, fire and other services are pinned to the 2026 adopted
          budget. The cost estimate switches pick low, typical or high values for
          the softest inputs, and Assumptions and sources shows every number.
          Sales tax counts only where it pays for streets, so retail parcels read
          worse here than on the city's actual books.
        </p>
        <div class="keys">
          <div><kbd>drag</kbd> pan</div>
          <div><kbd>shift</kbd>+drag, or right-drag, orbit</div>
          <div><kbd>scroll</kbd> zoom toward the cursor</div>
          <div><kbd>click</kbd> pin a parcel</div>
          <div><kbd>/</kbd> find an address</div>
          <div><kbd>r</kbd> reset the view</div>
          <div><kbd>f</kbd> flip gains and losses</div>
          <div><kbd>esc</kbd> clear</div>
        </div>
        <button class="primary" @click=${() => { state.showHelp = false; ui(); }}>
          Got it
        </button>
      </div>
    </div>`;
}

// ---- go --------------------------------------------------------------------

ui();
boot().then(() => {
  attachInput();
  frame();
});
