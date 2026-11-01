import { orientationNote } from '../analysis/parts.js';
import { assetClassIds } from '../assetClasses.js';

/** Prompt templates sent to Muse. Kept in one place so they are easy to tune. */

export function visionPlanPrompt(slotName, meshNames, imageCount = 2) {
  return [
    'You are analyzing a UV texture atlas for a 3D model used in a real-time engine.',
    `Texture name: "${slotName}". Meshes using it: ${meshNames.slice(0, 12).join(', ') || 'unknown'}.`,
    imageCount > 1
      ? 'Image 1 is the base color atlas. Image 2 is the same atlas with the UV island outlines drawn in pink.'
      : 'The image is the base color atlas with the UV island outlines drawn in pink.',
    'Identify what the model is and which part of the model each painted region of the atlas belongs to.',
    'Reply with JSON only, no prose, in this shape:',
    '{"subject": "short description of the model", "style": "current art style", "regions": [{"name": "part name", "description": "what is painted there", "bbox": [x0, y0, x1, y1]}]}',
    'bbox uses a 0-1000 normalized grid of the image, origin at the top-left. List at most 16 regions, largest first.',
  ].join('\n');
}

/** Prompt lines describing the known parts (from the 3D file) and their orientation. */
export function partLines(parts, { colors = true } = {}) {
  if (!parts?.length) return [];
  const lines = [
    colors
      ? 'Parts of the model, from the 3D file (exact). In the part map each part is filled with its own color:'
      : 'Parts of the model, from the 3D file (exact):',
  ];
  for (const p of parts) {
    const note = orientationNote(p.up);
    lines.push(
      `- ${p.name}${colors ? ` = ${p.color} area` : ''}, bbox [${p.bbox.join(', ')}]${note ? `, ${note}` : ''}`,
    );
  }
  return lines;
}

export function reskinAtlasPrompt(theme, plan, extra, parts) {
  const multi = parts?.length > 1;
  const lines = [
    multi
      ? 'Image 1 is a UV texture atlas (base color / albedo) that wraps a 3D model. Image 2 is a part map: the same layout with each part of the model filled in its own flat color.'
      : 'Image 1 is a UV texture atlas (base color / albedo) that wraps a 3D model. Image 2 shows its UV island layout.',
    `Repaint the atlas in this theme: "${theme}".`,
    'Rules:',
    '- Keep the exact same layout. Every painted island must stay at the same position, size, shape and orientation so the texture still wraps the model correctly.',
    '- Keep the same image framing and aspect ratio. Do not crop, zoom, rotate, mirror or add borders.',
    '- Paint flat, unlit albedo color: no baked shadows, no highlights, no perspective, no lettering.',
    multi
      ? '- Image 2 is only a guide: do not copy its flat colors. Paint each part only inside its own colored area, and repaint every part.'
      : '- Do not draw the UV outlines from image 2; they are only a guide.',
    "- Respect each part's orientation below: facial features, lettering and patterns must point the way the part's top points.",
    '- Fill empty space between islands with colors that match the neighbouring island to avoid seams. Never leave black or dark gaps next to an island.',
    '- Small parts made of many tiny islands (hands, fingers, buttons) should be one clean solid color each, without patterns.',
  ];
  if (plan?.subject) lines.push(`The model is: ${plan.subject}.`);
  lines.push(...partLines(parts, { colors: multi }));
  if (plan?.regions?.length) {
    lines.push('Regions in the atlas (bbox on a 0-1000 grid, origin top-left):');
    for (const r of plan.regions.slice(0, 16)) {
      lines.push(
        `- ${r.name}${r.bbox ? ` at [${r.bbox.join(', ')}]` : ''}${r.description ? `: ${r.description}` : ''}`,
      );
    }
    lines.push('Retheme each region so it suits its part of the model.');
  }
  if (extra) lines.push(extra);
  return lines.join('\n');
}

/**
 * Plain fallback used after a content-filter rejection: only the theme and the
 * layout rule, none of the generated region text.
 */
export function plainReskinAtlasPrompt(theme) {
  return `Recolor this game texture image in a "${theme}" style. Keep every shape in exactly the same place and size. Flat colors, no lighting.`;
}

export function plainSeamlessTexturePrompt(theme) {
  return `A seamless tileable game surface texture in a "${theme}" style, flat even lighting.`;
}

