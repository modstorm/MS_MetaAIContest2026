import { MuseClient } from '../muse/MuseClient.js';
import {
  normalMapPrompt,
  parseLayoutPlan,
  reskinAtlasPrompt,
  roughnessMapPrompt,
  seamlessTexturePrompt,
  visionPlanPrompt,
} from '../muse/prompts.js';
import { canvasToDataUrl, fitSize, museSizeFor, resizeCanvas } from '../texture/imageUtils.js';

/** Texture provider backed by Meta Muse: muse-spark for planning, muse-image for painting. */
export class MuseProvider {
  name = 'Meta Muse';
  client;
  opts;

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

  toUpload(c) {
    const max = this.opts.uploadMaxSize ?? 1536;
    const { width, height } = fitSize(c.width, c.height, max);
    const scaled = width === c.width && height === c.height ? c : resizeCanvas(c, width, height);
    return canvasToDataUrl(scaled, 'image/png');
  }

  get imageExtras() {
    return {
      outputFormat: 'png',
      reasoningStrength: this.opts.reasoningStrength,
      toolEnablement: this.opts.disableSearchTools
        ? { enable_image_search: false, enable_web_search: false }
        : undefined,
    };
  }

  async planLayout(req) {
    const text = await this.client.chat({
      reasoningEffort: 'low',
      signal: req.signal,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: visionPlanPrompt(req.slotName, req.meshNames) },
            { type: 'image_url', image_url: { url: this.toUpload(req.atlas) } },
            { type: 'image_url', image_url: { url: this.toUpload(req.atlasWithUvs) } },
          ],
        },
      ],
    });
    return parseLayoutPlan(text);
  }

  reskinAtlas(req) {
    return this.client.editImage({
      prompt: reskinAtlasPrompt(req.theme, req.plan, req.extraInstructions),
      images: [this.toUpload(req.atlas), this.toUpload(req.uvGuide)],
      size: museSizeFor(req.width, req.height),
      signal: req.signal,
      ...this.imageExtras,
    });
  }

  generateTexture(req) {
    return this.client.generateImage({
      prompt: seamlessTexturePrompt(req.theme, req.materialName, req.extraInstructions),
      size: museSizeFor(req.width, req.height),
      signal: req.signal,
      ...this.imageExtras,
    });
  }

  aiReskinAuxMap = (req) =>
    this.client.editImage({
      prompt: req.kind === 'normal' ? normalMapPrompt(req.theme) : roughnessMapPrompt(req.theme),
      images: [this.toUpload(req.source), this.toUpload(req.newBaseColor)],
      size: museSizeFor(req.width, req.height),
      signal: req.signal,
      ...this.imageExtras,
    });
}
