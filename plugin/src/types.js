/**
 * Shared JSDoc type definitions. This file has no runtime code; editors such as
 * VS Code read these for autocomplete. Reference them with
 * `@type {import('./types.js').TextureSlot}`.
 */

/**
 * Axis-aligned bounds in UV space.
 * @typedef {{ minU: number, minV: number, maxU: number, maxV: number }} UvBounds
 */

/**
 * One connected region of triangles in UV space.
 * @typedef {object} UvIsland
 * @property {number} triangleCount
 * @property {UvBounds} bounds
 * @property {number} area Area in UV units (0..1 squared).
 */

/**
 * Coverage statistics from rasterizing UV triangles into a coarse grid.
 * @typedef {object} UvCoverage
 * @property {number} resolution Grid resolution used for the estimate.
 * @property {number} coverage Fraction (0..1) of the UV square covered by at least one triangle.
 * @property {number} overlap Fraction (0..1) of covered cells hit by more than one island (mirrored / stacked UVs).
 */

/**
 * A unique base color texture (or an untextured material) plus everything that samples it.
 * @typedef {object} TextureSlot
 * @property {string} id Stable id within one analysis ("slot0", "slot1", ...).
 * @property {string} name
 * @property {import('three').Texture | null} texture The live base color map, or null when untextured.
 * @property {number} width
 * @property {number} height
 * @property {number} uvChannel UV channel the map samples (0 = uv, 1 = uv1, ...).
 * @property {import('three').MeshStandardMaterial[]} materials
 * @property {import('three').Mesh[]} meshes
 * @property {UvIsland[]} islands
 * @property {UvCoverage} coverage
 * @property {UvBounds} uvBounds
 * @property {boolean} tiled UVs extend outside 0..1, so the texture repeats.
 * @property {boolean} missingUvs At least one mesh using this slot has no UVs.
 * @property {string[]} otherMaps Other maps on the same materials (normalMap, roughnessMap, ...).
 * @property {number} triangleCount
 */

/**
 * @typedef {object} TextureLayout
 * @property {TextureSlot[]} slots
 * @property {number} meshCount
 * @property {number} materialCount
 * @property {number} triangleCount
 * @property {string[]} warnings Human readable notes (tiled UVs, missing UVs, overlap, unsupported materials).
 */

/**
 * @typedef {object} LoadedModel
 * @property {string} name
 * @property {import('three/examples/jsm/loaders/GLTFLoader.js').GLTF} gltf
 * @property {import('three').Group} scene
 */

/**
 * @typedef {'analyze' | 'plan' | 'generate' | 'postprocess' | 'apply' | 'done'} ReskinStage
 */

/**
 * @typedef {object} ReskinProgress
 * @property {ReskinStage} stage
 * @property {string} [slotId]
 * @property {string} message
 * @property {number} progress Overall progress 0..1.
 */

/**
 * Options for `ReskinPlugin.postPrompt`.
 * @typedef {object} PostPromptOptions
 * @property {string[]} [slotIds] Restrict to these slot ids. Default: all slots.
 * @property {number} [detailPreserve] How much of the original atlas's light/dark detail to keep (0..1). Default 0.35.
 * @property {boolean} [useVisionPlanning] Ask the vision model to describe atlas regions first. Default true.
 * @property {number} [maxTextureSize] Longest side of generated textures. Default: source size, capped at 2048.
 * @property {string} [extraInstructions] Free text appended to the model prompt.
 * @property {boolean} [normalMaps] Regenerate / create normal maps. Default true.
 * @property {boolean} [roughnessMaps] Regenerate / create roughness maps. Default true.
 * @property {number} [normalStrength] Strength of derived normal maps. Default 2.
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} ReskinSlotResult
 * @property {string} slotId
 * @property {HTMLCanvasElement} canvas Final base color applied to the model.
 * @property {HTMLCanvasElement} raw Image the provider returned, before resize and post-processing.
 * @property {LayoutPlan | null} [plan] Vision plan used to build the prompt.
 * @property {string} prompt
 */

/**
 * @typedef {object} ReskinResult
 * @property {string} prompt
 * @property {ReskinSlotResult[]} slots
 * @property {number} recoloredMaterials Materials tinted instead of textured (no UVs could be made).
 * @property {number} durationMs
 */

/**
 * What the vision model reports about a texture atlas.
 * @typedef {object} LayoutPlan
 * @property {string} subject
 * @property {{ name: string, description?: string, bbox?: [number, number, number, number] }[]} regions
 *   bbox is a normalized 0..1000 box [x0, y0, x1, y1] in image space.
 * @property {string} [style]
 * @property {string} [raw]
 */

export {};
