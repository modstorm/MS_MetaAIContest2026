/**
 * The texture provider contract (JSDoc only, no runtime code).
 *
 * A provider is any object with these methods. MuseProvider talks to Meta Muse;
 * ProceduralProvider runs offline for tests and demos. Write your own to plug in
 * another model or an in-house service.
 *
 * @typedef {Blob | HTMLCanvasElement} ProviderImage  What a provider may return for an image.
 *
 * @typedef {object} TextureProvider
 * @property {string} name
 * @property {(req: PlanLayoutRequest) => Promise<import('../types.js').LayoutPlan | null>} [planLayout]
 *   Optional: describe the atlas regions to improve the edit prompt.
 * @property {(req: ReskinAtlasRequest) => Promise<ProviderImage>} reskinAtlas
 *   Repaint an existing base color atlas, keeping its layout.
 * @property {(req: GenerateTextureRequest) => Promise<ProviderImage>} generateTexture
 *   Create a new seamless texture (untextured materials or tiled UVs).
 * @property {(req: ReskinAuxMapRequest) => Promise<ProviderImage>} [reskinAuxMap]
 *   Optional: repaint a normal / roughness map with the model. If absent, maps are derived locally.
 *
 * @typedef {object} PlanLayoutRequest
 * @property {string} slotName
 * @property {string[]} meshNames
 * @property {HTMLCanvasElement} atlas
 * @property {HTMLCanvasElement} atlasWithUvs Atlas with the UV wireframe drawn on top.
 * @property {AbortSignal} [signal]
 *
 * @typedef {object} ReskinAtlasRequest
 * @property {string} theme
 * @property {string} slotName
 * @property {HTMLCanvasElement} atlas
 * @property {HTMLCanvasElement} uvGuide White-on-black island mask with wireframe.
 * @property {number} width
 * @property {number} height
 * @property {import('../types.js').LayoutPlan | null} [plan]
 * @property {string} [extraInstructions]
 * @property {AbortSignal} [signal]
 *
 * @typedef {object} GenerateTextureRequest
 * @property {string} theme
 * @property {string} materialName
 * @property {number} width
 * @property {number} height
 * @property {string} [extraInstructions]
 * @property {AbortSignal} [signal]
 *
 * @typedef {object} ReskinAuxMapRequest
 * @property {'normal' | 'roughness'} kind
 * @property {string} theme
 * @property {HTMLCanvasElement} source The existing normal or roughness map.
 * @property {HTMLCanvasElement} newBaseColor The newly generated base color.
 * @property {number} width
 * @property {number} height
 * @property {AbortSignal} [signal]
 */

export {};