export function seamlessTexturePrompt(theme, materialName, extra) {
  return [
    `A seamless, tileable surface texture for the material "${materialName}" of a 3D model, theme: "${theme}".`,
    'Orthographic top-down view of the surface, flat even lighting, no shadows, no perspective, no objects, no text.',
    'The left/right and top/bottom edges must tile without visible seams.',
    extra ?? '',
  ]
    .join('\n')
    .trim();
}

export function normalMapPrompt(theme) {
  return [
    'Image 1 is a tangent-space normal map for a UV texture atlas. Image 2 is the new base color atlas for the same model.',
    `Produce a matching tangent-space normal map for the new "${theme}" surface detail.`,
    'Keep the exact same layout as image 1. Output must be a valid normal map: mostly flat lavender (RGB 128,128,255) with blue-purple detail. No colors from image 2.',
  ].join('\n');
}

export function roughnessMapPrompt(theme) {
  return [
    'Image 1 is a roughness map (grayscale, white = rough, black = glossy) for a UV texture atlas. Image 2 is the new base color atlas.',
    `Produce a matching grayscale roughness map for the new "${theme}" materials, same exact layout as image 1. Grayscale only.`,
  ].join('\n');
}

/**
 * Reads a JSON object out of a model reply: tolerates code fences, prose around it,
 * smart quotes, trailing commas, // comments and a reply cut off before it closed.
 * Returns the object or null.
 */
