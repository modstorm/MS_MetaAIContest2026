import * as THREE from 'three';

import {
  computeUvBounds,
  computeUvCoverage,
  computeUvIslands,
  emptyBounds,
  isTiled,
  mergeBounds,
  triangleCount,
} from './uvIslands.js';

const OTHER_MAPS = ['normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap'];

/** Name of the geometry attribute a texture channel reads (0 -> uv, 1 -> uv1, ...). */
export function uvAttributeName(channel) {
  return channel === 0 ? 'uv' : `uv${channel}`;
}

/** Extracts the UV triangle source for a mesh / channel, or null if it has no UVs. */
/**
 * True if a texture's own settings change where UVs land in the image:
 * flipY (three.js upload flag) or a KHR_texture_transform offset/repeat/rotation.
 */
export function hasTextureTransform(tex) {
  if (!tex) return false;
  return (
    tex.flipY === true ||
    tex.rotation !== 0 ||
    tex.offset.x !== 0 ||
    tex.offset.y !== 0 ||
    tex.repeat.x !== 1 ||
    tex.repeat.y !== 1
  );
}

/**
 * UVs of a mesh in IMAGE space (x right, y down, 0..1 over the image) for the given
 * texture: applies the texture's KHR_texture_transform (offset / repeat / rotation, as
 * three.js stores it on the texture) and its flipY flag, exactly like the shader does.
 * Without a texture (or with an identity transform) the raw glTF UVs are returned.
 */
export function uvSourceOf(mesh, channel = 0, texture = null) {
  const geom = mesh.geometry;
  const uv = geom.getAttribute(uvAttributeName(channel));
  if (!uv) return null;
  let uvs;
  if (hasTextureTransform(texture)) {
    if (texture.matrixAutoUpdate) texture.updateMatrix();
    const e = texture.matrix.elements; // column-major 3x3
    const flip = texture.flipY === true;
    uvs = new Float32Array(uv.count * 2);
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i),
        v = uv.getY(i);
      const s = e[0] * u + e[3] * v + e[6];
      const t = e[1] * u + e[4] * v + e[7];
      uvs[i * 2] = s;
      uvs[i * 2 + 1] = flip ? 1 - t : t;
    }
  } else if (uv.isInterleavedBufferAttribute || uv.normalized || uv.itemSize !== 2) {
    const flat = new Float32Array(uv.count * 2);
    for (let i = 0; i < uv.count; i++) {
      flat[i * 2] = uv.getX(i);
      flat[i * 2 + 1] = uv.getY(i);
    }
    uvs = flat;
  } else {
    uvs = uv.array;
  }
  const index = geom.getIndex();
  const src = { uvs, index: index ? index.array : null };
  // Respect geometry draw groups / drawRange only roughly: full geometry is used.
  return src;
}

