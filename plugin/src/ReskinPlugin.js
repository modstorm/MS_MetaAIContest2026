import * as THREE from 'three';
import { analyzeTextureLayout, summarizeLayout, uvAspect } from './analysis/textureLayout.js';
import { generateBoxUvs } from './analysis/uvGenerate.js';
import { REVIEW_VIEWS, THUMB_VIEW, renderAxisViews, stackCanvases } from './analysis/renderViews.js';
import {
  PART_COLORS,
  chooseOrientation,
  isIdentity,
  partName,
  resolveOrientation,
  slotParts,
  transformParts,
} from './analysis/parts.js';
import {
  drawFacingMap,
  facingGridText,
  facingStripsText,
  frontSpan,
  frontSpanText,
  facingShareText,
  facingSummary,
  splitPartRegions,
  splitTopBottom,
  whiteMask,
} from './analysis/facing.js';
import { avatarAnatomy, makeRegion, splitAvatarZones } from './analysis/anatomy.js';
import { findSamZones, regionData, zoneConceptsFor } from './analysis/samZones.js';
import { assetClassRules, detectAssetClass, getAssetClass, normalizeAssetClass, splitWords } from './assetClasses.js';
import { exportGLB, loadModel } from './io/modelIO.js';
import { makeZip } from './io/zip.js';
import { MuseProvider } from './providers/MuseProvider.js';
import { isContentPolicyError } from './muse/MuseClient.js';
import { ROOF_SURFACE } from './muse/prompts.js';
import { addUsage, emptyUsage, formatDollars, formatUsage, priceFor, usageCost } from './muse/pricing.js';
import {
  findIntrusions,
  intrusionNote,
  intrusionScore,
  intrusionText,
  maskedBlend,
  maskedShare,
  samRulesFor,
} from './analysis/samCheck.js';
import {
  applyDetailPreserve,
  accentColor,
  averageColor,
  blobToCanvas,
  createCanvas,
  flipVertical,
  ctx2d,
  drawAtlasWithUvs,
  drawPartLabels,
  partLayer,
  zoneAnchors,
  drawPartMap,
  drawUvGuide,
  fitSize,
  resizeCanvas,
  textureToCanvas,
  transformCanvas,
  untransformCanvas,
  alphaOf,
  applyAlpha,
  flattenOn,
} from './texture/imageUtils.js';
import { deriveNormalMap, deriveRoughnessMap } from './texture/pbrMaps.js';
import { flattenTinyIslands, islandIdMap, keepSkinSwatches, padIslands } from './texture/islandPost.js';
import { paintHairStrands } from './texture/strands.js';
import {
  fillMasked,
  growMask,
  horizontalRuns,
  seamLineMask,
  templateLineMask,
  verticalRuns,
} from './texture/lineCleanup.js';
import { hardenAlpha, keyColorInstruction, keyOut, pickKeyColor, trimTransparent } from './texture/chromaKey.js';
import { canvasSeams, makeSeamless } from './texture/seamless.js';
import {
  WHEEL_NAME,
  zoneHasWheel,
  bestSquare,
  cleanAroundLights,
  dominantColor,
  isColorful,
  keepTargetsFromRules,
  keptShare,
  slotIsGlass,
  namesOf,
  nearColor,
  sameShade,
  sameStrongShade,
  looksLikeGlass,
  vehicleKeepTriangles,
} from './analysis/keepAreas.js';
import { toTranscribeWav } from './audio/wav.js';
import {
  copyCanvas,
  cropCanvas,
  greyedCrop,
  fillBackgroundLeftovers,
  faceFeaturesKept,
  fillSkinLeftovers,
  mapLimit,
  maskedMedian,
  materialFill,
  oneFaceOnly,
  paintedSkin,
  plainNarrowSpans,
  restoreFeatures,
  rollCanvas,
  maskRect,
  padToMuseAspect,
  partMask,
  pasteInsideMask,
  unpad,
} from './texture/partPaint.js';

/**
 * Events the plugin emits. Subscribe to one with `plugin.on(type, cb)` or to
 * everything with `plugin.onUpdate(({ type, data }) => ...)`.
 *
 *   status          { state: 'idle'|'loading'|'analyzing'|'reskinning'|'exporting'|'error', message }
 *   loaded          { model: LoadedModel, layout: TextureLayout }
 *   progress        { stage, slotId?, message, progress: 0..1 }
 *   plan            { slotId, plan: LayoutPlan | null }   what Muse Spark read from the atlas
 *   textureUpdated  { slotId, kind: 'baseColor'|'normal'|'roughness', canvas }
 *   reskinned       ReskinResult
 *   reverted        {}
 *   exported        { glb: ArrayBuffer, filename }
 *   views           { views: [{ name, axis, canvas }], sheet }       six axis renders sent to Muse
 *   suggestion      Suggestion   Muse's recommended prompt + per-region plan (from postSuggest)
 *   request         { url, method, request, status, ms, error? }   every raw Muse call (images shortened)
 *   probe           { name, description, ok, ms, error? }      one per filter-probe test (postProbe)
 *   timing          { step, slotId, slotName, ms, ok, provider }   one per model call
 *   usage           { reskin, session, reskinCost, sessionCost, text, last? }   Muse usage + cost estimate
 *                   (reskin = since the last new suggest/prompt, incl. its review & fix; see muse/pricing.js)
 *   warning         { message }
 *   slotFailed      { slotId, name, error, step? }   a texture that could not be painted (it keeps its original); retry with postPrompt(theme, { slotIds: [slotId] })
 *   error           { error: Error, stage }
 *
 * @typedef {import('./types.js').LoadedModel} LoadedModel
 * @typedef {import('./types.js').TextureLayout} TextureLayout
 * @typedef {import('./types.js').TextureSlot} TextureSlot
 * @typedef {import('./types.js').ReskinResult} ReskinResult
 * @typedef {import('./types.js').PostPromptOptions} PostPromptOptions
 * @typedef {import('./providers/types.js').TextureProvider} TextureProvider
 *
 * @typedef {object} ReskinPluginOptions
 * @property {TextureProvider} [provider] A custom provider. Defaults to a MuseProvider built from `muse`.
 * @property {import('./providers/MuseProvider.js').MuseProviderOptions} [muse]
 *   Options for the default Muse provider (apiKey, baseUrl, fallbackBaseUrl, models...).
 */

/**
 * The reskin plugin: one object that owns loading, analysis, all Muse calls,
 * texture processing and GLB export. A host (like the harness) just posts
 * inputs and listens for updates:
 *
 *   const plugin = new ReskinPlugin({ muse: { apiKey } });
 *   plugin.onUpdate((e) => console.log(e.type, e.data));
 *   const { model } = await plugin.postModel(file);
 *   scene.add(model.scene);
 *   await plugin.postPrompt('haunted pumpkin armor');
 *   const { glb } = await plugin.postExport();
 */
/** Share (0..1) of a mask canvas's covered pixels (alpha >= 128) inside any of `rects`. */
function rectShare(mask, rects) {
  const W = mask.width,
    H = mask.height;
  const d = mask.getContext('2d').getImageData(0, 0, W, H).data;
  let all = 0,
    inside = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] < 128) continue;
      all++;
      const u = (x + 0.5) / W,
        v = (y + 0.5) / H;
      if (rects.some(({ rect: [u0, v0, u1, v1] }) => u >= u0 && u < u1 && v >= v0 && v < v1)) inside++;
    }
  return all ? inside / all : 0;
}

/** Mean color of the most common color bin (16 levels per channel) among pixels `use(p)`. */
function mainColor(d, use) {
  const bins = new Map();
  const key = (i) => ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
  for (let p = 0; p < d.length / 4; p++) {
    if (d[p * 4 + 3] < 128 || !use(p)) continue;
    const k = key(p * 4);
    bins.set(k, (bins.get(k) ?? 0) + 1);
  }
  if (!bins.size) return null;
  const top = [...bins].sort((a, b) => b[1] - a[1])[0][0];
  const sum = [0, 0, 0];
  let n = 0;
  for (let p = 0; p < d.length / 4; p++) {
    if (d[p * 4 + 3] < 128 || !use(p) || key(p * 4) !== top) continue;
    for (let c = 0; c < 3; c++) sum[c] += d[p * 4 + c];
    n++;
  }
  return sum.map((v) => v / n);
}

/**
 * Which pixels of a rect of `canvas` have the rect's main skin tone (any shade of it: same
 * hue mix, lighter or darker): a 0/1 array over the rect, or null when the rect's main color is
 * not a skin-like color (then the whole rect is kept).
 */