export function looseJson(text) {
  if (typeof text !== 'string') return null;
  let t = text
    .replace(/```(?:json)?/gi, '')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
  const start = t.indexOf('{');
  if (start < 0) return null;
  t = t.slice(start);
  // Find where the first object closes (string-aware), else keep everything (truncated reply).
  let depth = 0,
    inStr = false,
    esc = false,
    end = -1;
  const stack = [];
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') {
      depth++;
      stack.push(ch === '{' ? '}' : ']');
    } else if (ch === '}' || ch === ']') {
      depth--;
      stack.pop();
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const tries = [];
  if (end >= 0) tries.push(t.slice(0, end + 1));
  else {
    // Cut off: close what is open, after dropping the last partial entry if needed
    // (cut back to each of the last few commas until something parses).
    tries.push(closeOpen(t));
    let cut = t.length;
    for (let n = 0; n < 12; n++) {
      cut = t.lastIndexOf(',', cut - 1);
      if (cut <= 0) break;
      tries.push(closeOpen(t.slice(0, cut)));
    }
  }
  for (const raw of tries) {
    for (const fix of [
      (x) => x,
      (x) => x.replace(/,\s*([}\]])/g, '$1'),
      (x) =>
        x
          .replace(/^\s*\/\/.*$/gm, '')
          .replace(/,\s*([}\]])/g, '$1')
          .replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":'),
    ]) {
      try {
        const o = JSON.parse(fix(raw));
        if (o && typeof o === 'object') return o;
      } catch {
        // try the next repair
      }
    }
  }
  return null;
}

/** Closes the strings, arrays and objects left open at the end of `t`. */
function closeOpen(t) {
  let inStr = false,
    esc = false;
  const stack = [];
  for (const ch of t) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return t + (inStr ? '"' : '') + stack.reverse().join('');
}

/** Parses the vision model's reply into a LayoutPlan, tolerating code fences and prose. */
export function parseLayoutPlan(text) {
  const obj = looseJson(text);
  if (!obj) return null;
  try {
    const regions = Array.isArray(obj.regions) ? obj.regions : [];
    return {
      subject: String(obj.subject ?? ''),
      style: obj.style ? String(obj.style) : undefined,
      regions: regions
        .filter((r) => r && r.name)
        .map((r) => ({
          name: String(r.name),
          description: r.description ? String(r.description) : undefined,
          bbox:
            Array.isArray(r.bbox) && r.bbox.length === 4 && r.bbox.every((n) => Number.isFinite(Number(n)))
              ? r.bbox.map((n) => Math.round(Number(n)))
              : undefined,
        })),
      raw: text,
    };
  } catch {
    return null;
  }
}

/**
 * Art-director prompt: Muse Spark sees six axis renders plus the UV atlases, works out
 * what the object is, and writes a stronger, part-by-part paint prompt for the theme.
 */
export function suggestPrompt(theme, atlases, hasSheet = true, hasIdSheet = false, lessons = []) {
  const first = (hasSheet ? 1 : 0) + (hasIdSheet ? 1 : 0) + 1;
  const atlasLines = atlases.flatMap((a, i) => [
    `Image ${i + first}: UV texture atlas "${a.name}" with each part tinted in its own color and labelled with its name and an arrow pointing to the part's top.`,
    ...partLines(a.parts, { colors: true }),
  ]);
  return [
    'You are the art director for retexturing a 3D game asset.',
    hasSheet
      ? 'Image 1 is a contact sheet with six orthographic renders of the model: front (+Z), back (-Z), left (-X), right (+X), top (+Y), bottom (-Y).'
      : '',
    hasIdSheet
      ? `Image ${hasSheet ? 2 : 1} shows the same views with every texture area in its own flat color: the same colors as the areas in the atlas images, so you can see which atlas area is which part of the model.`
      : '',
    ...atlasLines,
    `The user wants to retheme the model as: "${theme}".`,
    lessons.length ? 'Lessons learned from reviews of earlier results (follow them):' : '',
    ...lessons.map((l) => `- ${l}`),
    'Work out what the object is and which atlas regions belong to which visible part. Then write the best possible instruction for an image model that will repaint each atlas while keeping its exact layout.',
    'Reply with JSON only, no prose, in this shape:',
    '{"subject": "what the object is, one line",',
    ` "assetClass": "one of: ${assetClassIds().join(', ')}",`,
    ' "parts": [{"name": "visible part", "description": "what it looks like now"}],',
    ' "prompt": "2-4 sentences: the improved theme prompt, naming concrete colors, materials and motifs for each part, flat unlit albedo, no text",',
    ' "atlases": [{"index": 1, "regions": [{"name": "part name", "bbox": [x0, y0, x1, y1], "paint": "what to paint there in the new theme"}]}],',
    ' "tips": "optional one-line note for the user"}',
    'Keep the recommended prompt family friendly: no blood, gore, injuries, weapons, real people or brands, because the image model has a strict safety filter. Express dark or scary themes through color, pattern and costume (for example "spooky", "eerie", "Halloween"), not violence.',
    'Region names must use the exact part names listed for each atlas where they apply, and a face or other detail must go only inside the part it belongs to (for example the face goes in the head part, never in the hair).',
    'Atlas "index" counts the atlas images from 1. bbox is on a 0-1000 grid of that atlas image, origin top-left. At most 12 regions per atlas.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Parses the art-director reply. Returns null if it is not usable JSON. */
export function parseSuggestion(text) {
  const o = looseJson(text);
  if (!o) return null;
  try {
    const bbox = (b) =>
      Array.isArray(b) && b.length === 4 && b.every((n) => Number.isFinite(Number(n)))
        ? b.map((n) => Math.round(Number(n)))
        : undefined;
    return {
      subject: String(o.subject ?? ''),
      assetClass: o.assetClass ? String(o.assetClass) : undefined,
      prompt: String(o.prompt ?? '').trim(),
      tips: o.tips ? String(o.tips) : undefined,
      parts: (Array.isArray(o.parts) ? o.parts : [])
        .filter((p) => p && p.name)
        .map((p) => ({ name: String(p.name), description: p.description ? String(p.description) : undefined })),
      atlases: (Array.isArray(o.atlases) ? o.atlases : []).map((a) => ({
        index: Number(a.index),
        regions: (Array.isArray(a.regions) ? a.regions : [])
          .filter((r) => r && r.name)
          .map((r) => ({ name: String(r.name), bbox: bbox(r.bbox), paint: r.paint ? String(r.paint) : undefined })),
      })),
      raw: text,
    };
  } catch {
    return null;
  }
}

/** True for part names that hold a face (eyes, nose, mouth). */
export function isFacePart(name) {
  if (/\b(hair|hands?|body)\)/i.test(name ?? '')) return false; // a non-face zone of a head mesh
  return /\b(head|face|skull|helmet)\b/i.test(name ?? '');
}

/**
 * Prompt for painting one part (or one region of a part) on its own. Image 1 is the area
 * cut out of the atlas, already turned upright, with everything else grey. Image 2 is its
 * facing map: which way each area faces on the model. Image 3, if sent, is an area that
 * was already painted, as the style reference.
 */
