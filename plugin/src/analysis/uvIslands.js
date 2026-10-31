/**
 * Pure UV-space geometry helpers. No three.js or DOM dependencies, so they run
 * in Node tests and in workers.
 */

export function emptyBounds() {
  return { minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity };
}

export function mergeBounds(a, b) {
  return {
    minU: Math.min(a.minU, b.minU),
    minV: Math.min(a.minV, b.minV),
    maxU: Math.max(a.maxU, b.maxU),
    maxV: Math.max(a.maxV, b.maxV),
  };
}

export function triangleCount(src) {
  return Math.floor((src.index ? src.index.length : src.uvs.length / 2) / 3);
}

function vertexAt(src, tri, corner) {
  const i = tri * 3 + corner;
  return src.index ? src.index[i] : i;
}

class UnionFind {
  parent;
  constructor(n) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x) {
    let r = x;
    while (this.parent[r] !== r) r = this.parent[r];
    while (this.parent[x] !== r) {
      const next = this.parent[x];
      this.parent[x] = r;
      x = next;
    }
    return r;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/**
 * Finds UV islands: groups of triangles connected through shared UV coordinates.
 * Vertices are welded by quantized UV position, so this works for indexed and
 * non-indexed geometry alike (glTF splits vertices along UV seams, so welding
 * by UV rather than by position gives true islands).
 */
export function computeUvIslands(src, epsilon = 1e-5) {
  const triCount = triangleCount(src);
  if (triCount === 0) return [];

  const islandOf = islandIdPerTriangle(src, epsilon);
  const islands = new Map();
  for (let t = 0; t < triCount; t++) {
    const a = vertexAt(src, t, 0);
    const b = vertexAt(src, t, 1);
    const c = vertexAt(src, t, 2);
    const root = islandOf[t];
    let island = islands.get(root);
    if (!island) {
      island = { triangleCount: 0, bounds: emptyBounds(), area: 0 };
      islands.set(root, island);
    }
    const ua = src.uvs[a * 2],
      va = src.uvs[a * 2 + 1];
    const ub = src.uvs[b * 2],
      vb = src.uvs[b * 2 + 1];
    const uc = src.uvs[c * 2],
      vc = src.uvs[c * 2 + 1];
    island.triangleCount++;
    island.area += Math.abs((ub - ua) * (vc - va) - (uc - ua) * (vb - va)) / 2;
    island.bounds = {
      minU: Math.min(island.bounds.minU, ua, ub, uc),
      minV: Math.min(island.bounds.minV, va, vb, vc),
      maxU: Math.max(island.bounds.maxU, ua, ub, uc),
      maxV: Math.max(island.bounds.maxV, va, vb, vc),
    };
  }
  return [...islands.values()].sort((x, y) => y.area - x.area);
}

/** Bounds of all UVs referenced by triangles. */
export function computeUvBounds(src) {
  const b = emptyBounds();
  const triCount = triangleCount(src);
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const v = vertexAt(src, t, c);
      const u = src.uvs[v * 2];
      const w = src.uvs[v * 2 + 1];
      if (u < b.minU) b.minU = u;
      if (w < b.minV) b.minV = w;
      if (u > b.maxU) b.maxU = u;
      if (w > b.maxV) b.maxV = w;
    }
  }
  return b;
}

/** True when any UV falls meaningfully outside the 0..1 square. */
export function isTiled(bounds, tolerance = 0.01) {
  return (
    bounds.minU < -tolerance || bounds.minV < -tolerance || bounds.maxU > 1 + tolerance || bounds.maxV > 1 + tolerance
  );
}

/**
 * Software-rasterizes the UV triangles of several sources into a grid and
 * estimates coverage and island overlap. Each source is rasterized with its
 * own island ids so overlap between meshes is detected as well.
 * UVs are wrapped into 0..1 (fractional part) per triangle, so tiled UVs are approximated.
 */
export function computeUvCoverage(sources, resolution = 256) {
  const owner = new Int32Array(resolution * resolution).fill(-1);
  const shared = new Uint8Array(resolution * resolution);
  let islandBase = 0;

  for (const src of sources) {
    const triCount = triangleCount(src);
    if (!triCount) continue;
    // Island id per vertex for overlap detection.
    const islandOf = islandIdPerTriangle(src);
    for (let t = 0; t < triCount; t++) {
      const id = islandBase + islandOf[t];
      const pts = [];
      for (let c = 0; c < 3; c++) {
        const v = vertexAt(src, t, c);
        pts.push(src.uvs[v * 2], src.uvs[v * 2 + 1]);
      }
      // Wrap the triangle into the unit square by its minimum corner.
      const offU = Math.floor(Math.min(pts[0], pts[2], pts[4]));
      const offV = Math.floor(Math.min(pts[1], pts[3], pts[5]));
      rasterTriangle(
        (pts[0] - offU) * resolution,
        (pts[1] - offV) * resolution,
        (pts[2] - offU) * resolution,
        (pts[3] - offV) * resolution,
        (pts[4] - offU) * resolution,
        (pts[5] - offV) * resolution,
        resolution,
        (cell) => {
          const o = owner[cell];
          if (o === -1) owner[cell] = id;
          else if (o !== id) shared[cell] = 1;
        },
      );
    }
    let maxId = 0;
    for (let i = 0; i < islandOf.length; i++) if (islandOf[i] > maxId) maxId = islandOf[i];
    islandBase += maxId + 1;
  }

  let covered = 0;
  let overlapped = 0;
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] !== -1) {
      covered++;
      if (shared[i]) overlapped++;
    }
  }
  return {
    resolution,
    coverage: covered / owner.length,
    overlap: covered ? overlapped / covered : 0,
  };
}

function islandIdPerTriangle(src, epsilon = 1e-5) {
  const triCount = triangleCount(src);
  const vertexCount = src.uvs.length / 2;
  const uf = new UnionFind(vertexCount);
  const weld = new Map();
  const q = 1 / epsilon;
  for (let v = 0; v < vertexCount; v++) {
    const key = `${Math.round(src.uvs[v * 2] * q)}_${Math.round(src.uvs[v * 2 + 1] * q)}`;
    const e = weld.get(key);
    if (e === undefined) weld.set(key, v);
    else uf.union(v, e);
  }
  for (let t = 0; t < triCount; t++) {
    const a = vertexAt(src, t, 0);
    uf.union(a, vertexAt(src, t, 1));
    uf.union(a, vertexAt(src, t, 2));
  }
  const ids = new Map();
  const out = new Int32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const r = uf.find(vertexAt(src, t, 0));
    let id = ids.get(r);
    if (id === undefined) {
      id = ids.size;
      ids.set(r, id);
    }
    out[t] = id;
  }
  return out;
}

/** Calls `plot` for every grid cell whose center is inside the triangle. */
function rasterTriangle(x0, y0, x1, y1, x2, y2, res, plot) {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(res - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(res - 1, Math.ceil(Math.max(y0, y1, y2)));
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(area) < 1e-12) {
    // Degenerate: mark the cell under the first vertex so slivers still count.
    const cx = Math.min(res - 1, Math.max(0, Math.floor(x0)));
    const cy = Math.min(res - 1, Math.max(0, Math.floor(y0)));
    plot(cy * res + cx);
    return;
  }
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const w0 = (x1 - px) * (y2 - py) - (x2 - px) * (y1 - py);
      const w1 = (x2 - px) * (y0 - py) - (x0 - px) * (y2 - py);
      const w2 = (x0 - px) * (y1 - py) - (x1 - px) * (y0 - py);
      if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
        plot(y * res + x);
      }
    }
  }
}
