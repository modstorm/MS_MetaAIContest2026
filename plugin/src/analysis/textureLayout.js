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
export function uvSourceOf(mesh, channel = 0) {
  const geom = mesh.geometry;
  const uv = geom.getAttribute(uvAttributeName(channel));
  if (!uv) return null;
  let uvs;
  if (uv.isInterleavedBufferAttribute || uv.normalized || uv.itemSize !== 2) {
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

function isStandard(m) {
  return m.isMeshStandardMaterial === true;
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
          `Material "${mat.name || mat.type}" on "${mesh.name}" is ${mat.type}; only standard/physical PBR materials are reskinned.`,
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
      for (const m of OTHER_MAPS) {
        if (mat[m] && !slot.otherMaps.includes(m)) slot.otherMaps.push(m);
      }
      if (!slot.meshes.includes(mesh)) {
        slot.meshes.push(mesh);
        const src = uvSourceOf(mesh, channel);
        if (src) sources.get(key).push(src);
        else slot.missingUvs = true;
      }
    }
  });

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
      warnings.push(`"${slot.name}": some meshes have no UVs; box-projected UVs and a seamless texture will be generated.`);
    if (slot.tiled)
      warnings.push(`"${slot.name}": UVs go outside 0..1, the texture tiles; a seamless texture is generated.`);
    if (slot.coverage.overlap > 0.05)
      warnings.push(
        `"${slot.name}": ${(slot.coverage.overlap * 100).toFixed(0)}% of UV area overlaps (mirrored or stacked islands).`,
      );
    if (slot.texture && slot.texture.offset && (slot.texture.repeat.x !== 1 || slot.texture.repeat.y !== 1))
      warnings.push(
        `"${slot.name}": texture uses KHR_texture_transform repeat; the layout is analyzed in raw UV space.`,
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