function materialsOf(mesh) {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** Materials with a base color map and color: PBR, and unlit / simple-lit ones (kept as they are). */
function isStandard(m) {
  return (
    m.isMeshStandardMaterial === true ||
    m.isMeshBasicMaterial === true ||
    m.isMeshLambertMaterial === true ||
    m.isMeshPhongMaterial === true ||
    m.isMeshToonMaterial === true
  );
}

function imageSize(tex) {
  const img = tex.image;
  return { width: img?.width ?? 0, height: img?.height ?? 0 };
}

/**
 * Walks a scene and groups everything by base color texture.
 * Materials without a base map but with a mesh are grouped into one
 * "untextured" slot per material so they can be retextured or recolored too.
 */
export function analyzeTextureLayout(root) {
  const byTexture = new Map();
  const sources = new Map();
  const materials = new Set();
  const warnings = [];
  let meshCount = 0;
  let totalTris = 0;

  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    const mesh = obj;
    if (!mesh.isMesh) return;
    meshCount++;
    const mats = materialsOf(mesh);
    for (const mat of mats) {
      materials.add(mat);
      if (!isStandard(mat)) {
        warnings.push(
          `Material "${mat.name || mat.type}" on "${mesh.name}" is ${mat.type}; only mesh materials with a color map are reskinned.`,
        );
        continue;
      }
      const tex = mat.map;
      const channel = tex?.channel ?? 0;
      const key = tex ? `tex:${tex.uuid}` : `mat:${mat.uuid}`;
      let slot = byTexture.get(key);
      if (!slot) {
        const size = tex ? imageSize(tex) : { width: 1024, height: 1024 };
        slot = {
          id: `slot${byTexture.size}`,
          name: tex?.name || mat.name || `material ${byTexture.size}`,
          texture: tex ?? null,
          width: size.width,
          height: size.height,
          uvChannel: channel,
          materials: [],
          meshes: [],
          islands: [],
          coverage: { resolution: 0, coverage: 0, overlap: 0 },
          uvBounds: emptyBounds(),
          tiled: false,
          missingUvs: false,
          otherMaps: [],
          triangleCount: 0,
        };
        byTexture.set(key, slot);
        sources.set(key, []);
      }
      if (!slot.materials.includes(mat)) slot.materials.push(mat);
      if (mat.isMeshBasicMaterial) slot.unlit = true;
      for (const m of OTHER_MAPS) {
        if (mat[m] && !slot.otherMaps.includes(m)) slot.otherMaps.push(m);
      }
      if (!slot.meshes.includes(mesh)) {
        slot.meshes.push(mesh);
        const src = uvSourceOf(mesh, channel, tex);
        if (src) sources.get(key).push(src);
        else slot.missingUvs = true;
      }
    }
  });

  uniqueSlotNames([...byTexture.values()]);

  for (const [key, slot] of byTexture) {
    const srcs = sources.get(key);
    let bounds = emptyBounds();
    for (const src of srcs) {
      const tris = triangleCount(src);
      slot.triangleCount += tris;
      totalTris += tris;
      bounds = mergeBounds(bounds, computeUvBounds(src));
      slot.islands.push(...computeUvIslands(src));
    }
    slot.islands.sort((a, b) => b.area - a.area);
    slot.uvBounds = bounds;
    slot.tiled = srcs.length > 0 && isTiled(bounds);
    slot.coverage = srcs.length ? computeUvCoverage(srcs, 256) : slot.coverage;

    if (slot.missingUvs)
      warnings.push(
        `"${slot.name}": some meshes have no UVs; box-projected UVs and a seamless texture will be generated.`,
      );
    if (slot.tiled)
      warnings.push(`"${slot.name}": UVs go outside 0..1, the texture tiles; a seamless texture is generated.`);
    if (slot.coverage.overlap > 0.05)
      warnings.push(
        `"${slot.name}": ${(slot.coverage.overlap * 100).toFixed(0)}% of UV area overlaps (mirrored or stacked islands).`,
      );
    if (hasTextureTransform(slot.texture))
      warnings.push(
        `"${slot.name}": the texture carries its own orientation (${slot.texture.flipY ? 'flipY' : ''}${slot.texture.flipY && slot.texture.rotation ? ', ' : ''}${slot.texture.rotation ? `rotation ${Math.round((slot.texture.rotation * 180) / Math.PI)}°` : ''}${slot.texture.repeat.x !== 1 || slot.texture.repeat.y !== 1 || slot.texture.offset.x || slot.texture.offset.y ? ' KHR_texture_transform offset/scale' : ''}); it is applied before analysis.`,
      );
  }

  return {
    slots: [...byTexture.values()],
    meshCount,
    materialCount: materials.size,
    triangleCount: totalTris,
    warnings,
  };
}

/**
 * Slots that share a name (two materials both called "lambert1", Maya's default) are
 * told apart by their first mesh: "lambert1 · carBody", "lambert1 · tireBackR".
 * Logs, panels, history and Muse prompts then all name the right texture.
 * @param {{ name: string, meshes: { name?: string }[] }[]} slots
 */
export function uniqueSlotNames(slots) {
  const count = new Map();
  for (const s of slots) count.set(s.name, (count.get(s.name) ?? 0) + 1);
  const taken = new Set(slots.filter((s) => count.get(s.name) === 1).map((s) => s.name));
  slots.forEach((s, i) => {
    if (count.get(s.name) === 1) return;
    const mesh = s.meshes
      .map((m) =>
        String(m.name || '')
          .replace(/[_.]\d+$/, '')
          .trim(),
      )
      .find(Boolean);
    let name = mesh ? `${s.name} · ${mesh}` : `${s.name} (${i + 1})`;
    for (let n = 2; taken.has(name); n++) name = `${s.name} · ${mesh || 'texture'} ${n}`;
    taken.add(name);
    s.name = name;
  });
  return slots;
}

