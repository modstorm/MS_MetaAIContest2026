import * as THREE from 'three';
import { uvSourceOf } from './textureLayout.js';
import { islandIdPerTriangle } from './uvIslands.js';
import { islandUpDirections } from './parts.js';
import { triangleFacings } from './facing.js';

/**
 * Body zones for characters. Avatar meshes often bundle several body zones in one mesh
 * (head + hair + torso, arms + hands). This finds them from the 3D shape alone, so the
 * same code works for any avatar layout:
 *   - the neck is the narrowest horizontal slice in the upper part of the model;
 *     everything above it is the head zone
 *   - the head zone is split into face and hair by separate UV island groups
 *   - in an arm-like mesh, the far end of each arm (from the shoulder) is the hand
 */

const _v = new THREE.Vector3();

/** Neck height and width, model center and height, from the model's vertices (world space). */
export function avatarAnatomy(root) {
  root.updateWorldMatrix(true, true);
  const pts = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const pos = o.geometry.getAttribute('position');
    if (!pos) return;
    const step = Math.max(1, Math.floor(pos.count / 6000));
    for (let i = 0; i < pos.count; i += step) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      pts.push(_v.x, _v.y, _v.z);
    }
  });
  if (pts.length < 30) return null;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    minX = Math.min(minX, pts[i]);
    maxX = Math.max(maxX, pts[i]);
    minY = Math.min(minY, pts[i + 1]);
    maxY = Math.max(maxY, pts[i + 1]);
    minZ = Math.min(minZ, pts[i + 2]);
    maxZ = Math.max(maxZ, pts[i + 2]);
  }
  const H = maxY - minY;
  if (!(H > 0)) return null;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const bins = 60;
  const width = new Float64Array(bins);
  const has = new Uint8Array(bins);
  for (let i = 0; i < pts.length; i += 3) {
    const b = Math.min(bins - 1, Math.floor(((pts[i + 1] - minY) / H) * bins));
    width[b] = Math.max(width[b], Math.abs(pts[i] - cx));
    has[b] = 1;
  }
  // Narrowest slice between 70% and 95% of the height: the neck.
  let neckBin = -1;
  for (let b = Math.floor(bins * 0.7); b < Math.floor(bins * 0.95); b++) {
    if (has[b] && (neckBin < 0 || width[b] < width[neckBin])) neckBin = b;
  }
  if (neckBin < 0) return null;
  const neckY = minY + ((neckBin + 0.5) / bins) * H;
  const neckHalfW = Math.max(width[neckBin], H * 0.02);
  // Torso half width: in a chest-height slice, the arms are separated from the torso by
  // the largest gap in |x|; without a gap (arms against the body) guess from the neck.
  // Points are sampled across the triangle surfaces (not just vertices): a low-poly torso
  // has few vertices, and the gaps between them looked like the torso/arm gap.
  const chest = surfaceSlice(root, neckY - H * 0.16, neckY - H * 0.08, H * 0.004).map((x) => Math.abs(x - cx));
  chest.sort((a, b) => a - b);
  let torsoHalfW = neckHalfW * 2.8;
  let bestGap = H * 0.015;
  for (let i = 1; i < chest.length; i++) {
    const gap = chest[i] - chest[i - 1];
    if (gap > bestGap && chest[i - 1] > neckHalfW) {
      bestGap = gap;
      torsoHalfW = chest[i - 1];
    }
  }
  // A torso narrower than ~1.6 necks is a misreading (e.g. a gap inside a loose garment).
  if (torsoHalfW < neckHalfW * 1.6) torsoHalfW = neckHalfW * 2.8;
  // Crotch: going up from the knees, the first height where the middle is filled.
  let crotchY = minY + H * 0.47;
  for (let i = Math.floor(bins * 0.25); i < Math.floor(bins * 0.65); i++) {
    const y0 = minY + (i / bins) * H,
      y1 = y0 + H / bins;
    let mid = false;
    for (let j = 0; j < pts.length && !mid; j += 3)
      mid = pts[j + 1] >= y0 && pts[j + 1] < y1 && Math.abs(pts[j] - cx) < neckHalfW * 0.25;
    if (mid) {
      crotchY = y0;
      break;
    }
  }
  // Legs that touch (or loose trousers with an inner seam near the middle) make the scan
  // stop at the knees; keep the hip line within normal human proportions.
  crotchY = Math.min(Math.max(crotchY, minY + H * 0.38), minY + H * 0.52);
  return { minY, maxY, H, cx, cz, neckY, neckHalfW, torsoHalfW, crotchY };
}

