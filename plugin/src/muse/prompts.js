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

/** Rules that must come first in a paint prompt (they start with "MOST IMPORTANT RULE"). */
const isTopRule = (r) => /^MOST IMPORTANT RULE/i.test(String(r).trim());

export function reskinAtlasPrompt(theme, plan, extra, parts) {
  const extraLines = String(extra ?? '')
    .split('\n')
    .filter((l) => l.trim());
  const top = extraLines.filter(isTopRule);
  extra = extraLines.filter((l) => !isTopRule(l)).join('\n');
  const multi = parts?.length > 1;
  const lines = [
    multi
      ? 'Image 1 is a UV texture atlas (base color / albedo) that wraps a 3D model. Image 2 is a part map: the same layout with each part of the model filled in its own flat color.'
      : 'Image 1 is a UV texture atlas (base color / albedo) that wraps a 3D model. Image 2 shows its UV island layout.',
    `Repaint the atlas in this theme: "${theme}".`,
    ...top,
    'Rules:',
    '- Keep the exact same layout. Every painted island must stay at the same position, size, shape and orientation so the texture still wraps the model correctly.',
    '- Keep the same image framing and aspect ratio. Do not crop, zoom, rotate, mirror or add borders.',
    '- Paint flat, unlit albedo color: no baked shadows, no highlights, no perspective, no lettering.',
    multi
      ? '- Image 2 is only a guide: do not copy its flat colors. Paint each part only inside its own colored area, and repaint every part.'
      : '- Image 2 is only a mask (white = used by the model): do not copy it, and do not draw any outlines, edges or wireframe lines.',
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
    `One seamless surface texture${materialName && !isPlaceholderName(materialName) ? ` for the material "${materialName}"` : ''} of a 3D model, theme: "${theme}".`,
    'Orthographic top-down view of the surface, flat even lighting, no shadows, no perspective, no objects, no text.',
    'The left/right and top/bottom edges must join without visible seams when the image is placed next to itself.',
    'The image is ONE single picture of the surface filling the whole square: never a smaller tile repeated inside it (no 2×2, 3×3 or 4×4 copies). Every panel, plank, tile or stone in it differs a little (wear, size, color).',
    extra ?? '',
  ]
    .join('\n')
    .trim();
}

/**
 * True for names that say nothing about the look and would pull Muse towards a grid or a
 * checker ("Grid", "Checker", "proto_mat", "Material.001", "default", "uv_test", "texture3").
 */
export function isPlaceholderName(name) {
  return (
    /^(?:[\W_]*(?:grid|checker\w*|proto\w*|prototype|placeholder|default|material|mat|texture|tex|image|img|untitled|uv\w*|test|dev|blockout|greybox|graybox|none|new)[\W_]*\d*)+$/i.test(
      String(name).trim(),
    ) ||
    /\b(grid|checker\w*|proto\w*|placeholder|blockout|gr[ae]ybox|uv[ _-]?test)\b/i.test(
      String(name).replace(/[_.-]/g, ' '),
    )
  );
}

/**
 * A new image with transparency: the subject alone on a flat key color (stripped afterwards).
 * @param {string} theme
 * @param {{ name?: string, context?: string, classRules?: string[], keyNote: string }} o
 */