/** Compact JSON-friendly summary of a layout (no three.js objects), for logging or sending to a model. */
export function summarizeLayout(layout) {
  return {
    meshCount: layout.meshCount,
    materialCount: layout.materialCount,
    triangleCount: layout.triangleCount,
    warnings: layout.warnings,
    slots: layout.slots.map((s) => ({
      id: s.id,
      name: s.name,
      textured: !!s.texture,
      size: `${s.width}x${s.height}`,
      uvChannel: s.uvChannel,
      materials: s.materials.map((m) => m.name),
      meshes: s.meshes.map((m) => m.name),
      triangles: s.triangleCount,
      islands: s.islands.length,
      coveragePct: Math.round(s.coverage.coverage * 1000) / 10,
      overlapPct: Math.round(s.coverage.overlap * 1000) / 10,
      tiled: s.tiled,
      missingUvs: s.missingUvs,
      otherMaps: s.otherMaps,
    })),
  };
}

/**
 * How wide the texture is on the model compared with how tall: world length per unit of u
 * over world length per unit of v, from the triangle edges that run along u or along v
 * (a ring 2πr around and h tall gives about 2πr / h). 1 when it cannot tell.
 */
export function uvAspect(slot) {
  let su = 0,
    nu = 0,
    sv = 0,
    nv = 0;
  const a = new THREE.Vector3(),
    b = new THREE.Vector3();
  for (const mesh of slot.meshes) {
    const geom = mesh.geometry;
    const pos = geom.getAttribute('position');
    const uv = geom.getAttribute(slot.uvChannel === 0 ? 'uv' : `uv${slot.uvChannel}`);
    if (!pos || !uv) continue;
    const index = geom.getIndex();
    const tris = index ? index.count / 3 : pos.count / 3;
    const step = Math.max(1, Math.floor(tris / 4000));
    mesh.updateMatrixWorld(true);
    for (let t = 0; t < tris; t += step) {
      for (let e = 0; e < 3; e++) {
        const i0 = index ? index.getX(t * 3 + e) : t * 3 + e;
        const i1 = index ? index.getX(t * 3 + ((e + 1) % 3)) : t * 3 + ((e + 1) % 3);
        const du = Math.abs(uv.getX(i1) - uv.getX(i0)),
          dv = Math.abs(uv.getY(i1) - uv.getY(i0));
        a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
        const len = a.distanceTo(b);
        if (du > 1e-6 && du > 4 * dv) {
          su += len / du;
          nu++;
        } else if (dv > 1e-6 && dv > 4 * du) {
          sv += len / dv;
          nv++;
        }
      }
    }
  }
  return nu && nv ? su / nu / (sv / nv) : 1;
}

/**
 * A mesh that is a band around a vertical axis (a background ring, possibly with a skyline
 * cut into its top): { cx, cz, radius, y0, y1, inward } in the mesh's own space, or null.
 * The vertices must lie at about the same distance from the centre, all the way round.
 */
export function ringBand(mesh, { loose = false } = {}) {
  const pos = mesh.geometry?.getAttribute('position');
  if (!pos || pos.count < 8) return null;
  const box = new THREE.Box3().setFromBufferAttribute(pos);
  const cx = (box.min.x + box.max.x) / 2,
    cz = (box.min.z + box.max.z) / 2;
  const r = [];
  const angles = [];
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - cx,
      dz = pos.getZ(i) - cz;
    r.push(Math.hypot(dx, dz));
    angles.push(Math.atan2(dz, dx));
  }
  // Goes all the way round: no gap between neighbouring vertex angles wider than 30°.
  angles.sort((a, b) => a - b);
  let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1]);
  r.sort((a, b) => a - b);
  const radius = r[r.length >> 1];
  const height = box.max.y - box.min.y;
  // loose: several rings of different sizes in one mesh (a layered backdrop) count too.
  const spread = loose ? 0.5 : 0.15;
  if (
    !radius ||
    r[Math.floor(r.length * 0.05)] < radius * (1 - spread) ||
    r[Math.floor(r.length * 0.95)] > radius * (1 + spread)
  )
    return null;
  if (gap > Math.PI / 6 || height <= 0 || height > radius * (loose ? 3 : 2)) return null;
  // Which way the faces look: towards the centre (seen from inside) or outwards.
  const nrm = mesh.geometry.getAttribute('normal');
  let dot = 0;
  if (nrm)
    for (let i = 0; i < pos.count; i++) dot += nrm.getX(i) * (pos.getX(i) - cx) + nrm.getZ(i) * (pos.getZ(i) - cz);
  return { cx, cz, radius, y0: box.min.y, y1: box.max.y, inward: dot < 0 };
}

