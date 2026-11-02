import { MuseApiError, MuseClient, isContentPolicyError } from '../muse/MuseClient.js';
import {
  areaThemesPrompt,
  normalMapPrompt,
  parseAreaThemes,
  parseLayoutPlan,
  reskinAtlasPrompt,
  roughnessMapPrompt,
  parseSuggestion,
  parseReview,
  reviewPrompt,
  plainReskinAtlasPrompt,
  plainReskinPartPrompt,
  reskinPartPrompt,
  plainSeamlessTexturePrompt,
  seamlessTexturePrompt,
  suggestPrompt as suggestPromptText,
  suggestFromAnalysisPrompt,
  visionPlanPrompt,
} from '../muse/prompts.js';
import { canvasToDataUrl, fitSize, museSizeFor, resizeCanvas } from '../texture/imageUtils.js';

/**
 * @typedef {import('../muse/MuseClient.js').MuseClientOptions & {
 *   fast?: boolean,
 *   aiAuxMaps?: boolean,
 *   uploadMaxSize?: number,
 *   reasoningStrength?: 'low' | 'high',
 *   disableSearchTools?: boolean,
 *   adviceModel?: string,
 * }} MuseProviderOptions
 *
 * fast (default true): turn off Muse's web / image search and shell tools, use low
 *   reasoning strength, and send smaller images. Much quicker; the texture prompt is
 *   self-contained, so search rarely helps.
 * aiAuxMaps (default false): also ask Muse to repaint normal / roughness maps
 *   (2 extra image calls per texture). Otherwise they are derived locally.
 * uploadMaxSize: longest side of images uploaded to Muse. Default 1024 (fast) / 1536.
 * adviceModel: chat model for the art-director steps (suggest a prompt, review the result).
 *   Default: the vision model (muse-spark-1.3). 'muse-wonder-1.0' (Preview) reasons more but
 *   costs about 3x as much per token. If it rejects a request, that step falls back to Spark.
 */

/** Texture provider backed by Meta Muse: muse-spark reads the layout, muse-image paints. */
export class MuseProvider {
  name = 'Meta Muse';
  client;
  opts;
  /** Set if the API rejected the speed options, so they are not sent again. */
  extrasRejected = false;

  /** @param {MuseProviderOptions | MuseClient} [opts] */
  constructor(opts = {}) {
    if (opts instanceof MuseClient) {
      this.client = opts;
      this.opts = {};
    } else {
      this.client = new MuseClient(opts);
      this.opts = opts;
    }
    if (this.opts.aiAuxMaps) this.reskinAuxMap = this.aiReskinAuxMap;
  }

  reskinAuxMap;
  /** Optional hook for notices the host should show (e.g. a model fallback): (message) => void. */
  onNotice = null;

  get fast() {
    return this.opts.fast ?? true;
  }

  /** Turn fast mode on or off. */
  setFast(on) {
    this.opts = { ...this.opts, fast: on };
  }

  /** Chat model for the suggest and review steps (default: the vision model, Muse Spark). */
  get adviceModel() {
    return this.opts.adviceModel || this.client.options.visionModel;
  }

  /** Pick the suggest/review model, e.g. 'muse-wonder-1.0'. Empty → Muse Spark. */
  setAdviceModel(model) {
    this.opts = { ...this.opts, adviceModel: model || undefined };
    this.adviceRejected = false;
  }

  /**
   * Chat call for the art-director steps, on the advice model. If a non-default model
   * (Muse Wonder) rejects the request (bad request, unknown model, no access), it is
   * retried on Muse Spark and Spark is used for the rest of the session.
   */
  async adviceChat(args) {
    const spark = this.client.options.visionModel;
    const model = this.adviceRejected ? spark : this.adviceModel;
    if (model === spark) return this.client.chat(args);
    try {
      return await this.client.chat({ ...args, model });
    } catch (err) {
      if (!(err instanceof MuseApiError) || ![400, 403, 404, 422].includes(err.status) || isContentPolicyError(err))
        throw err;
      this.adviceRejected = true;
      this.onNotice?.(`${model} rejected the request (${err.status}: ${err.message}); using ${spark} instead.`);
      return this.client.chat({ ...args, model: spark });
    }
  }

  toUpload(c, kind = 'photo') {
    const max = this.opts.uploadMaxSize ?? (this.fast ? 1024 : 1536);
    const { width, height } = fitSize(c.width, c.height, max);
    const scaled = width === c.width && height === c.height ? c : resizeCanvas(c, width, height);
    // Painted atlases compress well as JPEG (much smaller upload); line guides stay PNG.
    return kind === 'guide' ? canvasToDataUrl(scaled, 'image/png') : canvasToDataUrl(scaled, 'image/jpeg', 0.9);
  }

