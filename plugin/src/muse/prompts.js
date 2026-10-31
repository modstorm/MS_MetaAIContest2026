import { orientationNote } from '../analysis/parts.js';

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

/** Parses the vision model's reply into a LayoutPlan, tolerating code fences and prose. */
export function parseLayoutPlan(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
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
export function suggestPrompt(theme, atlases, hasSheet = true) {
  const atlasLines = atlases.flatMap((a, i) => [
    `Image ${i + (hasSheet ? 2 : 1)}: UV texture atlas "${a.name}" with each part tinted in its own color and labelled with its name and an arrow pointing to the part's top.`,
    ...partLines(a.parts, { colors: true }),
  ]);
  return [
    'You are the art director for retexturing a 3D game asset.',
    hasSheet
      ? 'Image 1 is a contact sheet with six orthographic renders of the model: front (+Z), back (-Z), left (-X), right (+X), top (+Y), bottom (-Y).'
      : '',
    ...atlasLines,
    `The user wants to retheme the model as: "${theme}".`,
    'Work out what the object is and which atlas regions belong to which visible part. Then write the best possible instruction for an image model that will repaint each atlas while keeping its exact layout.',
    'Reply with JSON only, no prose, in this shape:',
    '{"subject": "what the object is, one line",',
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
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1));
    const bbox = (b) =>
      Array.isArray(b) && b.length === 4 && b.every((n) => Number.isFinite(Number(n)))
        ? b.map((n) => Math.round(Number(n)))
        : undefined;
    return {
      subject: String(o.subject ?? ''),
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