export function reskinPartPrompt(
  theme,
  { partName, subject, paint, others, extra, facing, facingLayout, facingStrips, classRules, styleRef, areaTheme } = {},
) {
  const face = isFacePart(partName);
  const lines = [
    `Image 1 is the "${partName}" area of a 3D model's UV texture (base color / albedo), cut out on its own and shown upright. Flat grey (#808080) is not part of it.`,
    'Image 2 is its mask: white = this area, black = not part of it.',
    styleRef
      ? 'Image 3 is another area of the same model that is already painted in the new theme: match its palette and level of detail, but paint what belongs in this area (do not copy its garment or details here).'
      : '',
    subject && !areaTheme ? `The model is: ${subject}.` : '',
    facing ? `On the model this area is ${facing}.` : '',
    facingLayout ? `Where each side is in image 1 (3x3 grid): ${facingLayout}.` : '',
    facingStrips
      ? `Image 1 is laid out as strips that wrap around the body part (exact, from the 3D model): ${facingStrips}. "Inner side" faces the other arm or leg (or the body), "outer side" faces away. Each strip is one straight column covering the full height of the area: fill every column edge to edge (no gaps, wedges or curved trouser-leg shapes between them). Neighbouring strips meet on the model, so the fabric continues across them; pockets, buttons and other front details go only inside front strips and never span two strips.`
      : '',
    areaTheme
      ? `Repaint every white-mask pixel of image 1 as: "${areaTheme}".`
      : `Repaint every white-mask pixel of image 1 in this theme: "${theme}".`,
    "The theme may describe the whole character or object: use only what belongs on this area, at this area's scale. Never draw the character, a person, a figure or a portrait inside this area.",
    paint ? `For the ${partName}: ${paint}` : '',
    others?.length
      ? `The other areas (${others.slice(0, 8).join(', ')}) are painted separately in the same theme, so use one consistent palette and style.`
      : '',
    'Rules:',
    '- Keep every shape at exactly the same position, size and orientation, and keep the same framing. Do not crop, zoom, rotate, mirror or add borders.',
    '- Cover the whole white-mask area edge to edge with the new material, including thin strips along the edges (these are the sides of the part). Leave no patches of the old colors or skin showing, and no black or dark gaps.',
    '- Image 1 is a flattened (unwrapped) surface, not a picture of an object: fill the white area with the surface material itself, like fabric printed on a flat sheet, with no outlines, silhouettes or other objects drawn in it.',
    '- Front details (buttons, plackets, pockets, collars, emblems, buckles) only where the grid says front. Back areas get the plain back of the same material with no buttons or emblems.',
    '- Keep each decoration (chains, straps, emblems) whole inside one connected area: separate areas are not next to each other on the model.',
    '- Paint flat, unlit albedo color: no baked shadows, no highlights, no perspective, no lettering.',
    '- Ignore the grey areas; they will be discarded.',
  ];
  for (const r of classRules ?? []) lines.push(`- ${r}`);
  if (!face && !/hair/i.test(partName ?? ''))
    lines.push('- No head accessories here (goggles, glasses, hats, headbands): they belong on the head only.');
  if (face) {
    lines.push(
      '- This part is the face texture itself: skin with the eyes, brows, nose and mouth exactly where they are now, at the same size. It is not a picture of the character: no portrait, body, clothes or background inside it.',
      '- Draw any face accessory (goggles, glasses, mask) only once, directly over the existing eyes, never on the forehead or in the hair. Never draw a second pair of eyes or a second accessory.',
      '- No hair, beard, sideburns or fur anywhere in this area: hair is a separate area. Everything around the eyes, nose and mouth is plain skin.',
      '- There is exactly one face: where the eyes, nose and mouth already are. Every other piece of this area (back and sides of the head, ears, neck, small separate pieces) is plain skin or hair, never a second face or a copy of the face.',
    );
  }
  if (extra) lines.push(extra);
  return lines.filter(Boolean).join('\n');
}

/**
 * Splits a whole-model theme into one short surface description per texture area, so each
 * area's image prompt never mentions the whole character (Muse otherwise draws a small
 * portrait of the character inside the area).
 */