  get imageExtras() {
    if (this.extrasRejected) return { outputFormat: 'png' };
    const fast = this.fast;
    const disable = fast || this.opts.disableSearchTools;
    return {
      outputFormat: 'png',
      reasoningStrength: this.opts.reasoningStrength ?? (fast ? 'low' : undefined),
      toolEnablement: disable
        ? { enable_image_search: false, enable_web_search: false, enable_shell: false }
        : undefined,
    };
  }

  /** Calls an image endpoint; if the speed options are rejected (400), retries once without them. */
  async paint(method, args) {
    try {
      return await this.client[method]({ ...args, ...this.imageExtras });
    } catch (err) {
      const extrasSent =
        !this.extrasRejected && (this.imageExtras.reasoningStrength || this.imageExtras.toolEnablement);
      if (
        extrasSent &&
        err instanceof MuseApiError &&
        err.status === 400 &&
        /reasoning_strength|tool_enablement|enable_/i.test(`${err.param ?? ''} ${err.message}`)
      ) {
        this.extrasRejected = true;
        return this.client[method]({ ...args, ...this.imageExtras });
      }
      throw err;
    }
  }

  /** One short surface description per area for the theme (see areaThemesPrompt). */
  async areaThemes(req) {
    const text = await this.client.chat({
      reasoningEffort: this.fast ? 'minimal' : 'low',
      signal: req.signal,
      messages: [
        { role: 'user', content: [{ type: 'text', text: areaThemesPrompt(req.theme, req.areas, req.subject) }] },
      ],
    });
    return parseAreaThemes(text, req.areas);
  }

