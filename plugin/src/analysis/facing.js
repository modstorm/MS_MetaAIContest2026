import * as THREE from 'three';
import { uvSourceOf } from './textureLayout.js';
import { islandIdPerTriangle, triangleCount } from './uvIslands.js';
import { islandUpDirections } from './parts.js';

/**
 * Which way each surface faces on the model (glTF convention: the model looks toward +Z,
 * so its own left side is +X). Used to tell the image model where the front, back and
 * sides of a part are inside the texture, so front-only details (buttons, a V-neck,
 * pockets, a face) are not painted on the back.
 */
export const FACINGS = [
  { id: 'front', label: 'front', color: 'green', hex: '#00c853' },
  { id: 'back', label: 'back', color: 'blue', hex: '#2962ff' },
  { id: 'left', label: "model's left side", color: 'yellow', hex: '#ffd600' },
  { id: 'right', label: "model's right side", color: 'orange', hex: '#ff6d00' },
  { id: 'top', label: 'top', color: 'magenta', hex: '#d500f9' },
  { id: 'bottom', label: 'bottom / underside', color: 'cyan', hex: '#00e5ff' },
];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

function vertexIndex(src, t, k) {
  return src.index ? src.index[t * 3 + k] : t * 3 + k;
}

/** Index into FACINGS for a world-space normal. */
export function facingOf(nx, ny, nz) {
  if (ny > 0.75) return 4;
  if (ny < -0.75) return 5;
  if (Math.abs(nz) >= Math.abs(nx)) return nz >= 0 ? 0 : 1;
  return nx >= 0 ? 2 : 3;
}

/**
 * Per-triangle data for one mesh in world space: facing index, area, centroid.
 * @returns {{ facing: Uint8Array, area: Float32Array, centroid: Float32Array } | null}
 */
export function triangleFacings(mesh, src) {
  const pos = mesh.geometry.getAttribute('position');
  if (!pos || !src) return null;
  mesh.updateWorldMatrix(true, false);
  const m = mesh.matrixWorld;
  const tris = triangleCount(src);
  const facing = new Uint8Array(tris);
  const area = new Float32Array(tris);
  const centroid = new Float32Array(tris * 3);
  for (let t = 0; t < tris; t++) {
    _a.fromBufferAttribute(pos, vertexIndex(src, t, 0)).applyMatrix4(m);
    _b.fromBufferAttribute(pos, vertexIndex(src, t, 1)).applyMatrix4(m);
    _c.fromBufferAttribute(pos, vertexIndex(src, t, 2)).applyMatrix4(m);
    centroid[t * 3] = (_a.x + _b.x + _c.x) / 3;
    centroid[t * 3 + 1] = (_a.y + _b.y + _c.y) / 3;
    centroid[t * 3 + 2] = (_a.z + _b.z + _c.z) / 3;
    _b.sub(_a);
    _c.sub(_a);
    _b.cross(_c); // counter-clockwise winding: outward normal
    const len = _b.length();
    area[t] = len / 2;
    facing[t] = len > 0 ? facingOf(_b.x / len, _b.y / len, _b.z / len) : 0;
  }
  return { facing, area, centroid };
}

/**
 * Facing map of a part: its UV area colored by which way each triangle faces on the
 * model (see FACINGS), black elsewhere. Also returns each facing's share of the part's
 * surface area, e.g. { front: 0.45, back: 0.4, left: 0.08, … }.
 */