/**
 * A plain open band for `ring` (see ringBand): u runs once around, v from top (0) to bottom (1)
 * as in glTF, faces turned the same way as the original.
 */
export function ringBandGeometry(ring, segments = 128) {
  const h = ring.y1 - ring.y0;
  const g = new THREE.CylinderGeometry(ring.radius, ring.radius, h, segments, 1, true);
  g.translate(ring.cx, (ring.y0 + ring.y1) / 2, ring.cz);
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  if (ring.inward) {
    const idx = g.getIndex();
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, a);
    }
    const n = g.getAttribute('normal');
    for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  }
  return g;
}

/** Degrees around the ring that 5° `sectors` cover: 360 less the widest empty run (over 10°). */
function arcOf(sectors) {
  const n = sectors.length;
  let best = 0,
    run = 0;
  for (let i = 0; i < 2 * n; i++) {
    run = sectors[i % n] ? 0 : run + 1;
    best = Math.max(best, Math.min(run, n));
  }
  return best <= 2 ? 360 : Math.round(360 - (best * 360) / n);
}

/**
 * The horizontal strips a ring backdrop's UVs use in its texture, at width × height:
 * { width, height, flip, bands: [{ y0, y1, pieces: [{ x0, x1 }], aspect, pieceAspect, arc }] },
 * or null. A strip is a run of connected triangles (a UV island; islands side by side on the
 * same rows are one strip). A strip is either a whole ring (a depth layer) or a part of it
 * (`arc`: its degrees around, < 330), and is cut into pieces of about 2:1 on the model so Muse
 * paints each piece at its own shape. `flip`: the image's up is the model's down.
 */
