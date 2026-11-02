// WebGL2 renderer: extruded parcel prisms over a translucent ground plane.
//
// No 3D library. The scene is one mesh per spatial cell, drawn with a single
// indexed call each, plus a full-screen ground quad and, seen from above, the
// footprints of the parcels that hang below it. Parcel height and colour
// come from a texture keyed by parcel index, so changing the metric is a 1.3 MB
// upload rather than a geometry rebuild.
//
// Everything is in Web Mercator metres, translated so the scene centre is the
// origin: raw mercator values run to 1e7, where float32 has ~1 m of precision,
// which would visibly shred parcel boundaries.

import * as m4 from "../lib/mat4.js";

const PRISM_VS = `#version 300 es
precision highp float;
in vec2 aXY;
in float aTop;
in uint aParcel;

uniform vec2 uOrigin;      // cell origin, already scene-relative
uniform vec2 uQuant;       // metres per quantisation unit
uniform mat4 uViewProj;
uniform sampler2D uMetric; // r = height fraction, g = colour position
uniform float uHeight;     // world metres at height fraction 1.0; negative when flipped
uniform int uMetricW;
uniform int uSelected;     // parcel to highlight, -1 for none
uniform int uXray;         // 1: draw only the selected parcel
uniform int uFootprint;    // 1: draw only below-zero parcels, flat on the ground

out vec3 vWorld;
out float vColorT;
out float vTop;
out float vSelected;

void main() {
  int id = int(aParcel);
  vec2 met = texelFetch(uMetric, ivec2(id % uMetricW, id / uMetricW), 0).rg;
  vSelected = id == uSelected ? 1.0 : 0.0;
  if ((uXray == 1 && id != uSelected) || (uFootprint == 1 && met.r * uHeight >= 0.0)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside the clip volume
    return;
  }

  vec2 p = uOrigin + aXY * uQuant;
  // A footprint squashes the prism to z = 0: walls vanish, the cap remains.
  float z = uFootprint == 1 ? 0.0 : aTop * met.r * uHeight;

  vWorld = vec3(p, z);
  vColorT = met.g;
  vTop = uFootprint == 1 ? 1.0 : aTop;
  gl_Position = uViewProj * vec4(p, z, 1.0);
}`;

const PRISM_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in float vColorT;
in float vTop;
in float vSelected;

uniform sampler2D uRamp;
uniform vec3 uLightDir;
uniform float uAlpha;

out vec4 outColor;

void main() {
  // Flat shading from screen-space derivatives: saves a normal attribute on
  // 1.8M vertices and prisms have no smooth surfaces to lose.
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (!gl_FrontFacing) n = -n;
  float lambert = max(dot(n, normalize(uLightDir)), 0.0);

  vec3 base = texture(uRamp, vec2(clamp(vColorT, 0.0, 1.0), 0.5)).rgb;
  // Walls darken toward their foot so adjacent prisms stay separable.
  float foot = mix(0.72, 1.0, vTop);
  vec3 c = base * foot * (0.42 + 0.58 * lambert);
  c = mix(c, vec3(1.0, 0.86, 0.3), 0.75 * vSelected);

  outColor = vec4(c, uAlpha);
}`;

const PICK_VS = `#version 300 es
precision highp float;
in vec2 aXY;
in float aTop;
in uint aParcel;
uniform vec2 uOrigin;
uniform vec2 uQuant;
uniform mat4 uViewProj;
uniform sampler2D uMetric;
uniform float uHeight;
uniform int uMetricW;
flat out uint vId;
void main() {
  int id = int(aParcel);
  float h = texelFetch(uMetric, ivec2(id % uMetricW, id / uMetricW), 0).r;
  vec2 p = uOrigin + aXY * uQuant;
  vId = aParcel + 1u;                       // 0 means "nothing here"
  gl_Position = uViewProj * vec4(p, aTop * h * uHeight, 1.0);
}`;

const PICK_FS = `#version 300 es
precision highp float;
flat in uint vId;
out uint outId;
void main() { outId = vId; }`;

const GROUND_VS = `#version 300 es
precision highp float;
in vec2 aPos;
uniform mat4 uViewProj;
uniform vec2 uHalf;
out vec2 vWorld;
void main() {
  vWorld = aPos * uHalf;
  gl_Position = uViewProj * vec4(vWorld, 0.0, 1.0);
}`;

const GROUND_FS = `#version 300 es
precision highp float;
in vec2 vWorld;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uGrid;
out vec4 outColor;

void main() {
  // Antialiased 1 km grid; fades out when a pixel spans more than a cell.
  vec2 g = abs(fract(vWorld / uGrid - 0.5) - 0.5) / fwidth(vWorld / uGrid);
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  float fade = clamp(1.0 - length(fwidth(vWorld)) / (uGrid * 0.6), 0.0, 1.0);
  vec3 c = mix(uColor, uColor * 2.4 + 0.02, line * 0.55 * fade);
  outColor = vec4(c, uAlpha);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) + "\n" + src);
  }
  return s;
}

