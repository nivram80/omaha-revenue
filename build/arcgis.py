"""Paged extraction from an ArcGIS REST FeatureServer.

Shared by 01_fetch.py and 04_fetch_infra.py. The strategy is the same
everywhere: ask for every OBJECTID up front, then request features in explicit
id batches. Offset pagination drifts on large layers when the server's sort is
unstable and gives no way to resume; id batches are exact, resumable, and let a
single failed batch retry on its own.

Geometry always comes back as EPSG:4326. The layers' native projections vary
(3857 for the state parcels, 26852 for DOGIS), and 3857 is ~33% off on distance
at Omaha's latitude, so nothing here measures in a native SR.
"""

import json
import os
import time
import urllib.parse
import urllib.request

UA = "omaha-revenue/0.2"


def post(url, params, tries=5, timeout=180):
    """POST a query. Batches of ids blow past any sane URL length."""
    body = urllib.parse.urlencode(params).encode()
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                url,
                data=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": UA,
                },
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                payload = json.loads(r.read())
            # ArcGIS reports failures with HTTP 200 and an error object.
            if "error" in payload:
                raise RuntimeError(payload["error"])
            return payload
        except Exception as exc:  # noqa: BLE001 - retry anything transient
            last = exc
            if attempt < tries - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"query failed after {tries} tries: {last}")


def object_ids(service, where, cache_path):
    if os.path.exists(cache_path):
        with open(cache_path) as f:
            return json.load(f)
    payload = post(f"{service}/query", {"where": where, "returnIdsOnly": "true", "f": "json"})
    oids = sorted(payload["objectIds"] or [])
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(cache_path, "w") as f:
        json.dump(oids, f)
    return oids


def fetch_layer(
    service,
    where,
    fields,
    out_path,
    geometry=True,
    batch=500,
    geom_key="rings",
    label="layer",
):
    """Stream a whole layer to NDJSON. Resumable: state lives beside the output."""
    state_path = out_path + ".state"
    ids_path = out_path + ".oids"

    oids = object_ids(service, where, ids_path)
    batches = [oids[i : i + batch] for i in range(0, len(oids), batch)]

    done = 0
    if os.path.exists(state_path):
        with open(state_path) as f:
            done = json.load(f).get("done", 0)

    if done >= len(batches):
        print(f"  {label}: already complete ({len(oids):,} features)")
        return len(oids)

    print(f"  {label}: {len(oids):,} features in {len(batches)} batches"
          + (f", resuming at {done}" if done else ""), flush=True)

    written = 0
    t0 = time.time()
    with open(out_path, "a" if done else "w") as out:
        for i in range(done, len(batches)):
            payload = post(
                f"{service}/query",
                {
                    "objectIds": ",".join(str(o) for o in batches[i]),
                    "outFields": ",".join(fields),
                    "returnGeometry": "true" if geometry else "false",
                    "outSR": "4326",
                    "f": "json",
                },
            )
            for feat in payload.get("features", []):
                rec = feat["attributes"]
                if geometry and geom_key == "point":
                    g = feat.get("geometry") or {}
                    if g.get("x") is None:
                        continue
                    rec["lon"], rec["lat"] = g["x"], g["y"]
                elif geometry:
                    g = (feat.get("geometry") or {}).get(geom_key)
                    if not g:
                        continue  # a few rows carry attributes but no shape
                    rec["geom"] = g
                out.write(json.dumps(rec, separators=(",", ":")) + "\n")
                written += 1
            out.flush()
            with open(state_path, "w") as f:
                json.dump({"done": i + 1}, f)

            if (i + 1) % 25 == 0 or i + 1 == len(batches):
                rate = (i + 1 - done) / max(time.time() - t0, 1e-6)
                eta = (len(batches) - i - 1) / max(rate, 1e-6)
                print(f"    {label} {i + 1}/{len(batches)} "
                      f"({100 * (i + 1) / len(batches):.0f}%) eta {eta / 60:.1f}m", flush=True)

    print(f"  {label}: wrote {written:,} features, "
          f"{os.path.getsize(out_path) / 1e6:.0f} MB", flush=True)
    return written