export function areaThemesPrompt(theme, areas, subject) {
  return [
    `A 3D model${subject ? ` (${subject})` : ''} is being repainted in this theme: "${theme}".`,
    'Each texture area below is painted separately by an image model that only sees that area as a flat, unwrapped surface.',
    'For each area write one short description (at most 20 words) of the surface material, colors and pattern that belong on that area only, in this theme.',
    'Head accessories (goggles, glasses, hats, headbands) belong to the face area only: never put them in another area.',
    'Never mention the character, a person, a figure, a body or a scene. Describe only the material and details of that area (for the face: skin tone, makeup, facial features; for hair: hair color and texture).',
    'Areas:',
    ...areas.map((a) => `- ${a}`),
    'Reply with JSON only: {"areas": {"exact area name": "description", ...}}',
  ].join('\n');
}

/** Parses the area-theme reply into a Map of area name -> description. */
export function parseAreaThemes(text, names) {
  const o = looseJson(text);
  const src = o && typeof o.areas === 'object' && o.areas ? o.areas : o;
  const out = new Map();
  if (!src || typeof src !== 'object') return out;
  const lower = new Map(Object.entries(src).map(([k, v]) => [k.toLowerCase().trim(), v]));
  for (const n of names) {
    const v = lower.get(n.toLowerCase().trim());
    if (typeof v === 'string' && v.trim()) out.set(n, v.trim().slice(0, 300));
  }
  return out;
}

/** Plain per-part fallback after a content-filter rejection. */
export function plainReskinPartPrompt(theme, partName) {
  return `Recolor this game texture of a ${partName} in a "${theme}" style. Keep every shape in exactly the same place and size. Flat colors, no lighting. Ignore the grey areas.`;
}

/**
 * Review prompt: one image with the painted model from eight angles (top two rows) and
 * the same angles as an ID map (bottom two rows). Muse lists what is wrong, per area.
 */
export function reviewPrompt(theme, { areas = [], subject, classRules = [] } = {}) {
  return [
    'You are reviewing a retextured 3D game asset before it ships.',
    'The image has four rows. Rows 1-2: the newly painted model from eight angles (front, front 45°, side, top, back, back 45°, side, bottom). Rows 3-4: the same eight angles with every texture area in its own flat color (an ID map).',
    subject ? `The model is: ${subject}.` : '',
    `The requested theme was: "${theme}".`,
    'Texture areas (exact names) and their ID-map colors:',
    ...areas.map((a) => `- ${a.name}${a.color ? ` = ${a.color}` : ''}${a.facing ? ` (${a.facing})` : ''}`),
    classRules.length ? 'Rules this asset should follow:' : '',
    ...classRules.map((r) => `- ${r}`),
    'Look for: front details repeated on the back, details on the wrong part, doubled features, stripes or patches of the old texture or skin, designs cut off at seams (chains, straps), areas that do not match the theme or the rest of the model, garments that stop partway round a limb.',
    'Reply with JSON only, no prose:',
    '{"ok": true or false, "summary": "one line", "issues": [{"area": "exact area name from the list", "problem": "what is wrong", "fix": "one sentence instruction for repainting that area"}], "lessons": ["general rule"]}',
    '"lessons": 0-2 short, general rules that would have avoided these problems on ANY model of this kind (not specific to this model, theme or area names), e.g. "Keep chest details on front-facing areas only". Empty if nothing general was learned.',
    'At most 4 issues, most visible first. Only list real, clearly visible problems; an empty list is fine. Keep the wording family friendly.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Parses the review reply. */
export function parseReview(text) {
  const o = looseJson(text);
  if (!o) return { ok: true, summary: '', issues: [], lessons: [], raw: text };
  try {
    const issues = (Array.isArray(o.issues) ? o.issues : [])
      .filter((x) => x && (x.problem || x.fix))
      .slice(0, 4)
      .map((x) => ({
        area: x.area ? String(x.area) : '',
        problem: x.problem ? String(x.problem) : '',
        fix: x.fix ? String(x.fix) : '',
      }));
    const lessons = (Array.isArray(o.lessons) ? o.lessons : [])
      .map((x) => String(x ?? '').trim())
      .filter((x) => x.length > 8 && x.length < 240)
      .slice(0, 2);
    return { ok: o.ok !== false && !issues.length, summary: String(o.summary ?? ''), issues, lessons, raw: text };
  } catch {
    return { ok: true, summary: '', issues: [], lessons: [], raw: text };
  }
}