  async planLayout(req) {
    // Fast mode: one image (atlas with UV outlines drawn on it) at 768px, minimal reasoning.
    const images = this.fast
      ? [this.toUploadSized(req.atlasWithUvs, 768)]
      : [this.toUpload(req.atlas), this.toUpload(req.atlasWithUvs)];
    const text = await this.client.chat({
      reasoningEffort: this.fast ? 'minimal' : 'low',
      signal: req.signal,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: visionPlanPrompt(req.slotName, req.meshNames, images.length) },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        },
      ],
    });
    return parseLayoutPlan(text);
  }

  /**
   * Art-director step: Muse Spark looks at six renders of the model plus the UV atlases
   * and recommends a better prompt and a per-region paint plan.
   * @param {{ theme: string, sheet?: HTMLCanvasElement, atlases: { name: string, meshNames: string[], atlasWithUvs: HTMLCanvasElement }[], signal?: AbortSignal }} req
   */
  async suggestPrompt(req) {
    const images = [];
    if (req.sheet) images.push(this.toUploadSized(req.sheet, this.fast ? 1152 : 1536));
    if (req.idSheet) images.push(this.toUploadSized(req.idSheet, this.fast ? 864 : 1152));
    for (const a of req.atlases.slice(0, 4)) images.push(this.toUploadSized(a.atlasWithUvs, this.fast ? 768 : 1024));
    const ask = (strict) =>
      this.adviceChat({
        reasoningEffort: this.fast ? 'low' : 'medium',
        signal: req.signal,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  suggestPromptText(req.theme, req.atlases.slice(0, 4), !!req.sheet, !!req.idSheet, req.lessons) +
                  (strict
                    ? '\n\nIMPORTANT: your last reply could not be read. Reply with one complete JSON object only: no prose, no code fences, keep every text value short.'
                    : ''),
              },
              ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
            ],
          },
        ],
      });
    let text = await ask(false);
    let s = parseSuggestion(text ?? '');
    if (!s || (!s.prompt && !s.subject)) {
      // One retry asking for strict JSON (replies are sometimes cut off or wrapped in prose).
      const first = text;
      text = await ask(true);
      s = parseSuggestion(text ?? '');
      if (!s || (!s.prompt && !s.subject)) {
        const snippet = String(text || first || '(empty reply)')
          .replace(/\s+/g, ' ')
          .slice(0, 160);
        throw new Error(`Muse returned a suggestion that could not be read (twice). Reply started: "${snippet}"`);
      }
    }
    return s;
  }

  /** Art-director step reusing an earlier analysis of the same model (text only, no images). */
  async suggestFromAnalysis(req) {
    const ask = (strict) =>
      this.adviceChat({
        reasoningEffort: this.fast ? 'low' : 'medium',
        signal: req.signal,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  suggestFromAnalysisPrompt(req.theme, req.analysis, req.lessons) +
                  (strict ? '\n\nIMPORTANT: reply with one complete JSON object only, no prose, no code fences.' : ''),
              },
            ],
          },
        ],
      });
    let s = parseSuggestion((await ask(false)) ?? '');
    if (!s || !s.prompt) s = parseSuggestion((await ask(true)) ?? '');
    if (!s || !s.prompt) throw new Error('Muse returned a suggestion that could not be read (twice).');
    return s;
  }

  /**
   * Review step: Muse Spark looks at one image of the painted model (eight angles, plus the
   * same angles as an ID map) and lists problems per texture area.
   */
  async reviewResult(req) {
    const text = await this.adviceChat({
      reasoningEffort: this.fast ? 'low' : 'medium',
      signal: req.signal,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: reviewPrompt(req.theme, req) },
            { type: 'image_url', image_url: { url: this.toUploadSized(req.sheet, 1024) } },
          ],
        },
      ],
    });
    return parseReview(text);
  }

  /**
   * Content-filter probe: small separate requests to isolate what Muse rejects.
   * Runs one after another so each result is independent. Returns
   * [{ name, description, ok, ms, error? }].
   */
  async probeFilter({ theme, atlas, uvGuide, plan, signal, onResult }) {
    const small = (c, kind) =>
      kind === 'guide' ? canvasToDataUrl(resizeCanvas(c, 512, 512), 'image/png') : this.toUploadSized(c, 512);
    const fullPrompt = reskinAtlasPrompt(theme, plan);
    const neutral = 'Recolor this texture image in calm shades of blue. Keep every shape in exactly the same place.';
    const tests = [
      {
        name: 'theme only',
        description: `text→image with just "${theme}"`,
        run: () => this.paint('generateImage', { prompt: theme, size: '1024x1024', signal }),
      },
      {
        name: 'full prompt, no images',
        description: 'text→image with the complete paint prompt',
        run: () => this.paint('generateImage', { prompt: fullPrompt, size: '1024x1024', signal }),
      },
      {
        name: 'prompt + atlas',
        description: 'edit: paint prompt + the texture atlas only',
        run: () => this.paint('editImage', { prompt: fullPrompt, images: [small(atlas)], size: '1024x1024', signal }),
      },
      {
        name: 'prompt + UV mask',
        description: 'edit: paint prompt + the UV mask only',
        run: () =>
          this.paint('editImage', { prompt: fullPrompt, images: [small(uvGuide, 'guide')], size: '1024x1024', signal }),
      },
      {
        name: 'neutral + atlas',
        description: 'edit: harmless "recolor blue" prompt + the texture atlas',
        run: () => this.paint('editImage', { prompt: neutral, images: [small(atlas)], size: '1024x1024', signal }),
      },
    ];
    const results = [];
    for (const t of tests) {
      signal?.throwIfAborted();
      const t0 = performance.now();
      let r;
      try {
        await t.run();
        r = { name: t.name, description: t.description, ok: true, ms: performance.now() - t0 };
      } catch (err) {
        if (signal?.aborted) throw err;
        r = {
          name: t.name,
          description: t.description,
          ok: false,
          ms: performance.now() - t0,
          error: String(err?.message ?? err),
          filtered: isContentPolicyError(err),
        };
      }
      results.push(r);
      onResult?.(r);
    }
    return results;
  }

  toUploadSized(c, max) {
    const { width, height } = fitSize(c.width, c.height, max);
    return canvasToDataUrl(resizeCanvas(c, width, height), 'image/jpeg', 0.9);
  }

  reskinAtlas(req) {
    return this.paint('editImage', {
      prompt: req.plain
        ? plainReskinAtlasPrompt(req.theme)
        : reskinAtlasPrompt(req.theme, req.plan, req.extraInstructions, req.parts),
      // The plain retry sends only the atlas (no wireframe guide image).
      images: req.plain ? [this.toUpload(req.atlas)] : [this.toUpload(req.atlas), this.toUpload(req.uvGuide, 'guide')],
      size: museSizeFor(req.width, req.height),
      signal: req.signal,
    });
  }

  /**
   * Per-part painting: req.image is one area cut out and turned upright (grey elsewhere),
   * req.mask its facing map (black outside), req.styleRef an already painted area.
   */
  reskinPart(req) {
    return this.paint('editImage', {
      prompt: req.plain ? plainReskinPartPrompt(req.theme, req.partName) : reskinPartPrompt(req.theme, req),
      images: req.plain
        ? [this.toUpload(req.image)]
        : [
            this.toUpload(req.image),
            this.toUpload(req.mask, 'guide'),
            ...(req.styleRef ? [this.toUploadSized(req.styleRef, 512)] : []),
          ],
      size: museSizeFor(req.image.width, req.image.height),
      signal: req.signal,
    });
  }

  generateTexture(req) {
    return this.paint('generateImage', {
      prompt: req.plain
        ? plainSeamlessTexturePrompt(req.theme)
        : seamlessTexturePrompt(req.theme, req.materialName, req.extraInstructions),
      size: museSizeFor(req.width, req.height),
      signal: req.signal,
    });
  }

  aiReskinAuxMap = (req) =>
    this.paint('editImage', {
      prompt: req.kind === 'normal' ? normalMapPrompt(req.theme) : roughnessMapPrompt(req.theme),
      images: [this.toUpload(req.source, 'guide'), this.toUpload(req.newBaseColor)],
      size: museSizeFor(req.width, req.height),
      signal: req.signal,
    });
}
