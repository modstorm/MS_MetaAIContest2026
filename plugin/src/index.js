export { ReskinPlugin, slug, softenTheme, sanitizePrompt } from './ReskinPlugin.js';

export {
  MuseClient,
  MuseApiError,
  isContentPolicyError,
  MUSE_DEFAULT_BASE,
  MUSE_IMAGE_MODEL,
  MUSE_VISION_MODEL,
} from './muse/MuseClient.js';

export {
  MUSE_PRICES,
  MUSE_WONDER_MODEL,
  priceFor,
  emptyUsage,
  addUsage,
  usageCost,
  unpriced,
  formatUsage,
  formatTokens,
  formatDollars,
} from './muse/pricing.js';

export * as prompts from './muse/prompts.js';

export { MuseProvider } from './providers/MuseProvider.js';

export { ProceduralProvider, paletteForTheme } from './providers/ProceduralProvider.js';

export { loadModel, exportGLB } from './io/modelIO.js';

export { analyzeTextureLayout, summarizeLayout, uvSourceOf, hasTextureTransform } from './analysis/textureLayout.js';
export { computeUvIslands, computeUvCoverage, computeUvBounds, isTiled } from './analysis/uvIslands.js';
export { generateBoxUvs } from './analysis/uvGenerate.js';
export { renderAxisViews, AXIS_VIEWS } from './analysis/renderViews.js';
export { slotParts, chooseOrientation, resolveOrientation, transformParts } from './analysis/parts.js';
export {
  drawUvGuide,
  drawAtlasWithUvs,
  drawPartMap,
  transformCanvas,
  untransformCanvas,
  textureToCanvas,
  canvasToBlob,
  canvasToDataUrl,
} from './texture/imageUtils.js';
export { deriveNormalMap, deriveRoughnessMap } from './texture/pbrMaps.js';
export { ASSET_CLASSES, registerAssetClass, getAssetClass, detectAssetClass, assetClassRules } from './assetClasses.js';
export { drawFacingMap, splitPartRegions, FACINGS } from './analysis/facing.js';