/** x of points spread over every triangle surface, where the surface is between y0 and y1 (world). */
function surfaceSlice(root, y0, y1, spacing) {
  const xs = [];
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const pos = o.geometry.getAttribute('position');
    if (!pos) return;
    const index = o.geometry.index;
    const count = index ? index.count : pos.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const i0 = index ? index.getX(i) : i,
        i1 = index ? index.getX(i + 1) : i + 1,
        i2 = index ? index.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
      if (Math.max(a.y, b.y, c.y) < y0 || Math.min(a.y, b.y, c.y) > y1) continue;
      const edge = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
      const n = Math.min(48, Math.max(1, Math.ceil(edge / spacing)));
      for (let u = 0; u <= n; u++) {
        for (let v = 0; v <= n - u; v++) {
          const w = n - u - v;
          const y = (a.y * u + b.y * v + c.y * w) / n;
          if (y < y0 || y > y1) continue;
          xs.push((a.x * u + b.x * v + c.x * w) / n);
        }
      }
      if (xs.length > 400000) return;
    }
  });
  return xs;
}

function emptyMasks(meshes, sizes) {
  return new Map(meshes.map((m, i) => [m, new Uint8Array(sizes[i])]));
}

/**
 * Splits an avatar part into body zones: head (then face / hair), hands, and the rest.
 * Returns [part] when the part is a single zone. Regions carry `tris`
 * (Map mesh → Uint8Array, 1 = triangle belongs to the region).
 */