export function drawFacingMap(slot, part, width, height, { grow = 1, limbCenterX = null } = {}) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  ctx.lineWidth = Math.max(1, grow * 2);
  ctx.lineJoin = 'round';
  const totals = new Float64Array(FACINGS.length);
  for (const mesh of part.meshes) {
    const src = uvSourceOf(mesh, slot.uvChannel, slot.texture);
    const f = triangleFacings(mesh, src);
    if (!f) continue;
    const keep = part.islands?.get(mesh);
    const islandOf = keep ? islandIdPerTriangle(src) : null;
    const triKeep = part.tris?.get(mesh);
    if (part.tris && !triKeep) continue;
    const paths = FACINGS.map(() => new Path2D());
    for (let t = 0; t < f.facing.length; t++) {
      if (keep && !keep.has(islandOf[t])) continue;
      if (triKeep && !triKeep[t]) continue;
      const pts = [];
      for (let k = 0; k < 3; k++) {
        const v = vertexIndex(src, t, k);
        pts.push(src.uvs[v * 2], src.uvs[v * 2 + 1]);
      }
      const ou = Math.floor(Math.min(pts[0], pts[2], pts[4]));
      const ov = Math.floor(Math.min(pts[1], pts[3], pts[5]));
      // Limb mode: side faces are told apart as outer (facing away from the body's middle)
      // and inner (facing the middle) instead of the model's left / right.
      let fi = f.facing[t];
      if (limbCenterX != null && (fi === 2 || fi === 3)) {
        const outer = (fi === 2) === f.centroid[t * 3] > limbCenterX;
        fi = outer ? 2 : 3;
      }
      const p = paths[fi];
      // Same winding for every triangle: mirrored islands stacked on top of each other
      // would otherwise cancel out under the nonzero fill rule and leave holes.
      const ccw = (pts[2] - pts[0]) * (pts[5] - pts[1]) - (pts[4] - pts[0]) * (pts[3] - pts[1]) >= 0;
      const [i1, i2] = ccw ? [2, 4] : [4, 2];
      p.moveTo((pts[0] - ou) * width, (pts[1] - ov) * height);
      p.lineTo((pts[i1] - ou) * width, (pts[i1 + 1] - ov) * height);
      p.lineTo((pts[i2] - ou) * width, (pts[i2 + 1] - ov) * height);
      p.closePath();
      totals[fi] += f.area[t];
    }
    // Strokes first (grown edges), then fills, so each triangle's own color wins inside it.
    paths.forEach((p, i) => {
      ctx.strokeStyle = FACINGS[i].hex;
      ctx.stroke(p);
    });
    paths.forEach((p, i) => {
      ctx.fillStyle = FACINGS[i].hex;
      ctx.fill(p);
    });
  }
  const sum = totals.reduce((a, b) => a + b, 0) || 1;
  const share = {};
  FACINGS.forEach((f, i) => (share[f.id] = totals[i] / sum));
  return { canvas: c, share };
}

/** "45% front (green), 40% back (blue), 15% sides (yellow / orange)" for prompts. */
export function facingSummary(share) {
  return FACINGS.filter((f) => share[f.id] >= 0.03)
    .sort((a, b) => share[b.id] - share[a.id])
    .map((f) => `${Math.round(share[f.id] * 100)}% ${f.label} (${f.color})`)
    .join(', ');
}

/**
 * Splits a part into regions: groups of UV islands that sit apart in the texture (for
 * example a shirt's torso and its sleeves). Each region is named by where it sits on
 * the model (center, the model's left / right side, upper / lower) and keeps only its
 * own islands (`islands`: Map mesh → Set of island ids). Small groups are merged into
 * the nearest region. Returns [part] when there is nothing worth splitting.
 */