function program(gl, vs, fs, attribs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  // Bind before linking so the prism and pick programs share one VAO layout.
  for (const [name, loc] of Object.entries(attribs || {})) {
    gl.bindAttribLocation(p, loc, name);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p));
  }
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, "");
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { program: p, uniforms };
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      depth: true,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is required and is not available here.");
    this.gl = gl;
    this.canvas = canvas;

    const PRISM_ATTRS = { aXY: 0, aTop: 1, aParcel: 2 };
    this.prism = program(gl, PRISM_VS, PRISM_FS, PRISM_ATTRS);
    this.pick = program(gl, PICK_VS, PICK_FS, PRISM_ATTRS);
    this.ground = program(gl, GROUND_VS, GROUND_FS, { aPos: 0 });

    this.cells = [];
    this.metricW = 1024;
    this.height = 1500;
    this.groundColor = [0.043, 0.047, 0.055];
    this.groundAlpha = 0.9;
    this.lightDir = [0.45, -0.62, 0.65];
    this.selected = -1;
    this.xray = false;
    this.footprint = false;
    // Flipped, a signed metric's negatives rise and its positives hang below,
    // so losses can be read from above with north up.
    this.flip = false;

    this.camera = {
      target: [0, 0, 0],
      distance: 46000,
      azimuth: 0.35,
      elevation: 0.62,
    };
    this.viewProj = new Float32Array(16);
    this.invViewProj = new Float32Array(16);

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]);
    this.groundVao = gl.createVertexArray();
    gl.bindVertexArray(this.groundVao);
    const gb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, gb);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const gp = gl.getAttribLocation(this.ground.program, "aPos");
    gl.enableVertexAttribArray(gp);
    gl.vertexAttribPointer(gp, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.metricTex = gl.createTexture();
    this.rampTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.rampTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.initPickTarget();
  }

  // ---- scene setup --------------------------------------------------------

  setExtent(bbox) {
    this.center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
    this.extent = [bbox[2] - bbox[0], bbox[3] - bbox[1]];
    this.halfSpan = [
      Math.max(this.extent[0] / 2, 1) * 6,
      Math.max(this.extent[1] / 2, 1) * 6,
    ];
    this.frameExtent();
  }

  /** Pull the camera back far enough to hold the whole city in frame. */
  frameExtent() {
    const aspect = this.canvas.clientWidth / this.canvas.clientHeight || 1.6;
    const fov = (38 * Math.PI) / 180;
    const [w, h] = this.extent;
    // The vertical field is the tight one once the scene is tilted, so compare
    // the horizontal span against it through the aspect ratio.
    const need = Math.max(w / aspect, h) / (2 * Math.tan(fov / 2));
    this.camera.target = [0, 0, 0];
    this.camera.distance = need * 1.05;
    this.camera.azimuth = 0.28;
    this.camera.elevation = 0.66;
  }

  addCell(cell, mesh) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const buf = (data, target = gl.ARRAY_BUFFER) => {
      const b = gl.createBuffer();
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return b;
    };

    // Attribute locations are forced to match across the prism and pick
    // programs so one VAO serves both.
    buf(mesh.xy);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.UNSIGNED_SHORT, false, 0, 0);

    buf(mesh.top);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.UNSIGNED_BYTE, false, 0, 0);

    buf(mesh.parcel);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 0, 0);

    buf(mesh.indices, gl.ELEMENT_ARRAY_BUFFER);
    gl.bindVertexArray(null);

    this.cells.push({
      vao,
      count: mesh.indexCount,
      origin: [cell.originX - this.center[0], cell.originY - this.center[1]],
      quant: [cell.scaleX, cell.scaleY],
    });
  }

  /** metric: Float32Array, 2 per parcel - [heightFraction, colourPosition]. */
  setMetric(metric, parcelCount) {
    const gl = this.gl;
    const w = this.metricW;
    const h = Math.ceil(parcelCount / w);
    const padded = new Float32Array(w * h * 2);
    padded.set(metric.subarray(0, parcelCount * 2));

    gl.bindTexture(gl.TEXTURE_2D, this.metricTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, w, h, 0, gl.RG, gl.FLOAT, padded);
    this.metricH = h;
  }

  /** stops: array of [position 0..1, "#rrggbb"]. */
  setRamp(stops) {
    const N = 256;
    const px = new Uint8Array(N * 4);
    const rgb = stops.map(([p, hex]) => [
      p,
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ]);
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      let a = rgb[0];
      let b = rgb[rgb.length - 1];
      for (let k = 0; k < rgb.length - 1; k++) {
        if (t >= rgb[k][0] && t <= rgb[k + 1][0]) {
          a = rgb[k];
          b = rgb[k + 1];
          break;
        }
      }
      const span = b[0] - a[0] || 1;
      const f = Math.min(Math.max((t - a[0]) / span, 0), 1);
      px[i * 4] = a[1] + (b[1] - a[1]) * f;
      px[i * 4 + 1] = a[2] + (b[2] - a[2]) * f;
      px[i * 4 + 2] = a[3] + (b[3] - a[3]) * f;
      px[i * 4 + 3] = 255;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.rampTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }

  // ---- camera -------------------------------------------------------------

  eye() {
    const { target, distance, azimuth, elevation } = this.camera;
    const ce = Math.cos(elevation);
    return [
      target[0] + distance * ce * Math.sin(azimuth),
      target[1] - distance * ce * Math.cos(azimuth),
      target[2] + distance * Math.sin(elevation),
    ];
  }

  updateMatrices() {
    const { canvas } = this;
    const aspect = canvas.width / canvas.height || 1;
    const d = this.camera.distance;
    const proj = m4.perspective(
      (38 * Math.PI) / 180, aspect, Math.max(d * 0.005, 1), d * 12 + 200000
    );
    const view = m4.lookAt(this.eye(), this.camera.target, [0, 0, 1]);
    m4.multiply(proj, view, this.viewProj);
    m4.invert(this.viewProj, this.invViewProj);
  }

  screenToGround(px, py) {
    return m4.unprojectToPlane(
      px, py, this.canvas.clientWidth, this.canvas.clientHeight, this.invViewProj, 0
    );
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    this.resizePickTarget(w, h);
    return true;
  }

  // ---- drawing ------------------------------------------------------------

  render() {
    const gl = this.gl;
    this.updateMatrices();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.031, 0.035, 0.043, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE); // prisms invert when a metric goes negative
    gl.disable(gl.BLEND);

    this.drawPrisms(this.prism, false);
    this.drawGround();
    if (this.eye()[2] > 0) this.drawFootprints();
    if (this.selected >= 0) this.drawSelectedXray();
  }

  /**
   * From above, a parcel that hangs under the ground plane is dimmed nearly to
   * the background. Draw its footprint on top of the plane in its own colour,
   * so it reads from above too; orbit under, or flip, to see its depth.
   */
  drawFootprints() {
    this.footprint = true;
    this.drawPrisms(this.prism, false);
    this.footprint = false;
  }

  /** The selected parcel again, faintly, through anything standing in front. */
  drawSelectedXray() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.xray = true;
    this.drawPrisms(this.prism, false);
    this.xray = false;
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
  }

  drawPrisms({ program: prog, uniforms: u }, picking) {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.uniformMatrix4fv(u.uViewProj, false, this.viewProj);
    gl.uniform1f(u.uHeight, this.flip ? -this.height : this.height);
    gl.uniform1i(u.uMetricW, this.metricW);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.metricTex);
    gl.uniform1i(u.uMetric, 0);

    if (!picking) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.rampTex);
      gl.uniform1i(u.uRamp, 1);
      gl.uniform3fv(u.uLightDir, this.lightDir);
      gl.uniform1i(u.uSelected, this.selected);
      gl.uniform1i(u.uXray, this.xray ? 1 : 0);
      gl.uniform1i(u.uFootprint, this.footprint ? 1 : 0);
      gl.uniform1f(u.uAlpha, this.xray ? 0.45 : 1);
    }

    for (const c of this.cells) {
      gl.uniform2fv(u.uOrigin, c.origin);
      gl.uniform2fv(u.uQuant, c.quant);
      gl.bindVertexArray(c.vao);
      gl.drawElements(gl.TRIANGLES, c.count, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
  }

  drawGround() {
    const gl = this.gl;
    const { program: prog, uniforms: u } = this.ground;
    // Drawn after the prisms with depth test on but depth write off, so a
    // parcel that sits below zero shows through it instead of being clipped.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);

    gl.useProgram(prog);
    gl.uniformMatrix4fv(u.uViewProj, false, this.viewProj);
    gl.uniform2fv(u.uHalf, this.halfSpan || [50000, 50000]);
    gl.uniform3fv(u.uColor, this.groundColor);
    gl.uniform1f(u.uAlpha, this.groundAlpha);
    gl.uniform1f(u.uGrid, 1609.34); // one mile
    gl.bindVertexArray(this.groundVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);

    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  // ---- picking ------------------------------------------------------------

  initPickTarget() {
    const gl = this.gl;
    this.pickFbo = gl.createFramebuffer();
    this.pickTex = gl.createTexture();
    this.pickDepth = gl.createRenderbuffer();
    this.pickSize = [0, 0];
    this.pickBuf = new Uint32Array(1);
  }

  resizePickTarget(w, h) {
    const gl = this.gl;
    if (this.pickSize[0] === w && this.pickSize[1] === h) return;
    gl.bindTexture(gl.TEXTURE_2D, this.pickTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R32UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, null
    );
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0
    );
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepth
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.pickSize = [w, h];
  }

  /** Parcel index under a CSS pixel, or -1. Scissored to one pixel. */
  pickAt(cssX, cssY) {
    const gl = this.gl;
    const dpr = this.canvas.width / this.canvas.clientWidth;
    const x = Math.round(cssX * dpr);
    const y = Math.round((this.canvas.clientHeight - cssY) * dpr);
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return -1;

    this.updateMatrices();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, 1, 1);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
    gl.clear(gl.DEPTH_BUFFER_BIT);

    this.drawPrisms(this.pick, true);

    gl.readPixels(x, y, 1, 1, gl.RED_INTEGER, gl.UNSIGNED_INT, this.pickBuf);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.pickBuf[0] - 1;
  }
}