export function splitAvatarZones(slot, part, anat) {
  if (!anat) return [part];
  const data = [];
  let total = 0;
  for (const mesh of part.meshes) {
    const src = uvSourceOf(mesh, slot.uvChannel, slot.texture);
    const f = triangleFacings(mesh, src);
    if (!f) continue;
    data.push({ mesh, src, f, islands: islandIdPerTriangle(src) });
    for (const a of f.area) total += a;
  }
  if (!data.length || !(total > 0)) return [part];

  // zone per triangle: 0 = rest, 1 = head, 2 = hand
  const zones = data.map((d) => new Uint8Array(d.f.area.length));
  let headArea = 0;
  let lateralArea = 0;
  let centralArea = 0;
  const lateralW = anat.neckHalfW * 1.6;
  for (let k = 0; k < data.length; k++) {
    const { f } = data[k];
    for (let t = 0; t < f.area.length; t++) {
      const x = f.centroid[t * 3],
        y = f.centroid[t * 3 + 1];
      if (y > anat.neckY) {
        zones[k][t] = 1;
        headArea += f.area[t];
      } else if (Math.abs(x - anat.cx) > lateralW && y > anat.minY + anat.H * 0.3) lateralArea += f.area[t];
      if (Math.abs(x - anat.cx) < anat.neckHalfW * 1.5) centralArea += f.area[t];
    }
  }

  // A UV island is one piece of cloth or skin: when most of it is above the neck line it is
  // all head (the chin and the bottom of the face hang below the line), and when most of it
  // is below, it all stays with the body (a collar). Islands holding a big share of the
  // whole mesh (one island for everything) keep the per-triangle split.
  for (let k = 0; k < data.length; k++) {
    const { f, islands } = data[k];
    const up = new Map(),
      all = new Map();
    for (let t = 0; t < f.area.length; t++) {
      const id = islands[t];
      all.set(id, (all.get(id) ?? 0) + f.area[t]);
      if (zones[k][t] === 1) up.set(id, (up.get(id) ?? 0) + f.area[t]);
    }
    for (let t = 0; t < f.area.length; t++) {
      const id = islands[t];
      const a = all.get(id);
      if (a > total * 0.4) continue;
      const share = (up.get(id) ?? 0) / a;
      if (share >= 0.6 && zones[k][t] !== 1) {
        zones[k][t] = 1;
        headArea += f.area[t];
      } else if (share <= 0.4 && zones[k][t] === 1) {
        zones[k][t] = 0;
        headArea -= f.area[t];
      }
    }
  }

  // The rest (below the neck) is split by UV island groups (torso, arms, legs…).
  // Below the neck, every UV island gets a body label from where it sits on the model:
  // shoes (at the floor), arms (beside the torso), legs (below the crotch) or torso.
  const clusters = clusterRest(data, zones, -1, 0); // one group per island
  for (const c of clusters) {
    let lat = 0,
      ys = 0;
    for (const [k, t] of c.tris) {
      const f = data[k].f;
      lat += Math.abs(f.centroid[t * 3] - anat.cx) * f.area[t];
      ys += f.centroid[t * 3 + 1] * f.area[t];
    }
    const meanY = ys / (c.area || 1);
    const meanX = lat / (c.area || 1);
    c.arms = meanX > anat.torsoHalfW * 1.05 && meanY > anat.minY + anat.H * 0.3;
    // Below the hips it is a leg, unless it hangs well outside the torso (a hand or
    // forearm at hip height); legs sit within the hip width.
    const wide = meanX > anat.torsoHalfW * 1.15 && meanY > anat.minY + anat.H * 0.3;
    if (meanY < anat.minY + anat.H * 0.07) c.label = 'shoes';
    else if (meanY < anat.crotchY && !wide) c.label = 'legs';
    else c.label = c.arms ? 'arms' : 'torso';
    c.arms = c.label === 'arms';
  }

  // A torso island that runs into the sleeves or down the legs (one piece of cloth, e.g.
  // a jumpsuit): its triangles well beside the torso are arms, those below the hips legs.
  for (const c of clusters.filter((x) => x.label === 'torso')) {
    const side = [];
    const low = [];
    const keep = [];
    for (const kt of c.tris) {
      const f = data[kt[0]].f;
      const t = kt[1];
      const y = f.centroid[t * 3 + 1];
      const lateral = Math.abs(f.centroid[t * 3] - anat.cx) > anat.torsoHalfW * 1.15 && y > anat.minY + anat.H * 0.3;
      (lateral ? side : y < anat.crotchY - anat.H * 0.05 ? low : keep).push(kt);
    }
    if (!side.length && !low.length) continue;
    c.tris = keep;
    const areaOf = (list) => list.reduce((sum, [k, t]) => sum + data[k].f.area[t], 0);
    c.area = areaOf(keep);
    if (side.length) clusters.push({ tris: side, area: areaOf(side), label: 'arms', arms: true });
    if (low.length) clusters.push({ tris: low, area: areaOf(low), label: 'legs' });
  }

  // Hands: the far end of each arm, measured from the shoulder.
  const shoulderY = anat.neckY - anat.H * 0.03;
  const shoulderX = anat.torsoHalfW;
  const dist = (x, y, s) => Math.hypot(x - (anat.cx + s * shoulderX), y - shoulderY);
  const armTris = clusters.filter((x) => x.arms).flatMap((c) => c.tris);
  for (const s of [-1, 1]) {
    let maxD = 0;
    for (const [k, t] of armTris) {
      const f = data[k].f;
      if (Math.sign(f.centroid[t * 3] - anat.cx) === s)
        maxD = Math.max(maxD, dist(f.centroid[t * 3], f.centroid[t * 3 + 1], s));
    }
    if (!(maxD > 0)) continue;
    // A UV island that starts past the forearm (or sits mostly at the far end) is a hand
    // piece: the whole island is hand, so the back of the hand and the palm come with the
    // fingers. Arms that are one island with their hand fall back to the far 20%.
    for (const c of clusters.filter((x) => x.arms)) {
      let lo = Infinity,
        sum = 0,
        area = 0;
      const mine = c.tris.filter(([k, t]) => Math.sign(data[k].f.centroid[t * 3] - anat.cx) === s);
      for (const [k, t] of mine) {
        const f = data[k].f;
        const dd = dist(f.centroid[t * 3], f.centroid[t * 3 + 1], s);
        lo = Math.min(lo, dd);
        sum += dd * f.area[t];
        area += f.area[t];
      }
      if (!mine.length) continue;
      const whole = lo > maxD * 0.55 || sum / (area || 1) > maxD * 0.72;
      for (const [k, t] of mine) {
        const f = data[k].f;
        if (whole || dist(f.centroid[t * 3], f.centroid[t * 3 + 1], s) > maxD * 0.8) zones[k][t] = 2;
      }
    }
  }

  const regionOf = (pick) => {
    const tris = emptyMasks(
      data.map((d) => d.mesh),
      data.map((d) => d.f.area.length),
    );
    let area = 0;
    data.forEach((d, k) => {
      const m = tris.get(d.mesh);
      for (let t = 0; t < m.length; t++) {
        if (pick(k, t)) {
          m[t] = 1;
          area += d.f.area[t];
        }
      }
    });
    return { tris, area };
  };

  const pending = [];
  const add = (label, r, zone = label) => {
    if (r.area > 0) pending.push({ label, r, zone });
  };
  const head = regionOf((k, t) => zones[k][t] === 1);
  if (head.area > 0) {
    // Face vs hair: separate UV island groups inside the head zone.
    for (const [label, r] of splitHead(slot, data, zones, head)) add(label, r);
  }
  add(
    'hands',
    regionOf((k, t) => zones[k][t] === 2),
  );
  // Groups with the same label are one zone (both legs, both arms). A single remaining
  // zone keeps the part's own name; several get torso / arms / legs labels.
  const byLabel = new Map();
  for (const c of clusters) {
    if (!byLabel.has(c.label)) byLabel.set(c.label, new Set());
    for (const [k, t] of c.tris) byLabel.get(c.label).add(`${k}:${t}`);
  }
  for (const [label, set] of byLabel) {
    add(
      byLabel.size > 1 ? label : '',
      regionOf((k, t) => zones[k][t] === 0 && set.has(`${k}:${t}`)),
      label,
    );
  }
  // Zones under 1% of the part are merged into a neighbouring zone (a wrist cuff into the
  // hands or arms), so no triangle is left without a zone.
  const NEXT = {
    arms: ['torso', 'hands'],
    hands: ['arms', 'torso'],
    face: ['head', 'hair', 'torso'],
    hair: ['head', 'face'],
    head: ['face', 'hair'],
    shoes: ['legs'],
    legs: ['torso', 'shoes'],
    torso: ['arms', 'legs'],
  };
  pending.sort((x, y) => x.r.area - y.r.area);
  for (let i = 0; i < pending.length;) {
    const z = pending[i];
    if (z.r.area / total >= 0.01 || pending.length === 1) {
      i++;
      continue;
    }
    const others = pending.filter((o) => o !== z);
    // Best: the zone that shares UV islands with it (the same piece of cloth, e.g. the rest
    // of an arm column); else a neighbouring body zone; else the biggest.
    const islandsOf = (r) => {
      const set = new Set();
      data.forEach((d, k) => {
        const m = r.tris.get(d.mesh);
        if (m) for (let t = 0; t < m.length; t++) if (m[t]) set.add(`${k}:${d.islands[t]}`);
      });
      return set;
    };
    const mine = islandsOf(z.r);
    let shared = null,
      sharedN = 0;
    for (const o of others) {
      let n = 0;
      for (const id of islandsOf(o.r)) if (mine.has(id)) n++;
      if (n > sharedN) {
        sharedN = n;
        shared = o;
      }
    }
    const base = String(z.zone ?? '').replace(/ \d+$/, '');
    const target =
      shared ??
      (NEXT[base] ?? [])
        .map((n) => others.find((o) => String(o.zone ?? '').replace(/ \d+$/, '') === n))
        .find(Boolean) ??
      others.reduce((a, b) => (b.r.area > a.r.area ? b : a));
    for (const [mesh, m] of z.r.tris) {
      const t = target.r.tris.get(mesh);
      if (!t) target.r.tris.set(mesh, m);
      else for (let j = 0; j < m.length; j++) if (m[j]) t[j] = 1;
    }
    target.r.area += z.r.area;
    pending.splice(i, 1);
    pending.sort((x, y) => x.r.area - y.r.area);
    i = 0;
  }
  const out = pending.map(({ label, r, zone }) => ({ ...makeRegion(slot, part, label, r, total, data), zone }));
  return out.length > 1 ? out : [{ ...part, zone: out[0]?.zone }];
}

