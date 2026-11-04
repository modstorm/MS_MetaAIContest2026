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