function skinPixels(canvas, x, y, w, h) {
  const d = ctx2d(canvas).getImageData(x, y, w, h).data;
  const bins = new Map();
  for (let q = 0; q < w * h; q++) {
    const i = q * 4;
    if (d[i + 3] < 128) continue;
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  if (!bins.size) return null;
  const top = [...bins].sort((a, b) => b[1] - a[1])[0][0];
  let r = 0,
    gr = 0,
    b = 0,
    n = 0;
  for (let q = 0; q < w * h; q++) {
    const i = q * 4;
    if (d[i + 3] < 128 || (((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4)) !== top) continue;
    r += d[i];
    gr += d[i + 1];
    b += d[i + 2];
    n++;
  }
  r /= n;
  gr /= n;
  b /= n;
  const sum = r + gr + b;
  // A grey or black main color is no skin tone to match: keep the whole rect.
  if (!sum || (Math.max(r, gr, b) - Math.min(r, gr, b)) / Math.max(r, gr, b) < 0.15) return null;
  const tr = r / sum,
    tg = gr / sum,
    tb = b / sum;
  const out = new Uint8Array(w * h);
  for (let q = 0; q < w * h; q++) {
    const i = q * 4;
    const s = d[i] + d[i + 1] + d[i + 2];
    if (d[i + 3] < 128 || !s) continue;
    const shade = s / sum;
    if (shade < 0.35 || shade > 1.3) continue;
    const dc = Math.max(Math.abs(d[i] / s - tr), Math.abs(d[i + 1] / s - tg), Math.abs(d[i + 2] / s - tb));
    if (dc <= 0.035) out[q] = 1;
  }
  return out;
}

/** Material settings the plugin changes (only those the material type has: unlit has no normalMap). */
/** A prompt that asks for see-through areas. */
const WANTS_TRANSPARENCY = /\b(transparen\w*|see-?through|cut-?outs?)\b/i;

const MATERIAL_PROPS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'roughness', 'transparent', 'alphaTest'];
function readMaterial(mat) {
  const s = { color: mat.color?.clone() };
  for (const k of MATERIAL_PROPS) if (k in mat) s[k] = mat[k];
  return s;
}
function writeMaterial(mat, s) {
  for (const k of MATERIAL_PROPS) if (k in s && k in mat) mat[k] = s[k];
  if (s.color && mat.color) mat.color.copy(s.color);
}

/** What SAM found never to paint, per model (see findKeepZones): kept across postModel calls. */
const KEEP_MEMO = new Map();

/** A cheap fingerprint of a model's layout: same file posted again → same string. */
function modelSignature(layout) {
  return (layout?.slots ?? [])
    .map((s) => {
      const img = s.texture?.image;
      const meshes = s.meshes.map((m) => {
        const pos = m.geometry.getAttribute('position');
        const head = pos ? Array.from(pos.array.slice(0, 12), (v) => v.toFixed(3)).join(',') : '';
        return `${pos?.count ?? 0}:${head}`;
      });
      return `${img?.width ?? 0}x${img?.height ?? 0}[${meshes.join(';')}]`;
    })
    .join('|');
}

export class ReskinPlugin {
  provider;
  listeners = new Map();
  anyListeners = new Set();
  snapshots = new Map();
  /** Layout readings per texture, reused across prompts (the layout doesn't depend on the theme). */
  planCache = new Map();
  /** SAM 3.1 results on the original texture, per area and phrase (cleared with a new model). */
  samCache = new Map();
  /** Set when a SAM call fails, so the rest of the run skips the check. */
  samOff = false;
  /** Paint zones found by SAM 3.1, per slot id (see findZones; cleared with a new model). */
  samZones = new Map();
  /** SAM zones per slot used only to find what is never painted (glass, lights, the user's "don't paint X"). */
  keepZones = new Map();
  /** Use SAM-found zones for models without a profile (setSamZones / opts.samZones). */
  samZonesOn = false;
  /** Art-director suggestions per theme for the current model. */
  /** Per-part paint jobs of the last run, per slot (for review & repaint). */
  lastPartJobs = new Map();
  /** Paint areas per slot (UV island groups do not change for a loaded model). */
  regionCache = new Map();
  /** Per variation index: Map slotId → part jobs (filled during a run). */
  variantJobs = [];
  /** Painted results, newest last: { id, prompt, variant, of, state, partJobs, thumb }. */
  history = [];
  historyIndex = -1;
  /** Locked areas (by area name): a new prompt keeps their current paint and repaints only the rest. */
  locked = new Set();
  /**
   * Learned tips: general lessons from review passes, per asset class ('all' = every
   * class). They are added to future paint and suggestion prompts. Persist them with
   * getLessons() / setLessons() (the harness keeps them in localStorage).
   */
  lessons = {};
  suggestionCache = new Map();
  /** Muse usage: `reskin` restarts with each new suggestion or prompt; `session` never resets. */
  usage = { reskin: emptyUsage(), session: emptyUsage() };
  busy = false;
  abort = null;
  /** AbortControllers of running postTexture jobs (they run alongside each other). */
  textureJobs = new Set();

  model = null;
  layout = null;
  lastResult = null;
  lastPrompt = '';

  /** @param {ReskinPluginOptions} [opts] */
  constructor(opts = {}) {
    this.setProvider(opts.provider ?? new MuseProvider(opts.muse ?? {}));
  }

  // ---------------------------------------------------------------- listeners

  /** Subscribe to one event type. Returns an unsubscribe function. */
  on(type, cb) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  /** Subscribe to every update. Returns an unsubscribe function. */
  onUpdate(cb) {
    this.anyListeners.add(cb);
    return () => this.anyListeners.delete(cb);
  }

  emit(type, data) {
    if (type === 'warning' && data?.message) this.think('note', data.message);
    for (const cb of this.listeners.get(type) ?? []) safeCall(cb, data);
    for (const cb of this.anyListeners) safeCall(cb, { type, data });
  }

  /** One Muse request as a thinking entry: the exact image prompt, or the question asked. */
  thinkExchange(info) {
    const req = info?.request ?? {};
    const ok = !info.error && (info.status == null || info.status < 400);
    const meta = { url: info.url, model: req.model, status: info.status, ms: Math.round(info.ms ?? 0), ok };
    if (info.error) meta.error = String(info.error?.message ?? info.error).slice(0, 300);
    if (/images\//.test(info.url ?? '') && typeof req.prompt === 'string') {
      this.think('paint', `Asked Muse Image to paint${ok ? '' : ' (failed)'}`, { ...meta, prompt: req.prompt });
      return;
    }
    const msgs = req.messages ?? req.input;
    if (Array.isArray(msgs)) {
      const textOf = (m) =>
        typeof m?.content === 'string'
          ? m.content
          : (m?.content ?? [])
              .map((c) => c?.text ?? '')
              .filter(Boolean)
              .join('\n');
      const last = [...msgs].reverse().find((m) => m?.role === 'user');
      const system = msgs.find((m) => m?.role === 'system');
      this.think('ask', `Asked ${req.model ?? 'Muse'}${ok ? '' : ' (failed)'}`, {
        ...meta,
        question: textOf(last).slice(0, 8000),
        instructions: system ? textOf(system).slice(0, 8000) : undefined,
      });
    }
  }

  /**
   * What the plugin and Muse decided, step by step, for an editor to show ("what Muse is
   * thinking"). Each entry is emitted as a 'thinking' event and collected in the result's
   * `thinking` array (postSuggest, postPrompt, postReview). See types.js ThinkingEntry.
   * @param {string} step 'identify' | 'assetClass' | 'zones' | 'plan' | 'ask' | 'paint' | 'kept' | 'review' | 'note'
   * @param {string} text one readable line
   * @param {object} [data] details for that step
   */
  think(step, text, data = {}) {
    const entry = { step, text, at: Date.now(), ...data };
    (this.thinkingLog ??= []).push(entry);
    if (this.thinkingLog.length > 500) this.thinkingLog.shift();
    for (const cb of this.listeners.get('thinking') ?? []) safeCall(cb, entry);
    for (const cb of this.anyListeners) safeCall(cb, { type: 'thinking', data: entry });
  }

  status(state, message) {
    this.emit('status', { state, message });
  }

  // ---------------------------------------------------------------- config

  setProvider(provider) {
    this.provider = provider;
    // Surface every raw model request (images shortened) as a `request` event, for debugging.
    if (provider?.client && 'onExchange' in provider.client) {
      provider.client.onExchange = (info) => {
        this.emit('request', info);
        this.thinkExchange(info);
      };
    }
    if (provider?.client && 'onUsage' in provider.client) {
      provider.client.onUsage = (u) => this.recordUsage(u);
    }
    if (provider && 'onNotice' in provider) provider.onNotice = (message) => this.emit('warning', { message });
  }

  /**
   * Chat model for the suggest and review steps: '' / undefined = Muse Spark (default),
   * 'muse-wonder-1.0' = Muse Wonder (Preview, about 3x the token price).
   */
  setAdviceModel(model) {
    this.provider?.setAdviceModel?.(model);
  }

  // ---------------------------------------------------------------- usage

  /** Current Muse usage and estimated cost: { reskin, session, reskinCost, sessionCost, text }. */
  getUsage() {
    const { reskin, session } = this.usage;
    return {
      reskin,
      session,
      reskinCost: usageCost(reskin),
      sessionCost: usageCost(session),
      text: formatUsage(reskin),
    };
  }

  /**
   * Rough cost of one reskin before it runs, from the loaded model's areas and the options
   * (paintMode, variants, samCheck, suggest, review). Counts Muse images (1 per area in
   * part-by-part mode plus the torso's front and back panels, 1 per texture in one-pass
   * mode), SAM checks, and chat calls at about 1.5 cents each. Retries for flagged areas
   * and review fixes are not known in advance, so the real cost can be a little higher.
   * Returns { images, samChecks, chats, cost }.
   */
  estimateCost(opts = {}) {
    const out = { images: 0, samChecks: 0, chats: 0, cost: 0 };
    if (!this.layout || !this.model) return out;
    const variants = Math.max(1, Math.min(opts.variants ?? 1, 4));
    const assetClass = this.resolveAssetClass(opts);
    const onePass = opts.paintMode === 'atlas' || typeof this.provider.reskinPart !== 'function';
    const sam = opts.samCheck !== false && !!this.provider.segment;
    const modelRadius = boundingRadius(this.model.scene);
    let parts = false;
    for (const slot of this.layout.slots) {
      if (!slot.texture) {
        const small = boundingRadius(slot.meshes) < modelRadius * (opts.smallPartRatio ?? 0.2);
        if (!small) out.images += variants;
        continue;
      }
      // One pass on a building: one roofing material image too, shared by the variations.
      if (
        onePass &&
        getAssetClass(assetClass)?.topBottom &&
        opts.roofAsMaterial !== false &&
        this.idRegions(slot, { ...opts, assetClass }).some((r) => r.zone === 'roof')
      )
        out.images += 1;
      const regions = onePass ? [] : this.idRegions(slot, { ...opts, assetClass });
      if (regions.length <= 1 && slotParts(slot).length <= 1) {
        out.images += variants;
        continue;
      }
      if (onePass) {
        out.images += variants;
        continue;
      }
      parts = true;
      for (const r of regions) {
        if (r.zone === 'underside' && opts.undersideColor !== null) continue; // flat color, no Muse call
        out.images += variants * (r.zone === 'torso' && opts.frontPanelPass !== false ? 3 : 1);
        if (sam) out.samChecks += variants * samRulesFor(assetClass, r.zone, '', r.name).length;
      }
    }
    // Suggestion, per-area themes (part by part) or a layout reading (one pass), review.
    out.chats += opts.suggest ? 1 : 0;
    out.chats += parts ? 1 : onePass && opts.useVisionPlanning !== false && !opts.suggest ? 1 : 0;
    out.chats += opts.review ? 1 : 0;
    const img = priceFor(this.provider.client?.options?.imageModel ?? 'muse-image-1.0')?.image ?? 0.01;
    const seg = priceFor('sam-3.1')?.segment ?? 0.0025;
    out.cost = out.images * img + out.samChecks * seg + out.chats * 0.015;
    return out;
  }

  recordUsage(u) {
    addUsage(this.usage.reskin, u);
    addUsage(this.usage.session, u);
    this.emit('usage', { ...this.getUsage(), last: u });
  }

  /** Clears both tallies (reskin and session). */
  resetUsage() {
    this.usage = { reskin: emptyUsage(), session: emptyUsage() };
    this.emit('usage', this.getUsage());
  }

  /** Starts a new per-reskin tally (the session total keeps counting). */
  startReskinUsage() {
    this.usage.reskin = emptyUsage();
    this.emit('usage', this.getUsage());
  }

  getProvider() {
    return this.provider;
  }

  get isBusy() {
    return this.busy;
  }

  /** Cancels a running postPrompt. */
  cancel() {
    this.abort?.abort(new DOMException('Cancelled', 'AbortError'));
    for (const c of this.textureJobs) c.abort(new DOMException('Cancelled', 'AbortError'));
  }

  // ---------------------------------------------------------------- post: model

  /**
   * Load a model (File(s), Blob, ArrayBuffer or URL), analyze it and make it the current model.
   * @param {import('./io/modelIO.js').ModelInput} input
   * @param {import('./io/modelIO.js').LoadOptions} [opts]
   *   Also opts.imageOrder: 'gltf' (default) | 'image', the row order of the canvases this
   *   model's reskin results and textureUpdated events hand out (see PostPromptOptions).
   * @returns {Promise<{ model: LoadedModel, layout: TextureLayout }>}
   */
  async postModel(input, opts = {}) {
    this.guard();
    this.busy = true;
    try {
      this.status('loading', 'Loading model…');
      const model = await loadModel(input, opts);
      this.model = model;
      // Order of the canvases this model's results hand out: 'gltf' (default) or 'image'.
      this.imageOrder = opts.imageOrder === 'image' ? 'image' : 'gltf';
      this.snapshots.clear();
      this.planCache.clear();
      this.samCache.clear();
      this.samZones.clear();
      this.keepZones.clear();
      this.keepZonesKey = null;
      this.suggestionCache.clear();
      this.modelAnalysis = null;
      this.topBottomNoted = null;
      this.keepCache = null;
      this.keepNoted = null;
      this.lastPartJobs.clear();
      this.regionCache.clear();
      this.locked.clear();
      this.areaClass = undefined;
      this.anatomyCache = undefined;
      this.idMapSaved = null;
      this.history = [];
      this.historyIndex = -1;
      this.lastResult = null;
      this.originalThumb = null; // rendered after loading (see historySummary)
      this.status('analyzing', 'Analyzing texture layout…');
      const layout = this.analyze();
      for (const w of layout.warnings) this.emit('warning', { message: w });
      this.originalThumb = this.renderThumb(); // the unpainted model, first in History
      this.emit('loaded', { model, layout });
      this.status(
        'idle',
        `Loaded "${model.name}": ${layout.slots.length} texture slot(s), ${layout.triangleCount} triangles`,
      );
      return { model, layout };
    } catch (err) {
      this.fail(err, 'load');
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** Re-runs layout analysis on the current model. */
  analyze() {
    if (!this.model) throw new Error('No model loaded');
    this.layout = analyzeTextureLayout(this.model.scene);
    this.regionCache.clear();
    return this.layout;
  }

  /** JSON summary of the current layout (no three.js objects). */
  summary() {
    return this.layout ? summarizeLayout(this.layout) : null;
  }

  /** Preview images for one slot: atlas, atlas with UV wireframe, and the island mask. */
  slotPreview(slotId, maxSize = 512) {
    const slot = this.requireSlot(slotId);
    const { width, height } = fitSize(slot.width || 512, slot.height || 512, maxSize);
    const atlas = slot.texture ? textureToCanvas(slot.texture, maxSize) : null;
    const parts = this.idRegions(slot, this.areaOpts());
    const w = atlas?.width ?? width;
    const h = atlas?.height ?? height;
    return {
      atlas,
      atlasWithUvs: atlas ? drawAtlasWithUvs(atlas, slot) : drawUvGuide(slot, width, height, { fill: false }),
      uvGuide: drawUvGuide(slot, width, height),
      // Each part tinted; names in a border with a line to each of the part's patches.
      partMap: drawPartMap(slot, parts, w, h, { atlas, alpha: atlas ? 0.45 : 1, labels: true }),
      parts: parts.map(({ meshes, ...p }) => p),
      orientation: chooseOrientation(slotParts(slot)),
      // Which way each area faces on the model (green front, blue back, yellow / orange
      // sides or outer / inner on limbs, magenta top, cyan bottom), for checking layouts.
      facingMap: slot.texture ? this.facingPreview(slot, parts, w, h) : null,
    };
  }

  /** All areas' facing maps on one canvas (see slotPreview). */
  facingPreview(slot, parts, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighten';
    const limbs = parts.some((p) => p.zone === 'arms' || p.zone === 'legs') ? this.anatomy() : null;
    for (const part of parts) {
      const limb = limbs && (part.zone === 'arms' || part.zone === 'legs');
      g.drawImage(drawFacingMap(slot, part, w, h, { limbCenterX: limb ? limbs.cx : null }).canvas, 0, 0);
    }
    return c;
  }

  // ---------------------------------------------------------------- post: probe

  /**
   * Debug helper for content-filter rejections: sends a few small, separate requests
   * (theme only, full prompt without images, prompt + atlas, prompt + UV mask, neutral
   * prompt + atlas) and reports which ones pass, to find what triggers the filter.
   * Each image call is billed by the provider (Muse: about $0.01 each).
   * @param {string} theme
   * @param {{ signal?: AbortSignal, slotId?: string }} [opts]
   */
  async postProbe(theme, opts = {}) {
    this.guard();
    if (!this.model || !this.layout) throw new Error('Post a model first');
    if (typeof this.provider.probeFilter !== 'function') throw new Error(`${this.provider.name} has no filter probe`);
    const slot =
      (opts.slotId && this.layout.slots.find((s) => s.id === opts.slotId)) ||
      this.layout.slots.find((s) => s.texture && !s.tiled) ||
      this.layout.slots.find((s) => s.texture);
    if (!slot) throw new Error('The model has no textures to probe with');
    this.busy = true;
    this.abort = new AbortController();
    const signal = opts.signal ? anySignal([opts.signal, this.abort.signal]) : this.abort.signal;
    try {
      this.restoreSnapshots();
      this.status('reskinning', `Probing the content filter with "${theme}"…`);
      const atlas = textureToCanvas(slot.texture, 512);
      const uvGuide = drawUvGuide(slot, atlas.width, atlas.height);
      const results = await this.provider.probeFilter({
        theme: theme.trim(),
        atlas,
        uvGuide,
        plan: this.planCache.get(`${this.provider.name}:${slot.texture.uuid}`) ?? null,
        signal,
        onResult: (r) => this.emit('probe', r),
      });
      const failed = results.filter((r) => !r.ok).map((r) => r.name);
      this.status(
        'idle',
        failed.length ? `Filter probe: blocked → ${failed.join(', ')}` : 'Filter probe: everything passed',
      );
      return results;
    } catch (err) {
      this.fail(err, 'probe');
      throw err;
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }

  // ---------------------------------------------------------------- post: voice

  /** True if the current provider can turn speech into text (postVoice). */
  get canTranscribe() {
    return typeof this.provider.transcribe === 'function';
  }

  /**
   * Speech -> text with Muse Voice Transcribe, e.g. to speak a theme. `audio` is any
   * recording the browser can decode (MediaRecorder webm/opus or mp4, or a WAV); it is
   * converted to 16 kHz mono WAV first. Nothing is painted, and no model is needed.
   * Emits 'transcript' with the result. Does not block (or get blocked by) a reskin.
   * @param {Blob} audio
   * @param {{ signal?: AbortSignal, languageBias?: string[], keywords?: string[] }} [opts]
   * @returns {Promise<{ text: string, durationMs: number }>}
   */
  async postVoice(audio, opts = {}) {
    if (!this.canTranscribe) throw new Error(`${this.provider.name} cannot transcribe speech`);
    if (!(audio instanceof Blob) || !audio.size) throw new Error('postVoice needs a recorded audio Blob');
    const { wav, durationMs } = await toTranscribeWav(audio);
    if (durationMs < 300) throw new Error('The recording is too short: hold the mic a little longer');
    const res = await this.provider.transcribe({
      audio: wav,
      signal: opts.signal,
      languageBias: opts.languageBias,
      keywords: opts.keywords,
    });
    const out = { text: res.text, durationMs: res.durationMs || durationMs };
    this.think('voice', `Heard: "${out.text}"`, { durationMs: out.durationMs });
    this.emit('transcript', out);
    return out;
  }

  // ---------------------------------------------------------------- post: prompt

  /** True if the current provider can recommend prompts (postSuggest). */
  get canSuggest() {
    return typeof this.provider.suggestPrompt === 'function';
  }

  /**
   * Art-director step, run before painting: renders the model from the six axis
   * directions (±X, ±Y, ±Z), sends those views plus the UV atlases to the vision
   * model, and returns what it thinks the object is, a stronger prompt for the
   * theme, and a per-region paint plan. Nothing is painted. Pass the result to
   * `postPrompt(text, { suggestion })` to use it (the text may be edited first).
   * @param {string} theme
   * @param {{ signal?: AbortSignal, fast?: boolean, viewSize?: number }} [opts]
   * @returns {Promise<import('./types.js').Suggestion>}
   */
  async postSuggest(theme, opts = {}) {
    this.guard();
    if (!this.model || !this.layout) throw new Error('Post a model before asking for a suggestion');
    if (!this.canSuggest) throw new Error(`${this.provider.name} cannot suggest prompts`);
    theme = theme.trim();
    if (!theme) throw new Error('Prompt is empty');
    this.startReskinUsage(); // a suggestion starts a new reskin; the paint that follows adds to it
    this.usageAfterSuggest = true;
    this.setUserRules(opts.userRules);
    const thinkStart = (this.thinkingLog ??= []).length;
    const cached = this.suggestionCache.get(
      `${theme}|${JSON.stringify(opts.orientation ?? 'auto')}|${(this.userRules ?? []).join('|')}`,
    );
    if (cached) {
      this.emit('suggestion', cached);
      return cached;
    }

    this.busy = true;
    this.abort = new AbortController();
    const signal = opts.signal ? anySignal([opts.signal, this.abort.signal]) : this.abort.signal;
    try {
      if (opts.fast !== undefined) this.provider.setFast?.(opts.fast);
      // A model Muse already studied: reuse what it saw (subject, parts, regions, renders)
      // and only ask for the new theme, text only.
      const reuse = this.modelAnalysis && opts.reuseAnalysis !== false && this.provider.suggestFromAnalysis;
      let raw, sheet, idSheet, views, atlasSlots;
      if (reuse) {
        const an = this.modelAnalysis;
        ({ sheet, idSheet, views, atlasSlots } = an);
        this.emit('views', { views, sheet, idSheet });
        this.status('analyzing', `Reusing what Muse saw (${an.subject || 'this model'}); writing the new prompt…`);
        this.emit('progress', {
          stage: 'plan',
          message: 'Writing the prompt from the earlier analysis',
          progress: 0.3,
        });
        raw = await this.timed('suggest prompt (reused analysis)', null, () =>
          this.provider.suggestFromAnalysis({
            theme,
            analysis: an,
            lessons: this.lessonsFor(this.resolveAssetClass({ ...opts, suggestion: an })),
            signal,
          }),
        );
        raw.subject ||= an.subject;
        raw.assetClass ||= an.assetClass;
        if (!raw.parts?.length) raw.parts = an.parts;
        raw.partRoles ??= an.partRoles;
        if (!raw.atlases?.length) raw.atlases = an.atlases;
      } else {
        this.restoreSnapshots(); // study the original look
        if (opts.samZones !== undefined) this.setSamZones(opts.samZones);
        // SAM zones first (when the asset class has its own phrases), so the ID views match the paint.
        if (this.samZonesActive && this.slotsWithoutSamZones().length) {
          const cls = this.resolveAssetClass(opts);
          if (zoneConceptsFor(cls).concepts.length) await this.findZones({ ...opts, assetClass: cls }, signal);
        }
        this.status('analyzing', 'Rendering six views of the model…');
        this.emit('progress', { stage: 'plan', message: 'Rendering six views of the model', progress: 0.1 });
        ({ views, sheet } = renderAxisViews(this.model.scene, { size: opts.viewSize ?? 384 }));
        // The same views with every area in its own flat color (matching the atlas part map).
        idSheet = this.renderIdSheet({ size: Math.round((opts.viewSize ?? 384) * 0.75) });
        this.emit('views', { views, sheet, idSheet });

        atlasSlots = this.layout.slots.filter((s) => s.texture && !s.tiled).slice(0, 4);
        const atlases = atlasSlots.map((slot) => {
          const original = textureToCanvas(slot.texture, 1024);
          const rawParts = this.idRegions(slot);
          // Same upright transform as the whole-atlas paint step, so region boxes line up.
          const orient = resolveOrientation(opts.orientation, slotParts(slot));
          const parts = transformParts(rawParts, orient);
          const atlas = transformCanvas(original, orient);
          return {
            slotId: slot.id,
            name: slot.name,
            meshNames: slot.meshes.map((m) => m.name),
            parts,
            // Atlas with each part tinted + labelled (name and an arrow to the part's top).
            atlasWithUvs:
              parts.length > 1
                ? drawPartLabels(
                    transformCanvas(
                      drawPartMap(slot, rawParts, original.width, original.height, { atlas: original, alpha: 0.35 }),
                      orient,
                    ),
                    parts.map((p, i) => ({
                      ...p,
                      anchors: zoneAnchors(
                        transformCanvas(partLayer(slot, rawParts[i], original.width, original.height), orient),
                        1,
                      ),
                    })),
                  )
                : transformCanvas(drawAtlasWithUvs(original, slot), orient),
          };
        });

        this.status('analyzing', 'Muse is studying the model…');
        this.emit('progress', {
          stage: 'plan',
          message: 'Muse is studying the model and the texture layout',
          progress: 0.3,
        });
        raw = await this.timed('suggest prompt', null, () =>
          this.provider.suggestPrompt({
            theme,
            sheet,
            idSheet,
            atlases,
            lessons: this.lessonsFor(this.resolveAssetClass(opts)),
            signal,
          }),
        );
        this.modelAnalysis = {
          subject: raw.subject,
          assetClass: raw.assetClass,
          parts: raw.parts,
          partRoles: raw.partRoles,
          atlases: (raw.atlases ?? []).map((a) => ({
            index: a.index,
            regions: (a.regions ?? []).map((r) => ({ name: r.name, bbox: r.bbox })),
          })),
          sheet,
          idSheet,
          views,
          atlasSlots,
        };
      }
      const plans = {};
      for (const a of raw.atlases ?? []) {
        const slot = atlasSlots[a.index - 1];
        if (!slot || !a.regions?.length) continue;
        plans[slot.id] = {
          subject: raw.subject,
          regions: a.regions.map((r) => ({ name: r.name, bbox: r.bbox, description: r.paint })),
        };
      }
      // Model-written text is cleaned of common safety-filter triggers before it is shown or painted.
      for (const plan of Object.values(plans)) {
        for (const r of plan.regions) r.description = r.description && sanitizePrompt(r.description);
      }
      const suggestion = { ...raw, theme, prompt: sanitizePrompt(raw.prompt || theme), plans, sheet, idSheet, views };
      this.suggestionCache.set(
        `${theme}|${JSON.stringify(opts.orientation ?? 'auto')}|${(this.userRules ?? []).join('|')}`,
        suggestion,
      );
      this.prefetchAreaThemes(suggestion, opts);
      this.emit('progress', { stage: 'plan', message: 'Suggestion ready', progress: 1 });
      this.think('identify', `Muse sees: ${suggestion.subject || 'unknown object'}`, {
        subject: suggestion.subject,
        assetClass: suggestion.assetClass,
        prompt: suggestion.prompt,
        parts: suggestion.parts,
        partRoles: suggestion.partRoles ?? null,
        plans: suggestion.plans,
      });
      suggestion.thinking = this.thinkingLog.slice(thinkStart);
      this.emit('suggestion', suggestion);
      this.status('idle', `Muse sees: ${suggestion.subject || 'unknown object'}`);
      return suggestion;
    } catch (err) {
      this.fail(err, 'suggest');
      throw err;
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }

  /**
   * Reskin the current model from a theme prompt. Updates the model's materials in place.
   * @param {string} prompt
   * @param {PostPromptOptions} [opts]
   * @returns {Promise<ReskinResult>}
   */
  async postPrompt(prompt, opts = {}) {
    this.guard();
    if (!this.model || !this.layout) throw new Error('Post a model before posting a prompt');
    const theme = prompt.trim();
    const thinkStart = (this.thinkingLog ??= []).length;
    this.setUserRules(opts.userRules);
    if (!theme) throw new Error('Prompt is empty');
    // A new reskin starts its own cost tally, unless it follows its suggestion or is a review fix.
    if (!opts.fixes && !(this.usageAfterSuggest && opts.suggestion)) this.startReskinUsage();
    if (!opts.fixes) this.usageAfterSuggest = false;

    this.busy = true;
    this.abort = new AbortController();
    const signal = opts.signal ? anySignal([opts.signal, this.abort.signal]) : this.abort.signal;
    const started = performance.now();
    const results = [];
    let recolored = 0;
    let firstError = null;
    const failed = [];

    try {
      if (opts.fast !== undefined) this.provider.setFast?.(opts.fast);
      // 'high' = Muse Image reasons longer per picture (same price per image); '' = default.
      if (opts.imageReasoning !== undefined) this.provider.setImageReasoning?.(opts.imageReasoning);
      this.samOff = false;
      this.status('reskinning', `Reskinning with "${theme}" via ${this.provider.name}…`);
      opts = { ...opts, assetClassGiven: opts.assetClass, assetClass: this.resolveAssetClass(opts) };
      // Start from the original look every time, so prompts don't compound. A retry of
      // some slots (opts.slotIds) only resets those; the others keep their paint.
      this.restoreSnapshots(
        opts.slotIds ? this.layout.slots.filter((s) => opts.slotIds.includes(s.id)).flatMap((s) => s.materials) : null,
      );
      this.variantJobs = [];

      this.areaClass = opts.assetClass;
      this.emit('assetClass', { id: opts.assetClass, label: getAssetClass(opts.assetClass)?.label });
      {
        const given = opts.assetClassGiven;
        const source =
          given && given !== 'auto'
            ? 'set by the editor'
            : normalizeAssetClass(opts.suggestion?.assetClass)
              ? 'Muse identified it'
              : 'guessed from names';
        this.think(
          'assetClass',
          `Painting it as ${getAssetClass(opts.assetClass)?.label ?? opts.assetClass} (${source})`,
          {
            assetClass: opts.assetClass,
            source,
            rules: assetClassRules(opts.assetClass),
            paintMode: opts.paintMode ?? 'auto',
            detailPreserve: opts.detailPreserve ?? 0.35,
            samZones: this.samZonesActive,
          },
        );
      }

      // SAM zones: found once per model (the model shows its original look here).
      if (opts.samZones !== undefined) this.setSamZones(opts.samZones);
      if (this.samZonesActive && !opts.fixes && this.slotsWithoutSamZones().length) {
        await this.findZones(opts, signal);
      }
      // What must never be painted (windows, lights, the user's "don't paint X"), found by SAM
      // when the paint areas did not come from SAM. Once per model.
      if (!opts.fixes) await this.findKeepZones(opts, signal);

      const wanted = (s) => !opts.slotIds || opts.slotIds.includes(s.id);
      // Small untextured parts (a button, an eye, an antenna ball) are tinted locally
      // from the new palette instead of costing a Muse call.
      const modelRadius = boundingRadius(this.model.scene);
      const isSmallUntextured = (s) =>
        (opts.localSmallParts ?? true) &&
        !s.texture &&
        boundingRadius(s.meshes) < modelRadius * (opts.smallPartRatio ?? 0.2);
      const localIds = new Set(this.layout.slots.filter((s) => wanted(s) && isSmallUntextured(s)).map((s) => s.id));

      // Meshes with no UVs get box-projected UVs, then the layout is re-analyzed.
      let addedUvs = false;
      for (const slot of this.layout.slots) {
        if (!slot.missingUvs || localIds.has(slot.id) || !wanted(slot)) continue;
        for (const mesh of slot.meshes) addedUvs = generateBoxUvs(mesh, slot.uvChannel) || addedUvs;
      }
      if (addedUvs) {
        this.analyze();
        this.emit('warning', { message: 'Generated box-projected UVs for meshes without UVs.' });
      }

      // Never painted: a glass texture slot (the windows), and a vehicle texture that is all
      // lights (an "Optics" atlas). They keep their original look and cost no Muse call.
      const neverPainted = new Map();
      for (const s of this.layout.slots) {
        if (!wanted(s)) continue;
        const why = this.slotNeverPainted(s, opts);
        if (why) neverPainted.set(s.id, why);
      }
      for (const s of this.layout.slots.filter((x) => neverPainted.has(x.id))) {
        localIds.delete(s.id);
        const why = neverPainted.get(s.id);
        this.think('kept', `"${s.name}" is ${why}: never painted, keeps its original look`, {
          slotId: s.id,
          slotName: s.name,
          why,
          share: 1,
        });
        this.emit('warning', { message: `"${s.name}" is ${why}, so it keeps its original look (never painted).` });
      }
      const remote = this.layout.slots.filter((s) => wanted(s) && !localIds.has(s.id) && !neverPainted.has(s.id));
      const local = this.layout.slots.filter((s) => localIds.has(s.id));
      const fractions = remote.map(() => 0);
      const progress = (i, frac, stage, message, slotId) => {
        fractions[i] = Math.max(fractions[i], frac);
        const total = fractions.reduce((a, b) => a + b, 0) / (fractions.length || 1);
        this.emit('progress', { stage, slotId, message, progress: Math.min(0.98, total) });
      };

      // All texture slots run in parallel: each one is independent.
      const settled = await Promise.allSettled(
        remote.map((slot, i) =>
          this.reskinSlot(slot, theme, opts, signal, (frac, stage, msg) => progress(i, frac, stage, msg, slot.id)),
        ),
      );
      signal.throwIfAborted();
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          if (r.value) results.push(r.value);
          else recolored += remote[i].materials.length;
        } else {
          const e = toError(r.reason);
          firstError ??= e;
          const f = {
            slotId: remote[i].id,
            name: remote[i].name,
            ...this.textureIdentity(remote[i].texture),
            error: e.message,
            step: e.step,
          };
          failed.push(f);
          this.emit('warning', {
            message: `"${remote[i].name}" was not painted${e.step ? ` (${e.step})` : ''}: ${e.message}. It keeps its original texture.`,
          });
          this.emit('slotFailed', f);
        }
      });

      // If every texture failed, report that error (not a follow-up one).
      if (firstError && !results.length && remote.length) throw firstError;

      if (local.length) {
        // Pick an accent color from the largest new texture so small parts match the theme.
        const biggest = [...results].sort(
          (a, b) => b.canvas.width * b.canvas.height - a.canvas.width * a.canvas.height,
        )[0];
        let color = biggest ? accentColor(biggest.canvas) : null;
        if (!color) {
          const swatch = await this.timed('swatch', local[0].id, () =>
            this.provider.generateTexture({ theme, materialName: local[0].name, width: 256, height: 256, signal }),
          );
          color = averageColor(await this.toCanvas(swatch));
        }
        for (const slot of local) {
          for (const mat of slot.materials) {
            this.snapshot(mat);
            mat.color.copy(color);
            mat.needsUpdate = true;
          }
          recolored += slot.materials.length;
        }
      }

      if ((remote.length || local.length) && !results.length && !recolored) {
        throw firstError ?? new Error('No texture slot could be reskinned');
      }
      if (firstError && !results.length && remote.length) throw firstError;

      // History: one entry per variation (all slots), the first one applied.
      const entries = this.recordVariations(theme, results, opts);
      const result = {
        prompt: theme,
        slots: results,
        recoloredMaterials: recolored,
        failed,
        durationMs: performance.now() - started,
        variations: entries.map(({ id, variant, thumb }) => ({ id, variant, thumb })),
        usage: this.getUsage(),
        thinking: this.thinkingLog.slice(thinkStart),
      };
      this.lastResult = result;
      this.lastPrompt = theme;
      const { signal: _s, fixes: _f, changeRequest: _c, editAtlas: _e, ...runOpts } = opts;
      this.lastRun = { theme, opts: runOpts };
      this.emit('progress', { stage: 'done', message: 'Done', progress: 1 });
      this.emit('reskinned', result);
      this.status(
        'idle',
        (failed.length
          ? `Reskinned ${results.length} of ${results.length + failed.length} texture(s) in ${(result.durationMs / 1000).toFixed(1)}s; not painted: ${failed.map((f) => `"${f.name}"`).join(', ')}`
          : `Reskinned ${results.length} texture(s) in ${(result.durationMs / 1000).toFixed(1)}s`) +
          (result.usage.reskin.calls ? ` · ${result.usage.text}` : ''),
      );
      return result;
    } catch (err) {
      this.fail(err, 'reskin');
      throw err;
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }

  async reskinSlot(slot, theme, opts, signal, report) {
    const maxSize = Math.min(opts.maxTextureSize ?? 2048, 4096);
    const hasUvs = slot.meshes.some((m) =>
      m.geometry.getAttribute(slot.uvChannel === 0 ? 'uv' : `uv${slot.uvChannel}`),
    );
    if (!hasUvs) {
      // Nothing to map a texture onto: tint from a generated swatch.
      report(0.1, 'generate', `Generating color swatch for "${slot.name}"`);
      const swatch = await this.toCanvas(
        await this.timed('swatch', slot.id, () =>
          this.provider.generateTexture({ theme, materialName: slot.name, width: 256, height: 256, signal }),
        ),
      );
      const color = averageColor(swatch);
      for (const mat of slot.materials) {
        this.snapshot(mat);
        mat.color.copy(color);
        mat.needsUpdate = true;
      }
      return null;
    }

    const atlasMode = !!slot.texture && !slot.tiled;
    // Transparency asked for (opts.transparent, or the prompt says so): Muse paints on a flat key
    // color, which becomes alpha; the material is made transparent.
    // From the prompt only for an untextured mesh or a single wide band (a background ring): on
    // a textured model, "transparent windows" must not cut the whole texture.
    const wantAlpha =
      opts.transparent ??
      (WANTS_TRANSPARENCY.test(`${theme} ${opts.extraInstructions ?? ''}`) &&
        (!slot.texture || (slot.meshes.length === 1 && uvAspect(slot) >= 1.5)));
    const key = wantAlpha ? pickKeyColor(opts.keyColor, theme) : null;
    // An untextured wide band (a background ring or a cylinder around the scene): one panorama
    // strip whose left and right edges join, repeated around when it is very wide.
    let strip = null;
    if (!slot.texture && !slot.tiled) {
      const aspect = uvAspect(slot);
      if (aspect >= 1.5 || /\b(ring|panoram\w*|backdrop|skyline|horizon)\b/i.test(`${theme} ${slot.name}`))
        strip = { aspect, repeats: Math.max(1, Math.round(Math.max(1, aspect) / 2)) };
    }
    const { width, height } = slot.texture
      ? fitSize(slot.width, slot.height, maxSize)
      : strip
        ? { width: Math.min(2048, maxSize), height: Math.min(1024, maxSize) }
        : { width: Math.min(1024, maxSize), height: Math.min(1024, maxSize) };

    let plan = null;
    let orient = null;
    let parts = null;
    let usedPrompt = theme;
    let original = null;

    // Variations: each one is painted in parallel with its own variation note.
    const variants = Math.max(1, Math.min(opts.variants ?? 1, 4));
    const paintVariant = async (opts) => {
      let raw;
      if (atlasMode) {
        original = textureToCanvas(slot.texture, maxSize);
        // Parts from the 3D file (one per mesh name), with which way "up" points in the image.
        const rawParts = slotParts(slot);
        // Part by part when the atlas has several areas: several named meshes, or one mesh
        // whose islands form separate areas (an avatar's body zones in a single skin mesh).
        const byParts =
          (opts.paintMode ?? 'auto') !== 'atlas' &&
          typeof this.provider.reskinPart === 'function' &&
          (rawParts.length > 1 || this.idRegions(slot, opts).length > 1);
        if (byParts) {
          // Per-part mode: each part is painted on its own, upright, and pasted back inside its islands.
          parts = rawParts;
          plan = opts.suggestion?.plans?.[slot.id] ?? null;
          raw = await this.paintByParts(slot, theme, rawParts, original, plan, opts, signal, report);
        } else {
          // If the key part (head/face, else the largest) is stored upside down, sideways or
          // mirrored, turn the whole atlas upright before painting and turn the result back.
          orient = resolveOrientation(opts.orientation, rawParts);
          if (orient && !isIdentity(orient)) {
            this.emit('warning', {
              message:
                orient.reason === 'manual'
                  ? `"${slot.name}": using the manual orientation (${orient.rot}°${orient.flipX ? ', mirrored' : ''}).`
                  : `"${slot.name}": "${orient.reason}" is stored ${orient.rot ? `rotated ${orient.rot}°` : ''}${orient.rot && orient.flipX ? ' and ' : ''}${orient.flipX ? 'mirrored' : ''} in the atlas; painting it upright and turning it back.`,
            });
          }
          parts = transformParts(rawParts, orient);
          const guide =
            rawParts.length > 1
              ? drawPartMap(slot, rawParts, original.width, original.height)
              : // Filled islands only: Muse copied drawn triangle edges into the paint (the van's
                // wireframe lines).
                drawUvGuide(slot, original.width, original.height, { wireframe: false });
          const uvGuide = transformCanvas(guide, orient);
          // A change request on a one-pass result: Muse edits the current paint, not the original.
          const editFrom = opts.changeRequest ? opts.editAtlas?.get(slot.id) : null;
          const sendAtlas = transformCanvas(
            editFrom
              ? resizeCanvas(
                  textureToCanvas({ image: editFrom }, Math.max(original.width, original.height)),
                  original.width,
                  original.height,
                )
              : original,
            orient,
          );
          const planKey = `${this.provider.name}:${slot.texture.uuid}:${orient ? `${orient.rot}${orient.flipX}` : ''}`;
          const suggested = opts.suggestion?.plans?.[slot.id];
          if (suggested) {
            // The art-director step already mapped this atlas's regions.
            plan = suggested;
          } else if ((opts.useVisionPlanning ?? true) && this.planCache.has(planKey)) {
            // The layout doesn't depend on the theme, so it is read once per model.
            plan = this.planCache.get(planKey);
          } else if ((opts.useVisionPlanning ?? true) && this.provider.planLayout) {
            report(0.05, 'plan', `Reading atlas layout of "${slot.name}"`);
            try {
              // Variations run in parallel: they share one layout reading instead of one each.
              this.planInflight ??= new Map();
              if (!this.planInflight.has(planKey)) {
                const reading = this.timed('read layout', slot.id, () =>
                  this.provider.planLayout({
                    slotName: slot.name,
                    meshNames: slot.meshes.map((m) => m.name),
                    atlas: sendAtlas,
                    atlasWithUvs: transformCanvas(drawAtlasWithUvs(original, slot), orient),
                    signal,
                  }),
                );
                this.planInflight.set(planKey, reading);
                reading.finally(() => this.planInflight.delete(planKey)).catch(() => {});
              }
              plan = await this.planInflight.get(planKey);
              if (plan) this.planCache.set(planKey, plan);
            } catch (err) {
              if (signal.aborted) throw err;
              this.emit('warning', { message: `Layout planning skipped: ${toError(err).message}` });
            }
            this.emit('plan', { slotId: slot.id, plan });
            this.think('plan', `"${slot.name}": one picture for the whole texture`, {
              slotId: slot.id,
              slotName: slot.name,
              mode: 'atlas',
              areas: (plan?.regions ?? []).map((r) => ({ name: r.name, action: 'paint', paint: r.description })),
            });
          }
          report(0.2, 'generate', `Painting "${slot.name}" (${width}×${height})`);
          raw = await this.toCanvas(
            await this.withFilterRetry('paint atlas', slot, theme, (plain, t) =>
              this.provider.reskinAtlas({
                theme: t,
                slotName: slot.name,
                atlas: sendAtlas,
                uvGuide,
                parts: plain ? undefined : parts,
                width: sendAtlas.width,
                height: sendAtlas.height,
                plan: plain ? null : plan,
                extraInstructions: plain
                  ? undefined
                  : [
                      editFrom
                        ? `MOST IMPORTANT: change requested by the user: ${opts.changeRequest} Apply only this change to image 1 and keep everything else in it exactly the same.`
                        : null,
                      opts.extraInstructions,
                      key ? keyColorInstruction(key) : null,
                      ...this.rulesFor(
                        opts.assetClass,
                        rawParts.map((p) => p.name),
                      ),
                    ]
                      .filter(Boolean)
                      .join('\n') || undefined,
                plain,
                signal,
              }),
            ),
          );
        }
      } else if (strip || key || (opts.changeRequest && opts.editAtlas?.get(slot.id))) {
        // A panorama strip, a transparent image, or a change to the current paint.
        const notes = [
          strip
            ? 'This image is wrapped once around a ring seen from inside (a wide panorama strip): the bottom of the image is the bottom of the ring; the left and right edges must join seamlessly. Flat, even lighting, no perspective.'
            : '',
          key ? keyColorInstruction(key) : '',
          opts.extraInstructions,
          // A ring backdrop is not a sky panorama (whose rules forbid ground and mountains).
          ...(strip && opts.assetClass === 'sky'
            ? this.lessonsFor(opts.assetClass)
            : this.rulesFor(opts.assetClass, [])),
        ].filter(Boolean);
        const cur = opts.changeRequest ? opts.editAtlas?.get(slot.id) : null;
        if (cur && this.provider.reskinTexture) {
          report(0.2, 'generate', `Changing "${slot.name}"`);
          const img = textureToCanvas({ image: cur }, Math.max(width, height));
          const image = resizeCanvas(key ? flattenOn(img, key.hex) : img, width, height);
          raw = await this.toCanvas(
            await this.withFilterRetry('change texture', slot, theme, (plain, t) =>
              this.provider.reskinTexture({
                theme: t,
                image,
                name: slot.name,
                context: [
                  `MOST IMPORTANT: change requested by the user: ${opts.changeRequest} Apply only this change and keep everything else exactly the same.`,
                  ...notes,
                ].join('\n'),
                classRules: [],
                wrap: strip ? 'x' : 'both',
                keyColor: key?.hex,
                plain,
                signal,
              }),
            ),
          );
        } else {
          report(0.2, 'generate', `Generating ${strip ? 'a panorama' : 'an image'} for "${slot.name}"`);
          raw = await this.toCanvas(
            await this.withFilterRetry('generate texture', slot, theme, (plain, t) =>
              this.provider.generateTexture({
                theme: t,
                materialName: slot.name,
                width,
                height,
                cutout: notes.join('\n'),
                keyColor: key?.hex,
                context: '',
                classRules: [],
                plain,
                signal,
              }),
            ),
          );
        }
      } else {
        report(0.2, 'generate', `Generating seamless texture for "${slot.name}"`);
        raw = await this.toCanvas(
          await this.withFilterRetry('generate texture', slot, theme, (plain, t) =>
            this.provider.generateTexture({
              theme: t,
              materialName: slot.name,
              width,
              height,
              extraInstructions: plain
                ? undefined
                : [opts.extraInstructions, ...this.lessonsFor(opts.assetClass)].filter(Boolean).join('\n') || undefined,
              plain,
              signal,
            }),
          ),
        );
      }
      return raw;
    };
    const settled = await Promise.allSettled(
      Array.from({ length: variants }, (_, vi) =>
        paintVariant({
          ...opts,
          variantIndex: vi,
          extraInstructions:
            [opts.extraInstructions, variationNote(vi, variants)].filter(Boolean).join('\n') || undefined,
        }),
      ),
    );
    signal.throwIfAborted();
    const okIdx = settled.map((r, i) => (r.status === 'fulfilled' ? i : -1)).filter((i) => i >= 0);
    const raws = okIdx.map((i) => settled[i].value);
    if (!raws.length) throw settled[0].reason;
    if (raws.length < variants) {
      this.emit('warning', { message: `"${slot.name}": ${variants - raws.length} of ${variants} variations failed.` });
    }
    const ctx = {
      orient,
      width,
      height,
      atlasMode,
      original,
      theme,
      maxSize,
      signal,
      report,
      plan,
      usedPrompt,
      opts,
      key,
      strip,
    };
    const done = [];
    for (let vi = 0; vi < raws.length; vi++) {
      const r = await this.finishSlot(slot, {
        ...ctx,
        raw: raws[vi],
        partJobs: this.variantJobs[okIdx[vi]]?.get(slot.id),
      });
      r.variant = vi;
      r.state = this.captureMaterials(slot.materials);
      r.partJobs = this.variantJobs[okIdx[vi]]?.get(slot.id);
      done.push(r);
    }
    return { ...done[0], variants: done };
  }

  /** Post-processing and apply step of one painted texture (see reskinSlot). */
  async finishSlot(slot, ctx) {
    const { orient, width, height, atlasMode, original, theme, maxSize, signal, report, plan, usedPrompt, opts } = ctx;
    const { key, strip } = ctx;
    let raw = ctx.raw;
    const maps = []; // generated maps of this result, kept with it in the history
    // Each map carries the identity of the texture it replaces (name, uuid, glTF texture and
    // image index), so a host can match it to its own image ids.
    // imageOrder 'image': canvases handed out (events, results) are flipped into ordinary image
    // order (top row = v 1); the model's own textures stay in glTF order.
    const imageOrder = opts.imageOrder ?? this.imageOrder ?? 'gltf';
    const handOut = (c) => (imageOrder === 'image' ? flipVertical(c) : c);
    const emitMap = (kind, canvas, replaces) => {
      const entry = {
        slotId: slot.id,
        slotName: slot.name,
        kind,
        canvas: handOut(canvas),
        imageOrder,
        ...this.textureIdentity(replaces),
      };
      maps.push(entry);
      this.emit('textureUpdated', entry);
    };
    signal.throwIfAborted();
    // Undo the upright transform so the texture matches the model's UVs again.
    if (orient && !isIdentity(orient)) raw = untransformCanvas(raw, orient);

    report(0.7, 'postprocess', `Post-processing "${slot.name}"`);
    let baseColor = resizeCanvas(raw, width, height); // always a fresh copy; `raw` stays as returned
    // One pass on a building: roof and underside the same as part by part.
    if (atlasMode && !ctx.partJobs && getAssetClass(opts.assetClass)?.topBottom) {
      report(0.72, 'postprocess', `Roof and underside of "${slot.name}"`);
      await this.fillTopBottom(slot, baseColor, original, theme, opts, signal);
    }
    const islandMap = atlasMode ? islandIdMap(slot, width, height) : null;
    // Artists' template outlines and labels that Muse copied (thin light lines on the toy's
    // trousers): those pixels take the paint on both sides of the line.
    const tplForLines =
      atlasMode && opts.cleanTemplateLines !== false ? this.templateFor(slot, opts, width, height) : null;
    if (tplForLines) {
      const grow = Math.max(2, Math.round((3 * width) / 1024));
      const lines = templateLineMask(tplForLines, 0);
      // The original's own light seams inside the templated areas (the toy's knee and ankle
      // seams), which Muse copies from the reference picture just like template lines.
      if (original) {
        const area = this.templateArea(slot, opts, width, height);
        const seams = seamLineMask(resizeCanvas(original, width, height), area, {
          reach: Math.max(2, Math.round((4 * width) / 1024)),
          minRun: Math.max(8, Math.round((40 * width) / 1024)),
        });
        for (let p = 0; p < lines.length; p++) lines[p] |= seams.mask[p];
      }
      // Also the gutters between islands on a line (sampled at the seams through filtering).
      let n = fillMasked(baseColor, growMask(lines, width, height, grow), null, 24, { onlyLighter: 15 });
      // Muse sometimes paints a whole light band along a horizontal panel border (a white band
      // across the knees): up and down a little further, only clearly lighter pixels go.
      const horizontal = horizontalRuns(lines, width, height, Math.max(8, Math.round((40 * width) / 1024)));
      const band = growMask(horizontal, width, height, Math.max(4, Math.round((10 * width) / 1024)), {
        vertical: true,
      });
      n += fillMasked(baseColor, band, null, 32, { minStep: 30 });
      // The same along vertical strip borders (pale streaks at the edges of trouser strips),
      // only for paint much lighter than beside it, so stripes drawn on purpose mostly stay.
      const vertical = verticalRuns(lines, width, height, Math.max(8, Math.round((40 * width) / 1024)));
      const vband = growMask(vertical, width, height, Math.max(3, Math.round((8 * width) / 1024)), {
        horizontal: true,
      });
      n += fillMasked(baseColor, vband, null, 24, { minStep: 45 });
      if (n)
        this.think('note', `"${slot.name}": removed the template's outlines and labels from the paint (${n} px)`, {
          slotId: slot.id,
        });
    }
    if (islandMap && (opts.cleanTinyIslands ?? true)) {
      // Fingers, buttons and other tiny packed islands: one solid color each, no stray patterns.
      const n = flattenTinyIslands(baseColor, islandMap, opts.tinyIslandFraction ?? 0.002);
      if (n) this.emit('warning', { message: `"${slot.name}": cleaned up ${n} tiny island(s) to solid colors.` });
    }
    // Skin swatches (tiny skin-colored squares that color the rest of the head) keep their
    // color unless the face's skin color changed.
    const faceJob = ctx.partJobs?.jobs.find((j) => j.part.zone === 'face');
    if (islandMap && original && faceJob && opts.keepSkinSwatches !== false) {
      const sw = keepSkinSwatches(
        baseColor,
        resizeCanvas(original, width, height),
        islandMap,
        resizeCanvas(faceJob.mask, width, height),
        { maxFraction: opts.tinyIslandFraction ?? 0.002 },
      );
      if (sw.swatches)
        this.emit('warning', {
          message: sw.recolored
            ? `"${slot.name}": the skin color changed, so ${sw.swatches} skin swatch(es) took the new skin color.`
            : `"${slot.name}": kept ${sw.swatches} skin swatch(es) at their original color.`,
        });
    }
    const detail = opts.detailPreserve ?? 0.35;
    if (original && detail > 0) baseColor = applyDetailPreserve(baseColor, original, detail);
    // Areas that must never change (vehicle lights, tyre treads) get their original pixels back.
    let keptAlpha = atlasMode && original ? this.restoreKept(slot, baseColor, original, opts) : null;
    if (atlasMode && original)
      keptAlpha = this.restoreKeepRects(slot, baseColor, original, opts, keptAlpha, faceJob?.mask, ctx.partJobs?.jobs);
    // Check the final texture against the plan: areas meant to be painted that still show
    // the original (Muse left them, or something put them back) are flagged for the review.
    if (atlasMode && original) this.checkUnpainted(slot, baseColor, original, ctx.partJobs, keptAlpha, opts);
    if (islandMap && (opts.edgePadding ?? 12) > 0) {
      // Edge padding: grow island colors into the gaps so seams never sample dark pixels.
      padIslands(baseColor, islandMap, Math.max(1, Math.round(((opts.edgePadding ?? 12) * width) / 1024)));
    }

    // A panorama strip: the left and right edges join.
    if (strip) baseColor = makeSeamless(baseColor, { x: true, y: false }).canvas;
    // See-through pixels of the original (cut-outs, hair cards, decals) stay see-through.
    const keptAlphaOf = original && opts.keepAlpha !== false ? alphaOf(resizeCanvas(original, width, height)) : null;
    if (keptAlphaOf) {
      applyAlpha(baseColor, keptAlphaOf);
      this.think('note', `"${slot.name}": kept the original transparency (alpha)`, { slotId: slot.id });
    } else if (key) {
      // Transparency asked for: the key-color backdrop Muse painted becomes see-through.
      const k = keyOut(baseColor, key);
      if (opts.edge === 'hard') hardenAlpha(baseColor);
      this.think(
        'note',
        `"${slot.name}": ${Math.round(k.share * 100)}% made see-through (the ${key.name} backdrop, ${k.keyColor})`,
        { slotId: slot.id },
      );
      if (k.share < 0.02)
        this.emit('warning', {
          message: `"${slot.name}": almost nothing was see-through: Muse did not paint the ${key.name} backdrop.`,
        });
    }
    report(0.8, 'apply', `Applying "${slot.name}"`);
    const baseTex = this.makeTexture(baseColor, slot.texture, THREE.SRGBColorSpace, slot.uvChannel, !atlasMode);
    if (strip) {
      baseTex.wrapS = THREE.RepeatWrapping;
      baseTex.wrapT = THREE.ClampToEdgeWrapping;
      baseTex.repeat.set(strip.repeats, 1);
    }
    for (const mat of slot.materials) {
      this.snapshot(mat);
      mat.map = baseTex;
      mat.color.set(0xffffff);
      if (key && !keptAlphaOf) {
        // Blended so soft edges (mist) stay soft; fully clear pixels are not drawn at all.
        mat.transparent = true;
        mat.alphaTest = 0.01;
      }
      mat.needsUpdate = true;
    }
    emitMap('baseColor', baseColor, slot.texture);

    // ---- normal maps
    if (opts.normalMaps ?? true) {
      report(0.85, 'postprocess', `Normal map for "${slot.name}"`);
      const cache = new Map();
      for (const mat of slot.materials) {
        if (!('normalMap' in mat)) continue; // unlit (MeshBasicMaterial): no normal map
        const src = this.snapshots.get(mat).normalMap;
        // Only regenerate maps the model already has ('always' also creates new ones).
        if (!src && opts.normalMaps !== 'always') continue;
        const key = src?.uuid ?? 'none';
        let tex = cache.get(key);
        if (!tex) {
          const srcCanvas = src?.image ? textureToCanvas(src, maxSize) : null;
          const canvas = await this.auxMap('normal', theme, srcCanvas, baseColor, signal, () =>
            deriveNormalMap(baseColor, srcCanvas, opts.normalStrength ?? 2),
          );
          tex = this.makeTexture(canvas, src ?? slot.texture, THREE.NoColorSpace, slot.uvChannel, !atlasMode);
          cache.set(key, tex);
          emitMap('normal', canvas, src);
        }
        mat.normalMap = tex;
        mat.needsUpdate = true;
      }
    }

    // ---- roughness (glTF packs roughness in G and metalness in B of one texture)
    if (opts.roughnessMaps ?? true) {
      report(0.92, 'postprocess', `Roughness map for "${slot.name}"`);
      const cache = new Map();
      for (const mat of slot.materials) {
        if (!('roughnessMap' in mat)) continue; // unlit or non-PBR: no roughness map
        const snap = this.snapshots.get(mat);
        const src = snap.roughnessMap;
        if (!src && opts.roughnessMaps !== 'always') continue;
        const key = src?.uuid ?? 'none';
        let tex = cache.get(key);
        if (!tex) {
          const srcCanvas = src?.image ? textureToCanvas(src, maxSize) : null;
          const canvas = await this.auxMap('roughness', theme, srcCanvas, baseColor, signal, () =>
            deriveRoughnessMap(baseColor, srcCanvas, { baseRoughness: snap.roughness }),
          );
          tex = this.makeTexture(canvas, src ?? slot.texture, THREE.NoColorSpace, slot.uvChannel, !atlasMode);
          cache.set(key, tex);
          emitMap('roughness', canvas, src);
        }
        const packed = snap.metalnessMap && snap.metalnessMap === snap.roughnessMap;
        mat.roughnessMap = tex;
        if (packed) mat.metalnessMap = tex;
        if (!src) mat.roughness = 1; // the map now carries the value
        mat.needsUpdate = true;
      }
    }

    report(1, 'apply', `Finished "${slot.name}"`);
    return {
      slotId: slot.id,
      slotName: slot.name,
      ...this.textureIdentity(slot.texture),
      canvas: handOut(baseColor),
      imageOrder,
      raw,
      plan,
      prompt: usedPrompt,
      maps,
    };
  }

  async auxMap(kind, theme, source, newBaseColor, signal, derive) {
    if (source && this.provider.reskinAuxMap) {
      try {
        const img = await this.timed(`paint ${kind} map`, null, () =>
          this.provider.reskinAuxMap({
            kind,
            theme,
            source,
            newBaseColor,
            width: newBaseColor.width,
            height: newBaseColor.height,
            signal,
          }),
        );
        const c = await this.toCanvas(img);
        return c.width === newBaseColor.width && c.height === newBaseColor.height
          ? c
          : resizeCanvas(c, newBaseColor.width, newBaseColor.height);
      } catch (err) {
        if (signal.aborted) throw err;
        this.emit('warning', { message: `AI ${kind} map failed, deriving locally: ${toError(err).message}` });
      }
    }
    return derive();
  }

  // ---------------------------------------------------------------- texture identity

  /**
   * Who a texture is in the source file: { textureName, textureUuid, textureIndex,
   * imageIndex, imageName }. textureIndex / imageIndex are the glTF `textures[]` and
   * `images[]` indices (null if the texture did not come from the loaded GLB).
   * @param {THREE.Texture | null | undefined} tex
   */
  textureIdentity(tex) {
    const none = { textureName: null, textureUuid: null, textureIndex: null, imageIndex: null, imageName: null };
    if (!tex) return none;
    const parser = this.model?.gltf?.parser;
    const assoc = parser?.associations;
    let ref = assoc?.get(tex);
    if (ref?.textures == null && assoc) {
      // A clone (texture transform, a second sampler) shares the original's image.
      for (const [k, v] of assoc) {
        if (k?.isTexture && v?.textures != null && k.source && k.source === tex.source) {
          ref = v;
          break;
        }
      }
    }
    const textureIndex = ref?.textures ?? null;
    const t = textureIndex != null ? parser?.json?.textures?.[textureIndex] : null;
    const imageIndex = t
      ? (t.source ?? Object.values(t.extensions ?? {}).find((e) => e?.source != null)?.source ?? null)
      : null;
    return {
      textureName: tex.name || null,
      textureUuid: tex.uuid,
      textureIndex,
      imageIndex,
      imageName: imageIndex != null ? (parser.json.images?.[imageIndex]?.name ?? null) : null,
    };
  }

  // ---------------------------------------------------------------- post: texture

  /**
   * Repaints one standalone texture (no model needed): a tiling material, a track surface,
   * an equirectangular sky. Keeps the wrap: tiling textures tile on both axes, a sky
   * panorama joins left to right with calm poles. Returns the new base color plus
   * normal and roughness maps derived from it (they tile too).
   *
   * Runs alongside other postTexture calls and is not blocked by a running reskin.
   * Events: `textureProgress` { id, stage, message, progress }, `textureReskinned` (the
   * result), `textureFailed` { id, name, error }.
   *
   * @param {HTMLCanvasElement | HTMLImageElement | ImageBitmap | ImageData | Blob | THREE.Texture | string | null} input
   *   The texture to repaint (a URL string is fetched). null generates a new seamless texture.
   * @param {import('./types.js').PostTextureOptions} opts
   * @returns {Promise<import('./types.js').TextureResult>}
   */
  async postTexture(input, opts = {}) {
    const theme = String(opts.theme ?? '').trim();
    if (!theme) throw new Error('postTexture needs opts.theme');
    const ctrl = new AbortController();
    this.textureJobs.add(ctrl);
    const signal = opts.signal ? anySignal([opts.signal, ctrl.signal]) : ctrl.signal;
    this.textureCount = (this.textureCount ?? 0) + 1;
    const id = opts.id ?? `texture${this.textureCount}`;
    const name = opts.name ?? (typeof input?.name === 'string' && input.name ? input.name : id);
    const started = performance.now();
    const report = (progress, stage, message) => this.emit('textureProgress', { id, name, stage, message, progress });
    const job = { id: null, name };
    try {
      const assetClass = opts.assetClass
        ? (normalizeAssetClass(opts.assetClass) ?? String(opts.assetClass))
        : detectAssetClass({ subject: `${opts.context ?? ''} ${theme}`, modelName: name });
      report(0.02, 'load', `Reading "${name}"`);
      const source = input == null ? null : await this.toInputCanvas(input);
      signal.throwIfAborted();
      const maxSize = Math.min(opts.maxTextureSize ?? 2048, 4096);
      const transparent = !!opts.transparent;
      const wrap = resolveWrap(opts.wrap ?? (transparent ? 'none' : undefined), assetClass, source);
      let width, height;
      if (source) ({ width, height } = fitSize(source.width, source.height, maxSize));
      else {
        width = Math.min(opts.width ?? opts.size ?? 1024, maxSize);
        height = Math.min(opts.height ?? opts.size ?? (wrap === 'equirect' ? Math.round(width / 2) : width), maxSize);
      }
      const classRules = assetClassRules(assetClass);

      report(
        0.1,
        'paint',
        `Painting "${name}" (${wrap === 'none' ? 'no wrap' : wrap === 'equirect' ? 'sky panorama' : `wraps ${wrap}`})`,
      );
      let raw;
      // A see-through image (a background layer, a cut-out): Muse paints over a flat grey
      // backdrop and the original alpha is put back on the result.
      const sized = source ? resizeCanvas(source, width, height) : null;
      // An input that already has transparency keeps exactly its own alpha (even with
      // transparent: true): no key color, no ramp or threshold.
      const alpha = sized && opts.keepAlpha !== false && opts.alpha !== 'none' ? alphaOf(sized) : null;
      const key = transparent && !alpha ? pickKeyColor(opts.keyColor, `${theme} ${opts.context ?? ''}`, sized) : null;
      // transparent: Muse paints on a flat key color, which becomes transparency afterwards.
      const keyNote = key ? keyColorInstruction(key) : '';
      const context = [
        opts.context,
        alpha
          ? 'The flat grey areas of the image are transparent (see-through) and are cut away afterwards: keep the shapes and outlines exactly where they are, and put nothing important in the grey areas.'
          : '',
        keyNote,
      ]
        .filter(Boolean)
        .join('\n');
      if (source) {
        const image = key ? flattenOn(sized, key.hex) : alpha ? flattenOn(sized) : sized;
        raw = await this.withFilterRetry('paint texture', job, theme, (plain, t) =>
          this.provider.reskinTexture
            ? this.provider.reskinTexture({
                theme: t,
                image,
                name,
                context,
                classRules,
                wrap,
                keyColor: key?.hex,
                plain,
                signal,
              })
            : this.provider.reskinAtlas({
                theme: t,
                slotName: name,
                atlas: image,
                uvGuide: image,
                width,
                height,
                plain,
                extraInstructions: [context, ...classRules].filter(Boolean).join('\n'),
                signal,
              }),
        );
      } else {
        raw = await this.withFilterRetry('generate texture', job, theme, (plain, t) =>
          this.provider.generateTexture({
            theme: t,
            materialName: name,
            width,
            height,
            plain,
            extraInstructions: [context, ...classRules].filter(Boolean).join('\n'),
            cutout: keyNote || undefined,
            keyColor: key?.hex,
            context: opts.context,
            classRules,
            signal,
          }),
        );
      }
      signal.throwIfAborted();
      let canvas = resizeCanvas(await this.toCanvas(raw), width, height);

      // ---- seams
      const axes = {
        x: wrap === 'both' || wrap === 'x' || wrap === 'equirect',
        y: wrap === 'both' || wrap === 'y',
      };
      let seams = null;
      if (wrap !== 'none' && opts.fixSeams !== false) {
        report(0.75, 'seams', `Checking the wrap seams of "${name}"`);
        const r = makeSeamless(canvas, {
          ...axes,
          poles: wrap === 'equirect' && opts.calmPoles !== false,
          band: opts.seamBand,
        });
        canvas = r.canvas;
        seams = { before: r.before, after: r.after, blended: r.fixed };
      }

      if (alpha) applyAlpha(canvas, alpha);
      let keyed = null;
      if (key) {
        report(0.8, 'postprocess', `Cutting out "${name}"`);
        keyed = keyOut(canvas, key);
        if (keyed.share < 0.02)
          this.emit('warning', {
            message: `"${name}": almost nothing was see-through: Muse did not paint the ${key.name} backdrop.`,
          });
        if (opts.trim) canvas = trimTransparent(canvas);
      }
      if ((key || alpha) && opts.edge === 'hard') hardenAlpha(canvas);

      // ---- normal + roughness (sampled across the wrap so they tile as well)
      const sky = wrap === 'equirect';
      let normal = null;
      let roughness = null;
      const tidy = (c) => (wrap === 'none' ? c : makeSeamless(c, axes).canvas);
      if (opts.normalMap ?? (!sky && !transparent)) {
        report(0.85, 'postprocess', `Normal map for "${name}"`);
        const orig = opts.normal ? resizeCanvas(await this.toInputCanvas(opts.normal), width, height) : null;
        normal = tidy(
          await this.auxMap('normal', theme, orig, canvas, signal, () =>
            deriveNormalMap(canvas, orig, opts.normalStrength ?? 2, axes),
          ),
        );
      }
      if (opts.roughnessMap ?? (!sky && !transparent)) {
        report(0.92, 'postprocess', `Roughness map for "${name}"`);
        const orig = opts.roughness ? resizeCanvas(await this.toInputCanvas(opts.roughness), width, height) : null;
        roughness = tidy(
          await this.auxMap('roughness', theme, orig, canvas, signal, () =>
            deriveRoughnessMap(canvas, orig, { baseRoughness: opts.baseRoughness ?? 0.7 }),
          ),
        );
      }

      const result = {
        id,
        name,
        assetClass,
        wrap,
        canvas,
        normal,
        roughness,
        seams,
        hasAlpha: !!(alpha || keyed),
        keyColor: keyed?.keyColor,
        alpha: keyed ? keyed.share : undefined,
        theme,
        context: opts.context ?? null,
        width: canvas.width,
        height: canvas.height,
        durationMs: performance.now() - started,
        usage: this.getUsage(),
      };
      report(1, 'done', `Finished "${name}"`);
      this.emit('textureReskinned', result);
      return result;
    } catch (err) {
      const e = toError(err);
      this.emit('textureFailed', { id, name, error: e });
      throw err;
    } finally {
      this.textureJobs.delete(ctrl);
    }
  }

  /** Any image-like input → a canvas (URL strings are fetched). */
  async toInputCanvas(input) {
    if (typeof input === 'string') {
      const res = await fetch(input);
      if (!res.ok) throw new Error(`Could not fetch ${input}: HTTP ${res.status}`);
      return blobToCanvas(await res.blob());
    }
    if (input instanceof Blob) return blobToCanvas(input);
    if (input?.isTexture) return textureToCanvas(input, 4096);
    if (typeof ImageData !== 'undefined' && input instanceof ImageData) {
      const c = createCanvas(input.width, input.height);
      ctx2d(c).putImageData(input, 0, 0);
      return c;
    }
    const w = input?.naturalWidth || input?.videoWidth || input?.width;
    const h = input?.naturalHeight || input?.videoHeight || input?.height;
    if (!w || !h) throw new Error('postTexture: unsupported image input');
    const c = createCanvas(w, h);
    ctx2d(c).drawImage(input, 0, 0, w, h);
    return c;
  }

  /** Wrap seam measure of any image: { x, y } (about 1 = tiles, 3+ = visible seam). */
  async measureSeams(input) {
    return canvasSeams(await this.toInputCanvas(input));
  }

  // ---------------------------------------------------------------- post: export

  /**
   * Export the current (reskinned) model as GLB.
   * @param {string} [filename]
   * @returns {Promise<{ glb: ArrayBuffer, filename: string }>}
   */
  async postExport(filename) {
    this.guard();
    if (!this.model) throw new Error('No model loaded');
    this.showIdMap(false); // never export the ID-map preview materials
    this.busy = true;
    try {
      this.status('exporting', 'Exporting GLB…');
      const glb = await exportGLB(this.model.scene, { animations: this.model.gltf.animations });
      const name = filename ?? `${this.model.name}${this.lastPrompt ? '-' + slug(this.lastPrompt) : ''}.glb`;
      this.emit('exported', { glb, filename: name });
      this.status('idle', `Exported ${name} (${(glb.byteLength / 1024 / 1024).toFixed(2)} MB)`);
      return { glb, filename: name };
    } catch (err) {
      this.fail(err, 'export');
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /**
   * The textures on the model as it looks now (the reskin, or the original if nothing was
   * painted), as PNG files: one file per texture, named "<material>_<map>.png". More than
   * one comes back as a single .zip. Returns { data: Uint8Array, filename, type, count }.
   */
  async postExportTextures(baseName) {
    this.guard();
    if (!this.model) throw new Error('No model loaded');
    this.showIdMap(false); // never export the ID-map preview colors
    this.busy = true;
    try {
      this.status('exporting', 'Exporting textures…');
      const files = await collectTexturePngs(this.model.scene);
      if (!files.length) throw new Error('This model has no textures to export');
      const base = baseName ?? `${this.model.name}${this.lastPrompt ? '-' + slug(this.lastPrompt) : ''}`;
      const out =
        files.length === 1
          ? { data: files[0].data, filename: `${base}-${files[0].name}`, type: 'image/png' }
          : { data: makeZip(files), filename: `${base}-textures.zip`, type: 'application/zip' };
      out.count = files.length;
      this.emit('texturesExported', { ...out });
      this.status('idle', `Exported ${out.filename} (${files.length} texture${files.length === 1 ? '' : 's'})`);
      return out;
    } catch (err) {
      this.fail(err, 'export');
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** Put the original materials back. */
  revert() {
    this.restoreSnapshots();
    this.lastResult = null;
    this.lastPrompt = '';
    this.emit('reverted', {});
    this.status('idle', 'Reverted to original textures');
  }

  /** Toggle between original and last reskin without regenerating. */
  showOriginal(show) {
    if (!this.lastResult) return;
    for (const [mat, snap] of this.snapshots) {
      const cur = (mat.userData.__reskin ??= readMaterial(mat));
      const s = show ? snap : cur;
      writeMaterial(mat, s);
      mat.needsUpdate = true;
      if (!show) delete mat.userData.__reskin;
    }
  }

  dispose() {
    this.cancel();
    this.listeners.clear();
    this.anyListeners.clear();
    this.snapshots.clear();
    this.model = null;
    this.layout = null;
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Runs a paint call; if the model's safety filter rejects it, retries once with a
   * plain prompt (no generated region text) and a toned-down theme.
   */
  /**
   * The asset class for this run: a manual choice, else what the art-director step named,
   * else a guess from the model's part names.
   */
  resolveAssetClass(opts = {}) {
    if (opts.assetClass && opts.assetClass !== 'auto' && getAssetClass(opts.assetClass)) return opts.assetClass;
    const fromMuse = normalizeAssetClass(opts.suggestion?.assetClass);
    if (fromMuse) return fromMuse;
    const partNames = (this.layout?.slots ?? []).flatMap((s) => s.meshes.map((m) => partName(m)));
    return detectAssetClass({ subject: opts.suggestion?.subject, partNames, modelName: this.model?.name });
  }

  /**
   * Paints an atlas part by part. Each part is cut out of the atlas, turned upright by its
   * own orientation, greyed outside its islands, padded to a supported aspect ratio and
   * sent with a part-specific prompt. The results are pasted back only inside each part's
   * (slightly grown) UV area, on top of a copy of the original atlas. Returns that canvas,
   * in the atlas's own orientation.
   */
  /** 0/1 map of the texture pixels a template covers (see templateFor), or null. */
  templateArea(slot, opts, W, H) {
    const list = [...(opts.templates ?? []), ...(this.profile?.templates ?? [])].filter(
      (e) => e?.image && (!e.slot || e.slot === slot.id || e.slot === slot.name),
    );
    if (!list.length) return null;
    const area = new Uint8Array(W * H);
    for (const e of list) {
      const [u0, v0, u1, v1] = e.rect ?? [0, 0, 1, 1];
      const x1 = Math.min(W, Math.ceil(u1 * W)),
        y1 = Math.min(H, Math.ceil(v1 * H));
      for (let y = Math.max(0, Math.floor(v0 * H)); y < y1; y++)
        for (let x = Math.max(0, Math.floor(u0 * W)); x < x1; x++) area[y * W + x] = 1;
    }
    return area;
  }

  /**
   * Artists' templates for a slot, composed into one image at the atlas size (white where no
   * template covers it), or null. Entries come from opts.templates and the profile
   * (setProfile): { image, slot?, rect?: [u0, v0, u1, v1], flipY? }. `slot` is a slot name or
   * id (none = every textured slot); `rect` places the image on part of the texture (texture
   * fractions, default the whole texture); `flipY` turns it upside down first (templates drawn
   * upright for an atlas the model stores upside down).
   */
  templateFor(slot, opts, W, H) {
    const list = [...(opts.templates ?? []), ...(this.profile?.templates ?? [])].filter(
      (e) => e?.image && (!e.slot || e.slot === slot.id || e.slot === slot.name),
    );
    if (!list.length) return null;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
    for (const e of list) {
      const [u0, v0, u1, v1] = e.rect ?? [0, 0, 1, 1];
      const x = u0 * W,
        y = v0 * H,
        w = (u1 - u0) * W,
        h = (v1 - v0) * H;
      g.save();
      if (e.flipY) {
        g.translate(0, y * 2 + h);
        g.scale(1, -1);
      }
      g.drawImage(e.image, x, y, w, h);
      g.restore();
    }
    return c;
  }

  /**
   * Never-painted rects for a slot: opts.keepRects and the profile's `keep`, each
   * { rect: [u0, v0, u1, v1], slot?, name? } in texture fractions measured from the top of the
   * image (the same as template rects). E.g. a game avatar's face and hands.
   */
  keepRectsFor(slot, opts = {}, { withFace = false } = {}) {
    return [...(opts.keepRects ?? []), ...(this.profile?.keep ?? [])].filter(
      (k) =>
        Array.isArray(k?.rect) &&
        (!k.slot || k.slot === slot.id || k.slot === slot.name) &&
        // opts.paintFace: the face is painted with the theme (zombie, alien, face paint).
        (withFace || !opts.paintFace || !/\bface\b/i.test(k.name ?? '')),
    );
  }

  /**
   * With opts.paintFace, how the face's skin color changed: per-channel factors (new / old) from
   * the main color of the face before and after painting, or null when it hardly changed. The
   * face is the face area that was painted (`faceMask`) or the profile's face keep rects.
   */
  faceSkinShift(slot, baseColor, src, opts, faceMask) {
    const W = baseColor.width,
      H = baseColor.height;
    let inFace = null;
    if (faceMask) {
      const m = ctx2d(resizeCanvas(faceMask, W, H)).getImageData(0, 0, W, H).data;
      inFace = (p) => m[p * 4 + 3] >= 128;
    } else {
      const rects = this.keepRectsFor(slot, opts, { withFace: true })
        .filter((k) => /\bface\b/i.test(k.name ?? ''))
        .map((k) => k.rect);
      if (!rects.length) return null;
      inFace = (p) => {
        const u = ((p % W) + 0.5) / W,
          v = (Math.floor(p / W) + 0.5) / H;
        return rects.some(([u0, v0, u1, v1]) => u >= u0 && u < u1 && v >= v0 && v < v1);
      };
    }
    const before = mainColor(ctx2d(src).getImageData(0, 0, W, H).data, inFace);
    const after = mainColor(ctx2d(baseColor).getImageData(0, 0, W, H).data, inFace);
    if (!before || !after) return null;
    if (Math.max(...after.map((c, i) => Math.abs(c - before[i]))) < 12) return null;
    return { before, after, factor: after.map((c, i) => c / Math.max(1, before[i])) };
  }

  /**
   * Puts the original pixels back inside the keep rects (see keepRectsFor). Returns the kept
   * alpha (rgba data, alpha 255 = kept) merged with `keptAlpha`, for the unpainted check.
   */
  restoreKeepRects(slot, baseColor, original, opts, keptAlpha, faceMask = null, jobs = null) {
    const rects = this.keepRectsFor(slot, opts);
    if (!rects.length) return keptAlpha;
    const W = baseColor.width,
      H = baseColor.height;
    const g = ctx2d(baseColor);
    const src = resizeCanvas(original, W, H);
    // Kept skin only on the areas that are kept (hands): a piece of another area that the model
    // maps onto the same skin swatch (the toy's waist band) keeps that area's paint.
    let lazyOwners;
    const owners = () => (lazyOwners ??= this.keepRectOwners(slot, opts, rects, W, H, jobs));
    // A painted face that changed skin color (a green zombie): kept skin takes the same change,
    // keeping its shape and shading, so the hands match the face.
    const shift = opts.paintFace ? this.faceSkinShift(slot, baseColor, src, opts, faceMask) : null;
    if (shift)
      this.think(
        'note',
        `"${slot.name}": the painted face's skin changed from rgb(${shift.before.map(Math.round)}) to rgb(${shift.after.map(Math.round)}); the kept skin (hands) takes the same color`,
        { slotId: slot.id },
      );
    const out = keptAlpha ?? new Uint8ClampedArray(W * H * 4);
    for (const k of rects) {
      const [u0, v0, u1, v1] = k.rect;
      const x = Math.max(0, Math.floor(u0 * W)),
        y = Math.max(0, Math.floor(v0 * H));
      const w = Math.min(W, Math.ceil(u1 * W)) - x,
        h = Math.min(H, Math.ceil(v1 * H)) - y;
      if (w <= 0 || h <= 0) continue;
      const only = (k.skinOnly ?? /\b(hands?|skin)\b/i.test(k.name ?? '')) ? skinPixels(src, x, y, w, h) : null;
      if (!only) {
        g.clearRect(x, y, w, h);
        g.drawImage(src, x, y, w, h, x, y, w, h);
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) out[(yy * W + xx) * 4 + 3] = 255;
        continue;
      }
      // Only the skin-coloured pixels: a sleeve or cuff reaching into the rect keeps its paint.
      const cur = g.getImageData(x, y, w, h);
      const orig = ctx2d(src).getImageData(x, y, w, h).data;
      const own = owners();
      for (let q = 0; q < w * h; q++) {
        if (!only[q]) continue;
        const p = (y + Math.floor(q / w)) * W + x + (q % w);
        if (own && own.painted[p] && !own.kept[p]) continue;
        for (let c = 0; c < 4; c++)
          cur.data[q * 4 + c] = shift && c < 3 ? orig[q * 4 + c] * shift.factor[c] : orig[q * 4 + c];
        out[((y + Math.floor(q / w)) * W + x + (q % w)) * 4 + 3] = 255;
      }
      g.putImageData(cur, x, y);
    }
    const names = rects.map((k) => k.name).filter(Boolean);
    this.think(
      'kept',
      `"${slot.name}": kept ${names.length ? names.join(', ') : `${rects.length} area(s)`} as the original (profile)`,
      {
        slotId: slot.id,
        keepRects: rects.map((k) => ({ name: k.name, rect: k.rect })),
      },
    );
    return out;
  }

  /**
   * Which texture pixels belong to areas that are painted and which to areas that are kept
   * (all inside the keep rects): { painted, kept } 0/1 maps at W×H, or null when the slot has no
   * areas. Uses the part-by-part jobs when there are some, else the slot's paint areas.
   */
  keepRectOwners(slot, opts, rects, W, H, jobs) {
    let list = jobs?.map((j) => ({ mask: j.mask, kept: !!j.keep && !j.locked })) ?? null;
    if (!list) {
      let regions = [];
      try {
        regions = this.idRegions(slot, opts);
      } catch {
        return null;
      }
      if (regions.length < 2) return null;
      list = regions.map((part) => {
        const mask = partMask(slot, part, W, H, 1);
        return { mask, kept: rectShare(mask, rects) >= 0.95 };
      });
    }
    if (!list.length) return null;
    const painted = new Uint8Array(W * H),
      kept = new Uint8Array(W * H);
    for (const { mask, kept: k } of list) {
      const d = ctx2d(resizeCanvas(mask, W, H)).getImageData(0, 0, W, H).data;
      const into = k ? kept : painted;
      for (let p = 0; p < W * H; p++) if (d[p * 4 + 3] >= 128) into[p] = 1;
    }
    return { painted, kept };
  }

  /**
   * Caller-supplied profile for a family of models (e.g. a game's avatars): artists'
   * templates and exact panels, used by every later reskin. Pass null to clear.
   * @param {{ templates?: object[], panels?: object[], name?: string } | null} profile
   */
  setProfile(profile) {
    this.profile = profile ?? null;
    // A profile's zones win over SAM-found ones, so the areas may change.
    this.regionCache.clear();
  }

  // ---------------------------------------------------------------- SAM zones

  /**
   * Turns SAM zone finding on or off. When on, a model with no profile gets its paint
   * zones from SAM 3.1 (found once per model, before the first paint). A loaded profile
   * always wins: its model keeps the usual areas.
   */
  setSamZones(on) {
    on = !!on;
    if (on === this.samZonesOn) return;
    this.samZonesOn = on;
    this.regionCache.clear();
    this.emit('locks', { locked: [...this.locked], areas: this.listAreas() });
  }

  /** True when SAM-found zones replace the usual areas (switched on, and no profile loaded). */
  get samZonesActive() {
    return this.samZonesOn && !this.profile;
  }

  /** Atlas slots that still need SAM zones. */
  slotsWithoutSamZones() {
    return (this.layout?.slots ?? []).filter((s) => s.texture && !s.tiled && !this.samZones.has(s.id));
  }

  /**
   * Finds paint zones with SAM 3.1 now (the toggle is switched on too). Renders the six
   * views of the original look, asks SAM for each noun phrase of the asset class and maps
   * the masks back onto the UV layout. Returns the zones per slot, or null if none were found.
   * @param {{ assetClass?: string, suggestion?: object, force?: boolean, signal?: AbortSignal }} [opts]
   */
  async postFindZones(opts = {}) {
    this.guard();
    if (!this.model || !this.layout) throw new Error('Post a model before finding zones');
    this.setSamZones(true);
    this.busy = true;
    this.abort = new AbortController();
    const signal = opts.signal ? anySignal([opts.signal, this.abort.signal]) : this.abort.signal;
    const idMap = this.idMapVisible;
    try {
      if (idMap) this.showIdMap(false);
      const shown = !!this.lastResult;
      if (shown) this.showOriginal(true);
      try {
        if (opts.force) for (const s of this.layout.slots) this.samZones.delete(s.id);
        const found = await this.findZones(opts, signal);
        this.status('idle', found?.length ? 'SAM zones ready' : 'Using the usual areas');
        return found;
      } finally {
        if (shown) this.showOriginal(false);
      }
    } finally {
      if (idMap) this.showIdMap(true);
      this.busy = false;
      this.abort = null;
    }
  }

  /**
   * The SAM zone pass (see samZones.js). The model must show its original look. Never
   * throws apart from a cancel: on any failure the usual areas are kept.
   */
  async findZones(opts, signal) {
    const slots = this.slotsWithoutSamZones();
    if (!slots.length) return this.samZonesSummary();
    if (this.profile) {
      this.emit('warning', {
        message: `Profile "${this.profile.name ?? 'loaded'}" gives the zones; SAM zone finding skipped.`,
      });
      return null;
    }
    if (typeof this.provider.segment !== 'function') {
      this.emit('warning', { message: `${this.provider.name} cannot run SAM 3.1; using the usual areas.` });
      return null;
    }
    const assetClass = opts.assetClass && opts.assetClass !== 'auto' ? opts.assetClass : this.resolveAssetClass(opts);
    const partNames = (opts.suggestion?.parts ?? this.modelAnalysis?.parts ?? []).map((p) => p?.name);
    const { concepts, rest } = zoneConceptsFor(assetClass, partNames);
    if (!concepts.length) {
      this.emit('warning', {
        message:
          'SAM zones: no part names to look for (pick an asset class or get a Muse suggestion first); using the usual areas.',
      });
      return null;
    }
    const before = this.usage.session.segments ?? 0;
    const costBefore = usageCost(this.usage.session);
    this.status('analyzing', `SAM 3.1 is finding zones: ${concepts.map((c) => c.concept).join(', ')}…`);
    this.emit('progress', { stage: 'plan', message: 'SAM 3.1 is finding paint zones', progress: 0.05 });
    try {
      const res = await this.timed('sam zones', null, async () => {
        const { views } = renderAxisViews(this.model.scene, { size: opts.zoneViewSize ?? 384 });
        return findSamZones({
          root: this.model.scene,
          slots,
          views,
          concepts,
          rest,
          segment: (o) => this.provider.segment(o),
          signal,
        });
      });
      const names = new Set();
      for (const slot of slots) {
        const found = res.zones.get(slot.id) ?? [];
        // Even when the usual areas are kept for painting, SAM's windows and lights still say
        // what is never painted.
        this.keepZones.set(slot.id, found);
        // Fewer zones than the usual split means SAM missed parts (the live run: hair, hands and
        // shoes not seen on the test avatar), so the usual areas are kept unless preferSam is set.
        const usual = this.paintRegions(slot, slotParts(slot), { ...opts, assetClass }).length;
        if (found.length < 2 || (!opts.preferSam && found.length < usual)) {
          this.samZones.set(slot.id, []); // tried: keep the usual areas
          if (found.length >= 2)
            this.emit('warning', {
              message: `"${slot.name}": SAM found ${found.length} zones (${found.map((z) => z.zone).join(', ')}), fewer than the usual ${usual} areas; keeping the usual areas.`,
            });
          continue;
        }
        // Vehicles: a "wheels" zone with no round wheel in it is the body's wheel arches (SAM
        // marks the arch around a wheel). Painted as a wheel, Muse drew rims there; painted as
        // body it came out flat grey. The arches keep their original (dark) pixels instead.
        if (assetClass === 'vehicle')
          for (const z of found)
            if (z.zone === 'wheels' && !zoneHasWheel(slot, z)) {
              z.zone = 'wheel arches';
              this.think(
                'note',
                `"${slot.name}": SAM's "wheels" zone has no round wheel in it, so it is the wheel arches: kept as the original.`,
              );
            }
        const parts = slotParts(slot);
        const base =
          parts.length === 1 ? parts[0] : { name: slot.name, meshes: slot.meshes, up: null, mirrored: false };
        const regions = found.slice(0, opts.maxPaintAreas ?? 12).map((z) => {
          const data = regionData(slot, [...z.tris.keys()]);
          names.add(z.zone);
          return makeRegion(slot, { ...base, meshes: [...z.tris.keys()] }, z.zone, z, z.area / z.share, data);
        });
        this.samZones.set(slot.id, regions);
      }
      this.regionCache.clear();
      this.emit('locks', { locked: [...this.locked], areas: this.listAreas() });
      const images = (this.usage.session.segments ?? 0) - before;
      const cost = usageCost(this.usage.session) - costBefore;
      const missed = res.found.filter((f) => !f.masks).map((f) => f.concept);
      this.emit('warning', {
        message: names.size
          ? `SAM 3.1 zones: ${[...names].join(', ')}${missed.length ? ` (not seen: ${missed.join(', ')})` : ''}. ${images} SAM image${images === 1 ? '' : 's'} ≈ ${formatDollars(cost)}.`
          : `SAM 3.1 found no usable zones (${images} SAM images ≈ ${formatDollars(cost)}); using the usual areas.`,
      });
      const summary = this.samZonesSummary();
      this.think('zones', names.size ? `SAM found: ${[...names].join(', ')}` : 'SAM found no usable zones', {
        zones: summary,
        notSeen: missed,
      });
      this.emit('zones', { slots: summary, sheet: res.sheet, found: res.found, images, cost });
      return summary;
    } catch (err) {
      if (signal?.aborted) throw err;
      this.emit('warning', { message: `SAM zone finding failed (${toError(err).message}); using the usual areas.` });
      return null;
    }
  }

  /**
   * SAM noun phrases for what is never painted: windows (any model Muse says has glass, every
   * vehicle), vehicle lights, and each "don't paint X" from the user's rules.
   */
  keepConcepts(opts = {}) {
    const cls = opts.assetClass && opts.assetClass !== 'auto' ? opts.assetClass : this.resolveAssetClass(opts);
    const out = [];
    const roles = Object.values(this.partRolesFor(opts) ?? {});
    if (cls === 'vehicle')
      out.push(
        { zone: 'windows', concept: 'window' },
        { zone: 'lights', concept: 'headlight' },
        { zone: 'lights', concept: 'fog light' },
        { zone: 'lights', concept: 'tail light' },
      );
    else if (roles.includes('glass')) out.push({ zone: 'windows', concept: 'window' });
    for (const k of keepTargetsFromRules(this.userRules)) out.push({ zone: `keep: ${k.noun}`, concept: k.noun });
    return out.slice(0, 8);
  }

  /**
   * Finds the never-painted areas with SAM when the paint areas didn't come from SAM (SAM zones
   * off, or SAM's zones were fewer than the usual areas). Never throws apart from a cancel.
   * opts.keepSam: false skips it.
   */
  async findKeepZones(opts, signal) {
    if (opts.keepSam === false || typeof this.provider.segment !== 'function' || !this.model || !this.layout) return;
    const concepts = this.keepConcepts(opts);
    if (!concepts.length) return;
    const key = concepts.map((c) => c.zone + '=' + c.concept).join('|');
    const slots = (this.layout.slots ?? []).filter(
      (s) =>
        s.texture &&
        !s.tiled &&
        !(this.samZonesActive && this.samZones.get(s.id)?.length) &&
        this.keepZonesKey?.get(s.id) !== key,
    );
    if (!slots.length) return;
    const shown = !!this.lastResult;
    const idMap = this.idMapVisible;
    try {
      if (idMap) this.showIdMap(false);
      if (shown) this.showOriginal(true);
      this.status(
        'analyzing',
        `SAM 3.1 is finding what is never painted: ${concepts.map((c) => c.concept).join(', ')}…`,
      );
      // The same model again (ModStorm posts it for every reskin): reuse what SAM found, so
      // the kept areas are the same every run.
      const memoKey = `${modelSignature(this.layout)}#${key}`;
      const memo = KEEP_MEMO.get(memoKey);
      if (memo) {
        for (const slot of slots) {
          const i = this.layout.slots.indexOf(slot);
          this.keepZones.set(
            slot.id,
            (memo[i] ?? []).map((z) => ({
              ...z,
              tris: new Map(z.tris.filter(([k]) => slot.meshes[k]).map(([k, bits]) => [slot.meshes[k], bits])),
            })),
          );
          (this.keepZonesKey ??= new Map()).set(slot.id, key);
        }
        this.keepCache = null;
        this.think('zones', 'Reused what SAM found never to paint on this model last time (same every run)', {
          keep: true,
          concepts,
          reused: true,
        });
        return;
      }
      // SAM's masks change from one render to the next (a headlight seen in one run, missed in
      // the next), so it looks at two renders at different sizes and the areas are joined.
      const sizes = opts.keepSamRuns === 1 ? [opts.zoneViewSize ?? 384] : [opts.zoneViewSize ?? 384, 512];
      const runs = await this.timed('sam keep areas', null, () =>
        Promise.all(
          sizes.map((size) => {
            const { views } = renderAxisViews(this.model.scene, { size });
            return findSamZones({
              root: this.model.scene,
              slots,
              views,
              concepts,
              rest: 'paint',
              segment: (o) => this.provider.segment(o),
              signal,
            });
          }),
        ),
      );
      const res = {
        found: runs[0].found.map((f, k) => ({ ...f, masks: Math.max(...runs.map((r) => r.found[k]?.masks ?? 0)) })),
      };
      this.keepZonesKey ??= new Map();
      const stored = [];
      for (const slot of slots) {
        const joined = new Map();
        for (const r of runs)
          for (const z of r.zones.get(slot.id) ?? []) {
            if (z.zone === 'paint') continue;
            const j = joined.get(z.zone);
            if (!j) {
              joined.set(z.zone, { ...z, tris: new Map([...z.tris].map(([m, b]) => [m, Uint8Array.from(b)])) });
              continue;
            }
            for (const [m, b] of z.tris) {
              const t = j.tris.get(m);
              if (!t) j.tris.set(m, Uint8Array.from(b));
              else for (let i = 0; i < t.length; i++) t[i] |= b[i];
            }
            j.share = Math.max(j.share, z.share);
            j.area = Math.max(j.area, z.area);
          }
        const zones = [...joined.values()];
        this.keepZones.set(slot.id, zones);
        this.keepZonesKey.set(slot.id, key);
        stored[this.layout.slots.indexOf(slot)] = zones.map((z) => ({
          zone: z.zone,
          share: z.share,
          area: z.area,
          tris: [...z.tris].map(([m, b]) => [slot.meshes.indexOf(m), b]),
        }));
      }
      if (KEEP_MEMO.size > 20) KEEP_MEMO.delete(KEEP_MEMO.keys().next().value);
      KEEP_MEMO.set(memoKey, stored);
      this.keepCache = null;
      const missed = res.found.filter((f) => !f.masks).map((f) => f.concept);
      this.think(
        'zones',
        `SAM looked for what is never painted: ${concepts.map((c) => c.concept).join(', ')}${missed.length ? ` (not seen: ${missed.join(', ')})` : ''}`,
        { keep: true, concepts, notSeen: missed },
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      this.emit('warning', { message: `SAM could not look for the never-painted areas (${toError(err).message}).` });
    } finally {
      if (shown) this.showOriginal(false);
      if (idMap) this.showIdMap(true);
    }
  }

  /** SAM zones per slot: [{ slotId, slotName, zones: [{ name, zone, share }] }]. */
  samZonesSummary() {
    return (this.layout?.slots ?? [])
      .filter((s) => this.samZones.get(s.id)?.length)
      .map((s) => ({
        slotId: s.id,
        slotName: s.name,
        zones: this.samZones.get(s.id).map((r) => ({ name: r.name, zone: r.zone, share: r.share })),
      }));
  }

  /**
   * Speed: while the user reads the suggestion, the per-area theme split for its prompt is
   * already asked for, so painting that prompt starts with it ready (one Muse call less on
   * the clock). Opt-in (opts.prefetchAreaThemes: true on postSuggest), for editors that paint
   * the suggested prompt as is: if the prompt is edited, the call was wasted. Part mode only.
   */
  prefetchAreaThemes(suggestion, opts = {}) {
    if (opts.prefetchAreaThemes !== true || opts.paintMode === 'atlas' || opts.areaThemes === false) return;
    if (!this.provider.areaThemes || typeof this.provider.reskinPart !== 'function') return;
    const theme = String(suggestion.prompt ?? '').trim();
    if (!theme) return;
    const o = { ...opts, assetClass: this.resolveAssetClass({ ...opts, suggestion }), suggestion };
    for (const slot of this.layout?.slots ?? []) {
      if (!slot.texture || slot.tiled) continue;
      let names;
      try {
        names = this.idRegions(slot, o).map((r) => r.name);
      } catch {
        continue;
      }
      if (names.length < 2) continue;
      this.areaThemesFor(theme, names, suggestion.plans?.[slot.id] ?? { subject: suggestion.subject }, null).catch(
        () => {},
      );
    }
  }

  /** Per-area theme descriptions (cached per theme + area list; failures fall back to the theme). */
  async areaThemesFor(theme, names, plan, signal) {
    if (!this.provider.areaThemes) return new Map();
    this.areaThemeCache ??= new Map();
    const key = `${theme}|${[...names].sort().join(',')}`;
    if (!this.areaThemeCache.has(key)) {
      const p = this.timed('split theme per area', null, () =>
        this.provider.areaThemes({ theme, areas: names, subject: plan?.subject, signal }),
      ).then(
        (m) => {
          this.areaThemeResolved ??= new Map();
          for (const [n, d] of m) this.areaThemeResolved.set(`${theme}|${n}`, d);
          if (m.size)
            this.emit('warning', { message: `Area themes: ${[...m].map(([n, d]) => `${n}: ${d}`).join(' | ')}` });
          return m;
        },
        (err) => {
          this.areaThemeCache.delete(key);
          if (signal?.aborted) throw err;
          this.emit('warning', {
            message: `Could not split the theme per area (${err.message}); using the whole theme.`,
          });
          return new Map();
        },
      );
      this.areaThemeCache.set(key, p);
    }
    return this.areaThemeCache.get(key);
  }

  async paintByParts(slot, theme, parts, original, plan, opts, signal, report) {
    const W = original.width,
      H = original.height;
    const grow = Math.max(1, Math.round((2 * W) / 1024));
    const manual =
      opts.orientation != null && opts.orientation !== 'auto' ? resolveOrientation(opts.orientation, parts) : null;
    const regions = this.idRegions(slot, opts);
    const template = this.templateFor(slot, opts, W, H);
    if (template) this.emit('warning', { message: `"${slot.name}": using the artists' template for layout.` });
    // Review & fix: areas Muse did not flag reuse their last painted image.
    // Locked areas keep their current paint (or the original colors if never painted).
    const locked = new Set(opts.locked ?? this.locked);
    const prev = opts.fixes || locked.size ? this.lastPartJobs.get(slot.id) : null;
    const prevByName = new Map((prev?.jobs ?? []).filter((j) => j.painted).map((j) => [j.part.name, j]));
    const jobs = [];
    const keepTris = this.keepTriangles(slot, opts);
    // The profile's (or caller's) never-painted rects: an area all inside them costs no Muse call.
    const keepRects = this.keepRectsFor(slot, opts);
    // Strip layouts are only read for limbs (sleeves, trouser legs); torso, hands and shoes
    // are not laid out as clean wrap-around strips.
    const STRIP_ZONES = new Set(['arms', 'legs']);
    const anatForStrips = regions.some((r) => STRIP_ZONES.has(r.zone)) ? this.anatomy() : null;
    for (const part of regions) {
      const mask = partMask(slot, part, W, H, grow);
      const rect = maskRect(mask, Math.round(W / 128));
      if (!rect) continue;
      const t = manual ?? chooseOrientation([part]);
      const facing = drawFacingMap(slot, part, W, H, { grow });
      const job = { part, mask, rect, facing, orient: isIdentity(t) ? null : t };
      // Body zones: which way each vertical strip faces (front / back / outer / inner).
      if (anatForStrips && STRIP_ZONES.has(part.zone))
        job.sides = drawFacingMap(slot, part, W, H, { grow, limbCenterX: anatForStrips.cx }).canvas;
      // Vehicle lights (and areas that are all tyre tread) are never repainted.
      if (
        (keepTris && keptShare(slot, part, keepTris.tris) >= 0.95) ||
        (keepRects.length && rectShare(mask, keepRects) >= 0.95)
      ) {
        job.keep = true;
        job.protected = true;
      } else if (locked.has(part.name)) {
        const old = prevByName.get(part.name);
        if (old) job.reuse = old.painted;
        else job.keep = true;
        job.locked = true;
      } else if (opts.fixes) {
        const fix = opts.fixes[part.name];
        const old = prevByName.get(part.name);
        if (fix && opts.changeRequest) {
          // A change request edits the area as it is now (fast, and everything else stays).
          job.note = `Change requested by the user: ${fix} Apply only this change to the image and keep everything else in it exactly the same.`;
          if (old?.painted) job.editFrom = old.painted;
        } else if (fix) job.note = `Correction from a review of the last attempt: ${fix}`;
        else if (old) job.reuse = old.painted;
      }
      jobs.push(job);
    }
    // Largest area first: it is painted alone and then shown to the others as the style reference.
    jobs.sort((a, b) => b.rect.pixels - a.rect.pixels);
    const turned = jobs.filter((j) => j.orient).map((j) => j.part.name);
    if (turned.length && !manual) {
      this.emit('warning', {
        message: `"${slot.name}": ${turned.join(', ')} ${turned.length > 1 ? 'are' : 'is'} stored rotated or mirrored; painting upright and turning back.`,
      });
    }
    {
      const zoneOf = (j) => j.part.zone ?? null;
      const areas = jobs.map((j) => ({
        name: j.part.name,
        zone: zoneOf(j),
        action: j.keep ? 'keep' : j.reuse ? 'reuse' : 'paint',
        why: j.protected
          ? 'vehicle rule: lights, glass and tyre treads are never repainted'
          : j.locked
            ? 'locked by the user'
            : j.reuse
              ? 'not flagged by the review, so the last paint is reused'
              : j.note
                ? j.note
                : undefined,
        mergedFrom: j.part.mergedFrom,
      }));
      this.think(
        'plan',
        `"${slot.name}": ${areas.length} area(s): ${areas.map((a) => `${a.name}${a.action === 'paint' ? '' : ` (${a.action})`}`).join(', ')}`,
        { slotId: slot.id, slotName: slot.name, mode: 'parts', areas },
      );
    }
    this.emit('regions', {
      slotId: slot.id,
      regions: jobs.map((j) => ({ name: j.part.name, color: j.part.color, hex: j.part.hex, facing: j.facing.share })),
    });
    const names = jobs.map((j) => j.part.name);
    const regionPaint = (part) => {
      const keys = [part.name, part.baseName].filter(Boolean).map((n) => n.toLowerCase());
      const hits = (plan?.regions ?? []).filter((r) => {
        const m = r.name.toLowerCase();
        return keys.some((n) => m === n || m.includes(n) || n.includes(m));
      });
      return (
        hits
          .map((r) => r.description)
          .filter(Boolean)
          .join(' ') || undefined
      );
    };
    // One short surface description per area, so no area prompt describes the whole
    // character (Muse then draws little portraits inside the areas). Shared by variations.
    const areaThemes = opts.areaThemes === false ? new Map() : await this.areaThemesFor(theme, names, plan, signal);
    const out = copyCanvas(original);
    let done = 0;
    let styleRef = null;
    // Live preview: the model shows each area as soon as it is painted (first variation only).
    let live = null;
    if ((opts.variantIndex ?? 0) === 0 && opts.livePreview !== false) {
      live = this.makeTexture(out, slot.texture, THREE.SRGBColorSpace, slot.uvChannel, false);
      for (const mat of slot.materials) {
        this.snapshot(mat);
        mat.map = live;
        mat.color.set(0xffffff);
        mat.needsUpdate = true;
      }
    }
    const toPaint = jobs.filter((j) => !j.reuse && !j.keep).length;
    if (!toPaint && locked.size) throw new Error(`Every area of "${slot.name}" is locked; unlock one to repaint it.`);
    // Skin reference for leftover cleanup: the original face color (avatars only).
    const faceJob = jobs.find((j) => j.part.zone === 'face') ?? jobs.find((j) => j.part.zone === 'head');
    const skin =
      faceJob && opts.fixSkinLeftovers !== false
        ? maskedMedian(cropCanvas(original, faceJob.rect), cropCanvas(faceJob.mask, faceJob.rect))
        : null;
    const CLOTHED = new Set(['torso', 'arms', 'legs', 'hands', 'shoes']);
    // Up to this share of skin is taken as leftovers; more is taken as meant (bare hands).
    const COVERED_FRACTION = { torso: 0.6, arms: 0.6, legs: 0.6, hands: 0.35, shoes: 0.35 };
    report(
      0.2,
      'generate',
      toPaint < jobs.length
        ? `Repainting ${toPaint} of ${jobs.length} areas of "${slot.name}"`
        : `Painting "${slot.name}" part by part (${jobs.length} areas)`,
    );
    const paintOne = async (job) => {
      const { part, mask, rect, orient, facing } = job;
      if (job.keep) {
        done++;
        return null;
      }
      if (job.reuse) {
        pasteInsideMask(out, untransformCanvas(job.reuse, orient), mask, rect);
        job.painted = job.reuse;
        done++;
        return job.reuse;
      }
      const fresh = transformCanvas(greyedCrop(original, mask, rect), orient);
      let crop =
        job.editFrom && job.editFrom.width === fresh.width && job.editFrom.height === fresh.height
          ? job.editFrom
          : fresh;
      let guide = transformCanvas(cropCanvas(facing.canvas, rect), orient);
      // Artists' template (editor-supplied, same layout as the texture): cut like the area.
      let tpl = template ? transformCanvas(cropCanvas(template, rect), orient) : null;
      // Editor-supplied panels ({ zone | area, facing: 'front' | 'back', rect: [u0, v0, u1, v1] }
      // in texture fractions) give the exact front / back instead of reading it from the 3D data.
      const panelMask = (facingIdx) => {
        const pn = [...(opts.panels ?? []), ...(this.profile?.panels ?? [])].find(
          (p) =>
            p.facing === (facingIdx === 0 ? 'front' : 'back') &&
            (p.area === part.name || p.zone === part.zone) &&
            (!p.slot || p.slot === slot.name || p.slot === slot.id),
        );
        if (!pn) return null;
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const g = c.getContext('2d');
        g.fillStyle = '#000';
        g.fillRect(0, 0, W, H);
        g.fillStyle = '#fff';
        const [u0, v0, u1, v1] = pn.rect;
        g.fillRect(u0 * W, v0 * H, (u1 - u0) * W, (v1 - v0) * H);
        return transformCanvas(cropCanvas(c, rect), orient);
      };
      const colSpan = (c) => {
        if (!c) return null;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let a = -1,
          b = -1;
        for (let x = 0; x < c.width; x++) {
          let on = false;
          for (let y = 0; y < c.height && !on; y += 2) on = d[(y * c.width + x) * 4] > 128;
          if (on) {
            if (a < 0) a = x;
            b = x;
          }
        }
        return a < 0 ? null : { start: a, end: b };
      };
      const panelMasks = [panelMask(0), panelMask(1)];
      // Torso: the front panel is often off to one side of the crop and the image model
      // always centers the garment, so the crop is rolled (wrapping round) to put the front
      // in the middle, and rolled back after painting.
      let roll = 0;
      if (part.zone === 'torso' && opts.centerFront !== false) {
        const fs = colSpan(panelMasks[0]) ?? frontSpan(guide);
        const d = fs ? Math.round(guide.width / 2 - (fs.start + fs.end + 1) / 2) : 0;
        if (Math.abs(d) >= guide.width * 0.04) {
          roll = d;
          crop = rollCanvas(crop, roll);
          guide = rollCanvas(guide, roll);
          if (tpl) tpl = rollCanvas(tpl, roll);
          for (let i = 0; i < 2; i++) if (panelMasks[i]) panelMasks[i] = rollCanvas(panelMasks[i], roll);
        }
        this.emit('warning', {
          message: `${part.name}: ${fs ? (roll ? `front panel moved ${Math.round((100 * roll) / guide.width)}% to the center for painting` : 'front panel already centered') : `no single front panel found (front faces: ${Math.round((facing.share.front ?? 0) * 100)}%, crop ${guide.width}x${guide.height}, orientation ${orient ? JSON.stringify({ rot: orient.rot, flipX: orient.flipX }) : 'upright'})`}.`,
        });
      }
      const padded = padToMuseAspect(crop);
      // Image 2 is a plain white mask; which way each area faces goes in as text, since the
      // image model copies the colors of a colored guide (side areas came out skin-toned).
      const paddedGuide = padToMuseAspect(whiteMask(guide), { fill: '#000000' });
      const layout = facingGridText(guide);
      const strips = job.sides ? facingStripsText(transformCanvas(cropCanvas(job.sides, rect), orient)) : '';
      if (job.sides)
        this.emit('warning', { message: `${part.name} layout: ${strips || 'no clear vertical strips found'}.` });
      const rules = this.rulesFor(opts.assetClass, [part.name]);
      const frontLine = part.zone === 'torso' ? frontSpanText(guide) : '';
      if (frontLine) this.emit('warning', { message: `${part.name} front: ${frontLine.split(':')[0]}.` });
      // Building undersides are hardly seen: one flat color (black by default), no Muse call.
      if (part.zone === 'underside' && opts.undersideColor !== null) {
        const upright = copyCanvas(crop);
        const g = ctx2d(upright);
        const m = ctx2d(whiteMask(guide)).getImageData(0, 0, upright.width, upright.height).data;
        const img = g.getImageData(0, 0, upright.width, upright.height);
        const hex = parseInt(String(opts.undersideColor ?? '#000000').replace('#', ''), 16);
        for (let i = 0; i < m.length; i += 4) {
          if (m[i] < 128) continue;
          img.data[i] = hex >> 16;
          img.data[i + 1] = (hex >> 8) & 255;
          img.data[i + 2] = hex & 255;
          img.data[i + 3] = 255;
        }
        g.putImageData(img, 0, 0);
        pasteInsideMask(out, untransformCanvas(upright, orient), mask, rect);
        job.painted = upright;
        if (live) {
          live.needsUpdate = true;
          this.emit('partPainted', { slotId: slot.id, area: part.name, canvas: out });
        }
        done++;
        report(0.2 + (0.5 * done) / jobs.length, 'paint', `Filled ${part.name} (${done}/${jobs.length})`);
        return upright;
      }
      // Hands and roofs get a plain material (simple, and no figures or facades drawn in them).
      const asMaterial =
        (part.zone === 'hands' && opts.handsAsMaterial !== false) ||
        (part.zone === 'roof' && opts.roofAsMaterial !== false);
      if (asMaterial && this.provider.generateTexture) {
        const roof = part.zone === 'roof';
        // Hand islands are tiny and look like little figures to the image model (it drew a
        // shirt and trousers in them), so hands get a plain material: a seamless texture of
        // the area theme, shaded by the original's light and dark (finger lines, nails).
        const tex = roof
          ? await this.roofTexture(slot, theme, areaThemes.get(part.name), signal)
          : await this.withFilterRetry(`paint ${part.name}`, slot, theme, (plain, t) =>
              this.provider.generateTexture({
                theme: plain ? t : (areaThemes.get(part.name) ?? `${t}, hands (gloves or skin)`),
                materialName: 'hand surface (glove material or skin)',
                extraInstructions: 'Plain material only: no hands, fingers, clothes, figures or objects drawn on it.',
                width: 256,
                height: 256,
                signal,
              }),
            );
        signal.throwIfAborted();
        // Hands: shaded by the original's light and dark (finger lines, nails). Roofs: an even
        // surface in small units; only clearly dark spots (vents, chimneys) stay.
        const upright = roof
          ? materialFill(crop, whiteMask(guide), tex, { tile: roofTile(crop), shade: 'dark' })
          : materialFill(crop, whiteMask(guide), await this.toCanvas(tex));
        pasteInsideMask(out, untransformCanvas(upright, orient), mask, rect);
        job.painted = upright;
        if (live) {
          live.needsUpdate = true;
          this.emit('partPainted', { slotId: slot.id, area: part.name, canvas: out });
        }
        done++;
        report(0.2 + (0.5 * done) / jobs.length, 'generate', `Painted ${part.name} (${done}/${jobs.length})`);
        return upright;
      }
      const paintMuse = (retryNote) =>
        this.withFilterRetry(`paint ${part.name}`, slot, theme, (plain, t) =>
          this.provider.reskinPart({
            // Plain retry: only this area's short theme (the whole-model theme may name a
            // character the filter rejects), and no style reference image.
            theme: plain && areaThemes.get(part.name) ? softenTheme(areaThemes.get(part.name)) : t,
            slotName: slot.name,
            partName: part.name,
            image: padded.canvas,
            mask: paddedGuide.canvas,
            facing: facingShareText(facing.share),
            facingLayout: layout,
            facingStrips: strips || undefined,
            styleRef: plain ? null : styleRef,
            template: plain || !tpl ? undefined : padToMuseAspect(tpl, { fill: '#ffffff' }).canvas,
            subject: plain ? undefined : plan?.subject,
            areaTheme: plain ? undefined : areaThemes.get(part.name),
            paint: plain ? undefined : regionPaint(part),
            others: names.filter((n) => n !== part.name),
            classRules: plain ? undefined : rules,
            extra: plain
              ? undefined
              : [frontLine, opts.extraInstructions, job.note, retryNote].filter(Boolean).join('\n') || undefined,
            plain,
            signal,
          }),
        );
      let restoreLost = null;
      let painted = await this.toCanvas(await paintMuse());
      signal.throwIfAborted();
      if (part.zone === 'face' && opts.checkFace !== false) {
        // Muse sometimes moves the features (eyes drawn where the mouth was) or drops some.
        // Check the original's eyes / brows / mouth still have detail; repaint once if not.
        const where = (l) =>
          `${l.y < 0.4 ? 'upper' : l.y > 0.6 ? 'lower' : 'middle'} ${l.x < 0.4 ? 'left' : l.x > 0.6 ? 'right' : 'centre'}`;
        const check = (c) =>
          faceFeaturesKept(crop, unpad(c, padded.canvas, padded.box, crop.width, crop.height), whiteMask(guide));
        const first = check(painted);
        if (first.lost.length) {
          this.emit('warning', {
            message: `${part.name}: ${first.lost.length} of ${first.total} face features missing or moved (${first.lost.map(where).join(', ')}); repainting once.`,
          });
          const again = await this.toCanvas(
            await paintMuse(
              `The last attempt lost or moved facial features (at the ${first.lost.map(where).join(', ')} of image 1). Every eye, brow and the mouth must stay exactly where the dark shapes are in image 1, at the same size.`,
            ),
          );
          signal.throwIfAborted();
          const second = check(again);
          if (second.kept > first.kept) painted = again;
          const best = second.kept > first.kept ? second : first;
          if (best.lost.length) restoreLost = best.lost;
          this.emit('warning', {
            message: `${part.name}: repaint kept ${second.kept} of ${second.total} features (first try ${first.kept}); using the ${second.kept > first.kept ? 'repaint' : 'first try'}.`,
          });
        }
      }
      const samRules =
        opts.samCheck !== false && this.provider.segment
          ? samRulesFor(opts.assetClass, part.zone, theme, part.name)
          : [];
      let samUpright = null;
      if (samRules.length && !this.samOff) {
        // SAM 3.1 looks for things that belong to other areas (a face on the trousers, shoes
        // at the bottom of the legs) that this paint added; repaint once if it finds any.
        const areaMask = whiteMask(guide);
        const un = (c) => unpad(c, padded.canvas, padded.box, crop.width, crop.height);
        const find = (u) => this.samFind(slot, part.name, u, crop, areaMask, samRules, signal);
        const firstU = un(painted);
        const first = await find(firstU);
        if (first?.length) {
          const masked = opts.samMaskedRepaint !== false;
          this.emit('warning', {
            message: `${part.name}: SAM 3.1 found ${intrusionText(first)} painted where it does not belong; repainting${masked ? ` only the marked ${Math.max(1, Math.round(maskedShare(first) * 100))}% of the area` : ' once'}.`,
          });
          const again = await this.toCanvas(await paintMuse(intrusionNote(first, part.name)));
          signal.throwIfAborted();
          const againU = un(again);
          // Masked repaint first: only SAM's marked pixels come from the repaint, so the fix
          // cannot spread into the rest of the area. The whole repaint is the fallback.
          const tries = [];
          if (masked) {
            const mixed = maskedBlend(firstU, againU, first);
            tries.push({ label: 'masked repaint', canvas: mixed, hits: (await find(mixed)) ?? first });
          }
          if (!tries.length || tries[0].hits.length) {
            tries.push({ label: 'whole repaint', canvas: againU, padded: again, hits: (await find(againU)) ?? first });
          }
          const best = tries.reduce((a, b) => (intrusionScore(b.hits) < intrusionScore(a.hits) ? b : a));
          const better = intrusionScore(best.hits) < intrusionScore(first);
          if (better) {
            if (best.padded) painted = best.padded;
            else samUpright = best.canvas;
          }
          this.emit('warning', {
            message: `${part.name}: SAM 3.1 after the ${tries.map((t) => `${t.label}: ${t.hits.length ? intrusionText(t.hits) : 'nothing out of place'}`).join('; ')}; using the ${better ? best.label : 'first try'}.`,
          });
        } else if (first) {
          this.emit('warning', {
            message: `${part.name}: SAM 3.1 check passed (${samRules.map((r) => r.concept).join(', ')}).`,
          });
        }
      }
      const upright = samUpright ?? unpad(painted, padded.canvas, padded.box, crop.width, crop.height);
      if (restoreLost) {
        // Still missing after the repaint: draw the original's eyes / brows / mouth lines back.
        restoreFeatures(upright, crop, restoreLost);
        this.emit('warning', {
          message: `${part.name}: restored ${restoreLost.length} face feature(s) from the original.`,
        });
      }
      if (part.zone === 'torso' && opts.frontPanelPass !== false) {
        // Muse centers a garment in whatever image it gets, and the torso crop holds front,
        // side, back and side. The front and the back panel are each painted again on their
        // own (matching the whole-torso paint as style reference): the opening can only land
        // on the front's middle, and the back gets the plain back of the garment.
        const skinShare = (c) => {
          if (!skin) return 0;
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0,
            t = 0;
          for (let i = 0; i < d.length; i += 16) {
            t++;
            if (Math.hypot(d[i] - skin[0], d[i + 1] - skin[1], d[i + 2] - skin[2]) < 40) n++;
          }
          return n / (t || 1);
        };
        const panels = [
          {
            facing: 0,
            label: 'front',
            lines: [
              'Image 1 is only the front of the torso (chest and belly), seen straight on, from shoulder line to waist. Image 3 is the whole torso already painted: use the same garment, material and colors.',
              "Paint the garment's front centred: its opening, buttons or zip exactly on the vertical centre line of image 1, symmetric left and right.",
            ],
          },
          {
            facing: 1,
            label: 'back',
            lines: [
              'Image 1 is only the back of the torso, seen straight from behind, from shoulder line to waist. Image 3 is the whole torso already painted: use the same garment, material and colors.',
              'Paint the plain back of that garment: no opening, no buttons, no zip, no lapels, no pockets, no collar front and no shirt showing through. At most a centre back seam or a belt.',
            ],
          },
        ];
        for (const panel of panels) {
          const w = guide.width;
          const pm = panelMasks[panel.facing];
          const sp0 = colSpan(pm) ?? frontSpan(guide, panel.facing);
          if (!sp0 || sp0.end - sp0.start + 1 >= w * 0.8) continue;
          // Roll so the panel sits in the middle (a back panel is often split over the edges).
          const d = Math.round(w / 2 - (sp0.start + sp0.end + 1) / 2);
          const rCrop = d ? rollCanvas(crop, d) : crop;
          const rGuide = d ? rollCanvas(guide, d) : guide;
          const rUp = d ? rollCanvas(upright, d) : upright;
          const sp = colSpan(pm && d ? rollCanvas(pm, d) : pm) ?? frontSpan(rGuide, panel.facing);
          if (!sp || sp.end >= w) continue;
          const fr = { x: sp.start, y: 0, width: sp.end - sp.start + 1, height: rGuide.height };
          const fCrop = cropCanvas(rCrop, fr);
          const fPad = padToMuseAspect(fCrop);
          const fGuide = padToMuseAspect(whiteMask(cropCanvas(rGuide, fr)), { fill: '#000000' });
          const fTpl = tpl
            ? padToMuseAspect(cropCanvas(d ? rollCanvas(tpl, d) : tpl, fr), { fill: '#ffffff' }).canvas
            : null;
          try {
            const img = await this.withFilterRetry(`paint ${part.name} ${panel.label}`, slot, theme, (plain, t) =>
              this.provider.reskinPart({
                theme: t,
                slotName: slot.name,
                partName: `${part.name} (${panel.label} panel)`,
                image: fPad.canvas,
                mask: fGuide.canvas,
                facing:
                  panel.facing === 0
                    ? 'the front of the body, seen straight on'
                    : 'the back of the body, seen from behind',
                styleRef: plain ? null : rUp,
                template: plain ? undefined : (fTpl ?? undefined),
                areaTheme: plain ? undefined : areaThemes.get(part.name),
                classRules: plain ? undefined : rules,
                extra: plain
                  ? undefined
                  : [...panel.lines, opts.extraInstructions, job.note].filter(Boolean).join('\n'),
                plain,
                signal,
              }),
            );
            signal.throwIfAborted();
            const fp = unpad(await this.toCanvas(img), fPad.canvas, fPad.box, fCrop.width, fCrop.height);
            // A drawn face or person shows up as new skin-colored pixels: reject the pass then.
            const added = skinShare(fp) - skinShare(fCrop);
            if (added > 0.02)
              throw new Error(`it drew ${(added * 100).toFixed(0)}% new skin-colored area (a face or person)`);
            if (panel.facing === 0 && samRules.length && !this.samOff) {
              const hits = await this.samFind(
                slot,
                `${part.name} front panel`,
                fp,
                fCrop,
                whiteMask(cropCanvas(rGuide, fr)),
                samRules,
                signal,
              );
              if (hits?.length) throw new Error(`SAM 3.1 found ${intrusionText(hits)} on it`);
            }
            const ug = rUp.getContext('2d');
            const dst = ug.getImageData(fr.x, 0, fr.width, fr.height);
            const src = fp.getContext('2d').getImageData(0, 0, fr.width, fr.height).data;
            const mk = whiteMask(cropCanvas(rGuide, fr)).getContext('2d').getImageData(0, 0, fr.width, fr.height).data;
            for (let i = 0; i < src.length; i += 4) {
              if (mk[i] < 128) continue;
              dst.data[i] = src[i];
              dst.data[i + 1] = src[i + 1];
              dst.data[i + 2] = src[i + 2];
            }
            ug.putImageData(dst, fr.x, 0);
            if (d) {
              const back = rollCanvas(rUp, -d);
              upright
                .getContext('2d')
                .putImageData(back.getContext('2d').getImageData(0, 0, back.width, back.height), 0, 0);
            }
            this.emit('warning', { message: `${part.name}: ${panel.label} panel painted on its own.` });
          } catch (err) {
            if (signal.aborted) throw err;
            this.emit('warning', {
              message: `${part.name}: ${panel.label} panel pass skipped (${toError(err).message}); keeping the whole-torso paint there.`,
            });
          }
        }
      }
      if (part.zone === 'face' && opts.oneFace !== false) {
        // Small separate pieces of the face area (back of the head, ears) get the skin color,
        // so a second face can never appear on them.
        const n = oneFaceOnly(upright, crop, whiteMask(guide));
        if (n) this.emit('warning', { message: `${part.name}: ${n} separate piece(s) set to the painted skin color.` });
      }
      if (STRIP_ZONES.has(part.zone) && opts.plainNarrowStrips !== false) {
        // A narrow extra piece between two limbs (crotch / inseam strip) is plain fabric;
        // Muse tends to paint it as a separate trim (a gold bar between the trouser legs).
        const n = plainNarrowSpans(upright, whiteMask(guide));
        if (n) this.emit('warning', { message: `${part.name}: ${n} narrow piece(s) set to the plain fabric color.` });
      }
      if (CLOTHED.has(part.zone) && part.zone !== 'hands' && opts.fixBackgroundLeftovers !== false) {
        // Dark wedges / background blobs Muse leaves inside clothing (e.g. between trouser legs).
        const fb = fillBackgroundLeftovers(upright, whiteMask(guide));
        if (fb > 0.002)
          this.emit('warning', { message: `${part.name}: filled ${(fb * 100).toFixed(1)}% background gaps.` });
      }
      if (skin && CLOTHED.has(part.zone)) {
        const f = fillSkinLeftovers(upright, whiteMask(guide), skin, { maxFraction: COVERED_FRACTION[part.zone] });
        if (f > 0.002)
          this.emit('warning', { message: `${part.name}: filled ${(f * 100).toFixed(1)}% skin-colored leftovers.` });
      }
      const final = roll ? rollCanvas(upright, -roll) : upright;
      pasteInsideMask(out, untransformCanvas(final, orient), mask, rect);
      job.painted = final;
      if (live) {
        live.needsUpdate = true;
        this.emit('partPainted', { slotId: slot.id, area: part.name, canvas: out });
      }
      done++;
      report(0.2 + (0.5 * done) / jobs.length, 'generate', `Painted ${part.name} (${done}/${jobs.length})`);
      return final;
    };
    const results = [];
    const rest = jobs.slice();
    const reused = jobs.find((j) => j.reuse && !j.note);
    if (reused) styleRef = reused.reuse;
    // Only areas that are really painted count (kept lights / arches and reused areas don't).
    const toPaintJobs = jobs.filter((j) => !j.keep && !j.reuse);
    const styleFirst = !reused && (opts.styleReference ?? true) && toPaintJobs.length > 2;
    let ordered = jobs;
    if (styleFirst) {
      // Paint the biggest area first so every other call can match its palette and style.
      // Speed: glass (windows) needs no style match, and kept areas need no call, so they run
      // alongside it instead of waiting.
      const first = rest.find((j) => !j.keep && !j.reuse);
      const noStyle = (j) =>
        j !== first &&
        (j.keep || /\b(windows?|glass|windshield|windscreen)\b/i.test(`${j.part.zone ?? ''} ${j.part.name}`));
      const now = [first, ...rest.filter(noStyle)];
      const later = rest.filter((j) => !now.includes(j));
      const firstRun = mapLimit([first], 1, paintOne).then(([r]) => {
        if (r.status === 'fulfilled') styleRef = r.value;
        return r;
      });
      const side = mapLimit(now.slice(1), opts.partConcurrency ?? 4, paintOne);
      const [r1, sideResults] = await Promise.all([firstRun, side]);
      results.push(r1, ...sideResults);
      results.push(...(await mapLimit(later, opts.partConcurrency ?? 4, paintOne)));
      ordered = [...now, ...later];
    } else {
      results.push(...(await mapLimit(rest, opts.partConcurrency ?? 4, paintOne)));
      ordered = rest;
    }
    signal.throwIfAborted();
    const failed = results.map((r, i) => [r, ordered[i]]).filter(([r]) => r.status === 'rejected');
    if (failed.length === jobs.length && failed.length) throw failed[0][0].reason;
    for (const [r, job] of failed) {
      this.emit('warning', {
        message: `"${slot.name}": could not paint ${job.part.name} (${toError(r.reason).message}); it keeps its old colors.`,
      });
    }
    // Second skin pass with the painted skin color (a clown's white, a robot's metal): skin
    // patches in clothing that Muse painted in the new skin color are filled too.
    const faceDone = faceJob?.painted && !faceJob.reuse ? faceJob : null;
    // Off by default: when Muse paints the face wrongly, the "new skin" color is wrong too.
    if (skin && faceDone && opts.fillNewSkin === true) {
      const faceCrop = transformCanvas(greyedCrop(original, faceDone.mask, faceDone.rect), faceDone.orient);
      const faceMaskU = whiteMask(transformCanvas(cropCanvas(faceDone.facing.canvas, faceDone.rect), faceDone.orient));
      const newSkin = paintedSkin(faceDone.painted, faceCrop, faceMaskU, skin);
      if (newSkin && Math.hypot(newSkin[0] - skin[0], newSkin[1] - skin[1], newSkin[2] - skin[2]) > 40) {
        for (const job of jobs) {
          if (!CLOTHED.has(job.part.zone) || job.reuse || job.keep || !job.painted) continue;
          const piece = cropCanvas(out, job.rect);
          const f = fillSkinLeftovers(piece, cropCanvas(job.mask, job.rect), newSkin, {
            maxFraction: COVERED_FRACTION[job.part.zone],
          });
          if (f > 0.002) {
            pasteInsideMask(out, piece, job.mask, job.rect);
            this.emit('warning', {
              message: `${job.part.name}: filled ${(f * 100).toFixed(1)}% patches in the new skin color.`,
            });
          }
        }
        if (live) live.needsUpdate = true;
      }
    }
    // Hair made of strands (cards / spikes, each its own UV island) is shaded strand by
    // strand in the painted hair color, instead of keeping a pattern painted across it.
    if (opts.strandHair !== false) {
      const anat = this.anatomy();
      const center = anat ? [anat.cx, anat.neckY + (anat.maxY - anat.neckY) * 0.4, anat.cz] : null;
      for (const [r, job] of results.map((r, i) => [r, ordered[i]])) {
        const isHair = /^hair/.test(job.part.zone ?? '') || /(^|[^a-z])hair/i.test(job.part.name);
        if (!isHair || job.reuse || job.keep || r.status !== 'fulfilled') continue;
        const n = paintHairStrands(out, slot, job.part, { center });
        if (n) {
          this.emit('warning', { message: `${job.part.name}: shaded ${n} hair strands one by one.` });
          if (live) live.needsUpdate = true;
        }
      }
    }
    const rec = { jobs, original, out, theme, plan, opts };
    const vi = opts.variantIndex ?? 0;
    (this.variantJobs[vi] ??= new Map()).set(slot.id, rec);
    if (vi === 0) this.lastPartJobs.set(slot.id, rec);
    return out;
  }

  // ---------------------------------------------------------------- variations + history

  // ---------------------------------------------------------------- learned tips

  /** Class rules plus the learned tips for that class. */
  rulesFor(assetClass, partNames = []) {
    return [...assetClassRules(assetClass, partNames), ...this.lessonsFor(assetClass)];
  }

  lessonsFor(assetClass) {
    return [...this.userRuleLines(), ...(this.lessons.all ?? []), ...(this.lessons[assetClass] ?? [])];
  }

  /**
   * The user's own hard rules (opts.userRules on postSuggest / postPrompt, e.g. the editor's
   * Context field: "don't paint the windows"). Passed through unchanged, never rewritten by
   * Muse, and sent first in every Muse call of the run: the suggestion, every paint prompt
   * and the review. They stay until a call passes other userRules (null or [] clears them).
   */
  setUserRules(rules) {
    if (rules === undefined) return;
    const list = (Array.isArray(rules) ? rules : [rules])
      .flatMap((r) => String(r ?? '').split(/\n+/))
      .map((r) => r.trim())
      .filter(Boolean);
    this.userRules = list;
    if (list.length)
      this.think('rules', `Your rules, sent first in every Muse call: ${list.join(' | ')}`, { userRules: list });
  }

  userRuleLines() {
    return (this.userRules ?? []).map((r) => `MOST IMPORTANT RULE (from the user): ${r}`);
  }

  getLessons() {
    return JSON.parse(JSON.stringify(this.lessons));
  }

  /** Replaces all learned tips: { [assetClass | 'all']: string[] }. */
  setLessons(lessons = {}) {
    const clean = {};
    for (const [k, list] of Object.entries(lessons ?? {})) {
      const items = [...new Set((Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter(Boolean))];
      if (items.length) clean[k] = items.slice(-(this.maxLessons ?? 12));
    }
    this.lessons = clean;
    this.emit('lessons', this.getLessons());
  }

  /** Adds tips for a class, skipping near-duplicates; keeps the newest `maxLessons` (12). */
  addLessons(assetClass, list) {
    const norm = (t) =>
      t
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const cur = this.lessons[assetClass] ?? [];
    const seen = new Set([...cur, ...(this.lessons.all ?? [])].map(norm));
    const added = [];
    for (const l of list ?? []) {
      const n = norm(l);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      added.push(sanitizePrompt(l));
    }
    if (!added.length) return [];
    this.setLessons({ ...this.lessons, [assetClass]: [...cur, ...added] });
    return added;
  }

  /** Material state (maps, color, roughness) of `materials`, to switch between results. */
  captureMaterials(materials) {
    const state = new Map();
    for (const mat of materials) {
      state.set(mat, readMaterial(mat));
    }
    return state;
  }

  applyState(state) {
    for (const [mat, s] of state) {
      delete mat.userData.__reskin;
      writeMaterial(mat, s);
      mat.needsUpdate = true;
    }
  }

  recordVariations(theme, results, opts) {
    const base = this.captureMaterials(this.snapshots.keys());
    // A retry of some slots keeps the other slots' maps and part jobs from the entry shown now.
    const shown = opts.slotIds ? this.history[this.historyIndex] : null;
    const keepSlot = (id) => !opts.slotIds.includes(id);
    const keptMaps = shown ? shown.maps.filter((m) => keepSlot(m.slotId)) : [];
    const keptJobs = shown ? [...shown.partJobs].filter(([id]) => keepSlot(id)) : [];
    const count = Math.max(1, ...results.map((r) => r.variants?.length ?? 1));
    const entries = [];
    // Every paint is kept: new entries always go at the end, even after an undo.
    for (let vi = 0; vi < count; vi++) {
      const state = new Map(base);
      const partJobs = new Map(keptJobs);
      const maps = [...keptMaps];
      for (const r of results) {
        const v = r.variants?.[vi] ?? r.variants?.[0] ?? r;
        for (const [mat, st] of v.state ?? []) state.set(mat, st);
        if (v.partJobs) partJobs.set(r.slotId, v.partJobs);
        maps.push(...(v.maps ?? []));
      }
      this.applyState(state);
      const thumb = this.renderThumb();
      const entry = {
        maps,
        id: `h${Date.now().toString(36)}${vi}`,
        prompt: theme,
        variant: vi,
        of: count,
        state,
        partJobs,
        thumb,
        fixes: !!opts.fixes,
        change: opts.changeRequest ?? null,
      };
      this.history.push(entry);
      entries.push(entry);
    }
    this.goToHistory(this.history.length - count, { silent: true });
    this.emit('history', this.historySummary());
    return entries;
  }

  /** A small three-quarter render of the model as it looks now, from above (two sides and the top). */
  renderThumb(size = 160) {
    try {
      return renderAxisViews(this.model.scene, { size, views: [THUMB_VIEW], cols: 1 }).views[0].canvas;
    } catch {
      return null;
    }
  }

  historySummary() {
    return {
      index: this.historyIndex,
      originalThumb: this.originalThumb ?? null,
      entries: this.history.map(({ id, prompt, variant, of, thumb, fixes, change }) => ({
        id,
        prompt,
        variant,
        of,
        thumb,
        fixes,
        change: change ?? null,
      })),
    };
  }

  /** Shows history entry `index` (-1 = the original model). */
  goToHistory(index, { silent = false } = {}) {
    if (index < -1 || index >= this.history.length) return false;
    this.showIdMap(false);
    if (index === -1) this.restoreSnapshots();
    else {
      const e = this.history[index];
      this.applyState(e.state);
      this.lastPartJobs = new Map(e.partJobs);
      this.lastPrompt = e.prompt;
      if (this.lastRun) this.lastRun.theme = e.prompt;
    }
    this.historyIndex = index;
    // The generated maps of the shown result (none for the original).
    this.emit('maps', { maps: index === -1 ? [] : this.history[index].maps });
    if (!silent) this.emit('history', this.historySummary());
    return true;
  }

  /**
   * Before/after compare: returns { before(), after() } that switch the materials between
   * the original look and the current result (used for a split-screen slider).
   */
  compareStates() {
    const after = this.captureMaterials(this.snapshots.keys());
    const before = new Map([...this.snapshots].map(([mat, s]) => [mat, { ...s, color: s.color.clone() }]));
    return { before: () => this.applyState(before), after: () => this.applyState(after) };
  }

  /** Pick a result (e.g. one of the variations) by its id. */
  applyHistory(id) {
    return this.goToHistory(this.history.findIndex((e) => e.id === id));
  }

  undo() {
    return this.guardIdle() && this.goToHistory(this.historyIndex - 1);
  }

  redo() {
    return this.guardIdle() && this.goToHistory(this.historyIndex + 1);
  }

  guardIdle() {
    return !this.busy;
  }

  /** Neck height etc. of the loaded model (cached; see analysis/anatomy.js). */
  anatomy() {
    if (this.anatomyCache === undefined) this.anatomyCache = this.model ? avatarAnatomy(this.model.scene) : null;
    return this.anatomyCache;
  }

  /**
   * The areas of an atlas slot, each with its own color: every part, split into regions
   * when its UV islands sit in clearly separate groups. These are the areas painted one by
   * one, shown in the ID map, and named in the suggestion and review prompts.
   */
  idRegions(slot, opts = {}) {
    const assetClass = opts.assetClass && opts.assetClass !== 'auto' ? opts.assetClass : this.resolveAssetClass(opts);
    opts = { ...opts, assetClass };
    // SAM-found zones (switched on, no profile) replace the usual areas of this slot.
    const sam = this.samZonesActive && this.samZones.get(slot.id)?.length ? this.samZones.get(slot.id) : null;
    const key = `${slot.id}|${opts.splitRegions !== false}|${opts.maxPaintAreas ?? 12}|${assetClass}|${sam ? 'sam' : ''}`;
    const hit = this.regionCache.get(key);
    if (hit) return hit;
    const regions = sam ?? this.paintRegions(slot, slotParts(slot), opts);
    // Body zones always get the same color; other areas take the next unused one.
    const used = new Set();
    const fixed = regions.map((r) => {
      const c = r.zone && ZONE_COLORS[r.zone] && PART_COLORS.find(([n]) => n === ZONE_COLORS[r.zone]);
      if (c && !used.has(c[0])) {
        used.add(c[0]);
        return c;
      }
      return null;
    });
    const free = PART_COLORS.filter(([n]) => !used.has(n));
    let next = 0;
    const out = regions.map((r, i) => {
      const [color, hex] = fixed[i] ?? free[next++ % free.length] ?? PART_COLORS[i % PART_COLORS.length];
      return { ...r, color, hex };
    });
    this.regionCache.set(key, out);
    return out;
  }

  /** ID-map textures: per atlas slot, each area filled with its own flat color. */
  idMapTextures(size = 1024) {
    const out = new Map();
    for (const slot of this.layout?.slots ?? []) {
      if (!slot.texture || slot.tiled) continue;
      const { width, height } = fitSize(slot.width || size, slot.height || size, size);
      const c = drawPartMap(slot, this.idRegions(slot, this.areaOpts()), width, height);
      const tex = new THREE.CanvasTexture(c);
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.channel = slot.uvChannel;
      out.set(slot.id, { canvas: c, texture: tex, regions: this.idRegions(slot, this.areaOpts()) });
    }
    return out;
  }

  /**
   * Shows (or hides) the ID map on the model: every area in its own flat, unlit color,
   * the same colors as the part map, so you can see which atlas area is which part.
   * Untextured materials get a flat grey.
   */
  showIdMap(on) {
    if (!this.model) return;
    if (!on) {
      for (const [mesh, mat] of this.idMapSaved ?? []) mesh.material = mat;
      this.idMapSaved = null;
      this.emit('idMap', { on: false });
      return;
    }
    if (this.idMapSaved) return;
    const textures = this.idMapTextures();
    const bySlotMat = new Map();
    for (const slot of this.layout.slots) {
      const t = textures.get(slot.id);
      for (const mat of slot.materials) bySlotMat.set(mat, t);
    }
    this.idMapSaved = new Map();
    this.model.scene.traverse((o) => {
      if (!o.isMesh) return;
      this.idMapSaved.set(o, o.material);
      const swap = (m) => {
        const t = bySlotMat.get(m);
        return new THREE.MeshBasicMaterial(
          t ? { map: t.texture, side: m.side } : { color: 0x5a5f6a, side: m?.side ?? THREE.FrontSide },
        );
      };
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
    this.emit('idMap', {
      on: true,
      slots: [...textures.entries()].map(([slotId, t]) => ({
        slotId,
        canvas: t.canvas,
        regions: t.regions.map(({ meshes, islands, ...r }) => r),
      })),
    });
  }

  get idMapVisible() {
    return !!this.idMapSaved;
  }

  /** One labelled image of the model from many angles with the ID map shown. */
  renderIdSheet({ size = 288, views, cols } = {}) {
    const wasOn = this.idMapVisible;
    this.showIdMap(true);
    try {
      return renderAxisViews(this.model.scene, { size, views, cols }).sheet;
    } finally {
      if (!wasOn) this.showIdMap(false);
    }
  }

  /** Whether the provider can review a painted result. */
  get canReview() {
    return typeof this.provider.reviewResult === 'function';
  }

  /**
   * Review & fix: renders the painted model from eight angles (the six axis views plus
   * 45° views of the front and back) above the same views as an ID map, all in ONE image,
   * and asks Muse to compare it with the prompt. Muse returns notes per area; the flagged
   * areas are repainted with the note as a correction while the other areas keep their
   * painted image. Repeats up to `passes` times (default 1) or until Muse finds nothing.
   * Returns { passes: [{ notes, sheet, repainted }] }.
   */
  async postReview(opts = {}) {
    this.guard();
    if (!this.lastRun || !this.lastResult) throw new Error('Paint the model before reviewing it');
    if (!this.canReview) throw new Error(`${this.provider.name} cannot review results`);
    const passes = Math.max(1, Math.min(opts.passes ?? 1, 3));
    const out = [];
    const thinkStart = (this.thinkingLog ??= []).length;
    for (let i = 0; i < passes; i++) {
      const review = await this.reviewOnce(opts);
      const onePass = !this.areaNames().length;
      const fixable = onePass
        ? review.issues.filter((x) => x.fix || x.problem)
        : review.issues.filter((x) => x.area && this.areaNames().includes(x.area));
      const pass = { notes: review, sheet: review.sheet, repainted: [] };
      out.push(pass);
      if (opts.fix === false || !fixable.length) break;
      if (onePass) {
        // Painted in one pass: one edit of the whole texture with every correction.
        const text = fixable.map((x) => `${x.area ? `${x.area}: ` : ''}${x.fix || x.problem}`).join(' ');
        pass.repainted = ['whole texture'];
        this.status('reskinning', 'Fixing the whole texture');
        await this.onePassEdit(`Correction from a review: ${text}`, opts.signal);
        continue;
      }
      const fixes = {};
      for (const x of fixable) fixes[x.area] = [fixes[x.area], x.fix || x.problem].filter(Boolean).join(' ');
      pass.repainted = Object.keys(fixes);
      this.status('reskinning', `Repainting ${pass.repainted.join(', ')}`);
      await this.postPrompt(this.lastRun.theme, { ...this.lastRun.opts, variants: 1, fixes, signal: opts.signal });
    }
    return { passes: out, thinking: this.thinkingLog.slice(thinkStart) };
  }

  /**
   * Change request on a finished reskin ("make the stripes blue", "less neon on the hood").
   * Reuses everything from that run: identification, SAM zones, part roles, the paint plan,
   * area themes and every painted area. Muse Spark picks the areas the request touches
   * (one short text call), and only those are repainted, each starting from its current paint.
   * The result is a new History entry.
   * @param {string} text the user's change request
   * @param {{ historyIndex?: number, areas?: string[] | Record<string, string>, signal?: AbortSignal }} [opts]
   *   historyIndex: the History entry to change (default: the one shown). areas: skip Muse's
   *   choice: area names (each gets the request) or { area: instruction }.
   * @returns {Promise<import('./types.js').ReskinResult & { change: { request: string, areas: Record<string, string>, summary: string } }>}
   */
  async postChange(text, opts = {}) {
    this.guard();
    const request = String(text ?? '').trim();
    if (!request) throw new Error('The change request is empty');
    const thinkStart = (this.thinkingLog ??= []).length;
    if (!this.lastRun) throw new Error('Paint the model before asking for a change');
    if (opts.historyIndex != null && opts.historyIndex !== this.historyIndex) {
      if (opts.historyIndex < 0) throw new Error('Pick a painted result, not the original');
      this.goToHistory(opts.historyIndex, { silent: true });
    }
    const names = this.areaNames();
    // Painted in one pass (no separate areas): the whole texture is edited from its current paint.
    if (!names.length) {
      this.think('change', `Change "${request}": editing the whole texture (painted in one pass)`, { request });
      const res = await this.onePassEdit(request, opts.signal);
      res.change = { request, areas: {}, summary: 'whole texture' };
      res.thinking = this.thinkingLog.slice(thinkStart);
      return res;
    }
    // What each area looks like now (area themes / plan), so Muse can match "the stripes" etc.
    const jobsBy = new Map();
    for (const rec of this.lastPartJobs.values()) for (const j of rec.jobs) jobsBy.set(j.part.name, j);
    const areas = names
      .filter((n) => !jobsBy.get(n)?.keep)
      .map((n) => ({ name: n, zone: jobsBy.get(n)?.part.zone, now: this.areaDescription(n) }));
    let chosen = new Map();
    let summary = '';
    if (opts.areas) {
      const given = Array.isArray(opts.areas) ? opts.areas.map((n) => [n, request]) : Object.entries(opts.areas);
      chosen = new Map(given.filter(([n]) => names.includes(n)));
    } else if (this.provider.changePlan) {
      const plan = await this.timed('plan change', null, () =>
        this.provider.changePlan({
          request,
          theme: this.lastRun.theme,
          areas,
          subject: this.lastRun.opts?.suggestion?.subject,
          signal: opts.signal,
        }),
      );
      chosen = plan.areas;
      summary = plan.summary;
    }
    if (!chosen.size) {
      // No plan: areas named in the request, else every painted area.
      const words = new Set(splitWords(request).toLowerCase().split(/\s+/));
      const hit = areas.filter((a) =>
        splitWords(a.name)
          .toLowerCase()
          .split(/\s+/)
          .some((w) => w.length > 2 && words.has(w)),
      );
      chosen = new Map((hit.length ? hit : areas).map((a) => [a.name, request]));
    }
    const fixes = Object.fromEntries(chosen);
    this.think('change', `Change "${request}": repainting ${[...chosen.keys()].join(', ')}`, {
      request,
      areas: fixes,
      summary,
      reused: names.filter((n) => !chosen.has(n)),
    });
    const res = await this.postPrompt(this.lastRun.theme, {
      ...this.lastRun.opts,
      variants: 1,
      fixes,
      changeRequest: request,
      signal: opts.signal,
    });
    res.change = { request, areas: fixes, summary };
    res.thinking = this.thinkingLog.slice(thinkStart);
    return res;
  }

  /**
   * Edits every texture of a one-pass result from its current paint: `request` is applied and
   * everything else is kept (one Muse image per texture). Kept areas (lights, glass, treads)
   * are put back as in any run.
   */
  async onePassEdit(request, signal) {
    const editAtlas = new Map();
    for (const slot of this.layout?.slots ?? []) {
      const img = slot.materials[0]?.map?.image;
      // Textured atlases, and generated images (untextured meshes, panorama rings) once painted.
      if (img?.width && ((slot.texture && !slot.tiled) || this.snapshots.has(slot.materials[0])))
        editAtlas.set(slot.id, img);
    }
    return this.postPrompt(this.lastRun.theme, {
      ...this.lastRun.opts,
      variants: 1,
      changeRequest: request,
      editAtlas,
      signal,
    });
  }

  /** What an area was painted as (its area theme or plan description), if known. */
  areaDescription(name) {
    return this.areaThemeResolved?.get(`${this.lastRun?.theme}|${name}`);
  }

  /** Region options matching the last run's asset class (so names and colors agree). */
  areaOpts() {
    return this.areaClass ? { assetClass: this.areaClass } : {};
  }

  /**
   * All paint areas of the loaded model with their ID colors and lock state:
   * [{ slotId, slotName, name, zone, color, hex, locked }].
   */
  listAreas() {
    const out = [];
    for (const slot of this.layout?.slots ?? []) {
      if (!slot.texture || slot.tiled) continue;
      for (const r of this.idRegions(slot, this.areaOpts())) {
        out.push({
          slotId: slot.id,
          slotName: slot.name,
          name: r.name,
          zone: r.zone,
          color: r.color,
          hex: r.hex,
          locked: this.locked.has(r.name),
        });
      }
    }
    return out;
  }

  /** Locks (or unlocks) areas by name; locked areas keep their paint on the next prompt. */
  setLocked(names, on = true) {
    for (const n of [].concat(names)) {
      if (on) this.locked.add(n);
      else this.locked.delete(n);
    }
    this.emit('locks', { locked: [...this.locked], areas: this.listAreas() });
    return [...this.locked];
  }

  /** Names of all areas painted one by one in the last run. */
  areaNames() {
    return [...this.lastPartJobs.values()].flatMap((r) => r.jobs.map((j) => j.part.name));
  }

  async reviewOnce(opts = {}) {
    const thinkStart = (this.thinkingLog ??= []).length;
    this.busy = true;
    this.abort = new AbortController();
    const signal = opts.signal ? anySignal([opts.signal, this.abort.signal]) : this.abort.signal;
    try {
      this.status('analyzing', 'Rendering the result from 8 angles for review…');
      this.emit('progress', { stage: 'review', message: 'Rendering the result for review', progress: 0.1 });
      const size = opts.viewSize ?? 256;
      const idWasOn = this.idMapVisible;
      if (idWasOn) this.showIdMap(false);
      const painted = renderAxisViews(this.model.scene, { size, views: REVIEW_VIEWS, cols: 4 }).sheet;
      if (idWasOn) this.showIdMap(true);
      const ids = this.renderIdSheet({ size, views: REVIEW_VIEWS, cols: 4 });
      const sheet = stackCanvases([painted, ids]);
      this.emit('progress', { stage: 'review', message: 'Muse is reviewing the result', progress: 0.4 });
      const areas = [];
      for (const slot of this.layout.slots) {
        const run = this.lastPartJobs.get(slot.id);
        if (!run) continue;
        const regions = this.idRegions(slot);
        for (const j of run.jobs) {
          const r = regions.find((x) => x.name === j.part.name);
          areas.push({ name: j.part.name, color: r?.color, facing: facingSummary(j.facing.share) });
        }
      }
      const theme = this.lastRun.theme;
      const notes = await this.timed('review result', null, () =>
        this.provider.reviewResult({
          theme,
          sheet,
          areas,
          subject: this.lastRun.opts.suggestion?.subject,
          classRules: this.rulesFor(
            this.lastRun.opts.assetClass,
            areas.map((a) => a.name),
          ),
          signal,
        }),
      );
      // The plugin's own check: planned areas that still show the original texture.
      for (const slot of this.layout.slots) {
        for (const f of this.unpaintedBySlot?.get(slot.id) ?? []) {
          if (notes.issues.some((x) => x.area === f.area)) continue;
          const isArea = this.areaNames().includes(f.area);
          notes.issues.push({
            area: isArea ? f.area : undefined,
            problem: `${Math.round(f.share * 100)}% of this area still shows the original texture`,
            fix: 'Repaint the whole area in the theme; leave none of the old colors or patterns.',
            source: 'plugin check',
          });
        }
      }
      for (const x of notes.issues) {
        x.problem = x.problem && sanitizePrompt(x.problem);
        x.fix = x.fix && sanitizePrompt(x.fix);
      }
      if (opts.learn !== false && notes.lessons?.length) {
        const added = this.addLessons(this.lastRun.opts.assetClass ?? 'generic', notes.lessons);
        if (added.length) notes.learned = added;
      }
      const review = { ...notes, sheet, thinking: null };
      this.think(
        'review',
        notes.issues.length ? `Muse found ${notes.issues.length} issue(s)` : 'Muse says it looks good',
        {
          issues: notes.issues,
          lessons: notes.lessons,
          learned: notes.learned,
        },
      );
      review.thinking = this.thinkingLog.slice(thinkStart);
      this.emit('review', review);
      this.status('idle', notes.issues.length ? `Review: ${notes.issues.length} issue(s)` : 'Review: looks good');
      return review;
    } catch (err) {
      this.fail(err, 'review');
      throw err;
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }

  /**
   * The areas painted one by one: each part, split into regions when its UV islands sit
   * in clearly separate groups (for example a torso and two sleeves). At most 12 in total;
   * the smallest parts are left whole if there are more.
   */
  /**
   * Triangles of `slot` that must keep their original pixels (see keepAreas.js), or null.
   * Vehicles: head and tail lights and tyre treads. opts.keepVehicleParts: false turns it off.
   */
  keepTriangles(slot, opts = {}) {
    if (opts.keepVehicleParts === false) return null;
    const cls = opts.assetClass && opts.assetClass !== 'auto' ? opts.assetClass : this.resolveAssetClass(opts);
    // Vehicles keep lights, glass and tyre treads; every other model keeps its glass. Both keep
    // what the user's rules say not to paint.
    const glassOnly = cls !== 'vehicle';
    const userKeep = keepTargetsFromRules(this.userRules);
    const zones =
      this.samZonesActive && this.samZones.get(slot.id)?.length
        ? this.samZones.get(slot.id)
        : (this.keepZones.get(slot.id) ?? []);
    // What each part is: Muse's own reading of the renders first (partRoles), names only
    // for parts Muse did not cover.
    const roleByName = this.partRolesFor(opts);
    const roles = new Map();
    if (roleByName)
      for (const part of slotParts(slot)) {
        const role = roleByName[roleKey(part.name)];
        if (role) for (const m of part.meshes) roles.set(m, role);
      }
    this.keepCache ??= new Map();
    const key = `${slot.id}|${cls}|${zones.length}|${roles.size}|${userKeep.map((k) => k.noun).join(',')}`;
    if (!this.keepCache.has(key)) {
      // Muse sees SAM zones as parts named "<part> (<zone>)": its roles are matched per zone.
      let zoneRoles = null;
      if (roleByName)
        for (const z of zones) {
          const role = roleByName[roleKey(z.name)] ?? roleByName[roleKey(z.zone)];
          if (role) (zoneRoles ??= {})[z.zone] = role;
        }
      const keep = vehicleKeepTriangles(slot, { zones, roles, zoneRoles, glassOnly, userKeep });
      this.think(
        'parts',
        roleByName
          ? `"${slot.name}": Muse says ${Object.entries(this.partRolesFor(opts) ?? {})
              .map(([k, v]) => `${k} = ${v}`)
              .join(', ')}`
          : `"${slot.name}": no Muse part roles yet`,
        { slotId: slot.id, slotName: slot.name, museRoles: roleByName, zoneRoles },
      );
      if (!roleByName)
        this.think(
          'note',
          `"${slot.name}": Muse gave no part roles (no suggestion yet), so SAM zones and names decide.`,
        );
      this.keepCache.set(key, keep?.none ? null : keep);
      const why = keep?.decisions ?? [];
      if (why.length || keep?.rejected?.length)
        this.think(
          'parts',
          `"${slot.name}": ${why.map((d) => `${d.name} = ${d.role} (${d.source})`).join(', ') || 'no lights or wheels'}`,
          { slotId: slot.id, slotName: slot.name, decisions: why, rejected: keep?.rejected ?? [] },
        );
      for (const r of keep?.rejected ?? []) this.think('note', `"${slot.name}": ${r.name}: ${r.reason}.`);
    }
    return this.keepCache.get(key);
  }

  /**
   * Why `slot` is never painted ('glass', 'all lights', 'kept by your rules'), or null.
   * Glass on any model; a texture that is all kept area (vehicle lights, the user's rules).
   */
  slotNeverPainted(slot, opts = {}) {
    if (opts.keepVehicleParts === false) return null;
    const roleByName = this.partRolesFor(opts);
    const roles = new Map();
    if (roleByName)
      for (const part of slotParts(slot)) {
        const role = roleByName[roleKey(part.name)];
        if (role) for (const m of part.meshes) roles.set(m, role);
      }
    if (slotIsGlass(slot, roles)) return 'glass';
    if (!slot.texture) return null;
    const keep = this.keepTriangles(slot, opts);
    if (!keep) return null;
    if (keptShare(slot, { meshes: slot.meshes }, keep.tris) < 0.98) return null;
    return keep.user && !keep.headlights
      ? 'kept by your rules'
      : keep.glass && !keep.headlights
        ? 'glass'
        : 'all lights';
  }

  /**
   * Muse's part roles ({ roleKey(part name): role }) from the suggestion or the stored
   * model analysis, or null when Muse has not looked at the model.
   */
  partRolesFor(opts = {}) {
    const src = opts.suggestion?.partRoles ?? this.modelAnalysis?.partRoles;
    if (!src) return null;
    const out = {};
    for (const [k, v] of Object.entries(src)) out[roleKey(k)] = v;
    return out;
  }

  /**
   * Puts the original pixels back inside the kept triangles (light lenses, tyre treads).
   * Kept pixels whose original color is a colored old body paint (the painted ring or housing
   * around a lens, a mirror the light finder took for a light) get the new paint found next to
   * that light, and Muse's splashes right around each light are cleaned the same way
   * (cleanAroundLights).
   * Changes `baseColor` in place.
   */
  restoreKept(slot, baseColor, original, opts) {
    const keep = this.keepTriangles(slot, opts);
    if (!keep) return null;
    const W = baseColor.width,
      H = baseColor.height;
    const layer = drawUvGuide(slot, W, H, {
      meshes: [...keep.tris.keys()],
      tris: keep.tris,
      wireframe: true,
      lineColor: '#ffffff',
      lineWidth: 1,
      fillColor: '#ffffff',
      background: null,
    });
    const ld = ctx2d(layer).getImageData(0, 0, W, H).data;
    // Only light areas can hold old body paint (a lens ring, a mirror taken for a light);
    // tyre treads are always kept whole (their rubber is the main color of a wheel texture).
    const lightLayer = keep.lights?.size
      ? ctx2d(
          drawUvGuide(slot, W, H, {
            meshes: [...keep.lights.keys()],
            tris: keep.lights,
            wireframe: true,
            lineColor: '#ffffff',
            lineWidth: 1,
            fillColor: '#ffffff',
            background: null,
          }),
        ).getImageData(0, 0, W, H).data
      : null;
    // SAM-found kept areas: any shade of the old body paint there is body (a mirror SAM took
    // for a headlight), not only the exact color.
    // SAM's windows zone: old body paint in it (a side mirror SAM took for a window) is body.
    const glassLayer = keep.samGlass?.size
      ? ctx2d(
          drawUvGuide(slot, W, H, {
            meshes: [...keep.samGlass.keys()],
            tris: keep.samGlass,
            wireframe: true,
            lineColor: '#ffffff',
            lineWidth: 1,
            fillColor: '#ffffff',
            background: null,
          }),
        ).getImageData(0, 0, W, H).data
      : null;
    const softLayer = keep.soft?.size
      ? ctx2d(
          drawUvGuide(slot, W, H, {
            meshes: [...keep.soft.keys()],
            tris: keep.soft,
            wireframe: true,
            lineColor: '#ffffff',
            lineWidth: 1,
            fillColor: '#ffffff',
            background: null,
          }),
        ).getImageData(0, 0, W, H).data
      : null;
    const od = ctx2d(resizeCanvas(original, W, H)).getImageData(0, 0, W, H).data;
    const g = ctx2d(baseColor);
    const bd = g.getImageData(0, 0, W, H);
    // The old body paint: the most common original color outside the kept areas.
    const cover = ctx2d(
      drawUvGuide(slot, W, H, { wireframe: false, fillColor: '#ffffff', background: null }),
    ).getImageData(0, 0, W, H).data;
    const body =
      opts.keepBodyColor === false || (!lightLayer && !glassLayer)
        ? null
        : dominantColor(od, (p) => cover[p * 4 + 3] >= 128 && ld[p * 4 + 3] < 128);
    const tol = opts.keepBodyTolerance ?? 64;
    // A white, silver, grey or black body can't be told from a lens (white, clear, chrome), so
    // with such a body every pixel inside a light keeps its original. A colored body (the red
    // Porsche) can: its old paint inside a light area (lens ring, mirror) gets the new paint.
    const colorful = isColorful(body);
    const lum = body ? 0.299 * body[0] + 0.587 * body[1] + 0.114 * body[2] : 0;
    const isBody = (i) => {
      if (!body) return false;
      const r = od[i],
        gg = od[i + 1],
        b = od[i + 2];
      if (lightLayer?.[i + 3] >= 128)
        return (
          colorful && (softLayer?.[i + 3] >= 128 ? sameShade(r, gg, b, body, tol) : nearColor(r, gg, b, body, tol))
        );
      if (glassLayer?.[i + 3] >= 128)
        // SAM's windows zone keeps only what looks like glass (dark, grey, blue-grey). Strong
        // color (an orange van panel, a red mirror) or the old body paint is body.
        return (
          !looksLikeGlass(r, gg, b) ||
          (colorful && sameStrongShade(r, gg, b, body, tol)) ||
          (!colorful && lum > 140 && nearColor(r, gg, b, body, 40))
        );
      return false;
    };
    const before = new Uint8ClampedArray(bd.data);
    let n = 0;
    for (let i = 0; i < ld.length; i += 4) {
      if (ld[i + 3] < 128) continue;
      n++;
      bd.data[i] = od[i];
      bd.data[i + 1] = od[i + 1];
      bd.data[i + 2] = od[i + 2];
    }
    // Around and inside each light: Muse's splashes and rings, and old body paint, get the new
    // paint found right next to that light.
    let repainted = 0,
      cleaned = 0;
    if (body && (lightLayer || glassLayer) && opts.cleanAroundLights !== false) {
      const N = W * H;
      const ringFrom = new Uint8Array(N);
      const light = new Uint8Array(N),
        kept = new Uint8Array(N),
        inUv = new Uint8Array(N);
      for (let p = 0; p < N; p++) {
        ringFrom[p] = lightLayer?.[p * 4 + 3] >= 128 ? 1 : 0;
        light[p] = ringFrom[p] || glassLayer?.[p * 4 + 3] >= 128 ? 1 : 0;
        kept[p] = ld[p * 4 + 3] >= 128 ? 1 : 0;
        inUv[p] = cover[p * 4 + 3] >= 128 ? 1 : 0;
      }
      // For a light that is its own UV island (nothing painted next to it in the texture),
      // its old body paint gets a swatch of the new body paint instead.
      let fallback = null;
      // Old body paint Muse left untouched (a side mirror kept red on a black car): when the new
      // body paint is not a shade of the old one, it gets the new body paint too.
      let leftover = null;
      if (colorful && opts.cleanOldBodyPaint !== false && !this.locked.size) {
        const newBody = dominantColor(before, (p) => inUv[p] && !kept[p]);
        if (newBody && !sameShade(newBody[0], newBody[1], newBody[2], body, tol)) {
          leftover = new Uint8Array(N);
          let any = 0;
          for (let p = 0; p < N; p++) {
            if (!inUv[p] || kept[p]) continue;
            const i = p * 4;
            if (!sameShade(od[i], od[i + 1], od[i + 2], body, tol)) continue;
            const d =
              Math.abs(before[i] - od[i]) + Math.abs(before[i + 1] - od[i + 1]) + Math.abs(before[i + 2] - od[i + 2]);
            if (d <= 30) leftover[p] = any = 1;
          }
          if (!any) leftover = null;
        }
      }
      if (colorful || glassLayer) {
        const on = new Uint8Array(N);
        const old = colorful ? sameShade : nearColor;
        for (let p = 0; p < N; p++)
          on[p] = inUv[p] && !kept[p] && old(od[p * 4], od[p * 4 + 1], od[p * 4 + 2], body, tol) ? 1 : 0;
        const sq = bestSquare(on, W, H, Math.round(Math.min(W, H) / 10));
        if (sq.share > 0.5) {
          const swatch = cropCanvas(baseColor, { x: sq.x, y: sq.y, width: sq.size, height: sq.size });
          const mask = createCanvas(W, H);
          const mctx = ctx2d(mask);
          const md = mctx.createImageData(W, H);
          for (let i = 0; i < ld.length; i += 4)
            if ((ld[i + 3] >= 128 && isBody(i)) || leftover?.[i / 4])
              md.data[i] = md.data[i + 1] = md.data[i + 2] = md.data[i + 3] = 255;
          mctx.putImageData(md, 0, 0);
          fallback = ctx2d(materialFill(resizeCanvas(original, W, H), mask, swatch, { tile: sq.size })).getImageData(
            0,
            0,
            W,
            H,
          ).data;
        }
      }
      const r = cleanAroundLights({
        fallback,
        W,
        H,
        painted: bd.data,
        before,
        orig: od,
        light,
        ringFrom,
        kept,
        cover: inUv,
        body,
        bodyInside: isBody,
        bodyAround: (i) =>
          colorful
            ? sameShade(od[i], od[i + 1], od[i + 2], body, tol)
            : nearColor(od[i], od[i + 1], od[i + 2], body, tol),
        ring: opts.lightRing,
        oldBody: colorful ? (r, gg, b) => sameShade(r, gg, b, body, tol) : null,
      });
      repainted = r.inside;
      cleaned = r.around;
      n -= r.inside;
      if (leftover && fallback) {
        let left = 0;
        for (let p = 0; p < N; p++) {
          if (!leftover[p]) continue;
          const i = p * 4;
          bd.data[i] = fallback[i];
          bd.data[i + 1] = fallback[i + 1];
          bd.data[i + 2] = fallback[i + 2];
          left++;
        }
        this.think('kept', `"${slot.name}": ${left} pixel(s) of old body paint left by Muse got the new body paint`, {
          slotId: slot.id,
          leftOldBodyPaint: left,
        });
      }
    }
    g.putImageData(bd, 0, 0);
    let covered = 0;
    for (let i = 3; i < cover.length; i += 4) if (cover[i] >= 128) covered++;
    const keptShareOfTexture = covered ? n / covered : 0;
    const isWheel = slot.meshes.some((m) => WHEEL_NAME.test(namesOf(m)));
    if (keptShareOfTexture > 0.4 && !isWheel && !this.keepNoted?.has(`${slot.id}|big`)) {
      (this.keepNoted ??= new Set()).add(`${slot.id}|big`);
      this.emit('warning', {
        message: `"${slot.name}": ${Math.round(keptShareOfTexture * 100)}% of this texture is kept as lights or tyre treads. If this is not a wheel, check the part names (or pass keepVehicleParts: false).`,
      });
    }
    this.think('kept', `"${slot.name}": kept ${n} original pixel(s) of lights and tyre treads`, {
      slotId: slot.id,
      slotName: slot.name,
      lightTriangles: keep.headlights,
      treadTriangles: keep.treads,
      keptPixels: n,
      bodyColorRepaintedPixels: repainted,
      cleanedAroundLights: cleaned,
      oldBodyColor: body ? body.map(Math.round) : null,
      share: keptShareOfTexture,
    });
    this.keepNoted ??= new Set();
    if (n && !this.keepNoted.has(slot.id)) {
      this.keepNoted.add(slot.id);
      const what = [keep.headlights ? 'lights' : '', keep.glass ? 'glass' : '', keep.treads ? 'tyre treads' : '']
        .filter(Boolean)
        .join(', ');
      const extra = repainted ? ' Old body color around them was painted like the body.' : '';
      this.emit('warning', {
        message: `"${slot.name}": kept the original ${what} (vehicle rule: never repainted).${extra}`,
      });
    }
    return ld;
  }

  /**
   * Share of each painted area (or the whole texture in one-pass mode) whose final pixels
   * still match the original, leaving out kept pixels. Over `opts.unpaintedLimit` (0.3) the
   * area is flagged: a warning, a 'check' thinking entry, and `job.unpainted` for the review.
   */
  checkUnpainted(slot, baseColor, original, partJobs, keptAlpha, opts = {}) {
    const W = baseColor.width,
      H = baseColor.height;
    const limit = opts.unpaintedLimit ?? 0.3;
    const od = ctx2d(resizeCanvas(original, W, H)).getImageData(0, 0, W, H).data;
    const bd = ctx2d(baseColor).getImageData(0, 0, W, H).data;
    const areas = partJobs
      ? partJobs.jobs
          .filter((j) => !j.keep && !j.reuse && j.mask)
          .map((j) => ({ name: j.part.name, job: j, mask: j.mask }))
      : [
          {
            name: slot.name,
            mask: drawUvGuide(slot, W, H, { wireframe: false, fillColor: '#ffffff', background: null }),
          },
        ];
    const flagged = [];
    for (const a of areas) {
      const m = a.mask.width === W && a.mask.height === H ? a.mask : resizeCanvas(a.mask, W, H);
      const md = ctx2d(m).getImageData(0, 0, W, H).data;
      let all = 0,
        same = 0;
      for (let i = 0; i < md.length; i += 4) {
        if (md[i + 3] < 128 || keptAlpha?.[i + 3] >= 128) continue;
        all++;
        if (Math.abs(bd[i] - od[i]) + Math.abs(bd[i + 1] - od[i + 1]) + Math.abs(bd[i + 2] - od[i + 2]) < 30) same++;
      }
      if (all < 64) continue;
      const share = same / all;
      if (a.job) a.job.unpainted = share;
      // Glass stays glass and tyres stay rubber by the class rules, so they may look unchanged.
      const mayStay = /\b(windows?|glass|windshield|windscreen|tyres?|tires?|wheels?)\b/i.test(
        `${a.job?.part.zone ?? ''} ${a.name.replace(/[_\-.\d]+/g, ' ')}`,
      );
      if (share > limit && !mayStay) flagged.push({ area: a.name, share });
    }
    (this.unpaintedBySlot ??= new Map()).set(slot.id, flagged);
    for (const f of flagged) {
      const pct = Math.round(f.share * 100);
      this.emit('warning', { message: `"${slot.name}": ${pct}% of "${f.area}" still shows the original texture.` });
    }
    this.think(
      'check',
      flagged.length
        ? `"${slot.name}": ${flagged.map((f) => `${f.area} ${Math.round(f.share * 100)}% unpainted`).join(', ')}`
        : `"${slot.name}": every planned area is painted`,
      { slotId: slot.id, slotName: slot.name, unpainted: flagged, limit },
    );
    return flagged;
  }

  /**
   * One simple roofing surface for `theme` (asphalt, shingles, thatch…, picked by Muse to
   * fit it), as a seamless canvas. Cached per slot and theme, so variations share it.
   */
  async roofTexture(slot, theme, areaTheme, signal) {
    this.roofCache ??= new Map();
    const key = `${slot.id}|${theme}|${areaTheme ?? ''}`;
    if (!this.roofCache.has(key)) {
      const p = this.withFilterRetry('paint roof', slot, theme, (plain, t) =>
        this.provider.generateTexture({
          theme: plain
            ? `simple roofing for "${t}"`
            : areaTheme
              ? `${areaTheme} (theme: "${t}")`
              : `roofing for "${t}"`,
          materialName: 'roof covering seen from straight above',
          extraInstructions: `Choose ${ROOF_SURFACE} Fill the whole image evenly.`,
          width: 512,
          height: 512,
          signal,
        }),
      ).then((img) => this.toCanvas(img));
      p.catch(() => this.roofCache.delete(key));
      this.roofCache.set(key, p);
    }
    return this.roofCache.get(key);
  }

  /**
   * Fast (one pass) mode for buildings: the single atlas image paints walls everywhere, so
   * afterwards the roof gets the simple roofing surface and the underside its flat color,
   * the same as part-by-part mode. Changes `baseColor` in place.
   */
  async fillTopBottom(slot, baseColor, original, theme, opts, signal) {
    const regions = this.idRegions(slot, opts).filter((r) => r.zone === 'roof' || r.zone === 'underside');
    if (!regions.length) return;
    const W = baseColor.width,
      H = baseColor.height;
    const orig = original ? resizeCanvas(original, W, H) : baseColor;
    const g = ctx2d(baseColor);
    for (const r of regions) {
      const layer = partLayer(slot, { ...r, hex: '#ffffff' }, W, H);
      const ld = ctx2d(layer).getImageData(0, 0, W, H);
      const mask = createCanvas(W, H);
      const md = ctx2d(mask).createImageData(W, H);
      let x0 = W,
        y0 = H,
        x1 = -1,
        y1 = -1;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const on = ld.data[i + 3] >= 128;
          md.data[i] = md.data[i + 1] = md.data[i + 2] = on ? 255 : 0;
          md.data[i + 3] = 255;
          if (on) {
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x);
            y1 = Math.max(y1, y);
          }
        }
      if (x1 < 0) continue;
      ctx2d(mask).putImageData(md, 0, 0);
      let filled;
      if (r.zone === 'underside') {
        if (opts.undersideColor === null) continue;
        filled = createCanvas(W, H);
        const fg = ctx2d(filled);
        fg.fillStyle = opts.undersideColor ?? '#000000';
        fg.fillRect(0, 0, W, H);
      } else {
        if (opts.roofAsMaterial === false || !this.provider.generateTexture) continue;
        const tex = await this.roofTexture(slot, theme, null, signal);
        signal.throwIfAborted();
        filled = materialFill(orig, mask, tex, {
          tile: roofTile({ width: x1 - x0 + 1, height: y1 - y0 + 1 }),
          shade: 'dark',
        });
      }
      // Paste the filled pixels inside the mask only.
      const fd = ctx2d(filled).getImageData(0, 0, W, H).data;
      const bd = g.getImageData(0, 0, W, H);
      for (let i = 0; i < bd.data.length; i += 4) {
        if (md.data[i] < 128) continue;
        bd.data[i] = fd[i];
        bd.data[i + 1] = fd[i + 1];
        bd.data[i + 2] = fd[i + 2];
      }
      g.putImageData(bd, 0, 0);
      this.emit('warning', {
        message: `"${slot.name}": ${r.zone === 'roof' ? 'roof painted as one simple roofing surface' : 'underside filled with a flat color'} (one-pass mode).`,
      });
    }
  }

  /**
   * Roof / underside pieces of a part (see splitTopBottom). A piece that shares its texture
   * space with the walls (overlapping UVs) can't be painted on its own and stays with them.
   */
  topBottomPieces(slot, part, names) {
    const tb = splitTopBottom(slot, part, { names });
    if (!tb) return null;
    this.topBottomNoted ??= new Set();
    if (!this.topBottomNoted.has(slot.id)) {
      this.topBottomNoted.add(slot.id);
      this.emit('warning', {
        message: `"${slot.name}": treated as a building, so its top is painted as a simple roof and its underside flat black. If it is not a building, pick another asset type in the options.`,
      });
    }
    const S = 256;
    const restLayer = partLayer(slot, tb.rest, S, S);
    const rd = ctx2d(restLayer).getImageData(0, 0, S, S).data;
    for (const k of ['top', 'bottom']) {
      const piece = tb[k];
      if (!piece) continue;
      const d = ctx2d(partLayer(slot, piece, S, S)).getImageData(0, 0, S, S).data;
      let on = 0,
        shared = 0;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] < 128) continue;
        on++;
        if (rd[i] >= 128) shared++;
      }
      if (on && shared / on > 0.3) {
        this.emit('warning', {
          message: `"${slot.name}": the ${piece.region} uses the same part of the texture as the walls (${Math.round((100 * shared) / on)}% shared), so it is painted with them.`,
        });
        for (const [mesh, arr] of piece.tris) {
          const r = tb.rest.tris.get(mesh) ?? new Uint8Array(arr.length);
          for (let t = 0; t < arr.length; t++) if (arr[t]) r[t] = 1;
          tb.rest.tris.set(mesh, r);
          if (!tb.rest.meshes.includes(mesh)) tb.rest.meshes.push(mesh);
        }
        tb[k] = null;
      }
    }
    return tb.top || tb.bottom ? tb : null;
  }

  paintRegions(slot, parts, opts = {}) {
    if (opts.splitRegions === false) return parts;
    // Vehicles: every body panel (doors, fenders, hood, bumpers…) is painted as one area, so
    // stripes and lines carry across the doors instead of each panel getting its own design.
    if (opts.assetClass === 'vehicle' && opts.mergeBodyPanels !== false) {
      const merged = mergeBodyPanels(parts, this.partRolesFor(opts));
      if (merged) {
        const [body, ...rest] = merged;
        return [body, ...this.paintRegions(slot, rest, { ...opts, mergeBodyPanels: false })];
      }
    }
    const max = opts.maxPaintAreas ?? 12;
    const out = [];
    let left = max;
    parts.forEach((p, i) => {
      const remainingParts = parts.length - i - 1;
      let split = [p];
      if (left - remainingParts > 1) {
        // Characters: body zones (head → face / hair, hands) from the 3D shape first.
        const zones = opts.assetClass === 'avatar' ? splitAvatarZones(slot, p, this.anatomy()) : [p];
        // Avatars keep each mesh whole apart from those zones (legs stay one "pants" area).
        if (zones.length > 1 || opts.assetClass === 'avatar') split = zones;
        else if (opts.assetClass === 'vehicle' && isBodyPanel(p.name)) {
          // A vehicle's body stays one area even when its doors are separate UV islands, so
          // stripes are painted across all of it in one image.
          split = [p];
        } else {
          // Buildings: roofs and undersides are their own areas, so they are never painted
          // as walls (windows and doors on the roof, a facade on the underside).
          const tb = getAssetClass(opts.assetClass)?.topBottom
            ? this.topBottomPieces(slot, p, getAssetClass(opts.assetClass).topBottom)
            : null;
          split = tb
            ? [...splitPartRegions(slot, tb.rest), ...[tb.top, tb.bottom].filter(Boolean)]
            : splitPartRegions(slot, p);
        }
      }
      const take = split.length <= left - remainingParts ? split : [p];
      out.push(...take);
      left -= take.length;
    });
    return out.slice(0, max);
  }

  async withFilterRetry(step, slot, theme, call) {
    try {
      return await this.timed(step, slot.id, () => call(false, theme));
    } catch (err) {
      if (!isContentPolicyError(err)) throw err;
      const softer = softenTheme(theme);
      this.emit('warning', {
        message: `Muse's safety filter rejected the "${step}" request for "${slot.name}". Retrying with a plainer prompt (no style image; for areas, only that area's own theme).`,
      });
      try {
        return await this.timed(`${step} (plain retry)`, slot.id, () => call(true, softer));
      } catch (err2) {
        if (isContentPolicyError(err2)) {
          const e = new Error(
            `Muse's safety filter rejected the theme "${theme}" (${step}, also after a plainer retry). Try rewording it: gentler words usually pass (e.g. "spooky" instead of "scary", no blood or weapons).`,
          );
          e.code = 'content_policy_violation';
          e.step = step;
          throw e;
        }
        throw err2;
      }
    }
  }

  /** Runs one provider call and emits a `timing` event with how long it took. */
  /**
   * SAM 3.1 check of one painted crop against the original crop. Returns the hits the paint
   * added, [] if clean, or null if SAM could not be reached (the check is then turned off
   * for the rest of the run, with one warning).
   */
  async samFind(slot, areaName, painted, original, guide, rules, signal) {
    if (this.samOff || !this.provider.segment) return null;
    try {
      return await this.timed(`sam ${areaName}`, slot.id, () =>
        findIntrusions({
          segment: (o) => this.provider.segment(o),
          painted,
          original,
          guide,
          rules,
          cache: this.samCache,
          cacheKey: `${slot.id}|${areaName}`,
          signal,
        }),
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      if (!this.samOff) {
        this.samOff = true;
        this.emit('warning', {
          message: `SAM 3.1 check turned off for this run (${toError(err).message}); painting continues without it.`,
        });
      }
      return null;
    }
  }

  async timed(step, slotId, fn) {
    const t0 = performance.now();
    let ok = false;
    let error = null;
    try {
      const out = await fn();
      ok = true;
      return out;
    } catch (err) {
      if (err && typeof err === 'object' && !err.step) err.step = step;
      error = err;
      throw err;
    } finally {
      const slot = slotId ? this.layout?.slots.find((s) => s.id === slotId) : null;
      this.emit('timing', {
        step,
        slotId,
        slotName: slot?.name,
        ms: performance.now() - t0,
        ok,
        error: error ? String(error.message ?? error) : undefined,
        provider: this.provider.name,
      });
    }
  }

  guard() {
    if (this.busy) throw new Error('The plugin is busy with another request');
  }

  fail(err, stage) {
    const e = toError(err);
    this.emit('error', { error: e, stage });
    this.status('error', e.name === 'AbortError' ? 'Cancelled' : e.message);
  }

  requireSlot(id) {
    const slot = this.layout?.slots.find((s) => s.id === id);
    if (!slot) throw new Error(`Unknown slot ${id}`);
    return slot;
  }

  snapshot(mat) {
    if (this.snapshots.has(mat)) return;
    this.snapshots.set(mat, readMaterial(mat));
  }

  /** Puts the original maps back on all reskinned materials (or only on `only`). */
  restoreSnapshots(only = null) {
    for (const [mat, s] of this.snapshots) {
      if (only && !only.includes(mat)) continue;
      delete mat.userData.__reskin;
      writeMaterial(mat, s);
      mat.needsUpdate = true;
    }
  }

  async toCanvas(img) {
    return img instanceof Blob ? blobToCanvas(img) : img;
  }

  makeTexture(canvas, like, colorSpace, channel, repeat) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = false; // glTF convention
    tex.colorSpace = colorSpace;
    tex.channel = channel;
    if (like) {
      tex.wrapS = like.wrapS;
      tex.wrapT = like.wrapT;
      tex.magFilter = like.magFilter;
      tex.minFilter = like.minFilter;
      tex.offset.copy(like.offset);
      tex.repeat.copy(like.repeat);
      tex.rotation = like.rotation;
      tex.center.copy(like.center);
    }
    if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    tex.name = `${like?.name || 'reskin'}_${colorSpace === THREE.SRGBColorSpace ? 'baseColor' : 'data'}`;
    tex.userData.mimeType = 'image/png';
    tex.needsUpdate = true;
    return tex;
  }
}

/** Extra instruction that makes each variation look different. */
export function variationNote(index, count) {
  if (count <= 1 || index === 0) return '';
  const styles = [
    '',
    'Variation 2: use a clearly different color palette and different motifs from the obvious choice.',
    'Variation 3: a bolder, more stylized take with a contrasting accent color.',
    'Variation 4: a subtle, muted take with fine detail.',
  ];
  return styles[index] ?? `Variation ${index + 1}: a different palette and motifs.`;
}

/** Fixed ID colors for character body zones (as Kris asked: one unique color each). */
export const ZONE_COLORS = {
  face: 'red',
  head: 'red',
  hair: 'blue',
  legs: 'green',
  torso: 'yellow',
  hands: 'purple',
  shoes: 'aqua',
  arms: 'pink',
};

/** Material maps written out by postExportTextures, with their file name suffix. */
const EXPORT_MAPS = [
  ['map', 'baseColor'],
  ['normalMap', 'normal'],
  ['roughnessMap', 'roughness'],
  ['metalnessMap', 'metalness'],
  ['emissiveMap', 'emissive'],
  ['aoMap', 'occlusion'],
];

/** Every distinct texture on the scene's materials as a PNG: [{ name, data: Uint8Array }]. */
async function collectTexturePngs(scene) {
  const seen = new Map(); // texture (or its image) -> file
  const names = new Set();
  const files = [];
  const mats = [];
  scene.traverse((o) => {
    if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) mats.push(m);
  });
  for (const m of mats) {
    for (const [key, suffix] of EXPORT_MAPS) {
      const tex = m[key];
      const img = tex?.image;
      if (!img || !(img.width > 0) || seen.has(img)) continue;
      // roughnessMap and metalnessMap are often one packed texture: write it once.
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      if (!blob) continue;
      let name = `${fileSafe(m.name || 'material')}_${suffix}`;
      for (let i = 2; names.has(name); i++) name = `${fileSafe(m.name || 'material')}_${suffix}_${i}`;
      names.add(name);
      const file = { name: `${name}.png`, data: new Uint8Array(await blob.arrayBuffer()) };
      seen.set(img, file);
      files.push(file);
    }
  }
  return files;
}

function fileSafe(s) {
  return (
    String(s)
      .replace(/[^\w.-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'material'
  );
}

export function slug(s) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'reskin'
  );
}

/** Parts of a vehicle that are not body paint (they keep their own areas). */
const NOT_BODY_PANEL =
  /\b(wheels?|tires?|tyres?|rims?|hubcaps?|treads?|lights?|lamps?|headlights?|taillights?|glass|windows?|windshield|windscreen|interior|seats?|steering|dashboard|engine|exhaust|grille|mirror glass|chrome)\b/i;

/**
 * Vehicles: all body-panel parts merged into one "Body panels" part (first), the others
 * after it. null when there are fewer than two body panels.
 */
const isBodyPanel = (name) =>
  !NOT_BODY_PANEL.test(
    String(name)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_\-.\d]+/g, ' '),
  );

/** Key for matching a part name to Muse's partRoles: lowercase, separators as spaces. */
export function roleKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[_.\-\s]+/g, ' ')
    .trim();
}

export function mergeBodyPanels(parts, roles = null) {
  // Muse's role for a part wins; the name is the fallback.
  const BODY_ROLES = new Set(['body', 'trim']);
  const isPanel = (p) => {
    const role = roles?.[roleKey(p.name)];
    return role ? BODY_ROLES.has(role) : isBodyPanel(p.name);
  };
  const panels = parts.filter(isPanel);
  if (panels.length < 2) return null;
  const others = parts.filter((p) => !panels.includes(p));
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of panels)
    for (let k = 0; k < 4; k++) box[k] = k < 2 ? Math.min(box[k], p.bbox[k]) : Math.max(box[k], p.bbox[k]);
  const biggest = [...panels].sort((a, b) => b.area - a.area)[0];
  const body = {
    ...biggest,
    name: 'Body panels',
    meshes: panels.flatMap((p) => p.meshes),
    bbox: box,
    area: panels.reduce((sum, p) => sum + (p.area ?? 0), 0),
    mergedFrom: panels.map((p) => p.name),
  };
  return [body, ...others];
}

/** Roof material tile size: about a fifth of the roof, so shingles and tiles stay small. */
function roofTile(c) {
  return Math.max(48, Math.round(Math.max(c.width, c.height) / 5));
}

/**
 * Which edges of a standalone texture must join: 'both' | 'x' | 'y' | 'none' | 'equirect'.
 * Explicit `wrap` wins (true = 'both', 'sky' = 'equirect'); else a sky is an equirect
 * panorama, a seamless class (terrain, tiling material) tiles both ways, and otherwise the
 * source decides: an axis that already wraps keeps wrapping.
 */
export function resolveWrap(wrap, assetClass, source) {
  if (wrap === true) return 'both';
  if (wrap === false) return 'none';
  if (wrap === 'sky' || wrap === 'equirect') return 'equirect';
  if (['both', 'x', 'y', 'none'].includes(wrap)) return wrap;
  if (assetClass === 'sky') return 'equirect';
  if (getAssetClass(assetClass)?.seamless) return 'both';
  if (!source) return 'both';
  const s = canvasSeams(source);
  const x = s.x < 2,
    y = s.y < 2;
  return x && y ? 'both' : x ? 'x' : y ? 'y' : 'none';
}

function toError(err) {
  return err instanceof Error ? err : new Error(String(err));
}

function safeCall(cb, d) {
  try {
    cb(d);
  } catch (e) {
    console.error('[ReskinPlugin] listener error', e);
  }
}

function anySignal(signals) {
  const anyFn = AbortSignal.any;
  if (anyFn) return anyFn(signals);
  const ctrl = new AbortController();
  for (const s of signals) s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  return ctrl.signal;
}

/** Bounding-sphere radius of one object or a list of objects (world space). */
function boundingRadius(objs) {
  const box = new THREE.Box3();
  for (const o of Array.isArray(objs) ? objs : [objs]) box.expandByObject(o);
  return box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length() / 2;
}

/** Word swaps that keep the look but avoid phrases image safety filters commonly reject. */
const SAFE_WORDING = [
  [/\bblood[- ]red\b/gi, 'crimson'],
  [/\bblood[- ]?(stained|soaked|spattered|splattered)\b/gi, 'paint-splattered'],
  [/\bdripping blood\b/gi, 'dripping red paint'],
  [/\bblood\b/gi, 'red paint'],
  [/\bbloody\b/gi, 'crimson'],
  [/\b(gore|gory|guts|entrails)\b/gi, 'messy paint'],
  [/\b(wounds?|gashes|gash|injur(y|ies))\b/gi, 'cracks'],
  [/\beye sockets\b/gi, 'eye makeup'],
  [/\b(corpse|cadaver)\b/gi, 'ghost'],
  [/\b(severed|mutilated|decapitated)\b/gi, 'patchwork'],
];

/** Rewrites generated prompt text to avoid common safety-filter triggers. */
export function sanitizePrompt(text) {
  let t = String(text ?? '');
  for (const [re, word] of SAFE_WORDING) t = t.replace(re, word);
  return t;
}

const SOFTEN = [
  [
    /\b(scary|creepy|horror|horrifying|terrifying|frightening|evil|sinister|menacing|demonic|nightmare\w*)\b/gi,
    'spooky',
  ],
  [/\b(blood\w*|gor(e|y)|guts)\b/gi, 'red paint'],
  [/\b(dead|death|zombie|corpse|undead|skull\w*)\b/gi, 'ghostly'],
  [/\b(kill\w*|murder\w*|weapon\w*|gun\w*|knife|knives|violent|violence)\b/gi, 'bold'],
];

/** Tones a theme down for a retry after a content-filter rejection ("scary clown" -> "spooky clown, playful Halloween style"). */
export function softenTheme(theme) {
  let t = theme;
  for (const [re, word] of SOFTEN) t = t.replace(re, word);
  t = t.replace(/\b(\w+)( \1\b)+/gi, '$1').trim();
  return t === theme ? `${theme}, playful cartoon style` : `${t}, playful Halloween style`;
}