export function splitPartRegions(slot, part, { gap = 0.02, minShare = 0.08, maxRegions = 4 } = {}) {
  const islands = [];
  const world = new THREE.Box3();
  for (const mesh of part.meshes) {
    const src = uvSourceOf(mesh, slot.uvChannel, slot.texture);
    const f = triangleFacings(mesh, src);
    if (!f) continue;
    const ids = islandIdPerTriangle(src);
    const byId = new Map();
    for (let t = 0; t < ids.length; t++) {
      let isl = byId.get(ids[t]);
      if (!isl) {
        byId.set(
          ids[t],
          (isl = { mesh, id: ids[t], box: [Infinity, Infinity, -Infinity, -Infinity], area: 0, c: [0, 0, 0] }),
        );
        islands.push(isl);
      }
      for (let k = 0; k < 3; k++) {
        const v = vertexIndex(src, t, k);
        const u = src.uvs[v * 2],
          w = src.uvs[v * 2 + 1];
        isl.box[0] = Math.min(isl.box[0], u);
        isl.box[1] = Math.min(isl.box[1], w);
        isl.box[2] = Math.max(isl.box[2], u);
        isl.box[3] = Math.max(isl.box[3], w);
      }
      const a = f.area[t];
      isl.area += a;
      isl.c[0] += f.centroid[t * 3] * a;
      isl.c[1] += f.centroid[t * 3 + 1] * a;
      isl.c[2] += f.centroid[t * 3 + 2] * a;
      world.expandByPoint(_a.set(f.centroid[t * 3], f.centroid[t * 3 + 1], f.centroid[t * 3 + 2]));
    }
  }
  if (islands.length < 2) return [part];

  // Union islands whose UV boxes (grown by `gap`) overlap.
  const parent = islands.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < islands.length; i++) {
    const a = islands[i].box;
    for (let j = i + 1; j < islands.length; j++) {
      const b = islands[j].box;
      if (a[0] - gap <= b[2] && b[0] - gap <= a[2] && a[1] - gap <= b[3] && b[1] - gap <= a[3])
        parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < islands.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(islands[i]);
  }
  const total = islands.reduce((s, i) => s + i.area, 0) || 1;
  let regions = [...groups.values()].map((list) => {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const c = [0, 0, 0];
    let area = 0;
    for (const i of list) {
      box[0] = Math.min(box[0], i.box[0]);
      box[1] = Math.min(box[1], i.box[1]);
      box[2] = Math.max(box[2], i.box[2]);
      box[3] = Math.max(box[3], i.box[3]);
      area += i.area;
      for (let k = 0; k < 3; k++) c[k] += i.c[k];
    }
    return { list, box, area, c };
  });
  regions.sort((a, b) => b.area - a.area);
  const big = regions.filter((r) => r.area / total >= minShare).slice(0, maxRegions);
  if (big.length < 2) return [part];
  // Merge every other group into the nearest big region (by UV box center).
  const center = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  for (const r of regions) {
    if (big.includes(r)) continue;
    const [x, y] = center(r.box);
    let best = big[0],
      bestD = Infinity;
    for (const b of big) {
      const [bx, by] = center(b.box);
      const d = (bx - x) ** 2 + (by - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    best.list.push(...r.list);
    best.area += r.area;
    for (let k = 0; k < 3; k++) best.c[k] += r.c[k];
  }

  const wc = world.getCenter(new THREE.Vector3());
  const ws = world.getSize(new THREE.Vector3());
  const used = new Map();
  return big.map((r) => {
    const cx = r.c[0] / r.area,
      cy = r.c[1] / r.area;
    const dx = ws.x > 0 ? (cx - wc.x) / (ws.x / 2) : 0;
    const dy = ws.y > 0 ? (cy - wc.y) / (ws.y / 2) : 0;
    const words = [];
    if (dy > 0.4) words.push('upper');
    else if (dy < -0.4) words.push('lower');
    if (dx > 0.35) words.push("model's left side");
    else if (dx < -0.35) words.push("model's right side");
    else words.push('center');
    let label = words.join(' ');
    const n = (used.get(label) ?? 0) + 1;
    used.set(label, n);
    if (n > 1) label += ` ${n}`;

    const keep = new Map();
    for (const i of r.list) {
      if (!keep.has(i.mesh)) keep.set(i.mesh, new Set());
      keep.get(i.mesh).add(i.id);
    }
    // Orientation of just these islands.
    const votes = { up: 0, down: 0, left: 0, right: 0 };
    let area = 0,
      mirroredArea = 0;
    for (const [mesh, ids] of keep) {
      for (const o of islandUpDirections(mesh, uvSourceOf(mesh, slot.uvChannel, slot.texture))) {
        if (!ids.has(o.id)) continue;
        votes[o.dir] += o.area;
        area += o.area;
        if (o.mirrored) mirroredArea += o.area;
      }
    }
    const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    const up = area > 0 ? (ranked[0][1] / area >= 0.6 ? ranked[0][0] : 'mixed') : part.up;
    const clamp = (x) => Math.round(Math.min(1, Math.max(0, x)) * 1000);
    return {
      ...part,
      name: `${part.name} (${label})`,
      baseName: part.name,
      region: label,
      islands: keep,
      bbox: r.box.map(clamp),
      area: r.area,
      share: r.area / total,
      up,
      mirrored: area > 0 ? mirroredArea / area > 0.5 : part.mirrored,
    };
  });
}

function nearestFacing(r, g, b) {
  let best = -1,
    bestD = 60 * 60 * 3; // only clear matches; antialiased edge pixels are skipped
  FACINGS.forEach((f, i) => {
    const n = parseInt(f.hex.slice(1), 16);
    const d = (r - (n >> 16)) ** 2 + (g - ((n >> 8) & 255)) ** 2 + (b - (n & 255)) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/**
 * Describes a (cropped, upright) facing map in words on a 3×3 grid, e.g.
 * "top-left: back; middle: front; right column: the model's left side". Sent as text
 * instead of a colored guide image, because image models copy guide colors into the paint.
 */
export function facingGridText(guide, grid = 3) {
  const { width: w, height: h } = guide;
  const d = guide.getContext('2d').getImageData(0, 0, w, h).data;
  const counts = Array.from({ length: grid * grid }, () => new Float64Array(FACINGS.length));
  const covered = new Float64Array(grid * grid);
  const step = Math.max(1, Math.floor(Math.min(w, h) / 200)); // sample, fast enough at any size
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (d[i] + d[i + 1] + d[i + 2] < 30) continue;
      const f = nearestFacing(d[i], d[i + 1], d[i + 2]);
      if (f < 0) continue;
      const c = Math.min(grid - 1, Math.floor((y / h) * grid)) * grid + Math.min(grid - 1, Math.floor((x / w) * grid));
      counts[c][f]++;
      covered[c]++;
    }
  }
  const total = covered.reduce((a, b) => a + b, 0) || 1;
  const rows = ['top', 'middle', 'bottom'];
  const cols = ['left', 'center', 'right'];
  const cells = [];
  for (let c = 0; c < grid * grid; c++) {
    if (covered[c] / total < 0.03) continue;
    const ranked = [...counts[c]].map((n, i) => [n, i]).sort((a, b) => b[0] - a[0]);
    const main = FACINGS[ranked[0][1]].label;
    const second = ranked[1][0] / covered[c] > 0.3 ? ` and ${FACINGS[ranked[1][1]].label}` : '';
    const where =
      grid === 3 ? `${rows[Math.floor(c / 3)]}-${cols[c % 3]}`.replace('middle-center', 'center') : `cell ${c}`;
    cells.push(`${where}: ${main}${second}`);
  }
  return cells.join('; ');
}

/** The facing map as a plain white-on-black mask (no colors for the image model to copy). */
export function whiteMask(guide) {
  const c = document.createElement('canvas');
  c.width = guide.width;
  c.height = guide.height;
  const g = c.getContext('2d');
  g.drawImage(guide, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] + d[i + 1] + d[i + 2] > 30 ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** "45% front, 40% back, 15% the model's left side" (no colors). */
export function facingShareText(share) {
  return FACINGS.filter((f) => share[f.id] >= 0.03)
    .sort((a, b) => share[b.id] - share[a.id])
    .map((f) => `${Math.round(share[f.id] * 100)}% ${f.label}`)
    .join(', ');
}

/**
 * Left-to-right strips of an unwrapped area (sleeves, trouser legs, torso sides): which
 * way each vertical strip faces, read from a facing map made with `limbCenterX` (so the
 * sides read as outer / inner). Separate pieces are split by "|". Returns '' when the area
 * is not laid out in vertical strips.
 */
export function facingStripsText(guide) {
  const { width: w, height: h } = guide;
  if (w < 8 || h < 8) return '';
  const d = guide.getContext('2d').getImageData(0, 0, w, h).data;
  const names = ['front', 'back', 'outer side', 'inner side', 'top', 'bottom'];
  const step = Math.max(1, Math.floor(h / 160));
  const cols = [];
  for (let x = 0; x < w; x++) {
    const counts = new Float64Array(6);
    let covered = 0;
    for (let y = 0; y < h; y += step) {
      const i = (y * w + x) * 4;
      if (d[i] + d[i + 1] + d[i + 2] < 30) continue;
      const f = nearestFacing(d[i], d[i + 1], d[i + 2]);
      if (f < 0) continue;
      counts[f]++;
      covered++;
    }
    if (covered < 3) {
      cols.push({ f: -1, purity: 1 });
      continue;
    }
    let best = 0;
    for (let k = 1; k < 6; k++) if (counts[k] > counts[best]) best = k;
    cols.push({ f: best, purity: counts[best] / covered });
  }
  // Runs of the same facing; gaps split pieces; very thin runs are absorbed.
  const runs = [];
  for (let x = 0; x < w; x++) {
    const c = cols[x];
    const last = runs[runs.length - 1];
    if (last && last.f === c.f) {
      last.end = x;
      last.purity += c.purity;
    } else runs.push({ f: c.f, start: x, end: x, purity: c.purity });
  }
  const minW = Math.max(2, w * 0.03);
  const kept = runs.filter((r) => r.f < 0 || r.end - r.start + 1 >= minW);
  const pieces = [[]];
  let purity = 0,
    n = 0;
  for (const r of kept) {
    if (r.f < 0) {
      if (pieces[pieces.length - 1].length && r.end - r.start + 1 >= minW) pieces.push([]);
      continue;
    }
    const piece = pieces[pieces.length - 1];
    if (piece[piece.length - 1] !== names[r.f]) piece.push(names[r.f]);
    purity += r.purity;
    n += r.end - r.start + 1;
  }
  // A piece that repeats a direction is several limbs side by side (two trouser legs):
  // split it where a direction comes round again.
  const real = [];
  const sides = new Set(['front', 'back', 'outer side', 'inner side']);
  for (const p0 of pieces.filter((x) => x.length)) {
    // Caps (top / bottom faces of cuffs) are not strips.
    const p = p0.filter((x) => sides.has(x)).filter((x, i, a) => i === 0 || a[i - 1] !== x);
    let cur = [];
    for (const name of p) {
      if (cur.includes(name) && cur.length >= 3) {
        real.push(cur);
        cur = [];
      }
      cur.push(name);
    }
    if (cur.length) real.push(cur);
  }
  const strips = real.reduce((a, p) => a + p.length, 0);
  // Only worth saying for real strip layouts: several strips, each mostly one facing top to bottom.
  if (strips < 3 || purity / (n || 1) < 0.55) return '';
  // Only clean layouts: one or two limbs, each 3-4 different sides. Anything else would
  // mislead the image model more than it helps.
  if (real.length > 2 || real.some((g) => g.length < 3 || g.length > 4 || new Set(g).size !== g.length)) return '';
  return `from left to right, ${strips} vertical strips${real.length > 1 ? ` in ${real.length} groups (one per limb), each wrapping all the way round` : ''}: ${real
    .map((p) => p.join(', '))
    .join(' | ')}`;
}

/**
 * Where the front of an area is, left to right, read from a facing map (green = front).
 * Used for torsos, whose front panel is often not centered in the crop: the image model
 * otherwise centers the garment opening in the image and it lands off the body's middle.
 * Returns '' when there is no single clear front panel.
 */
export function frontSpanText(guide) {
  const span = frontSpan(guide);
  if (!span) return '';
  const w = guide.width;
  const { start, end } = span;
  const pct = (v) => Math.round((100 * v) / w);
  const mid = (start + end + 1) / 2;
  if (Math.abs(mid - w / 2) < w * 0.04) return ''; // already centered: nothing to say
  return `The front of the body in image 1 is the band from ${pct(start)}% to ${pct(end + 1)}% of the image width (measured from the left edge). Its vertical centre line is at ${pct(mid)}% of the width, not at the middle of the image: put the garment's centre (opening, buttons, zip, placket) exactly on that line and keep the front design symmetric around it.`;
}

/** The single clear front panel of a facing map, left to right ({ start, end } in pixels), or null. */
export function frontSpan(guide) {
  const { width: w, height: h } = guide;
  if (w < 16 || h < 16) return null;
  const d = guide.getContext('2d').getImageData(0, 0, w, h).data;
  const step = Math.max(1, Math.floor(h / 200));
  const isFront = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    let front = 0,
      covered = 0;
    for (let y = 0; y < h; y += step) {
      const i = (y * w + x) * 4;
      if (d[i] + d[i + 1] + d[i + 2] < 30) continue;
      const f = nearestFacing(d[i], d[i + 1], d[i + 2]);
      if (f < 0) continue;
      covered++;
      if (f === 0) front++;
    }
    isFront[x] = covered >= 3 && front / covered >= 0.6 ? 1 : 0;
  }
  const runs = [];
  const gap = Math.max(2, Math.round(w * 0.01));
  for (let x = 0; x < w; x++) {
    if (!isFront[x]) continue;
    const last = runs[runs.length - 1];
    if (last && x - last.end <= gap) last.end = x;
    else runs.push({ start: x, end: x });
  }
  // A front panel split over the left and right edges of the crop (the wrap seam runs
  // down the front) is one panel: its end is given past the right edge (end >= w).
  if (runs.length > 1 && runs[0].start <= gap && runs[runs.length - 1].end >= w - 1 - gap) {
    const first = runs.shift();
    runs[runs.length - 1].end = first.end + w;
  }
  const big = runs.filter((r) => r.end - r.start + 1 >= w * 0.1);
  return big.length === 1 ? big[0] : null;
}
