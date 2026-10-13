// Turns quantised parcel outlines into prism meshes.
//
// Runs off the main thread because this is where the vertex count explodes: an
// outline of v points becomes 2v vertices (a base ring and a top ring) and
// 9v-6 indices (v-2 cap triangles plus 2v wall triangles). Shipping that from
// the build step would be ~300 MB; rebuilding it here costs a second.
//
// Height is NOT baked in. Every vertex carries a top/bottom flag and its parcel
// index, and the vertex shader looks the parcel's value up in a texture. That
// way switching metric or height scale is a 660 KB texture upload, not a
// rebuild of 50 MB of geometry.

self.onmessage = (e) => {
  const { cells } = e.data;
  for (let i = 0; i < cells.length; i++) {
    const mesh = build(cells[i]);
    self.postMessage({ type: "cell", index: i, mesh }, [
      mesh.xy.buffer, mesh.top.buffer, mesh.parcel.buffer, mesh.indices.buffer,
    ]);
  }
  self.postMessage({ type: "done" });
};

function build(cell) {
  const { coords, ringStart, parcelRingStart, parcelCount, firstParcel } = cell;
  const v = cell.vertexCount;

  const xy = new Uint16Array(v * 4); // 2 vertices per outline point
  const top = new Uint8Array(v * 2);
  const parcel = new Uint32Array(v * 2);
  // 9v is the exact upper bound; rings under 3 points emit nothing, so trim.
  const indices = new Uint32Array(v * 9);

  let vOut = 0;
  let iOut = 0;
  const scratch = [];

  for (let p = 0; p < parcelCount; p++) {
    const gid = firstParcel + p;
    const r0 = parcelRingStart[p];
    const r1 = parcelRingStart[p + 1];

    for (let r = r0; r < r1; r++) {
      const s = ringStart[r];
      const n = ringStart[r + 1] - s;
      if (n < 3) continue;

      const base = vOut;
      // Emit base/top pairs: point k becomes vertices base+2k and base+2k+1.
      for (let k = 0; k < n; k++) {
        const x = coords[(s + k) * 2];
        const y = coords[(s + k) * 2 + 1];
        const a = vOut++;
        const b = vOut++;
        xy[a * 2] = x; xy[a * 2 + 1] = y;
        xy[b * 2] = x; xy[b * 2 + 1] = y;
        top[a] = 0; top[b] = 1;
        parcel[a] = gid; parcel[b] = gid;
      }

      // Cap. Ear clipping wants counter-clockwise; Esri winds outer rings
      // clockwise, so most of these get reversed.
      const ccw = area2(coords, s, n) > 0;
      scratch.length = 0;
      for (let k = 0; k < n; k++) scratch.push(ccw ? k : n - 1 - k);
      iOut = earClip(coords, s, scratch, indices, iOut, base);

      // Walls. One quad per edge, wound so the outward face is front.
      for (let k = 0; k < n; k++) {
        const kk = ccw ? k : n - 1 - k;
        const nn = ccw ? (k + 1) % n : (n - 1 - ((k + 1) % n));
        const b0 = base + kk * 2, t0 = b0 + 1;
        const b1 = base + nn * 2, t1 = b1 + 1;
        indices[iOut++] = b0; indices[iOut++] = b1; indices[iOut++] = t1;
        indices[iOut++] = b0; indices[iOut++] = t1; indices[iOut++] = t0;
      }
    }
  }

  return {
    xy: xy.subarray(0, vOut * 2).slice(),
    top: top.subarray(0, vOut).slice(),
    parcel: parcel.subarray(0, vOut).slice(),
    indices: indices.subarray(0, iOut).slice(),
    vertexCount: vOut,
    indexCount: iOut,
  };
}

/** Twice the signed area of a ring. Positive means counter-clockwise. */
function area2(coords, s, n) {
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    total +=
      coords[(s + i) * 2] * coords[(s + j) * 2 + 1] -
      coords[(s + j) * 2] * coords[(s + i) * 2 + 1];
  }
  return total;
}

/**
 * Ear clipping, O(n^2). Fine here: after simplification the median parcel is a
 * five-point ring and the 99th percentile is under a hundred.
 *
 * `order` holds ring-local point indices in CCW order; emitted indices are
 * mapped to the top-ring vertices (base + k*2 + 1).
 */
function earClip(coords, s, order, out, at, base) {
  const poly = order.slice();
  let guard = 0;

  while (poly.length > 3) {
    let clipped = false;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[(i + poly.length - 1) % poly.length];
      const b = poly[i];
      const c = poly[(i + 1) % poly.length];
      if (!isEar(coords, s, poly, a, b, c)) continue;
      out[at++] = base + a * 2 + 1;
      out[at++] = base + b * 2 + 1;
      out[at++] = base + c * 2 + 1;
      poly.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Self-intersecting or fully collinear ring. Force a clip so we always
      // terminate; a sliver triangle is invisible at parcel scale.
      const a = poly[poly.length - 1];
      const b = poly[0];
      const c = poly[1];
      out[at++] = base + a * 2 + 1;
      out[at++] = base + b * 2 + 1;
      out[at++] = base + c * 2 + 1;
      poly.splice(0, 1);
    }
    if (++guard > 4096) break;
  }

  if (poly.length === 3) {
    out[at++] = base + poly[0] * 2 + 1;
    out[at++] = base + poly[1] * 2 + 1;
    out[at++] = base + poly[2] * 2 + 1;
  }
  return at;
}

function isEar(coords, s, poly, a, b, c) {
  const ax = coords[(s + a) * 2], ay = coords[(s + a) * 2 + 1];
  const bx = coords[(s + b) * 2], by = coords[(s + b) * 2 + 1];
  const cx = coords[(s + c) * 2], cy = coords[(s + c) * 2 + 1];

  // Convex in a CCW ring means a positive cross product.
  const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (cross <= 0) return false;

  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    if (p === a || p === b || p === c) continue;
    const px = coords[(s + p) * 2], py = coords[(s + p) * 2 + 1];
    if (inTriangle(px, py, ax, ay, bx, by, cx, cy)) return false;
  }
  return true;
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
