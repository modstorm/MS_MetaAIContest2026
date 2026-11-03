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
 *   topBottom names for splitting a part by facing into rest / top / bottom areas (a building's
 *             walls, roof and underside); see splitTopBottom
 *   samCheck  { zone: [noun phrase | { concept, minShare, maxShare, minConfidence }] } things SAM 3.1
 *             must NOT find newly painted in that zone; a hit repaints the area once (see samCheck.js)
 *   samZones  { concepts: [{ zone, concept }], rest } noun phrases SAM 3.1 looks for to find paint zones on
 *             a model with no profile (samZones.js); `rest` names what no phrase covered. Without
 *             a list, the part names from Muse's suggestion are used.
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
          'Hands: this area is the hands themselves (palm, back of the hand, fingers), not a sleeve. Paint skin, or gloves if the theme suggests them; gloves cover the whole hand area including the back of the hand, both sides, the palm and every finger. The sleeve fabric stops at the wrist and is not continued here.',
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
          'Torso: this area is only the body of the garment (front, sides, back, shoulders). Fill all of it, including the side strips and the top and bottom edges, with the same garment fabric and pattern.',
        ],
      },
      {
        match: /\b(pants|trousers|legs?|skirt|shorts|lower)\b/i,
        rules: [
          'Trousers cover each leg all the way round in the same fabric, including the outer and inner side strips; no skin shows anywhere on the legs. Fill the whole area edge to edge: do not draw the outline of a pair of trousers, shoes or feet.',
          'Shoes are a separate area: the trouser fabric runs all the way to the bottom edge of every strip, with at most a hem. No shoes, boots, laces, soles, feet, faces or creatures anywhere on the legs.',
          'Each leg is unwrapped as side-by-side vertical strips (front, outer side, back, inner side) that wrap around the leg, hip at the top and ankle at the bottom: paint all strips as the same fabric so they match where they meet.',
        ],
      },
    ],
    // Known Muse mistakes: portraits on the face / hands / pants, shoes at the bottom of the
    // legs, a face on the jacket front.
    // A painted face scores 0.80-0.89 for "face" in live tests; a skull emblem scored 0.76, so
    // "face" needs 0.8 (people and shoes score 0.89+).
    samCheck: {
      face: [{ concept: 'person', maxShare: 0.5 }],
      hair: [{ concept: 'face', minConfidence: 0.8 }],
      hands: [{ concept: 'face', minConfidence: 0.8 }, 'person'],
      torso: [{ concept: 'face', minConfidence: 0.8 }, 'person'],
      arms: [{ concept: 'face', minConfidence: 0.8 }, 'person'],
      legs: ['shoe', { concept: 'face', minConfidence: 0.8 }, 'person'],
      shoes: [{ concept: 'face', minConfidence: 0.8 }, 'person'],
    },
    // Zone finding: one SAM image per phrase. Zone names match the body zones above.
    samZones: {
      concepts: [
        { zone: 'face', concept: 'face' },
        { zone: 'hair', concept: 'hair' },
        { zone: 'hands', concept: 'hand' },
        { zone: 'arms', concept: 'arm' },
        { zone: 'shoes', concept: 'shoe' },
        { zone: 'legs', concept: 'leg' },
      ],
      // "shirt" found nothing on any model in the live run; what no phrase covers is the torso.
      rest: 'torso',
    },
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
    samZones: { concepts: ['head', 'leg', 'tail', 'wing'], rest: 'body' },
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
    samZones: {
      concepts: [
        { zone: 'wheels', concept: 'wheel' },
        { zone: 'windows', concept: 'window' },
        { zone: 'lights', concept: 'headlight' },
      ],
      rest: 'body',
    },
  },
  {
    id: 'weapon',
    label: 'Tool / handheld item',
    keywords: /\b(sword|blade|axe|hammer|tool|staff|wand|bow|shield|gun|rifle|pistol|spear|knife|handle|grip)\b/i,
    rules: [
      'This is a handheld item. Keep the grip, metal and trim zones as separate materials; edges and bevels stay where they are.',
      'Decorations follow the length of the item and stay inside one area.',
    ],
    samZones: {
      concepts: [
        { zone: 'blade', concept: 'blade' },
        { zone: 'handle', concept: 'handle' },
      ],
      rest: 'body',
    },
  },
  {
    id: 'furniture',
    label: 'Furniture',
    keywords: /\b(chair|table|desk|sofa|couch|bed|cabinet|shelf|drawer|lamp|bench|stool|furniture)\b/i,
    rules: [
      'This is furniture. Wood grain runs along the long side of each piece; upholstery and cushions get fabric, legs and frames get wood or metal.',
      NO_SEAM_CROSSING,
    ],
    samZones: {
      concepts: [
        { zone: 'cushions', concept: 'cushion' },
        { zone: 'legs', concept: 'furniture leg' },
      ],
      rest: 'frame',
    },
  },
  {
    id: 'building',
    label: 'Building / structure',
    // Not door / window / wall / floor: cars, rooms and props have parts named that too.
    keywords:
      /\b(building|buildings|house|houses|tower|castle|roof|rooftop|bridge|structure|facade|temple|shop|hut|cottage|barn|church|cabin|warehouse|skyscraper|apartment)\b/i,
    rules: [
      'This is a building. Windows, doors and trim stay exactly where they are; walls get brick, stone, wood or plaster in even courses; top (magenta) areas are roofs.',
      'Keep the scale of bricks and planks consistent across all walls. No readable signs or text.',
    ],
    // Up-facing surfaces are the roof (a simple material), down-facing ones the underside (flat black); see splitTopBottom.
    topBottom: {
      rest: 'walls',
      restZone: 'walls',
      top: 'roof',
      topZone: 'roof',
      bottom: 'underside',
      bottomZone: 'underside',
    },
    parts: [
      {
        match: /\(roof\)/i,
        rules: [
          'This area is the roof, seen from straight above. Paint only roof covering (tiles, slates, shingles, gravel, planks or a flat slab) and keep any vents, chimneys or skylights already there. No walls, bricks in wall courses, windows, doors, ledges or a facade: it is not a wall.',
        ],
      },
    ],
    samZones: {
      concepts: [
        { zone: 'windows', concept: 'window' },
        { zone: 'doors', concept: 'door' },
        { zone: 'roof', concept: 'roof' },
      ],
      rest: 'walls',
    },
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
    samZones: {
      concepts: [
        { zone: 'leaves', concept: 'leaves' },
        { zone: 'trunk', concept: 'tree trunk' },
      ],
      rest: 'plant',
    },
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
  {
    id: 'material',
    label: 'Tiling material / track',
    keywords: /\b(track|road|asphalt|pavement|tiles?|tiling|tileable|seamless)\b/i,
    seamless: true,
    rules: [
      'This is a tiling surface material. Keep the scale of the pattern; no single objects, no perspective, no lighting baked in.',
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
/** "Prop_Barrel01" / "propBarrel" → "Prop Barrel 01" / "prop Barrel", so word matches work. */
export function splitWords(name) {
  return String(name ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ');
}

export function normalizeAssetClass(text) {
  if (!text) return null;
  const t = splitWords(String(text)).trim().toLowerCase();
  const exact = ASSET_CLASSES.find((c) => c.id === t || c.label.toLowerCase() === t);
  if (exact) return exact.id;
  // "prop (storage barrel)", "Prop / object": a class id as the first word wins.
  const first = t.match(/[a-z]+/)?.[0];
  const lead = ASSET_CLASSES.find((c) => c.id === first);
  if (lead) return lead.id;
  // Otherwise the class with the most keyword hits (not the first one in the list that has any).
  const best = detectAssetClass({ subject: t });
  return best === 'generic' ? null : best;
}

/**
 * Offline guess from the subject line and part names. Picks the class with the most
 * keyword hits; 'generic' when nothing matches.
 */
export function detectAssetClass({ subject = '', partNames = [], modelName = '' } = {}) {
  const words = [subject, modelName, ...partNames].map(splitWords).join(' | ');
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
