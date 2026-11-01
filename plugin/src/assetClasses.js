/**
 * Asset classes: extra prompt rules for each kind of 3D asset. The class is detected by
 * the art-director step (Muse Spark names it from the six views), else from the model's
 * part names, and the user can override it.
 *
 * Adding a class is adding an entry (or calling registerAssetClass):
 *   id        short key, also what Muse is asked to answer with
 *   label     shown in the UI
 *   keywords  regex tested against the subject and part names for the offline guess
 *   rules     prompt lines for every paint call of this class
 *   parts     [{ match: regex on the part name, rules: [...] }] extra lines for matching parts
 *   seamless  true if the texture should wrap around (sky, terrain)
 */

/** @typedef {{ id: string, label: string, keywords?: RegExp, rules: string[], parts?: { match: RegExp, rules: string[] }[], seamless?: boolean }} AssetClass */

const NO_SEAM_CROSSING =
  'Keep each decoration (chains, straps, emblems, stripes that end) whole inside one area of the texture. Separate areas are not next to each other on the model, so a design crossing an area edge gets cut off.';

/** @type {AssetClass[]} */
export const ASSET_CLASSES = [
  {
    id: 'avatar',
    label: 'Avatar / character',
    keywords:
      /\b(avatar|character|human|person|girl|boy|man|woman|doll|hero|npc|body|torso|head|hair|hands?|legs?|pants|shirt|shoes?|arms?)\b/i,
    rules: [
      'This is a character. Front details (buttons, zips, V-necks, collars, pockets, badges, buckles, a pocket watch, a face) go only on front-facing areas. The back of a garment is a plain continuation of the same fabric without front details.',
      'Each garment covers its whole area on every side: sleeves, trousers, gloves and shoes leave no strips of skin or of the old colors.',
      'Separate areas of the same part use the same fabric, pattern and colors.',
      'Keep skin as skin (it may change tone for the theme) unless the theme is a costume, robot or creature.',
      NO_SEAM_CROSSING,
    ],
    parts: [
      {
        match: /\b(head|face|skull)\b/i,
        rules: [
          'Face: eyes, nose and mouth stay exactly where they are. Glasses, goggles or a mask are drawn once, over the existing eyes.',
        ],
      },
      {
        match: /\bhair\b/i,
        rules: [
          'Hair: paint it as plain hair in one hair color that suits the theme (with strand flow), never skin-colored. No patterns, symbols, gears, logos or decorations in the hair, no goggles, hats or other accessories; no face or skin here.',
        ],
      },
      {
        match: /\b(hands?|gloves?|fingers?)\b/i,
        rules: [
          'Hands: if they get gloves, the gloves cover the whole hand area including the back of the hand, both sides, the palm and every finger.',
        ],
      },
      {
        match: /\b(feet|foot|shoes?|boots?|sneakers?)\b/i,
        rules: [
          'Shoes: this area is the whole shoe unwrapped flat (toe, both sides, heel and top), not a front view of a shoe. Cover all of it in the shoe material; laces, tongue and toe cap only on the parts the grid says are front or top, plain shoe material on the sides and heel, soles on the bottom parts.',
        ],
      },
      {
        match: /\b(arms?|sleeves?)\b/i,
        rules: [
          'Arms: long sleeves that cover the whole arm area from shoulder to wrist, all the way round, in the outfit fabric. No bare skin, no short sleeves, no cuffs halfway; the hands are a separate area.',
          'The arm area is one arm unwrapped: side-by-side vertical strips (front, outer side, back, inner side) that wrap around the arm, shoulder at the top and wrist at the bottom, and the leftmost strip joins the rightmost one. Paint every strip as the same sleeve so they match where they meet; stripes go across all strips at the same heights.',
          'Both arms often share this one piece of texture (mirrored), so keep it symmetric: no detail that belongs on only one arm, and no lettering.',
        ],
      },
      {
        match: /\b(torso|chest|shirt|jacket|vest|coat|upper)\b/i,
        rules: [
          'Torso: paint only the garment body (front, sides, back). The arms and hands are separate areas: no sleeves, cuffs, gloves, arms or hands in this area, even at its edges. The garment covers the whole area, including the side strips and the top and bottom edges.',
        ],
      },
      {
        match: /\b(pants|trousers|legs?|skirt|shorts|lower)\b/i,
        rules: [
          'Trousers cover each leg all the way round in the same fabric, including the outer and inner side strips; no skin shows anywhere on the legs. Fill the whole area edge to edge: do not draw the outline of a pair of trousers, shoes or feet.',
          'Each leg is unwrapped as side-by-side vertical strips (front, outer side, back, inner side) that wrap around the leg, hip at the top and ankle at the bottom: paint all strips as the same fabric so they match where they meet.',
        ],
      },
    ],
  },
  {
    id: 'creature',
    label: 'Creature / animal',
    keywords:
      /\b(creature|animal|monster|dragon|dog|cat|bird|fish|horse|beast|dino\w*|insect|fur|tail|paws?|wings?)\b/i,
    rules: [
      'This is a creature. Fur, scales or skin patterns follow the body; the belly and underside (bottom areas) are usually lighter.',
      'Eyes, mouth and nose stay exactly where they are.',
      NO_SEAM_CROSSING,
    ],
  },
  {
    id: 'vehicle',
    label: 'Vehicle',
    keywords:
      /\b(vehicle|car|truck|bus|tank|ship|boat|plane|aircraft|jet|spaceship|bike|motorcycle|train|kart|wheels?|tires?|hull|wing)\b/i,
    rules: [
      'This is a vehicle. Paint body panels with continuous paint; keep panel lines where they are.',
      'Decals and stripes stay inside one panel. Windows stay glass (dark or reflective), lights stay lights, tires stay dark rubber.',
      'No readable text, numbers or brand logos.',
      NO_SEAM_CROSSING,
    ],
  },
  {
    id: 'weapon',
    label: 'Tool / handheld item',
    keywords: /\b(sword|blade|axe|hammer|tool|staff|wand|bow|shield|gun|rifle|pistol|spear|knife|handle|grip)\b/i,
    rules: [
      'This is a handheld item. Keep the grip, metal and trim zones as separate materials; edges and bevels stay where they are.',
      'Decorations follow the length of the item and stay inside one area.',
    ],
  },
  {
    id: 'furniture',
    label: 'Furniture',
    keywords: /\b(chair|table|desk|sofa|couch|bed|cabinet|shelf|drawer|lamp|bench|stool|furniture)\b/i,
    rules: [
      'This is furniture. Wood grain runs along the long side of each piece; upholstery and cushions get fabric, legs and frames get wood or metal.',
      NO_SEAM_CROSSING,
    ],
  },
  {
    id: 'building',
    label: 'Building / structure',
    keywords: /\b(building|house|tower|castle|wall|roof|door|window|bridge|structure|facade|temple|shop|hut|floor)\b/i,
    rules: [
      'This is a building. Windows, doors and trim stay exactly where they are; walls get brick, stone, wood or plaster in even courses; top (magenta) areas are roofs.',
      'Keep the scale of bricks and planks consistent across all walls. No readable signs or text.',
    ],
  },
  {
    id: 'terrain',
    label: 'Terrain / ground',
    keywords: /\b(terrain|ground|landscape|floor|grass|sand|rock|cliff|island|heightmap)\b/i,
    seamless: true,
    rules: [
      'This is terrain. Natural ground materials seen from above with low-contrast, large-scale color variation; no objects, no shadows, no horizon.',
    ],
  },
  {
    id: 'vegetation',
    label: 'Vegetation',
    keywords: /\b(tree|plant|bush|leaf|leaves|flower|foliage|grass|vine|bark|trunk|branch)\b/i,
    rules: ['This is vegetation. Leaves keep their silhouettes exactly; bark runs along the trunk and branches.'],
  },
  {
    id: 'sky',
    label: 'Sky / skybox',
    keywords: /\b(sky|skybox|skydome|clouds?|horizon|space|stars|environment)\b/i,
    seamless: true,
    rules: [
      'This is a sky. Keep the horizon at the same height; the left and right edges must join seamlessly; the top is straight up. No ground objects or text.',
    ],
  },
  {
    id: 'prop',
    label: 'Prop / object',
    keywords: /\b(prop|box|crate|barrel|bottle|cup|toy|robot|machine|statue|chest|item|object)\b/i,
    rules: [
      'This is a prop. Keep each material zone (metal, wood, cloth, glass, plastic) where it is and give each a material suited to the theme.',
      NO_SEAM_CROSSING,
    ],
  },
  { id: 'generic', label: 'Other', rules: [] },
];

