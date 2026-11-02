import * as THREE from 'three';
import { analyzeTextureLayout, summarizeLayout } from './analysis/textureLayout.js';
import { generateBoxUvs } from './analysis/uvGenerate.js';
import { REVIEW_VIEWS, renderAxisViews, stackCanvases } from './analysis/renderViews.js';
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
  whiteMask,
} from './analysis/facing.js';
import { avatarAnatomy, splitAvatarZones } from './analysis/anatomy.js';
import { assetClassRules, detectAssetClass, getAssetClass, normalizeAssetClass } from './assetClasses.js';
import { exportGLB, loadModel } from './io/modelIO.js';
import { MuseProvider } from './providers/MuseProvider.js';
import { isContentPolicyError } from './muse/MuseClient.js';
import { addUsage, emptyUsage, formatUsage, usageCost } from './muse/pricing.js';
import {
  applyDetailPreserve,
  accentColor,
  averageColor,
  blobToCanvas,
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
} from './texture/imageUtils.js';
import { deriveNormalMap, deriveRoughnessMap } from './texture/pbrMaps.js';
import { flattenTinyIslands, islandIdMap, keepSkinSwatches, padIslands } from './texture/islandPost.js';
import { paintHairStrands } from './texture/strands.js';
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
export class ReskinPlugin {
  provider;
  listeners = new Map();
  anyListeners = new Set();
  snapshots = new Map();
  /** Layout readings per texture, reused across prompts (the layout doesn't depend on the theme). */
  planCache = new Map();
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
    for (const cb of this.listeners.get(type) ?? []) safeCall(cb, data);
    for (const cb of this.anyListeners) safeCall(cb, { type, data });
  }

  status(state, message) {
    this.emit('status', { state, message });
  }

  // ---------------------------------------------------------------- config

  setProvider(provider) {
    this.provider = provider;
    // Surface every raw model request (images shortened) as a `request` event, for debugging.
    if (provider?.client && 'onExchange' in provider.client) {
      provider.client.onExchange = (info) => this.emit('request', info);
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
  }

  // ---------------------------------------------------------------- post: model

  /**
   * Load a model (File(s), Blob, ArrayBuffer or URL), analyze it and make it the current model.
   * @param {import('./io/modelIO.js').ModelInput} input
   * @param {import('./io/modelIO.js').LoadOptions} [opts]
   * @returns {Promise<{ model: LoadedModel, layout: TextureLayout }>}
   */
  async postModel(input, opts = {}) {
    this.guard();
    this.busy = true;
    try {
      this.status('loading', 'Loading model…');
      const model = await loadModel(input, opts);
      this.model = model;
      this.snapshots.clear();
      this.planCache.clear();
      this.suggestionCache.clear();
      this.modelAnalysis = null;
      this.lastPartJobs.clear();
      this.regionCache.clear();
      this.locked.clear();
      this.areaClass = undefined;
      this.anatomyCache = undefined;
      this.idMapSaved = null;
      this.history = [];
      this.historyIndex = -1;
      this.lastResult = null;
      this.status('analyzing', 'Analyzing texture layout…');
      const layout = this.analyze();
      for (const w of layout.warnings) this.emit('warning', { message: w });
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
    const cached = this.suggestionCache.get(`${theme}|${JSON.stringify(opts.orientation ?? 'auto')}`);
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
        if (!raw.atlases?.length) raw.atlases = an.atlases;
      } else {
        this.restoreSnapshots(); // study the original look
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
      this.suggestionCache.set(`${theme}|${JSON.stringify(opts.orientation ?? 'auto')}`, suggestion);
      this.emit('progress', { stage: 'plan', message: 'Suggestion ready', progress: 1 });
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

    try {
      if (opts.fast !== undefined) this.provider.setFast?.(opts.fast);
      this.status('reskinning', `Reskinning with "${theme}" via ${this.provider.name}…`);
      // Start from the original look every time, so prompts don't compound.
      this.restoreSnapshots();
      this.variantJobs = [];

      opts = { ...opts, assetClass: this.resolveAssetClass(opts) };
      this.areaClass = opts.assetClass;
      this.emit('assetClass', { id: opts.assetClass, label: getAssetClass(opts.assetClass)?.label });

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

      const remote = this.layout.slots.filter((s) => wanted(s) && !localIds.has(s.id));
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
          this.emit('warning', { message: `Slot "${remote[i].name}" failed: ${e.message}` });
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
        durationMs: performance.now() - started,
        variations: entries.map(({ id, variant, thumb }) => ({ id, variant, thumb })),
        usage: this.getUsage(),
      };
      this.lastResult = result;
      this.lastPrompt = theme;
      const { signal: _s, fixes: _f, ...runOpts } = opts;
      this.lastRun = { theme, opts: runOpts };
      this.emit('progress', { stage: 'done', message: 'Done', progress: 1 });
      this.emit('reskinned', result);
      this.status(
        'idle',
        `Reskinned ${results.length} texture(s) in ${(result.durationMs / 1000).toFixed(1)}s` +
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
    const { width, height } = slot.texture
      ? fitSize(slot.width, slot.height, maxSize)
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
              : drawUvGuide(slot, original.width, original.height, { lineWidth: Math.max(1, original.width / 1024) });
          const uvGuide = transformCanvas(guide, orient);
          const sendAtlas = transformCanvas(original, orient);
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
              plan = await this.timed('read layout', slot.id, () =>
                this.provider.planLayout({
                  slotName: slot.name,
                  meshNames: slot.meshes.map((m) => m.name),
                  atlas: sendAtlas,
                  atlasWithUvs: transformCanvas(drawAtlasWithUvs(original, slot), orient),
                  signal,
                }),
              );
              if (plan) this.planCache.set(planKey, plan);
            } catch (err) {
              if (signal.aborted) throw err;
              this.emit('warning', { message: `Layout planning skipped: ${toError(err).message}` });
            }
            this.emit('plan', { slotId: slot.id, plan });
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
                      opts.extraInstructions,
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
    const ctx = { orient, width, height, atlasMode, original, theme, maxSize, signal, report, plan, usedPrompt, opts };
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
    let raw = ctx.raw;
    const maps = []; // generated maps of this result, kept with it in the history
    const emitMap = (kind, canvas) => {
      maps.push({ slotId: slot.id, kind, canvas });
      this.emit('textureUpdated', { slotId: slot.id, kind, canvas });
    };
    signal.throwIfAborted();
    // Undo the upright transform so the texture matches the model's UVs again.
    if (orient && !isIdentity(orient)) raw = untransformCanvas(raw, orient);

    report(0.7, 'postprocess', `Post-processing "${slot.name}"`);
    let baseColor = resizeCanvas(raw, width, height); // always a fresh copy; `raw` stays as returned
    const islandMap = atlasMode ? islandIdMap(slot, width, height) : null;
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
    if (islandMap && (opts.edgePadding ?? 12) > 0) {
      // Edge padding: grow island colors into the gaps so seams never sample dark pixels.
      padIslands(baseColor, islandMap, Math.max(1, Math.round(((opts.edgePadding ?? 12) * width) / 1024)));
    }

    report(0.8, 'apply', `Applying "${slot.name}"`);
    const baseTex = this.makeTexture(baseColor, slot.texture, THREE.SRGBColorSpace, slot.uvChannel, !atlasMode);
    for (const mat of slot.materials) {
      this.snapshot(mat);
      mat.map = baseTex;
      mat.color.set(0xffffff);
      mat.needsUpdate = true;
    }
    emitMap('baseColor', baseColor);

    // ---- normal maps
    if (opts.normalMaps ?? true) {
      report(0.85, 'postprocess', `Normal map for "${slot.name}"`);
      const cache = new Map();
      for (const mat of slot.materials) {
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
          emitMap('normal', canvas);
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
          emitMap('roughness', canvas);
        }
        const packed = snap.metalnessMap && snap.metalnessMap === snap.roughnessMap;
        mat.roughnessMap = tex;
        if (packed) mat.metalnessMap = tex;
        if (!src) mat.roughness = 1; // the map now carries the value
        mat.needsUpdate = true;
      }
    }

    report(1, 'apply', `Finished "${slot.name}"`);
    return { slotId: slot.id, canvas: baseColor, raw, plan, prompt: usedPrompt, maps };
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
      const cur = (mat.userData.__reskin ??= {
        map: mat.map,
        normalMap: mat.normalMap,
        roughnessMap: mat.roughnessMap,
        metalnessMap: mat.metalnessMap,
        color: mat.color.clone(),
        roughness: mat.roughness,
      });
      const s = show ? snap : cur;
      mat.map = s.map;
      mat.normalMap = s.normalMap;
      mat.roughnessMap = s.roughnessMap;
      mat.metalnessMap = s.metalnessMap;
      mat.color.copy(s.color);
      mat.roughness = s.roughness;
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
   * Caller-supplied profile for a family of models (e.g. a game's avatars): artists'
   * templates and exact panels, used by every later reskin. Pass null to clear.
   * @param {{ templates?: object[], panels?: object[], name?: string } | null} profile
   */
  setProfile(profile) {
    this.profile = profile ?? null;
  }

  /** Per-area theme descriptions (cached per theme + area list; failures fall back to the theme). */
  async areaThemesFor(theme, names, plan, signal) {
    if (!this.provider.areaThemes) return new Map();
    this.areaThemeCache ??= new Map();
    const key = `${theme}|${names.join(',')}`;
    if (!this.areaThemeCache.has(key)) {
      const p = this.timed('split theme per area', null, () =>
        this.provider.areaThemes({ theme, areas: names, subject: plan?.subject, signal }),
      ).then(
        (m) => {
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
      if (locked.has(part.name)) {
        const old = prevByName.get(part.name);
        if (old) job.reuse = old.painted;
        else job.keep = true;
        job.locked = true;
      } else if (opts.fixes) {
        const fix = opts.fixes[part.name];
        const old = prevByName.get(part.name);
        if (fix) job.note = `Correction from a review of the last attempt: ${fix}`;
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
      let crop = transformCanvas(greyedCrop(original, mask, rect), orient);
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
      if (part.zone === 'hands' && opts.handsAsMaterial !== false && this.provider.generateTexture) {
        // Hand islands are tiny and look like little figures to the image model (it drew a
        // shirt and trousers in them), so hands get a plain material: a seamless texture of
        // the area theme, shaded by the original's light and dark (finger lines, nails).
        const tex = await this.withFilterRetry(`paint ${part.name}`, slot, theme, (plain, t) =>
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
        const upright = materialFill(crop, whiteMask(guide), await this.toCanvas(tex));
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
      const upright = unpad(painted, padded.canvas, padded.box, crop.width, crop.height);
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
    const styleFirst = !reused && (opts.styleReference ?? true) && jobs.length > 2;
    if (styleFirst) {
      // Paint the biggest area first so every other call can match its palette and style.
      const first = rest.shift();
      const [r] = await mapLimit([first], 1, paintOne);
      results.push(r);
      if (r.status === 'fulfilled') styleRef = r.value;
    }
    results.push(...(await mapLimit(rest, opts.partConcurrency ?? 4, paintOne)));
    signal.throwIfAborted();
    const ordered = styleFirst ? jobs : rest;
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
    return [...(this.lessons.all ?? []), ...(this.lessons[assetClass] ?? [])];
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
      state.set(mat, {
        map: mat.map,
        normalMap: mat.normalMap,
        roughnessMap: mat.roughnessMap,
        metalnessMap: mat.metalnessMap,
        color: mat.color.clone(),
        roughness: mat.roughness,
      });
    }
    return state;
  }

  applyState(state) {
    for (const [mat, s] of state) {
      delete mat.userData.__reskin;
      mat.map = s.map;
      mat.normalMap = s.normalMap;
      mat.roughnessMap = s.roughnessMap;
      mat.metalnessMap = s.metalnessMap;
      mat.color.copy(s.color);
      mat.roughness = s.roughness;
      mat.needsUpdate = true;
    }
  }

  recordVariations(theme, results, opts) {
    const base = this.captureMaterials(this.snapshots.keys());
    const count = Math.max(1, ...results.map((r) => r.variants?.length ?? 1));
    const entries = [];
    // Drop any redo branch: a new paint goes after the current entry.
    this.history = this.history.slice(0, this.historyIndex + 1);
    for (let vi = 0; vi < count; vi++) {
      const state = new Map(base);
      const partJobs = new Map();
      const maps = [];
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
      };
      this.history.push(entry);
      entries.push(entry);
    }
    this.goToHistory(this.history.length - count, { silent: true });
    this.emit('history', this.historySummary());
    return entries;
  }

  /** A small three-quarter render of the model as it looks now. */
  renderThumb(size = 160) {
    try {
      return renderAxisViews(this.model.scene, { size, views: [REVIEW_VIEWS[1]], cols: 1 }).views[0].canvas;
    } catch {
      return null;
    }
  }

  historySummary() {
    return {
      index: this.historyIndex,
      entries: this.history.map(({ id, prompt, variant, of, thumb, fixes }) => ({
        id,
        prompt,
        variant,
        of,
        thumb,
        fixes,
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
    const key = `${slot.id}|${opts.splitRegions !== false}|${opts.maxPaintAreas ?? 12}|${assetClass}`;
    const hit = this.regionCache.get(key);
    if (hit) return hit;
    const regions = this.paintRegions(slot, slotParts(slot), opts);
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
    for (let i = 0; i < passes; i++) {
      const review = await this.reviewOnce(opts);
      const fixable = review.issues.filter((x) => x.area && this.areaNames().includes(x.area));
      const pass = { notes: review, sheet: review.sheet, repainted: [] };
      out.push(pass);
      if (opts.fix === false || !fixable.length) break;
      const fixes = {};
      for (const x of fixable) fixes[x.area] = [fixes[x.area], x.fix || x.problem].filter(Boolean).join(' ');
      pass.repainted = Object.keys(fixes);
      this.status('reskinning', `Repainting ${pass.repainted.join(', ')}`);
      await this.postPrompt(this.lastRun.theme, { ...this.lastRun.opts, variants: 1, fixes, signal: opts.signal });
    }
    return { passes: out };
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
      for (const x of notes.issues) {
        x.problem = x.problem && sanitizePrompt(x.problem);
        x.fix = x.fix && sanitizePrompt(x.fix);
      }
      if (opts.learn !== false && notes.lessons?.length) {
        const added = this.addLessons(this.lastRun.opts.assetClass ?? 'generic', notes.lessons);
        if (added.length) notes.learned = added;
      }
      const review = { ...notes, sheet };
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
  paintRegions(slot, parts, opts = {}) {
    if (opts.splitRegions === false) return parts;
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
        split = zones.length > 1 || opts.assetClass === 'avatar' ? zones : splitPartRegions(slot, p);
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
    this.snapshots.set(mat, {
      map: mat.map,
      normalMap: mat.normalMap,
      roughnessMap: mat.roughnessMap,
      metalnessMap: mat.metalnessMap,
      color: mat.color.clone(),
      roughness: mat.roughness,
    });
  }

  restoreSnapshots() {
    for (const [mat, s] of this.snapshots) {
      delete mat.userData.__reskin;
      mat.map = s.map;
      mat.normalMap = s.normalMap;
      mat.roughnessMap = s.roughnessMap;
      mat.metalnessMap = s.metalnessMap;
      mat.color.copy(s.color);
      mat.roughness = s.roughness;
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

export function slug(s) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'reskin'
  );
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
