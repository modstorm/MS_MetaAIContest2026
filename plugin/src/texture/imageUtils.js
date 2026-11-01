import * as THREE from 'three';

import { uvSourceOf } from '../analysis/textureLayout.js';
import { islandIdPerTriangle } from '../analysis/uvIslands.js';

/** Canvas helpers. These need a DOM (browser, or a DOM shim with canvas support). */

export function createCanvas(width, height) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

export function ctx2d(c) {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

/** Fits (w, h) inside maxSize on the longest side, keeping aspect. */
export function fitSize(w, h, maxSize) {
  const s = Math.min(1, maxSize / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Draws a texture's image into a new canvas (supports images, bitmaps, canvases and DataTextures). */
export function textureToCanvas(tex, maxSize = 4096) {
  const img = tex.image;
  if (!img) throw new Error(`Texture "${tex.name}" has no image`);
  const { width, height } = fitSize(img.width, img.height, maxSize);
  const c = createCanvas(width, height);
  const ctx = ctx2d(c);
  if (img.data && !(img instanceof HTMLImageElement)) {
    // DataTexture: build ImageData at native size, then scale.
    const src = createCanvas(img.width, img.height);
    const data = new Uint8ClampedArray(img.width * img.height * 4);
    const channels = img.data.length / (img.width * img.height);
    for (let i = 0; i < img.width * img.height; i++) {
      data[i * 4] = img.data[i * channels];
      data[i * 4 + 1] = img.data[i * channels + (channels > 1 ? 1 : 0)];
      data[i * 4 + 2] = img.data[i * channels + (channels > 2 ? 2 : 0)];
      data[i * 4 + 3] = channels > 3 ? img.data[i * channels + 3] : 255;
    }
    ctx2d(src).putImageData(new ImageData(data, img.width, img.height), 0, 0);
    ctx.drawImage(src, 0, 0, width, height);
  } else {
    ctx.drawImage(img, 0, 0, width, height);
  }
  return c;
}

export function resizeCanvas(src, width, height) {
  const c = createCanvas(width, height);
  const ctx = ctx2d(c);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export async function blobToCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const c = createCanvas(bmp.width, bmp.height);
  ctx2d(c).drawImage(bmp, 0, 0);
  bmp.close?.();
  return c;
}

export function canvasToDataUrl(c, type = 'image/png', quality = 0.92) {
  return c.toDataURL(type, quality);
}

export function canvasToBlob(c, type = 'image/png', quality = 0.92) {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality),
  );
}

/**
 * Draws the slot's UV layout into a canvas of the given size.
 * glTF UV (0,0) is the image's top-left and three.js keeps flipY=false for glTF,
 * so u maps to x and v maps to y directly.
 */
export function drawUvGuide(slot, width, height, opts = {}) {
  const {
    fill = true,
    wireframe = true,
    fillColor = '#ffffff',
    lineColor = '#ff2a6d',
    background = '#000000',
    lineWidth = 1,
  } = opts;
  const c = createCanvas(width, height);
  const ctx = ctx2d(c);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  for (const mesh of opts.meshes ?? slot.meshes) {
    const src = uvSourceOf(mesh, slot.uvChannel, slot.texture);
    if (!src) continue;
    const tris = Math.floor((src.index ? src.index.length : src.uvs.length / 2) / 3);
    // Optional: only some UV islands of this mesh (a region of a part).
    const keep = opts.islands?.get(mesh);
    const islandOf = keep ? islandIdPerTriangle(src) : null;
    const triKeep = opts.tris?.get(mesh);
    if (opts.tris && !triKeep) continue;
    const path = new Path2D();
    for (let t = 0; t < tris; t++) {
      if (keep && !keep.has(islandOf[t])) continue;
      if (triKeep && !triKeep[t]) continue;
      const pts = [];
      for (let k = 0; k < 3; k++) {
        const v = src.index ? src.index[t * 3 + k] : t * 3 + k;
        pts.push(src.uvs[v * 2], src.uvs[v * 2 + 1]);
      }
      const ou = Math.floor(Math.min(pts[0], pts[2], pts[4]));
      const ov = Math.floor(Math.min(pts[1], pts[3], pts[5]));
      // Same winding for every triangle: mirrored islands stacked on top of each other
      // would otherwise cancel out under the nonzero fill rule and leave holes.
      const ccw = (pts[2] - pts[0]) * (pts[5] - pts[1]) - (pts[4] - pts[0]) * (pts[3] - pts[1]) >= 0;
      const [i1, i2] = ccw ? [2, 4] : [4, 2];
      path.moveTo((pts[0] - ou) * c.width, (pts[1] - ov) * c.height);
      path.lineTo((pts[i1] - ou) * c.width, (pts[i1 + 1] - ov) * c.height);
      path.lineTo((pts[i2] - ou) * c.width, (pts[i2 + 1] - ov) * c.height);
      path.closePath();
    }
    if (fill) {
      ctx.fillStyle = fillColor;
      ctx.fill(path);
      // Stroke with the fill color too, so thin slivers and edges are not lost.
      ctx.strokeStyle = fillColor;
      ctx.stroke(path);
    }
    if (wireframe) {
      ctx.strokeStyle = lineColor;
      ctx.stroke(path);
    }
  }
  return c;
}

/**
 * Part map: each part's UV area filled with its own flat color (see analysis/parts.js).
 * With `atlas`, the colors are drawn semi-transparent over it. With `labels`, the map
 * gets a wide border on the left and right holding each part's name, with a line to
 * every separate patch of that part (see drawCallouts).
 */
export function drawPartMap(slot, parts, width, height, { atlas = null, labels = false, alpha = 1 } = {}) {
  const c = createCanvas(width, height);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, c.width, c.height);
  if (atlas) ctx.drawImage(atlas, 0, 0, c.width, c.height);
  ctx.globalAlpha = alpha;
  const layers = [];
  for (const p of parts) {
    const layer = partLayer(slot, p, c.width, c.height);
    layers.push(layer);
    ctx.drawImage(layer, 0, 0);
  }
  ctx.globalAlpha = 1;
  if (!labels) return c;
  return drawCallouts(
    c,
    parts.map((p, i) => ({ name: p.name, hex: p.hex, patches: zonePatches(layers[i]) })),
  );
}

