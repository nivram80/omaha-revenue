// Address and parcel-ID lookup over the attribute sidecar.
//
// The assessor writes addresses its own way - "5119  UNDERWOOD AV", "6612 S
// 171 CR" - with no ordinals and two-letter street types. Queries and the index
// go through the same normaliser, so "5119 Underwood Ave, Omaha NE" and
// "6612 S 171st Circle" land on the assessor's spelling.

const STREET_TYPES = {
  STREET: "ST", AVENUE: "AV", AVE: "AV", CIRCLE: "CR", CIR: "CR",
  DRIVE: "DR", ROAD: "RD", BOULEVARD: "BD", BLVD: "BD", COURT: "CT",
  LANE: "LA", LN: "LA", TERRACE: "TR", TER: "TR", TRAIL: "TL", TRL: "TL",
  PLAZA: "PA", PLZ: "PA", PARKWAY: "PW", PKWY: "PW", HIGHWAY: "HW", HWY: "HW",
  PLACE: "PL",
};
const DIRECTIONS = { NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W" };
const TRAILER = /^(OMAHA|NE|NEBRASKA|\d{5}(-\d{4})?)$/;

export function normalizeAddress(s) {
  const t = s.toUpperCase().split(",")[0].replace(/[.#]/g, " ").split(/\s+/).filter(Boolean);
  while (t.length > 2 && TRAILER.test(t[t.length - 1])) t.pop();
  return t.map((w, i) => {
    const ord = /^(\d+)(ST|ND|RD|TH)$/.exec(w);
    if (ord) return ord[1];
    // A direction word leading the street name: "5119 West Center" or, with
    // no house number, "West Center".
    if (DIRECTIONS[w] && i < t.length - 1 && (i === 0 || /^[\d/]+$/.test(t[i - 1]))) {
      return DIRECTIONS[w];
    }
    if (i > 1 && STREET_TYPES[w]) return STREET_TYPES[w];
    return w;
  }).join(" ");
}

/** Normalised address per parcel index. attrs[i][1] is the situs address. */
export function buildIndex(attrs) {
  return {
    address: attrs.map((a) => normalizeAddress(a[1] || "")),
    pin: attrs.map((a) => a[0] || ""),
  };
}

/**
 * Parcel indices for a query, best first: exact address, then addresses that
 * start with it, then ones that contain it. A query with a unit number or a
 * half-typed word that matches nothing is retried a word shorter.
 */
export function search(index, query, limit = 8) {
  let q = normalizeAddress(query);
  while (q.length >= 2) {
    const hits = matches(index, q, limit);
    if (hits.length) return hits;
    const cut = q.lastIndexOf(" ");
    if (cut < 0) break;
    q = q.slice(0, cut);
  }
  return [];
}

function matches({ address, pin }, q, limit) {
  const scored = [];
  const digits = /^\d{6,}$/.test(q);
  for (let i = 0; i < address.length; i++) {
    const a = address[i];
    let rank = -1;
    if (a === q) rank = 0;
    else if (a.startsWith(q)) rank = 1;
    else if (digits && pin[i].startsWith(q)) rank = 1;
    else if (q.length >= 3 && a.includes(q)) rank = 2;
    if (rank >= 0) scored.push([rank, a.length, a, i]);
  }
  scored.sort((x, y) => x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0));
  return scored.slice(0, limit).map((s) => s[3]);
}