export function ringLayerBands(slot, width, height) {
  const W = width,
    H = height;
  let up = 0;
  const islands = [];
  const pa = new THREE.Vector3(),
    pb = new THREE.Vector3();
  for (const mesh of slot.meshes) {
    const src = uvSourceOf(mesh, slot.uvChannel, slot.texture);
    const pos = mesh.geometry.getAttribute('position');
    if (!src || !pos) continue;
    mesh.updateMatrixWorld(true);
    const n = src.uvs.length / 2;
    // Islands: triangles sharing a vertex, or a vertex at the same place with the same UV.
    const parent = Int32Array.from({ length: n }, (_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    const join = (a, b) => {
      a = find(a);
      b = find(b);
      if (a !== b) parent[b] = a;
    };
    const same = new Map();
    for (let i = 0; i < n; i++) {
      const k = [src.uvs[i * 2], src.uvs[i * 2 + 1], pos.getX(i), pos.getY(i), pos.getZ(i)]
        .map((v) => Math.round(v * 1e4))
        .join(',');
      if (same.has(k)) join(same.get(k), i);
      else same.set(k, i);
    }
    const tris = Math.floor((src.index ? src.index.length : n) / 3);
    const vOf = (t, k) => (src.index ? src.index[t * 3 + k] : t * 3 + k);
    const ok = new Uint8Array(tris);
    for (let t = 0; t < tris; t++) {
      const vs = [0, 1, 2].map((k) => vOf(t, k));
      const us = vs.map((v) => src.uvs[v * 2]),
        ws = vs.map((v) => src.uvs[v * 2 + 1]);
      // A stray triangle across everything is left out.
      if (Math.max(...us) - Math.min(...us) > 0.9 && Math.max(...ws) - Math.min(...ws) > 0.9) continue;
      ok[t] = 1;
      join(vs[0], vs[1]);
      join(vs[0], vs[2]);
    }
    const byRoot = new Map();
    const box = new THREE.Box3().setFromBufferAttribute(pos);
    const cx = (box.min.x + box.max.x) / 2,
      cz = (box.min.z + box.max.z) / 2;
    for (let t = 0; t < tris; t++) {
      if (!ok[t]) continue;
      const vs = [0, 1, 2].map((k) => vOf(t, k));
      const root = find(vs[0]);
      let isl = byRoot.get(root);
      if (!isl) {
        isl = { u0: 1e9, u1: -1e9, v0: 1e9, v1: -1e9, su: 0, cu: 0, sv: 0, cv: 0, sectors: new Uint8Array(72) };
        byRoot.set(root, isl);
        islands.push(isl);
      }
      for (let k = 0; k < 3; k++) {
        const a = vs[k],
          b = vs[(k + 1) % 3];
        const ua = src.uvs[a * 2],
          wa = src.uvs[a * 2 + 1],
          ub = src.uvs[b * 2],
          wb = src.uvs[b * 2 + 1];
        isl.u0 = Math.min(isl.u0, ua);
        isl.u1 = Math.max(isl.u1, ua);
        isl.v0 = Math.min(isl.v0, wa);
        isl.v1 = Math.max(isl.v1, wa);
        // Which way is up: image rows going down (v up) should go down the model (y down).
        up += (wb - wa) * (pos.getY(b) - pos.getY(a));
        const du = Math.abs(ub - ua) * W,
          dv = Math.abs(wb - wa) * H;
        pa.fromBufferAttribute(pos, a).applyMatrix4(mesh.matrixWorld);
        pb.fromBufferAttribute(pos, b).applyMatrix4(mesh.matrixWorld);
        const len = pa.distanceTo(pb);
        // World length per pixel along u and along v (for the strip's shape on the model).
        if (du > 0.5 && du > 4 * dv) {
          isl.su += len / du;
          isl.cu++;
        } else if (dv > 0.5 && dv > 4 * du) {
          isl.sv += len / dv;
          isl.cv++;
        }
        const ang = Math.atan2(pos.getZ(a) - cz, pos.getX(a) - cx);
        isl.sectors[Math.min(71, Math.floor(((ang + Math.PI) / (2 * Math.PI)) * 72))] = 1;
      }
    }
  }
  // Strips: islands on (mostly) the same rows, side by side.
  const px = islands
    .map((s) => ({
      ...s,
      x0: Math.max(0, Math.floor(s.u0 * W)),
      x1: Math.min(W, Math.ceil(s.u1 * W)),
      y0: Math.max(0, Math.floor(s.v0 * H)),
      y1: Math.min(H, Math.ceil(s.v1 * H)),
    }))
    .filter((s) => s.x1 - s.x0 >= 4 && s.y1 - s.y0 >= Math.max(4, H * 0.005))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const bands = [];
  for (const s of px) {
    const b = bands.find((b) => {
      const o = Math.min(b.y1, s.y1) - Math.max(b.y0, s.y0);
      return o > 0.5 * Math.min(b.y1 - b.y0, s.y1 - s.y0);
    });
    if (!b) {
      bands.push({ ...s, sectors: Uint8Array.from(s.sectors) });
      continue;
    }
    b.x0 = Math.min(b.x0, s.x0);
    b.x1 = Math.max(b.x1, s.x1);
    b.y0 = Math.min(b.y0, s.y0);
    b.y1 = Math.max(b.y1, s.y1);
    for (const k of ['su', 'cu', 'sv', 'cv']) b[k] += s[k];
    for (let i = 0; i < 72; i++) b.sectors[i] |= s.sectors[i];
  }
  // Overlapping strips (rounding at shared edges): the later one starts where the earlier ends.
  bands.sort((a, b) => a.y0 - b.y0);
  for (let i = 1; i < bands.length; i++) if (bands[i].y0 < bands[i - 1].y1) bands[i].y0 = bands[i - 1].y1;
  const out = bands.filter((b) => b.y1 - b.y0 >= 4);
  if (!out.length) return null;
  const result = out.map((b) => {
    const pxAspect = (b.x1 - b.x0) / (b.y1 - b.y0);
    // The strip's shape on the model (a 785 m ring 33 m tall is 24:1, whatever its pixels say).
    const aspect = b.cu && b.cv ? pxAspect * (b.su / b.cu / (b.sv / b.cv)) : pxAspect;
    // Pieces of about 2:1 on the model, at most 8 (each a little wider then).
    const n = Math.min(8, Math.max(1, Math.round(aspect / 2)));
    return {
      y0: b.y0,
      y1: b.y1,
      aspect,
      pieceAspect: aspect / n,
      arc: arcOf(b.sectors),
      pieces: Array.from({ length: n }, (_, i) => ({
        x0: Math.round(b.x0 + ((b.x1 - b.x0) * i) / n),
        x1: Math.round(b.x0 + ((b.x1 - b.x0) * (i + 1)) / n),
      })),
    };
  });
  return { width, height, flip: up > 0, bands: result };
}
