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
 * assetClasses.js), so other kinds of models can add their own. Every area of every model is
 * also checked for stray text and logos (STRAY_MARKS), which Muse sometimes adds unasked.
 */

import { decodeMaskToRaster, recordsOfKind } from '@meta-sam/parser';
import { getAssetClass, splitWords } from '../assetClasses.js';

/**
 * @typedef {{ concept: string, minShare?: number, maxShare?: number, minConfidence?: number }} SamRule
 *   concept        one short noun phrase for SAM
 *   minShare       flag only if the paint added at least this share of the area (default 0.01)
 *   maxShare       ignore hits bigger than this share (the whole area read as one thing)
 *   minConfidence  ignore detections below this confidence (default 0.4)
 */

/** @typedef {{ concept: string, share: number, before: number, added: number, where: string, confidence?: number }} SamHit */

/**
 * Checked in every area of every model: lettering, a logo or a watermark that Muse painted
 * without being asked. Skipped when the theme asks for writing or decals (THEME_WANTS_MARKS).
 */
export const STRAY_MARKS = [
  { concept: 'text', minConfidence: 0.6 },
  { concept: 'logo', minConfidence: 0.6 },
];
const STRAY_CONCEPTS = new Set(STRAY_MARKS.map((r) => r.concept));
const THEME_WANTS_MARKS =
  /\b(text|letters?|lettering|words?|writing|written|signs?|signage|graffiti|numbers?|numbered|logos?|decals?|sponsors?|brand(s|ed|ing)?|emblems?|badges?|labels?|slogans?|typography|insignias?|livery)\b/i;

/**
 * The SAM rules for one area: the asset class's rules for its zone plus the stray text/logo
 * check, minus concepts the theme asks for.
 */
export function samRulesFor(assetClassId, zone, theme = '', partName = '') {
  const table = getAssetClass(assetClassId)?.samCheck;
  // '*': rules for areas with no zone of their own (named mesh parts), unless the part's
  // name matches table.skipNames (a vehicle's wheels may of course show a wheel).
  const any = table?.['*'] && !(table.skipNames && table.skipNames.test(splitWords(`${zone ?? ''} ${partName ?? ''}`)));
  const list = (table && zone && table[zone]) || (any ? table['*'] : []);
  const t = String(theme).toLowerCase();
  const zoneRules = list
    .map((r) => (typeof r === 'string' ? { concept: r } : r))
    .filter((r) => r?.concept && !new RegExp(`\\b${escapeRe(r.concept)}s?\\b`, 'i').test(t));
  const stray = THEME_WANTS_MARKS.test(t) ? [] : STRAY_MARKS.map((r) => ({ ...r }));
  return [...zoneRules, ...stray];
}

/**
 * Share of the area (mask pixels set) covered by SAM's masks, plus where the biggest one is.
 * `result` is an image result of @meta-sam/parser; `area` a Uint8Array (w*h, 1 = inside)
 * at the size of the image that was sent.
 */
export function areaCoverage(result, area, w, h, minConfidence = 0.4) {
  const hitMap = new Uint8Array(w * h);
  let best = null;
  const boxes = [];
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
    if (n) boxes.push({ left, top, right, bottom });
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
    /** 1 where a mask covers the area, at w x h (for a masked repaint). */
    mask: hitMap,
    /** Boxes (pixels at w x h) of the masks that touch the area. */
    boxes,
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
      return {
        concept: r.concept,
        share: now.share,
        before: b,
        added,
        where: now.where,
        confidence: now.confidence,
        mask: now.mask,
        boxes: now.boxes,
        maskSize: size,
      };
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
  const at = (h) => (h.where ? ` at the ${h.where} of image 1` : '');
  const misplaced = hits.filter((h) => !STRAY_CONCEPTS.has(h.concept));
  const stray = hits.filter((h) => STRAY_CONCEPTS.has(h.concept));
  const notes = [];
  if (misplaced.length)
    notes.push(
      `The last attempt drew ${misplaced.map((h) => `a ${h.concept}${at(h)}`).join(', ')}. Those belong to other areas of the model, not to the ${partName}. Paint this area only as its own material, edge to edge, with no ${misplaced.map((h) => `${h.concept}s`).join(', ')} or figures anywhere in it.`,
    );
  if (stray.length)
    notes.push(
      `The last attempt ${misplaced.length ? 'also ' : ''}added ${stray.map((h) => `${h.concept === 'text' ? 'lettering' : 'a logo'}${at(h)}`).join(', ')} that nobody asked for. Paint the ${partName} with no text, letters, numbers, logos or watermarks anywhere in it.`,
    );
  return notes.join(' ');
}

/**
 * Masked repaint: `base` with only the pixels SAM marked in `hits` taken from `patch`, so a fix
 * never spreads into the rest of the area. The marks are grown by `grow` (share of the longer
 * side, default 0.03) and feathered so the patch blends in. Returns a new canvas at base size.
 */
export function maskedBlend(base, patch, hits, { grow = 0.03 } = {}) {
  const withMask = hits.filter((h) => h.mask && h.maskSize);
  const out = document.createElement('canvas');
  out.width = base.width;
  out.height = base.height;
  const g = out.getContext('2d');
  g.drawImage(base, 0, 0);
  if (!withMask.length) return out;
  const { w, h } = withMask[0].maskSize;
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const sg = small.getContext('2d');
  const id = sg.createImageData(w, h);
  for (const hit of withMask) {
    for (let i = 0; i < hit.mask.length; i++) if (hit.mask[i]) id.data[i * 4 + 3] = 255;
  }
  sg.putImageData(id, 0, 0);
  // Also each detection's whole box, grown by a fifth: SAM's mask of a face often leaves out
  // the hair, neck and outline of the drawn figure, and a patch on the mask alone left a face.
  sg.fillStyle = '#000';
  for (const hit of withMask) {
    for (const b of hit.boxes ?? []) {
      const gx = (b.right - b.left) * 0.2,
        gy = (b.bottom - b.top) * 0.2;
      sg.fillRect(b.left - gx, b.top - gy, b.right - b.left + 2 * gx, b.bottom - b.top + 2 * gy);
    }
  }
  // Grow and feather at full size: blur the alpha, then stretch it so the core stays solid.
  const r = Math.max(1, Math.round(Math.max(base.width, base.height) * grow));
  const alpha = document.createElement('canvas');
  alpha.width = base.width;
  alpha.height = base.height;
  const ag = alpha.getContext('2d');
  ag.filter = `blur(${r}px)`;
  ag.drawImage(small, 0, 0, base.width, base.height);
  ag.filter = 'none';
  const ad = ag.getImageData(0, 0, base.width, base.height);
  for (let i = 3; i < ad.data.length; i += 4) ad.data[i] = Math.min(255, ad.data[i] * 3);
  ag.putImageData(ad, 0, 0);
  // Patch pixels where the alpha is set, drawn over the base.
  const p = document.createElement('canvas');
  p.width = base.width;
  p.height = base.height;
  const pg = p.getContext('2d');
  pg.drawImage(patch, 0, 0, base.width, base.height);
  pg.globalCompositeOperation = 'destination-in';
  pg.drawImage(alpha, 0, 0);
  g.drawImage(p, 0, 0);
  return out;
}

/** Share of the image the masks of `hits` cover (for the log). */
export function maskedShare(hits) {
  const withMask = hits.filter((h) => h.mask);
  if (!withMask.length) return 0;
  const n = withMask[0].mask.length;
  let c = 0;
  for (let i = 0; i < n; i++) if (withMask.some((h) => h.mask[i])) c++;
  return c / n;
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