/** One part's UV area filled with its color on a transparent canvas. */
export function partLayer(slot, p, width, height) {
  return drawUvGuide(slot, width, height, {
    meshes: p.meshes,
    islands: p.islands,
    tris: p.tris,
    fillColor: p.hex ?? '#ffffff',
    wireframe: false,
    background: null,
  });
}

const GRID = 64;

/** Which cells of a GRID-cells-wide grid over `layer` are covered (opaque). */
function coverage(layer) {
  const W = layer.width,
    H = layer.height;
  const cell = Math.max(W, H) / GRID;
  const gw = Math.max(1, Math.ceil(W / cell)),
    gh = Math.max(1, Math.ceil(H / cell));
  const d = ctx2d(layer).getImageData(0, 0, W, H).data;
  const on = new Uint8Array(gw * gh);
  const probes = [
    [0.5, 0.5],
    [0.2, 0.2],
    [0.8, 0.2],
    [0.2, 0.8],
    [0.8, 0.8],
  ];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let hits = 0;
      for (const [fx, fy] of probes) {
        const x = Math.min(W - 1, Math.floor((gx + fx) * cell)),
          y = Math.min(H - 1, Math.floor((gy + fy) * cell));
        if (d[(y * W + x) * 4 + 3] > 128) hits++;
      }
      if (hits >= 3) on[gy * gw + gx] = 1;
    }
  }
  return { on, gw, gh, cell };
}

