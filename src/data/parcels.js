// Reads data/out/parcels.bin. Layout is written by build/03_build.py.
//
//   header  magic 'OMRV' | u32 version | u32 cellCount | u32 parcelCount
//           | f64 minX,minY,maxX,maxY            (Web Mercator metres)
//   dir     per cell: f64 originX,originY,scaleX,scaleY | u32 firstParcel
//           | u32 parcelCount | u32 byteLength
//   cells   u32 ringCount | u32 vertexCount
//           | u32 parcelRingStart[n+1] | u32 ringStart[ringCount+1]
//           | u16 coords[vertexCount*2] | f32 assessed[n] | f32 acres[n]
//           | f32 cFrontageShared[n] | f32 cFrontageOwn[n]
//           | f32 cPeople[n] | f32 cFlat[n]
//           | f32 frontage[n] | f32 sewerFee[n] | f32 cSewer[n]
//           | u8 cls[n] | u8 flags[n]
//
// The cost components are stored separately rather than pre-netted so the
// cost-basis switch can recombine them in the browser without a rebuild.
// Street cost comes twice: with the through-road premium shared citywide, and
// with each road charged in full to the lots along it.
// Sewer is income and cost both: an estimated sewer bill against a share of the
// sewer system. All are zero-filled when the cost model has not been built.
//
// Coordinates are quantised per cell: world = origin + coord * scale.

const HEADER = 48;
const DIR_ENTRY = 44;

export async function loadParcels(url, onProgress) {
  // Revalidate every load: a rebuild replaces the file in place, and a
  // heuristically cached copy would pair new geometry with old attributes.
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);

  const total = Number(res.headers.get("content-length")) || 0;
  const chunks = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress && total) onProgress(received / total);
  }

  const buf = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.length;
  }
  return parse(buf.buffer);
}

function parse(buffer) {
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(
    dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)
  );
  if (magic !== "OMRV") throw new Error(`bad magic ${magic}`);

  const version = dv.getUint32(4, true);
  if (version !== 5) {
    throw new Error(`parcels.bin is version ${version}; this build reads 5. Re-run build/03_build.py.`);
  }
  const cellCount = dv.getUint32(8, true);
  const parcelCount = dv.getUint32(12, true);
  const bbox = [
    dv.getFloat64(16, true), dv.getFloat64(24, true),
    dv.getFloat64(32, true), dv.getFloat64(40, true),
  ];

  // Per-parcel attributes get flattened into one array each; the renderer
  // wants them contiguous so a metric texture is a single upload.
  const assessed = new Float32Array(parcelCount);
  const acres = new Float32Array(parcelCount);
  const cFrontageShared = new Float32Array(parcelCount);
  const cFrontageOwn = new Float32Array(parcelCount);
  const cPeople = new Float32Array(parcelCount);
  const cFlat = new Float32Array(parcelCount);
  const frontage = new Float32Array(parcelCount);
  const sewerFee = new Float32Array(parcelCount);
  const cSewer = new Float32Array(parcelCount);
  const cls = new Uint8Array(parcelCount);
  const flags = new Uint8Array(parcelCount);

  const cells = [];
  let blockAt = HEADER + cellCount * DIR_ENTRY;

  for (let i = 0; i < cellCount; i++) {
    const d = HEADER + i * DIR_ENTRY;
    const originX = dv.getFloat64(d, true);
    const originY = dv.getFloat64(d + 8, true);
    const scaleX = dv.getFloat64(d + 16, true);
    const scaleY = dv.getFloat64(d + 24, true);
    const firstParcel = dv.getUint32(d + 32, true);
    const n = dv.getUint32(d + 36, true);
    const byteLength = dv.getUint32(d + 40, true);

    let p = blockAt;
    const ringCount = dv.getUint32(p, true);
    const vertexCount = dv.getUint32(p + 4, true);
    p += 8;

    const parcelRingStart = new Uint32Array(buffer, p, n + 1);
    p += 4 * (n + 1);
    const ringStart = new Uint32Array(buffer, p, ringCount + 1);
    p += 4 * (ringCount + 1);
    const coords = new Uint16Array(buffer, p, vertexCount * 2);
    p += 4 * vertexCount;

    assessed.set(new Float32Array(buffer, p, n), firstParcel);
    p += 4 * n;
    acres.set(new Float32Array(buffer, p, n), firstParcel);
    p += 4 * n;
    cFrontageShared.set(new Float32Array(buffer, p, n), firstParcel);
    p += 4 * n;
    cFrontageOwn.set(new Float32Array(buffer, p, n), firstParcel);
    p += 4 * n;
    cPeople.set(new Float32Array(buffer, p, n), firstParcel);
    p += 4 * n;
    cFlat.set(new Float32Array(buffer, p, n), firstParcel);
    p += 4 * n;
    frontage.set(new Float32Array(buffer, p, n), firstParcel);
    p += 4 * n;
    sewerFee.set(new Float32Array(buffer, p, n), firstParcel);
    p += 4 * n;
    cSewer.set(new Float32Array(buffer, p, n), firstParcel);
    p += 4 * n;
    cls.set(new Uint8Array(buffer, p, n), firstParcel);
    p += n;
    flags.set(new Uint8Array(buffer, p, n), firstParcel);

    cells.push({
      originX, originY, scaleX, scaleY,
      firstParcel, parcelCount: n,
      ringCount, vertexCount,
      parcelRingStart, ringStart, coords,
    });
    blockAt += byteLength;
  }

  return {
    version, bbox, parcelCount, cells,
    assessed, acres, cFrontageShared, cFrontageOwn, cPeople, cFlat, frontage, sewerFee, cSewer,
    cls, flags,
  };
}
