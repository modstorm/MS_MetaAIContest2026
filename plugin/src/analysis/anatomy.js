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
  return {
    minY,
    maxY,
    H,
    cx,
    cz,
    neckY: minY + ((neckBin + 0.5) / bins) * H,
    neckHalfW: Math.max(width[neckBin], H * 0.02),
  };
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

  // Arm-like part (mostly beside the body, above the knees): its far ends are the hands.
  // Arms: beside the body, nothing in the middle, no head.
  if (lateralArea / total > 0.6 && centralArea / total < 0.05 && headArea / total < 0.01) {
    const shoulderY = anat.neckY - anat.H * 0.03;
    const shoulderX = anat.neckHalfW * 2.5;
    const dist = (x, y, s) => Math.hypot(x - (anat.cx + s * shoulderX), y - shoulderY);
    for (const s of [-1, 1]) {
      let maxD = 0;
      for (const { f } of data) {
        for (let t = 0; t < f.area.length; t++) {
          const x = f.centroid[t * 3];
          if (Math.sign(x - anat.cx) !== s) continue;
          maxD = Math.max(maxD, dist(x, f.centroid[t * 3 + 1], s));
        }
      }
      if (!(maxD > 0)) continue;
      data.forEach(({ f }, k) => {
        for (let t = 0; t < f.area.length; t++) {
          const x = f.centroid[t * 3];
          if (Math.sign(x - anat.cx) !== s || zones[k][t] === 1) continue;
          if (dist(x, f.centroid[t * 3 + 1], s) > maxD * 0.8) zones[k][t] = 2;
        }
      });
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

  const out = [];
  const add = (label, r) => {
    if (r.area / total < 0.01) return;
    out.push(makeRegion(slot, part, label, r, total, data));
  };
  const head = regionOf((k, t) => zones[k][t] === 1);
  const hands = regionOf((k, t) => zones[k][t] === 2);
  const rest = regionOf((k, t) => zones[k][t] === 0);
  const headShare = head.area / total;

  if (headShare > 0.01) {
    // Face vs hair: separate UV island groups inside the head zone.
    for (const [label, r] of splitHead(slot, data, zones, head)) add(label, r);
  }
  add('hands', hands);
  if (out.length) add(restLabel(), rest);
  return out.length > 1 || (out.length === 1 && out[0].share < 0.99) ? out : [part];
}

function restLabel() {
  return ''; // the rest keeps the part's own name
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
    if (!clusters.has(r)) clusters.set(r, { members: [], area: 0, front: 0, top: 0, y: 0 });
    const c = clusters.get(r);
    c.members.push(g);
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
  const [face, ...others] = list;
  const small = [...clusters.values()].filter((c) => !list.includes(c));
  const out = [['face', pick(face.members.concat(small.flatMap((c) => c.members)))]];
  others.forEach((c, i) => out.push([others.length > 1 ? `hair ${i + 1}` : 'hair', pick(c.members)]));
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