/**
 * The separate patches of a part (up to `max`, biggest first). Each has `x, y` (the covered
 * spot nearest its middle), `cells` (candidate points well inside the patch, pixels) and
 * the coverage grid (`grid`), so callouts can pick points whose lines avoid other parts.
 */
export function zonePatches(layer, max = 4) {
  const grid = coverage(layer);
  const { on, gw, gh, cell } = grid;
  const comp = new Int32Array(gw * gh).fill(-1);
  const comps = [];
  for (let i = 0; i < on.length; i++) {
    if (!on[i] || comp[i] >= 0) continue;
    const cells = [];
    const stack = [i];
    comp[i] = comps.length;
    while (stack.length) {
      const j = stack.pop();
      cells.push(j);
      const x = j % gw,
        y = (j / gw) | 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const xx = x + dx,
          yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
        const k = yy * gw + xx;
        if (on[k] && comp[k] < 0) {
          comp[k] = comps.length;
          stack.push(k);
        }
      }
    }
    comps.push(cells);
  }
  comps.sort((a, b) => b.length - a.length);
  const biggest = comps[0]?.length ?? 0;
  const center = (j) => ({ x: ((j % gw) + 0.5) * cell, y: (((j / gw) | 0) + 0.5) * cell });
  const inner = (j) => [1, -1, gw, -gw].filter((o) => on[j + o]).length;
  const out = [];
  for (const cells of comps) {
    if (out.length >= max || (out.length && cells.length < Math.max(2, biggest * 0.12))) break;
    let mx = 0,
      my = 0;
    for (const j of cells) {
      mx += j % gw;
      my += (j / gw) | 0;
    }
    mx /= cells.length;
    my /= cells.length;
    let best = cells[0],
      bestD = Infinity;
    for (const j of cells) {
      const dd = Math.hypot((j % gw) - mx, ((j / gw) | 0) - my) - inner(j) * 0.5;
      if (dd < bestD) {
        bestD = dd;
        best = j;
      }
    }
    // Candidates: cells with all four neighbours covered (else any), at most ~40, spread out.
    let cand = cells.filter((j) => inner(j) === 4);
    if (!cand.length) cand = cells;
    const step = Math.max(1, Math.floor(cand.length / 40));
    out.push({ ...center(best), cells: cand.filter((_, i) => i % step === 0).map(center), grid });
  }
  return out;
}

/** A point inside each separate patch of a part, biggest patch first. */
export function zoneAnchors(layer, max = 4) {
  return zonePatches(layer, max).map(({ x, y }) => ({ x, y }));
}

/**
 * Callout labels: returns `base` inside a wide dark border. Each item's name (with a
 * color swatch) sits in the left or right border, with a line and a dot to each of its
 * patches. Sides and points are chosen so lines cross as little of the other parts as
 * possible and points of different parts keep apart.
 * @param {{ name: string, hex?: string, patches?: ReturnType<typeof zonePatches>, anchors?: { x: number, y: number }[] }[]} items
 */