export function cutoutPrompt(theme, { name, context, classRules = [], keyNote }) {
  return [
    `A game image${name && !isPlaceholderName(name) ? ` ("${name}")` : ''}: ${theme}.`,
    context ? `What it is used for: ${context}.` : '',
    ...classRules,
    keyNote,
    'No text, no logos, no watermark, no border.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * One standalone texture (not a model atlas): a tiling material, a track surface or an
 * equirectangular sky panorama. `wrap` says which edges must join.
 * @param {string} theme
 * @param {{ name?: string, context?: string, classRules?: string[], wrap?: 'both' | 'x' | 'y' | 'none' | 'equirect' }} [o]
 */
export function reskinTexturePrompt(theme, { name, context, classRules = [], wrap = 'none' } = {}) {
  const sky = wrap === 'equirect';
  return [
    sky
      ? 'The image is an equirectangular 360° sky panorama (2:1). The left and right edges are the same direction, the top row is straight up and the bottom row straight down.'
      : `The image is a ${wrap === 'none' ? '' : 'seamless, tiling '}game surface texture${name ? ` ("${name}")` : ''} (base color / albedo), seen flat on, not a photo of an object.`,
    `Repaint it in this theme: "${theme}".`,
    context ? `What it is used for: ${context}.` : '',
    sky
      ? 'Keep the horizon at exactly the same height and keep it level and straight. Keep the same projection: no fisheye, no perspective change, no frame or border. The zenith and nadir rows stay calm (sky or ground color only, no objects). The left and right edges must join seamlessly.'
      : 'Keep the same layout and scale of the pattern (stripes, lines, tiles, markings stay where they are and the same size). Flat even lighting: no shadows, no highlights, no vignette, no perspective.',
    wrap === 'both'
      ? 'The left/right and top/bottom edges must tile seamlessly: nothing may touch or cross an edge differently on the opposite side.'
      : '',
    wrap === 'x' ? 'The left and right edges must join seamlessly.' : '',
    wrap === 'y' ? 'The top and bottom edges must join seamlessly.' : '',
    ...classRules,
    'No text, no logos, no watermark, no border.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Plain fallback for reskinTexturePrompt after a safety-filter rejection. */
export function plainReskinTexturePrompt(theme, wrap = 'none') {
  return wrap === 'equirect'
    ? `Recolor this 360° sky panorama in a "${theme}" style. Keep the horizon level at the same height; the left and right edges must join.`
    : `Recolor this game surface texture in a "${theme}" style. Keep the pattern in the same place and size; flat even lighting${wrap === 'none' ? '' : '; the edges must tile seamlessly'}.`;
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
    ` "partRoles": {"exact part name": "one of: ${PART_ROLES.join(', ')}"},`,
    ' "prompt": "2-4 sentences: the improved theme prompt, naming concrete colors, materials and motifs for each part, flat unlit albedo, no text",',
    ' "atlases": [{"index": 1, "regions": [{"name": "part name", "bbox": [x0, y0, x1, y1], "paint": "what to paint there in the new theme"}]}],',
    ' "tips": "optional one-line note for the user"}',
    'Keep the recommended prompt family friendly: no blood, gore, injuries, weapons, real people or brands, because the image model has a strict safety filter. Express dark or scary themes through color, pattern and costume (for example "spooky", "eerie", "Halloween"), not violence.',
    'partRoles: for EVERY part listed for the atlases (exact names), say what that part really is, judged from the renders and the part map, not from its name (names can be wrong or shared by a whole group).',
    'Region names must use the exact part names listed for each atlas where they apply, and a face or other detail must go only inside the part it belongs to (for example the face goes in the head part, never in the hair).',
    'Atlas "index" counts the atlas images from 1. bbox is on a 0-1000 grid of that atlas image, origin top-left. At most 12 regions per atlas.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Art-director step for a model Muse has already studied: text only, reusing what it saw
 * (subject, parts, atlas regions), so a new theme needs no renders or images.
 */
export function suggestFromAnalysisPrompt(theme, analysis, lessons = []) {
  return [
    'You are the art director for retexturing a 3D game asset you have already studied.',
    `The model is: ${analysis.subject || 'unknown'}${analysis.assetClass ? ` (asset class: ${analysis.assetClass})` : ''}.`,
    analysis.parts?.length ? 'Visible parts:' : '',
    ...(analysis.parts ?? []).map((p) => `- ${p.name}${p.description ? `: ${p.description}` : ''}`),
    'Texture atlas regions (keep these names and boxes exactly):',
    ...(analysis.atlases ?? []).flatMap((a) =>
      a.regions.map((r) => `- atlas ${a.index}: "${r.name}"${r.bbox ? ` bbox [${r.bbox.join(', ')}]` : ''}`),
    ),
    `The user wants to retheme the model as: "${theme}".`,
    lessons.length ? 'Lessons learned from reviews of earlier results (follow them):' : '',
    ...lessons.map((l) => `- ${l}`),
    'Write the best possible instruction for an image model that will repaint each region in this theme.',
    'Reply with JSON only, no prose, in this shape:',
    '{"prompt": "2-4 sentences: the improved theme prompt, naming concrete colors, materials and motifs for each part, flat unlit albedo, no text",',
    ' "atlases": [{"index": 1, "regions": [{"name": "exact region name", "bbox": [x0, y0, x1, y1], "paint": "what to paint there in the new theme"}]}],',
    ' "tips": "optional one-line note for the user"}',
    'Keep it family friendly: no blood, gore, injuries, weapons, real people or brands. Express dark or scary themes through color, pattern and costume.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** What a part of a model is, as Muse names it in a suggestion (partRoles). */
export const PART_ROLES = ['body', 'wheel', 'tyre', 'light', 'glass', 'trim', 'interior', 'other'];

/** { "part name": role } with known roles only (synonyms mapped), or undefined. */
export function parsePartRoles(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const alias = {
    tire: 'tyre',
    tires: 'tyre',
    tyres: 'tyre',
    wheels: 'wheel',
    rim: 'wheel',
    lights: 'light',
    lamp: 'light',
    headlight: 'light',
    taillight: 'light',
    window: 'glass',
    windows: 'glass',
    windshield: 'glass',
    paint: 'body',
    panel: 'body',
  };
  const out = {};
  for (const [name, v] of Object.entries(o)) {
    const r = String(v ?? '')
      .toLowerCase()
      .trim();
    const role = PART_ROLES.includes(r) ? r : alias[r];
    if (role) out[name] = role;
  }
  return Object.keys(out).length ? out : undefined;
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
      partRoles: parsePartRoles(o.partRoles),
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
  {
    partName,
    subject,
    paint,
    others,
    extra,
    facing,
    facingLayout,
    facingStrips,
    classRules,
    styleRef,
    areaTheme,
    template,
  } = {},
) {
  const face = isFacePart(partName);
  const lines = [
    `Image 1 is the "${partName}" area of a 3D model's UV texture (base color / albedo), cut out on its own and shown upright. Flat grey (#808080) is not part of it.`,
    'Image 2 is its mask: white = this area, black = not part of it.',
    styleRef
      ? 'Image 3 is another area of the same model that is already painted in the new theme: match its palette and level of detail, but paint what belongs in this area (do not copy its garment or details here).'
      : '',
    template
      ? `Image ${styleRef ? 4 : 3} is the artists' template for this same area, at the same position and size as image 1: its outlines and labels show the garment's panels (front, back, sides, neckline, seams, sleeve parts). Follow it exactly: put each design element in the panel it belongs to, follow the neckline shape it shows, and centre front details on the front panel's centre line. Never draw the template's lines, labels or text.`
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
  for (const r of classRules ?? []) if (!isTopRule(r)) lines.push(`- ${r}`);
  // The most important class rules go right after the first lines, where they are read first.
  const top = (classRules ?? []).filter(isTopRule);
  if (top.length) lines.splice(Math.min(2, lines.length), 0, ...top);
  if (!face && !/hair/i.test(partName ?? ''))
    lines.push(
      '- No head accessories here (goggles, glasses, hats, headbands): they belong on the head only.',
      '- No faces, heads, people, characters or portraits anywhere in this area: only the surface material and its details.',
    );
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
/** What a building roof should be: one plain surface chosen to fit the theme. */
export const ROOF_SURFACE =
  'one simple, uniform roofing surface picked to fit the theme (for example asphalt, shingles, slate tiles, clay tiles, thatch, corrugated metal, tar paper), in colors that suit the theme. Small even units or a plain surface only: no cracks, glow, lava, symbols, large panels, borders or decorations.';

export function areaThemesPrompt(theme, areas, subject) {
  return [
    `A 3D model${subject ? ` (${subject})` : ''} is being repainted in this theme: "${theme}".`,
    'Each texture area below is painted separately by an image model that only sees that area as a flat, unwrapped surface.',
    'For each area write one short description (at most 20 words) of the surface material, colors and pattern that belong on that area only, in this theme.',
    'Head accessories (goggles, glasses, hats, headbands) belong to the face area only: never put them in another area.',
    'Never describe something that belongs to another listed area (for example no shoes or boots in the legs area, no gloves in the arms area, no shirt in the hands area).',
    'Never mention the character, a person, a figure, a body or a scene. Describe only the material and details of that area (for the face: skin tone, makeup, facial features; for hair: hair color and texture).',
    areas.some((a) => /\(roof\)/i.test(a))
      ? `An area named "(roof)" is a roof seen from straight above: ${ROOF_SURFACE} Name it with its colors in at most 12 words.`
      : '',
    'Areas:',
    ...areas.map((a) => `- ${a}`),
    'Reply with JSON only: {"areas": {"exact area name": "description", ...}}',
  ]
    .filter(Boolean)
    .join('\n');
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

/**
 * Change request on a finished reskin: Muse Spark decides which painted areas the user's
 * request touches and what to change in each, so only those are repainted.
 */
export function changePlanPrompt(request, theme, areas, subject) {
  return [
    'A 3D game asset was retextured. The user looked at the result and asks for a change.',
    subject ? `The model is: ${subject}.` : '',
    `The current theme is: "${theme}".`,
    'Its texture areas (exact names), with what each looks like now when known:',
    ...areas.map((a) => `- ${a.name}${a.zone ? ` (${a.zone})` : ''}${a.now ? `: ${a.now}` : ''}`),
    `The user's change request: "${request}".`,
    'Decide which areas this request changes, and for each one write a short, concrete instruction for the image model that edits that area (what to change, and that everything else stays exactly the same). Leave out every area the request does not touch. If the request changes the look of the whole model, list every area.',
    'Reply with JSON only: {"areas": {"exact area name": "instruction"}, "summary": "one line for the user"}',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Parses the change plan: { areas: Map name → instruction, summary }. */
export function parseChangePlan(text, names) {
  const o = looseJson(text) ?? {};
  const areas = parseAreaThemes(JSON.stringify(o.areas ?? {}), names);
  return { areas, summary: typeof o.summary === 'string' ? o.summary.slice(0, 300) : '' };
}