/** Adds or replaces a class definition. */
export function registerAssetClass(def) {
  if (!def?.id) throw new Error('Asset class needs an id');
  const i = ASSET_CLASSES.findIndex((c) => c.id === def.id);
  const entry = { rules: [], ...def };
  if (i >= 0) ASSET_CLASSES[i] = entry;
  else ASSET_CLASSES.splice(ASSET_CLASSES.length - 1, 0, entry); // keep 'generic' last
  return entry;
}

export function getAssetClass(id) {
  return ASSET_CLASSES.find((c) => c.id === id) ?? null;
}

/** Normalizes a free-text class from Muse ("Character", "car") to a registry id. */
export function normalizeAssetClass(text) {
  if (!text) return null;
  const t = String(text).trim().toLowerCase();
  const exact = ASSET_CLASSES.find((c) => c.id === t || c.label.toLowerCase() === t);
  if (exact) return exact.id;
  const byWord = ASSET_CLASSES.find((c) => c.keywords?.test(t));
  return byWord?.id ?? null;
}

/**
 * Offline guess from the subject line and part names. Picks the class with the most
 * keyword hits; 'generic' when nothing matches.
 */
export function detectAssetClass({ subject = '', partNames = [], modelName = '' } = {}) {
  const words = [subject, modelName, ...partNames].join(' | ');
  let best = 'generic',
    bestHits = 0;
  for (const c of ASSET_CLASSES) {
    if (!c.keywords) continue;
    const re = new RegExp(c.keywords.source, 'gi');
    const hits = (words.match(re) ?? []).length;
    if (hits > bestHits) {
      best = c.id;
      bestHits = hits;
    }
  }
  return best;
}

/** Prompt lines for a class, plus the part-specific ones for `partNames`. */
export function assetClassRules(id, partNames = []) {
  const c = getAssetClass(id);
  if (!c) return [];
  const lines = [...c.rules];
  for (const p of c.parts ?? []) {
    if (partNames.some((n) => p.match.test(n))) lines.push(...p.rules);
  }
  return lines;
}

/** The ids, for the art-director prompt. */
export function assetClassIds() {
  return ASSET_CLASSES.map((c) => c.id);
}