/**
 * Groups the triangles of zone 0 (below the neck) by their UV islands: islands whose UV
 * boxes are within `gap` of each other form a group; groups under `minShare` of the area
 * join the nearest big group. Returns [{ tris: [[k, t]…], area }], biggest first.
 */
function clusterRest(data, zones, gap, minShare) {
  const groups = [];
  data.forEach((d, k) => {
    const byIsland = new Map();
    for (let t = 0; t < d.f.area.length; t++) {
      if (zones[k][t] !== 0) continue;
      let g = byIsland.get(d.islands[t]);
      if (!g) byIsland.set(d.islands[t], (g = { tris: [], area: 0, box: [Infinity, Infinity, -Infinity, -Infinity] }));
      g.tris.push([k, t]);
      g.area += d.f.area[t];
      for (let j = 0; j < 3; j++) {
        const v = d.src.index ? d.src.index[t * 3 + j] : t * 3 + j;
        const u = d.src.uvs[v * 2],
          w = d.src.uvs[v * 2 + 1];
        g.box[0] = Math.min(g.box[0], u);
        g.box[1] = Math.min(g.box[1], w);
        g.box[2] = Math.max(g.box[2], u);
        g.box[3] = Math.max(g.box[3], w);
      }
    }
    groups.push(...byIsland.values());
  });
  if (!groups.length) return [];
  const parent = groups.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < groups.length; i++)
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i].box,
        b = groups[j].box;
      if (a[0] - gap <= b[2] && b[0] - gap <= a[2] && a[1] - gap <= b[3] && b[1] - gap <= a[3])
        parent[find(i)] = find(j);
    }
  const merged = new Map();
  groups.forEach((g, i) => {
    const r = find(i);
    if (!merged.has(r)) merged.set(r, { tris: [], area: 0, box: [Infinity, Infinity, -Infinity, -Infinity] });
    const c = merged.get(r);
    c.tris.push(...g.tris);
    c.area += g.area;
    for (let q = 0; q < 2; q++) c.box[q] = Math.min(c.box[q], g.box[q]);
    for (let q = 2; q < 4; q++) c.box[q] = Math.max(c.box[q], g.box[q]);
  });
  const all = [...merged.values()].sort((a, b) => b.area - a.area);
  const total = all.reduce((s, c) => s + c.area, 0) || 1;
  const big = all.filter((c) => c.area / total >= minShare);
  if (!big.length)
    return [
      all.reduce((acc, c) => ({ tris: acc.tris.concat(c.tris), area: acc.area + c.area }), { tris: [], area: 0 }),
    ];
  const center = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  for (const c of all) {
    if (big.includes(c)) continue;
    const [x, y] = center(c.box);
    let best = big[0],
      bestD = Infinity;
    for (const b of big) {
      const [bx, by] = center(b.box);
      const dd = (bx - x) ** 2 + (by - y) ** 2;
      if (dd < bestD) {
        bestD = dd;
        best = b;
      }
    }
    best.tris.push(...c.tris);
    best.area += c.area;
  }
  return big;
}

