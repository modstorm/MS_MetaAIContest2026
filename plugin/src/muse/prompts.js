/** Prompt templates sent to Muse. Kept in one place so they are easy to tune. */

export function visionPlanPrompt(slotName, meshNames) {
  return [
    'You are analyzing a UV texture atlas for a 3D model used in a real-time engine.',
    `Texture name: "${slotName}". Meshes using it: ${meshNames.slice(0, 12).join(', ') || 'unknown'}.`,
    'Image 1 is the base color atlas. Image 2 is the same atlas with the UV island outlines drawn in pink.',
    'Identify what the model is and which part of the model each painted region of the atlas belongs to.',
    'Reply with JSON only, no prose, in this shape:',
    '{"subject": "short description of the model", "style": "current art style", "regions": [{"name": "part name", "description": "what is painted there", "bbox": [x0, y0, x1, y1]}]}',
    'bbox uses a 0-1000 normalized grid of the image, origin at the top-left. List at most 16 regions, largest first.',
  ].join('\n');
}

export function reskinAtlasPrompt(theme, plan, extra) {
  const lines = [
    'Image 1 is a UV texture atlas (base color / albedo) that wraps a 3D model. Image 2 shows its UV island layout.',
    `Repaint the atlas in this theme: "${theme}".`,
    'Critical rules:',
    '- Keep the exact same layout. Every painted island must stay at the same position, size, shape and orientation so the texture still wraps the model correctly.',
    '- Keep the same image framing and aspect ratio. Do not crop, zoom, rotate, mirror or add borders.',
    '- Paint flat, unlit albedo color: no baked shadows, no highlights, no perspective, no text, no watermarks.',
    '- Do not draw the UV outlines from image 2; they are only a guide.',
    '- Fill empty space between islands with colors that match the neighbouring island to avoid seams.',
  ];
  if (plan?.subject) lines.push(`The model is: ${plan.subject}.`);
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
