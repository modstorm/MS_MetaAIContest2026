import { createCanvas, ctx2d } from '../texture/imageUtils.js';

/**
 * Offline provider: no network, no key. Builds a color palette from the theme
 * words and gradient-maps the original atlas through it, so the layout is kept
 * exactly. Useful for judging the pipeline without a Muse key, and in tests.
 */
export class ProceduralProvider {
  name = 'Offline (procedural)';

  async reskinAtlas(req) {
    const palette = paletteForTheme(req.theme);
    const src = req.atlas;
    const out = createCanvas(src.width, src.height);
    const img = ctx2d(src).getImageData(0, 0, src.width, src.height);
    const d = img.data;
    const rand = mulberry32(hash(req.theme));
    const noise = new ValueNoise(rand, 64);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const i = (y * src.width + x) * 4;
        const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        const n = noise.fbm((x / src.width) * 8, (y / src.height) * 8);
        const t = Math.min(1, Math.max(0, lum * 0.85 + (n - 0.5) * 0.3));
        const [r, g, b] = samplePalette(palette, t);
        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
      }
    }
    ctx2d(out).putImageData(img, 0, 0);
    await yieldFrame();
    return out;
  }

  /** Per-part painting: the same gradient map, applied to the part's crop. */
  reskinPart(req) {
    return this.reskinAtlas({ theme: req.theme, atlas: req.image });
  }

  async generateTexture(req) {
    const palette = paletteForTheme(req.theme + req.materialName);
    const w = Math.min(1024, req.width);
    const h = Math.min(1024, req.height);
    const out = createCanvas(w, h);
    const ctx = ctx2d(out);
    const img = ctx.createImageData(w, h);
    const rand = mulberry32(hash(req.theme + req.materialName));
    const noise = new ValueNoise(rand, 8); // period 8 cells => tiles seamlessly
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const n = noise.fbm((x / w) * 8, (y / h) * 8);
        const [r, g, b] = samplePalette(palette, n);
        const i = (y * w + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    await yieldFrame();
    return out;
  }
}

const KEYWORD_PALETTES = [
  [
    /lava|fire|volcan|magma|inferno|hell/i,
    [
      [20, 5, 5],
      [120, 20, 5],
      [230, 90, 10],
      [255, 210, 80],
    ],
  ],
  [
    /ice|frost|snow|frozen|winter|glacier/i,
    [
      [20, 40, 70],
      [80, 140, 200],
      [180, 220, 245],
      [250, 252, 255],
    ],
  ],
  [
    /forest|moss|jungle|leaf|nature|vine|elf/i,
    [
      [15, 30, 10],
      [40, 90, 30],
      [110, 150, 60],
      [200, 210, 120],
    ],
  ],
  [
    /gold|royal|king|treasure|luxury/i,
    [
      [50, 30, 5],
      [140, 95, 20],
      [220, 170, 50],
      [255, 235, 150],
    ],
  ],
  [
    /cyber|neon|synth|tron|futur|sci-?fi/i,
    [
      [10, 5, 30],
      [90, 10, 140],
      [255, 40, 160],
      [40, 240, 255],
    ],
  ],
  [
    /rust|steampunk|copper|bronze|industrial/i,
    [
      [30, 15, 10],
      [110, 50, 25],
      [180, 100, 50],
      [220, 180, 120],
    ],
  ],
  [
    /ocean|sea|water|coral|aqua|underwater/i,
    [
      [5, 20, 40],
      [10, 80, 120],
      [40, 170, 190],
      [210, 240, 230],
    ],
  ],
  [
    /candy|pastel|cute|kawaii|sweet/i,
    [
      [250, 170, 200],
      [190, 160, 250],
      [160, 230, 220],
      [255, 245, 200],
    ],
  ],
  [
    /zombie|toxic|slime|poison|radioactive/i,
    [
      [20, 30, 10],
      [60, 110, 20],
      [140, 220, 40],
      [220, 255, 120],
    ],
  ],
  [
    /stone|rock|marble|granite|ancient|ruin/i,
    [
      [40, 38, 36],
      [95, 90, 85],
      [160, 155, 145],
      [225, 220, 210],
    ],
  ],
  [
    /wood|oak|timber|bark/i,
    [
      [40, 22, 10],
      [100, 60, 30],
      [160, 110, 60],
      [210, 170, 110],
    ],
  ],
  [
    /halloween|pumpkin|spooky/i,
    [
      [15, 5, 20],
      [70, 20, 90],
      [240, 110, 10],
      [255, 190, 60],
    ],
  ],
  [
    /desert|sand|dune|egypt/i,
    [
      [90, 60, 30],
      [170, 120, 70],
      [220, 180, 120],
      [250, 235, 200],
    ],
  ],
  [
    /night|shadow|dark|gothic|void/i,
    [
      [5, 5, 10],
      [30, 25, 50],
      [70, 60, 100],
      [150, 140, 180],
    ],
  ],
];

export function paletteForTheme(theme) {
  for (const [re, pal] of KEYWORD_PALETTES) if (re.test(theme)) return pal;
  // Unknown theme: a deterministic palette from the text hash.
  const rand = mulberry32(hash(theme));
  const baseHue = rand();
  return [0.12, 0.35, 0.62, 0.9].map((l, i) => hslToRgb((baseHue + i * 0.07) % 1, 0.45 + rand() * 0.35, l));
}

function samplePalette(p, t) {
  const x = Math.min(0.9999, Math.max(0, t)) * (p.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = p[i],
    b = p[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Periodic 2D value noise (period = grid size), so textures tile. */
class ValueNoise {
  grid;
  constructor(rand, size) {
    this.size = size;
    this.grid = new Float32Array(size * size);
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = rand();
  }
  at(x, y) {
    const s = this.size;
    return this.grid[(((y % s) + s) % s) * s + (((x % s) + s) % s)];
  }
  sample(x, y) {
    const xi = Math.floor(x),
      yi = Math.floor(y);
    const fx = x - xi,
      fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx),
      sy = fy * fy * (3 - 2 * fy);
    const a = this.at(xi, yi),
      b = this.at(xi + 1, yi);
    const c = this.at(xi, yi + 1),
      d = this.at(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  fbm(x, y) {
    let v = 0,
      amp = 0.5,
      freq = 1,
      norm = 0;
    for (let o = 0; o < 4; o++) {
      v += this.sample(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return v / norm;
  }
}

function yieldFrame() {
  return new Promise((r) => setTimeout(r, 0));
}