/** Splits the head zone into face and hair using UV island groups and which way they face. */
function splitHead(slot, data, zones, head) {
  // Islands with most of their area in the head zone.
  const groups = [];
  data.forEach((d, k) => {
    const byIsland = new Map();
    for (let t = 0; t < d.f.area.length; t++) {
      if (zones[k][t] !== 1) continue;
      const id = d.islands[t];
      let g = byIsland.get(id);
      if (!g)
        byIsland.set(
          id,
          (g = { k, id, area: 0, front: 0, top: 0, y: 0, box: [Infinity, Infinity, -Infinity, -Infinity] }),
        );
      g.area += d.f.area[t];
      if (d.f.facing[t] === 0) g.front += d.f.area[t];
      if (d.f.facing[t] === 4) g.top += d.f.area[t];
      g.y += d.f.centroid[t * 3 + 1] * d.f.area[t];
      for (let j = 0; j < 3; j++) {
        const v = d.src.index ? d.src.index[t * 3 + j] : t * 3 + j;
        const u = d.src.uvs[v * 2],
          w = d.src.uvs[v * 2 + 1];
        g.box[0] = Math.min(g.box[0], u);
        g.box[1] = Math.min(g.box[1], w);
        g.box[2] = Math.max(g.box[2], u);
        g.box[3] = Math.max(g.box[3], w);
      }
    }
    groups.push(...byIsland.values());
  });
  // Merge islands whose UV boxes touch (gap 0.5%).
  const gap = 0.005;
  const parent = groups.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < groups.length; i++)
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i].box,
        b = groups[j].box;
      if (a[0] - gap <= b[2] && b[0] - gap <= a[2] && a[1] - gap <= b[3] && b[1] - gap <= a[3])
        parent[find(i)] = find(j);
    }
  const clusters = new Map();
  groups.forEach((g, i) => {
    const r = find(i);
    if (!clusters.has(r))
      clusters.set(r, {
        members: [],
        area: 0,
        front: 0,
        top: 0,
        y: 0,
        box: [Infinity, Infinity, -Infinity, -Infinity],
      });
    const c = clusters.get(r);
    c.members.push(g);
    c.box = [
      Math.min(c.box[0], g.box[0]),
      Math.min(c.box[1], g.box[1]),
      Math.max(c.box[2], g.box[2]),
      Math.max(c.box[3], g.box[3]),
    ];
    c.area += g.area;
    c.front += g.front;
    c.top += g.top;
    c.y += g.y;
  });
  const list = [...clusters.values()].filter((c) => c.area / head.area >= 0.08);
  const pick = (members) => {
    const set = new Set(members.map((g) => `${g.k}:${g.id}`));
    const tris = new Map();
    let area = 0;
    data.forEach((d, k) => {
      const m = new Uint8Array(d.f.area.length);
      for (let t = 0; t < m.length; t++) {
        if (zones[k][t] === 1 && set.has(`${k}:${d.islands[t]}`)) {
          m[t] = 1;
          area += d.f.area[t];
        }
      }
      tris.set(d.mesh, m);
    });
    return { tris, area };
  };
  if (list.length < 2) return [['head', head]];
  // The face is the group with the most front-facing surface; the rest is hair.
  list.sort((a, b) => b.front / b.area - a.front / a.area);
  // Small groups (single strands, ears, bits) join the big group nearest to them in the
  // texture: loose hair strands sit next to the hair, not the face.
  const boxGap = (a, b) => Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));
  const members = list.map((c) => c.members.slice());
  for (const c of clusters.values()) {
    if (list.includes(c)) continue;
    let best = 0;
    for (let i = 1; i < list.length; i++) if (boxGap(c.box, list[i].box) < boxGap(c.box, list[best].box)) best = i;
    members[best].push(...c.members);
  }
  const out = [['face', pick(members[0])]];
  const others = members.slice(1);
  others.forEach((m, i) => out.push([others.length > 1 ? `hair ${i + 1}` : 'hair', pick(m)]));
  return out;
}

