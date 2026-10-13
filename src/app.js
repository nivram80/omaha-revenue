import { html, render, nothing } from "../vendor/lit-html.js";
import { Renderer } from "./gl/renderer.js";
import { loadParcels } from "./data/parcels.js";
import {
  METRICS, TRANSFORMS, BASES, RAMP_SEQUENTIAL, RAMP_DIVERGING,
  buildMetric, legendTicks, costUnder, revenueUnder, taxUnder, sewerFeeUnder,
  money, moneyFull,
} from "./metrics.js";
import { buildIndex, search } from "./search.js";

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

const state = {
  phase: "boot",
  progress: 0,
  note: "",
  metricId: "net_per_acre",
  basisId: "full",
  transformId: "linear",
  heightScale: 1,
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
};

let renderer = null;
let data = null;
let attrs = null;
let searchIndex = null;
let needsDraw = true;
let flight = null;

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
  const m = state.manifest.cost_model.bases[state.basisId];
  data.basis = { ...BASES[state.basisId], ...m };
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
    if (e.key === "Escape") { state.showHelp = false; pin(-1); }
    if (e.key === "?") { state.showHelp = !state.showHelp; ui(); }
    if (e.key === "/") { e.preventDefault(); document.getElementById("find")?.focus(); }
    if (e.key === "r" || e.key === "R") { flight = null; renderer.frameExtent(); invalidate(); }
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
  const top = Math.max(state.current.tex[id * 2] * renderer.height, 0);
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
        <div><dt>${!b ? "City tax"
          : b.pots.includes("sewer") ? (b.credit < 0.999 ? "Tax share + sewer" : "Tax + sewer fees")
          : b.credit < 0.999 ? "Tax credited" : "City tax"}</dt>
          <dd>${money(b ? b.revenue : m.estimated_city_property_tax)}</dd></div>
        ${b ? html`<div><dt>Allocated cost</dt><dd>${money(b.cost)}</dd></div>`
            : html`<div><dt>Assessed</dt><dd>${money(m.total_assessed)}</dd></div>`}
      </dl>
      ${b ? html`<p class="shortfall ${Math.abs(b.net) < b.revenue * 0.01 ? "flat" : ""}">
        ${b.net < -b.revenue * 0.01
          ? html`Citywide shortfall <b>${money(b.net)}</b> a year — the street
              renewal the city is not funding.`
          : html`This basis balances citywide (<b>${money(b.net)}</b>), so the
              map shows purely who pays more or less than their share.`}
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
              ? "Lots on an arterial or collector pay what a neighbourhood street " +
                "would cost there. The extra for the bigger road is split over " +
                "every foot of street frontage in the city."
              : "Each road's full cost goes to the lots along it, so homes on " +
                "arterials and collectors pay for the whole road."}</p>` : nothing}
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
  // 10 [frontage, people, residents, acres, parcels] cost breakdown,
  // 11 [sewer bill, local pipes, shared sewer system] sewer breakdown
  const parts = a ? a[10] : null;
  const sewer = a ? a[11] : null;
  const tax = state.hasCost ? taxUnder(data, id) : null;
  const fee = state.hasCost ? sewerFeeUnder(data, id) : 0;
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
              ? `City tax (${(data.basis.credit * 100).toFixed(0)}% share)`
              : "City property tax"}</span>
            <b class="pos">${moneyFull(tax)}</b></div>
          ${pots.includes("sewer") ? html`<div class="led-row">
            <span>Sewer bill (est.)</span>
            <b class="pos">${moneyFull(fee)}</b></div>` : nothing}
          <div class="led-row"><span>Allocated cost</span>
            <b class="neg">−${moneyFull(cost)}</b></div>
          ${parts ? html`<ul class="breakdown">
            ${pots.includes("frontage") ? html`<li>
              <span>Streets</span><i>${moneyFull(data.cFrontage[id])}</i></li>` : nothing}
            ${pots.includes("sewer") && sewer ? html`<li>
              <span>Sewer pipes along the lot</span><i>${moneyFull(sewer[1])}</i></li>
            <li><span>Sewer plants, trunk lines, upkeep</span><i>${moneyFull(sewer[2])}</i></li>` : nothing}
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
          Parcels above the plane pay more in city property tax and sewer
          fees than the services and infrastructure allocated to them cost.
          Parcels below it do not, and the rest of the city covers the
          difference.
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
          infrastructure cost per property. Totals are pinned to the 2026 adopted
          budget and every assumption lives in <code>config/</code>. Sales tax is
          excluded by scope, so retail parcels read worse here than on the city's
          actual books.
        </p>
        <div class="keys">
          <div><kbd>drag</kbd> pan</div>
          <div><kbd>shift</kbd>+drag, or right-drag, orbit</div>
          <div><kbd>scroll</kbd> zoom toward the cursor</div>
          <div><kbd>click</kbd> pin a parcel</div>
          <div><kbd>/</kbd> find an address</div>
          <div><kbd>r</kbd> reset the view</div>
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
