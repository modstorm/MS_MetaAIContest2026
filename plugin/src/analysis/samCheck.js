/**
 * SAM 3.1 check for misplaced paint.
 *
 * After Muse Image paints one area of a character (trousers, hands, torso...), SAM 3.1 is
 * asked with short noun phrases ("face", "shoe", "person") whether something that belongs
 * in another area shows up inside it: a portrait on the hands, shoes at the bottom of the
 * legs, a face on the jacket. The same question is asked once of the original texture, so
 * only things the paint ADDED count (a printed face that was already there is fine).
 *
 * Which phrases are checked for which zone comes from the asset class (`samCheck` in
 * assetClasses.js), so other kinds of models can add their own.
 */

import { decodeMaskToRaster, recordsOfKind } from '@meta-sam/parser';
import { getAssetClass } from '../assetClasses.js';

/**
 * @typedef {{ concept: string, minShare?: number, maxShare?: number, minConfidence?: number }} SamRule
 *   concept        one short noun phrase for SAM
 *   minShare       flag only if the paint added at least this share of the area (default 0.01)
 *   maxShare       ignore hits bigger than this share (the whole area read as one thing)
 *   minConfidence  ignore detections below this confidence (default 0.4)
 */

/** @typedef {{ concept: string, share: number, before: number, added: number, where: string, confidence?: number }} SamHit */

/** The SAM rules for one zone of an asset class, minus concepts the theme asks for. */
export function samRulesFor(assetClassId, zone, theme = '') {
  const table = getAssetClass(assetClassId)?.samCheck;
  const list = (table && zone && table[zone]) || [];
  const t = String(theme).toLowerCase();
  return list
    .map((r) => (typeof r === 'string' ? { concept: r } : r))
    .filter((r) => r?.concept && !new RegExp(`\\b${escapeRe(r.concept)}s?\\b`, 'i').test(t));
}

/**
 * Share of the area (mask pixels set) covered by SAM's masks, plus where the biggest one is.
 * `result` is an image result of @meta-sam/parser; `area` a Uint8Array (w*h, 1 = inside)
 * at the size of the image that was sent.
 */
export function areaCoverage(result, area, w, h, minConfidence = 0.4) {
  const hitMap = new Uint8Array(w * h);
  let best = null;
  for (const rec of recordsOfKind(result?.records ?? [], 'mask')) {
    if (rec.confidence !== undefined && rec.confidence < minConfidence) continue;
    const { left, top, right, bottom } = rec.bounds;
    const bw = right - left,
      bh = bottom - top;
    if (bw <= 0 || bh <= 0) continue;
    const raster = decodeMaskToRaster(rec.mask);
    const rw = rec.mask.width,
      rh = rec.mask.height;
    let n = 0;
    for (let y = Math.max(0, top); y < Math.min(h, bottom); y++) {
      const ry = Math.min(rh - 1, Math.floor(((y - top) * rh) / bh));
      for (let x = Math.max(0, left); x < Math.min(w, right); x++) {
        const rx = Math.min(rw - 1, Math.floor(((x - left) * rw) / bw));
        if (!raster[ry * rw + rx]) continue;
        const i = y * w + x;
        if (area[i] && !hitMap[i]) {
          hitMap[i] = 1;
          n++;
        }
      }
    }
    if (!best || n > best.n) best = { n, cx: (left + right) / 2 / w, cy: (top + bottom) / 2 / h, c: rec.confidence };
  }
  let total = 0,
    hit = 0;
  for (let i = 0; i < area.length; i++) {
    if (!area[i]) continue;
    total++;
    if (hitMap[i]) hit++;
  }
  return {
    share: total ? hit / total : 0,
    where: best && best.n ? whereText(best.cx, best.cy) : '',
    confidence: best?.c,
  };
}

/** "upper left", "middle centre"... for a normalized point. */
export function whereText(x, y) {
  return `${y < 0.34 ? 'upper' : y > 0.66 ? 'lower' : 'middle'} ${x < 0.34 ? 'left' : x > 0.66 ? 'right' : 'centre'}`;
}

/**
 * Runs the rules on a painted crop and on the original crop (cached per key), returns the
 * hits the paint added. `segment({ image, prompt, signal })` is the provider's SAM call.
 * @param {{ segment: Function, painted: HTMLCanvasElement, original: HTMLCanvasElement, guide: HTMLCanvasElement,
 *   rules: SamRule[], cache?: Map<string, Promise<any>>, cacheKey?: string, maxSize?: number, signal?: AbortSignal }} o
 * @returns {Promise<SamHit[]>}
 */
export async function findIntrusions(o) {
  const { segment, painted, original, guide, rules, signal } = o;
  if (!rules.length) return [];
  const size = fitWithin(painted.width, painted.height, o.maxSize ?? 768);
  const area = maskBits(guide, size.w, size.h);
  const toUrl = (c) => scaled(c, size.w, size.h).toDataURL('image/png');
  const paintedUrl = toUrl(painted);
  let originalUrl = null;
  const ask = (url, concept) => segment({ image: url, prompt: concept, signal });
  const hits = await Promise.all(
    rules.map(async (r) => {
      const minConf = r.minConfidence ?? 0.4;
      const key = o.cacheKey ? `${o.cacheKey}|${r.concept}|${size.w}x${size.h}` : null;
      let before = key && o.cache?.get(key);
      if (!before) {
        originalUrl ??= toUrl(original);
        before = ask(originalUrl, r.concept).then((res) => areaCoverage(res, area, size.w, size.h, minConf).share);
        if (key && o.cache) {
          o.cache.set(key, before);
          before.catch(() => o.cache.delete(key));
        }
      }
      const [b, now] = await Promise.all([
        before,
        ask(paintedUrl, r.concept).then((res) => areaCoverage(res, area, size.w, size.h, minConf)),
      ]);
      const added = now.share - b;
      if (added < (r.minShare ?? 0.01)) return null;
      if (r.maxShare !== undefined && now.share > r.maxShare) return null;
      return { concept: r.concept, share: now.share, before: b, added, where: now.where, confidence: now.confidence };
    }),
  );
  return hits.filter(Boolean);
}

/** One score to compare two attempts: total area share the paint added (lower is better). */
export function intrusionScore(hits) {
  return hits.reduce((s, h) => s + h.added, 0);
}

/** Short log text: `face 4% (upper left), shoe 6% (lower centre)`. */
export function intrusionText(hits) {
  return hits.map((h) => `${h.concept} ${Math.round(h.share * 100)}%${h.where ? ` (${h.where})` : ''}`).join(', ');
}

/** Correction line for the repaint prompt. */
export function intrusionNote(hits, partName) {
  const things = hits.map((h) => `a ${h.concept}${h.where ? ` at the ${h.where} of image 1` : ''}`).join(', ');
  return `The last attempt drew ${things}. Those belong to other areas of the model, not to the ${partName}. Paint this area only as its own material, edge to edge, with no ${hits.map((h) => `${h.concept}s`).join(', ')} or figures anywhere in it.`;
}

function fitWithin(w, h, max) {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

function scaled(c, w, h) {
  if (c.width === w && c.height === h) return c;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').drawImage(c, 0, 0, w, h);
  return out;
}

/** White-on-black guide -> 1/0 bits at w x h. */
function maskBits(guide, w, h) {
  const d = scaled(guide, w, h).getContext('2d').getImageData(0, 0, w, h).data;
  const bits = new Uint8Array(w * h);
  for (let i = 0; i < bits.length; i++) bits[i] = d[i * 4] > 127 ? 1 : 0;
  return bits;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