function makeRegion(slot, part, label, r, total, data) {
  // Orientation of the islands mostly inside this region.
  const votes = { up: 0, down: 0, left: 0, right: 0 };
  let area = 0,
    mirroredArea = 0;
  let minU = Infinity,
    minV = Infinity,
    maxU = -Infinity,
    maxV = -Infinity;
  for (const d of data) {
    const m = r.tris.get(d.mesh);
    const inIsland = new Map();
    for (let t = 0; t < m.length; t++) {
      if (!m[t]) continue;
      inIsland.set(d.islands[t], (inIsland.get(d.islands[t]) ?? 0) + 1);
      for (let j = 0; j < 3; j++) {
        const v = d.src.index ? d.src.index[t * 3 + j] : t * 3 + j;
        minU = Math.min(minU, d.src.uvs[v * 2]);
        minV = Math.min(minV, d.src.uvs[v * 2 + 1]);
        maxU = Math.max(maxU, d.src.uvs[v * 2]);
        maxV = Math.max(maxV, d.src.uvs[v * 2 + 1]);
      }
    }
    for (const o of islandUpDirections(d.mesh, d.src)) {
      if (!inIsland.has(o.id)) continue;
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
    name: label ? `${part.name} (${label})` : part.name,
    baseName: part.name,
    region: label,
    zone: label,
    islands: undefined,
    tris: r.tris,
    bbox: [clamp(minU), clamp(minV), clamp(maxU), clamp(maxV)],
    area: r.area,
    share: r.area / total,
    up,
    mirrored: area > 0 ? mirroredArea / area > 0.5 : part.mirrored,
  };
}