export function drawCallouts(base, items) {
  const W = base.width,
    H = base.height;
  const fs = Math.max(13, Math.round(Math.max(W, H) / 38));
  const probe = ctx2d(createCanvas(1, 1));
  probe.font = `bold ${fs}px system-ui, sans-serif`;
  const textW = Math.max(fs * 4, ...items.map((it) => probe.measureText(it.name).width));
  const lane = Math.max(4, Math.round(fs / 3));
  const gutter = lane * (items.length + 2); // jog columns between the labels and the map
  const border = Math.round(Math.min(textW + fs * 2.6 + gutter, W * 0.9 + gutter));
  const pad = Math.round(fs * 0.8 + lane * 6); // room for lines routed above / below the map
  const c = createCanvas(W + border * 2, H + pad * 2);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#1b1f27';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(base, border, pad);
  ctx.strokeStyle = '#ffffff55';
  ctx.lineWidth = 1;
  ctx.strokeRect(border - 0.5, pad - 0.5, W + 1, H + 1);

  // Parts covering each grid cell (bit i = item i).
  const g = items.find((it) => it.patches?.length)?.patches[0].grid;
  let owner = null;
  if (g) {
    owner = new Uint32Array(g.gw * g.gh);
    items.forEach((it, i) => {
      const on = it.patches?.[0]?.grid.on;
      if (!on) return;
      for (let j = 0; j < on.length; j++) if (on[j]) owner[j] |= 1 << (i % 32);
    });
  }
  // Grid cells of other parts that the straight line (x0,y0)→(x1,y1) passes over.
  const crossings = (i, x0, y0, x1, y1) => {
    if (!owner) return 0;
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (g.cell / 2));
    let hits = 0;
    for (let k = 0; k <= n; k++) {
      const x = x0 + ((x1 - x0) * k) / n,
        y = y0 + ((y1 - y0) * k) / n;
      const gx = Math.floor(x / g.cell),
        gy = Math.floor(y / g.cell);
      if (gx < 0 || gy < 0 || gx >= g.gw || gy >= g.gh) continue;
      const o = owner[gy * g.gw + gx];
      if (o && !(o & (1 << (i % 32)))) hits++;
    }
    return hits;
  };

  // Choose a side and, per patch, a point and a route: 'level' (straight in from the side)
  // or 'top' / 'bottom' (along the margin above or below the map, then straight down/up).
  // Cost: other parts crossed, then lines running close to other lines, then length.
  // Bigger parts choose first.
  const chosen = [];
  const order = items
    .map((it, i) => ({ it, i, size: (it.patches ?? []).reduce((s, p) => s + p.cells.length, 0) }))
    .sort((a, b) => b.size - a.size);
  const near = g ? g.cell * 1.6 : 8;
  const placed = [];
  for (const { it, i } of order) {
    const patches = it.patches ?? (it.anchors ?? []).map((a) => ({ ...a, cells: [a] }));
    if (!patches.length) continue;
    let best = null;
    for (const side of ['left', 'right']) {
      const edge = side === 'left' ? 0 : W;
      let cost = 0;
      const pts = [];
      for (const p of patches) {
        let pick = null,
          pickCost = Infinity;
        for (const q of p.cells) {
          for (const route of ['level', 'top', 'bottom']) {
            const cross =
              route === 'level'
                ? crossings(i, edge, q.y, q.x, q.y)
                : crossings(i, q.x, route === 'top' ? 0 : H, q.x, q.y);
            let crowd = 0;
            for (const o of chosen) {
              if (Math.hypot(o.x - q.x, o.y - q.y) < near * 2.5) crowd += 120;
              if (route === 'level' && o.route === 'level' && o.side === side && Math.abs(o.y - q.y) < near)
                crowd += 150;
              if (route !== 'level' && o.route === route && Math.abs(o.x - q.x) < near) crowd += 150;
            }
            const len =
              route === 'level' ? Math.abs(edge - q.x) : Math.abs(edge - q.x) + (route === 'top' ? q.y : H - q.y);
            const cst = cross * 60 + crowd + len * 0.05 + (route === 'level' ? 0 : 8);
            if (cst < pickCost) {
              pickCost = cst;
              pick = { x: q.x, y: q.y, route, side };
            }
          }
        }
        cost += pickCost;
        pts.push(pick);
      }
      if (!best || cost < best.cost) best = { side, cost, pts };
    }
    chosen.push(...best.pts);
    const ay =
      best.pts.reduce((s, a) => s + (a.route === 'top' ? 0 : a.route === 'bottom' ? H : a.y), 0) / best.pts.length;
    placed.push({ ...it, i, side: best.side, anchors: best.pts, ay });
  }

  const rowH = fs * 1.9;
  const sides = { left: placed.filter((p) => p.side === 'left'), right: placed.filter((p) => p.side === 'right') };
  for (const [side, list] of Object.entries(sides)) {
    list.sort((a, b) => a.ay - b.ay);
    // Rows as close to their patches' height as possible without overlapping.
    let y = -Infinity;
    for (const it of list) {
      it.ly = Math.max(pad + it.ay, y + rowH);
      y = it.ly;
    }
    const bottom = c.height - rowH / 2;
    for (let k = list.length - 1; k >= 0; k--) {
      const limit = k === list.length - 1 ? bottom : list[k + 1].ly - rowH;
      if (list[k].ly > limit) list[k].ly = limit;
    }
    for (const it of list) if (it.ly < rowH / 2) it.ly = rowH / 2;
    const left = side === 'left';
    const boxW = border - fs * 0.6 - gutter;
    const bx = left ? fs * 0.6 : W + border + fs * 0.6;
    const edgeX = left ? bx + boxW : bx;
    // Each label's lines leave it on their own lane (jog column / margin row), so lines of
    // different labels never share a stretch.
    list.forEach((it, k) => {
      const ex = left ? border : border + W;
      const jogX = ex + (left ? -1 : 1) * (lane * (k + 1));
      for (const a of it.anchors) {
        const tx = border + a.x,
          ty = pad + a.y;
        const pts = [[edgeX, it.ly]];
        if (a.route === 'level') {
          pts.push([jogX, it.ly], [jogX, ty], [tx, ty]);
        } else {
          const my = a.route === 'top' ? pad - lane * (1 + (it.i % 5)) : pad + H + lane * (1 + (it.i % 5));
          pts.push([jogX, it.ly], [jogX, my], [tx, my], [tx, ty]);
        }
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        pts.forEach(([x, y], n) => (n ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.strokeStyle = '#000000cc';
        ctx.lineWidth = Math.max(3, fs / 4);
        ctx.stroke();
        ctx.strokeStyle = it.hex ?? '#ffffff';
        ctx.lineWidth = Math.max(1.5, fs / 9);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(tx, ty, Math.max(3, fs / 4), 0, Math.PI * 2);
        ctx.fillStyle = it.hex ?? '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#000000';
        ctx.stroke();
      }
    });
    for (const it of list) {
      const by = it.ly - fs * 0.8;
      ctx.fillStyle = '#000000d9';
      ctx.fillRect(bx, by, boxW, fs * 1.6);
      ctx.strokeStyle = it.hex ?? '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(bx + 1, by + 1, boxW - 2, fs * 1.6 - 2);
      ctx.fillStyle = it.hex ?? '#ffffff';
      ctx.fillRect(bx + fs * 0.35, it.ly - fs * 0.4, fs * 0.8, fs * 0.8);
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${fs}px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(it.name, bx + fs * 1.45, it.ly, boxW - fs * 1.7);
    }
  }
  return c;
}

/** Draws each part's name and an arrow toward the part's top, on the part (`anchors`) or at its bbox center. */
export function drawPartLabels(c, parts) {
  const ctx = ctx2d(c);
  {
    const fs = Math.max(12, Math.round(c.width / 40));
    ctx.font = `bold ${fs}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (const p of parts) {
      // On the part itself (its biggest patch) when known; the bbox center can fall on another part.
      const [x0, y0, x1, y1] = p.bbox.map((n, i) => (n / 1000) * (i % 2 ? c.height : c.width));
      const at = p.anchors?.[0];
      const cx = at ? at.x : (x0 + x1) / 2,
        cy = at ? at.y : (y0 + y1) / 2;
      const arrow = { up: ' ↑', down: ' ↓', left: ' ←', right: ' →' }[p.up] ?? '';
      const label = `${p.name}${arrow}`;
      const w = ctx.measureText(label).width + fs;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(cx - w / 2, cy - fs * 0.75, w, fs * 1.5);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, cx, cy);
    }
  }
  return c;
}

/** Applies T = rotate `rot`° clockwise, then optional horizontal mirror. */
export function transformCanvas(src, t) {
  if (!t || (t.rot % 360 === 0 && !t.flipX)) return src;
  const rot = ((t.rot % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const c = createCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const ctx = ctx2d(c);
  if (t.flipX) {
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/** Undoes transformCanvas(…, t). */
export function untransformCanvas(src, t) {
  if (!t || (t.rot % 360 === 0 && !t.flipX)) return src;
  let c = t.flipX ? transformCanvas(src, { rot: 0, flipX: true }) : src;
  return transformCanvas(c, { rot: (360 - (t.rot % 360)) % 360, flipX: false });
}

/** The atlas with the UV wireframe drawn over it (for display and as a model hint). */
export function drawAtlasWithUvs(atlas, slot) {
  const c = createCanvas(atlas.width, atlas.height);
  const ctx = ctx2d(c);
  ctx.drawImage(atlas, 0, 0);
  const wire = drawUvGuide(slot, atlas.width, atlas.height, {
    fill: false,
    background: null,
    lineWidth: Math.max(1, atlas.width / 1024),
  });
  ctx.drawImage(wire, 0, 0);
  return c;
}

function luminanceArray(c) {
  const d = ctx2d(c).getImageData(0, 0, c.width, c.height).data;
  const out = new Float32Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  }
  return out;
}

/**
 * Keeps the original atlas's light/dark detail in the new texture:
 * new = lerp(gen, gen * (origLum / meanOrigLum), strength).
 * The alpha channel of the original is carried over so cut-outs keep working.
 */
export function applyDetailPreserve(generated, original, strength) {
  const w = generated.width;
  const h = generated.height;
  const orig = original.width === w && original.height === h ? original : resizeCanvas(original, w, h);
  const lum = luminanceArray(orig);
  const origData = ctx2d(orig).getImageData(0, 0, w, h).data;
  let mean = 0;
  for (let i = 0; i < lum.length; i++) mean += lum[i];
  mean = Math.max(1e-3, mean / lum.length);

  const out = createCanvas(w, h);
  const genData = ctx2d(generated).getImageData(0, 0, w, h);
  const d = genData.data;
  const s = Math.min(1, Math.max(0, strength));
  for (let i = 0; i < lum.length; i++) {
    const f = 1 - s + s * Math.min(2.5, lum[i] / mean);
    d[i * 4] = d[i * 4] * f;
    d[i * 4 + 1] = d[i * 4 + 1] * f;
    d[i * 4 + 2] = d[i * 4 + 2] * f;
    d[i * 4 + 3] = origData[i * 4 + 3];
  }
  ctx2d(out).putImageData(genData, 0, 0);
  return out;
}

/** Average color of a canvas (sRGB), optionally ignoring near-black/white pixels. */
export function averageColor(c) {
  const small = resizeCanvas(c, 32, 32);
  const d = ctx2d(small).getImageData(0, 0, 32, 32).data;
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
    n++;
  }
  return new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace);
}

/**
 * The most vivid color in a canvas (high saturation and brightness), or null if
 * the image is basically gray. Used to tint small untextured parts to match.
 */
export function accentColor(c) {
  const small = resizeCanvas(c, 48, 48);
  const d = ctx2d(small).getImageData(0, 0, 48, 48).data;
  let best = -1;
  let rgb = null;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255,
      g = d[i + 1] / 255,
      b = d[i + 2] / 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const score = sat * 0.7 + max * 0.3;
    if (score > best) {
      best = score;
      rgb = [r, g, b];
    }
  }
  if (!rgb || best < 0.35) return null;
  return new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
}

/** Picks a Muse `size` string with the closest supported aspect ratio. */
export function museSizeFor(width, height) {
  const aspect = width / height;
  if (aspect > 1.6) return '1792x1024';
  if (aspect > 1.2) return '1536x1024';
  if (aspect < 1 / 1.6) return '1024x1792';
  if (aspect < 1 / 1.2) return '1024x1536';
  return '1024x1024';
}
