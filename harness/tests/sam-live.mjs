// Live test of the SAM 3.1 check against the real Meta Model API (costs real money: about $1).
// Needs MUSE_API_KEY in the repo-root .env. Run: node harness/tests/sam-live.mjs
//   SAM_LIVE_GLB=/path/to/avatar.glb   also reskin your own avatar (else only the built-in test avatar)
//   SAM_LIVE_THEMES="pirate|astronaut"  themes for the reskin part (default: 4 themes)
//   SAM_LIVE_SKIP_RESKIN=1              only run the planted-object probes
// Writes harness/test-results/sam-live/ (report.json + PNGs of every case and every flagged area).
// It never prints or saves the key.
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const harnessDir = fileURLToPath(new URL('..', import.meta.url));
const pluginDir = fileURLToPath(new URL('../../plugin/', import.meta.url));
const outDir = fileURLToPath(new URL('../test-results/sam-live/', import.meta.url));
mkdirSync(outDir, { recursive: true });

process.env.NO_OPEN = '1';
const server = await createServer({
  root: harnessDir,
  configFile: `${harnessDir}/vite.config.js`,
  server: { port: 5198, strictPort: true, open: false },
  logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { startedAt: new Date().toISOString(), cors: null, probes: [], reskins: [], usage: null };
const save = () => writeFileSync(`${outDir}report.json`, JSON.stringify(report, null, 2));
const savePng = (name, dataUrl) => writeFileSync(`${outDir}${name}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));

try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  // Direct calls (the harness default), with the dev key the dev server injects.
  await ctx.addInitScript(() =>
    localStorage.setItem('muse-reskin-settings', JSON.stringify({ provider: 'muse', useProxy: false })),
  );
  const page = await ctx.newPage();
  if (process.env.SAM_LIVE_MOCK) {
    // Dry run of this script itself (no API): images are a flat PNG, SAM finds nothing.
    await page.setContent('<body style="margin:0;background:#3366cc"></body>');
    const png = (await page.screenshot({ clip: { x: 0, y: 0, width: 64, height: 64 } })).toString('base64');
    await ctx.route(/api\.meta\.ai|\/api\/muse\//, (route) => {
      const u = route.request().url();
      const body = u.endsWith('/responses')
        ? { status: 'completed', output_text: '' }
        : u.endsWith('/chat/completions')
          ? { choices: [{ message: { content: '{}' } }] }
          : { data: [{ b64_json: png }] };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(body),
      });
    });
  }
  page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
  await page.goto('http://localhost:5198/');
  await page.waitForFunction(() => !!window.reskin);
  const ok = await page.evaluate(() => !!window.reskin.plugin.getProvider().client?.options?.apiKey);
  if (!ok) throw new Error('No MUSE_API_KEY: add it to the repo-root .env');

  // 1. Can the browser reach SAM directly (CORS), and what does a reply look like?
  console.log('1. SAM from the browser (direct, no proxy)');
  report.cors = await page.evaluate(async () => {
    const client = window.reskin.plugin.getProvider().client;
    // Direct only: no fallback to the dev proxy, so a CORS block shows up here.
    const fallback = client.options.fallbackBaseUrl;
    client.options.fallbackBaseUrl = undefined;
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#2a4d8f';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#f2c9a0';
    g.beginPath();
    g.arc(128, 120, 60, 0, Math.PI * 2);
    g.fill();
    const t0 = performance.now();
    try {
      const r = await client.segment({ image: c.toDataURL('image/png'), prompt: 'circle' }).finally(() => {
        client.options.fallbackBaseUrl = fallback;
      });
      return {
        ok: true,
        ms: Math.round(performance.now() - t0),
        records: r.records.length,
        diagnostics: r.diagnostics,
        outcome: r.outcome,
        raw: r.rawOutput?.slice(0, 300),
      };
    } catch (err) {
      return {
        ok: false,
        ms: Math.round(performance.now() - t0),
        error: String(err?.message ?? err),
        status: err?.status,
      };
    }
  });
  console.log('  ', JSON.stringify(report.cors));
  save();
  if (!report.cors.ok) {
    // Try the dev proxy so the rest of the test can still run, and record that direct calls fail.
    await page.evaluate(() => {
      const c = window.reskin.plugin.getProvider().client;
      c.options.baseUrl = '/api/muse';
    });
    console.log('   direct call failed; using the dev proxy for the rest');
  }

  // 2. Planted objects: Muse paints a fabric, a portrait and a sneaker; they are pasted into the
  // fabric at different sizes and places, and the check must find them (and not flag clean fabric).
  console.log('2. Planted objects (should be caught) and clean areas (should pass)');
  const probes = await page.evaluate(async (samPath) => {
    const { findIntrusions, samRulesFor } = await import(samPath);
    const p = window.reskin.plugin;
    const client = p.getProvider().client;
    const toCanvas = async (blob) => {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      return c;
    };
    const gen = async (prompt) => toCanvas(await client.generateImage({ prompt, size: '1024x1024' }));
    const sources = {
      denim: await gen(
        'Seamless flat texture of plain blue denim trouser fabric, filling the whole image, no objects.',
      ),
      leather: await gen('Seamless flat texture of plain brown leather jacket material, filling the whole image.'),
      portrait: await gen('A cartoon portrait of a smiling pirate, head and shoulders, plain light background.'),
      sneaker: await gen('A single red sneaker seen from the side, plain white background.'),
      skull: await gen('A cartoon skull emblem, plain white background.'),
    };
    const W = 384,
      H = 640;
    const base = (name) => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      c.getContext('2d').drawImage(sources[name], 0, 0, W, H);
      return c;
    };
    const plant = (bg, obj, x, y, w) => {
      const c = base(bg);
      const s = sources[obj];
      c.getContext('2d').drawImage(s, x * W, y * H, w * W, (w * W * s.height) / s.width);
      return c;
    };
    const guide = (() => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, W, H);
      return c;
    })();
    const cases = [
      { name: 'clean denim legs', zone: 'legs', bg: 'denim', expect: [] },
      { name: 'clean leather torso', zone: 'torso', bg: 'leather', expect: [] },
      {
        name: 'big portrait on legs',
        zone: 'legs',
        bg: 'denim',
        obj: 'portrait',
        at: [0.25, 0.3, 0.5],
        expect: ['face', 'person'],
      },
      {
        name: 'small portrait on legs',
        zone: 'legs',
        bg: 'denim',
        obj: 'portrait',
        at: [0.4, 0.4, 0.2],
        expect: ['face', 'person'],
      },
      {
        name: 'shoe at bottom of legs',
        zone: 'legs',
        bg: 'denim',
        obj: 'sneaker',
        at: [0.2, 0.78, 0.6],
        expect: ['shoe'],
      },
      {
        name: 'small shoe at bottom of legs',
        zone: 'legs',
        bg: 'denim',
        obj: 'sneaker',
        at: [0.35, 0.86, 0.3],
        expect: ['shoe'],
      },
      {
        name: 'face on jacket front',
        zone: 'torso',
        bg: 'leather',
        obj: 'portrait',
        at: [0.3, 0.25, 0.4],
        expect: ['face', 'person'],
      },
      {
        name: 'portrait on hands',
        zone: 'hands',
        bg: 'leather',
        obj: 'portrait',
        at: [0.15, 0.2, 0.7],
        expect: ['face', 'person'],
      },
      {
        name: 'skull emblem on torso',
        zone: 'torso',
        bg: 'leather',
        obj: 'skull',
        at: [0.3, 0.3, 0.4],
        expect: ['face?'],
      },
    ];
    const out = [];
    const cache = new Map();
    for (const k of cases) {
      const painted = k.obj ? plant(k.bg, k.obj, ...k.at) : base(k.bg);
      const original = base(k.bg);
      const rules = samRulesFor('avatar', k.zone, '');
      const t0 = performance.now();
      let hits = null,
        error = null;
      try {
        hits = await findIntrusions({
          segment: (o) => client.segment(o),
          painted,
          original,
          guide,
          rules,
          cache,
          cacheKey: `${k.bg}|${k.zone}`,
        });
      } catch (err) {
        error = String(err?.message ?? err);
      }
      // Raw confidence per concept on the planted image (for tuning thresholds).
      const raw = {};
      for (const r of rules) {
        try {
          const res = await client.segment({ image: painted.toDataURL('image/png'), prompt: r.concept });
          raw[r.concept] = res.records.filter((x) => x.kind === 'box').map((x) => x.confidence ?? null);
        } catch (err) {
          raw[r.concept] = String(err?.message ?? err);
        }
      }
      out.push({
        name: k.name,
        zone: k.zone,
        expect: k.expect,
        concepts: rules.map((r) => r.concept),
        hits,
        error,
        raw,
        ms: Math.round(performance.now() - t0),
        png: painted.toDataURL('image/png'),
      });
    }
    return out;
  }, `/@fs${pluginDir}src/analysis/samCheck.js`);
  for (const pr of probes) {
    const found = (pr.hits ?? []).map((h) => h.concept);
    const want = pr.expect.filter((e) => !e.endsWith('?'));
    pr.verdict = pr.error
      ? 'error'
      : want.length
        ? found.some((f) => want.includes(f))
          ? 'caught'
          : 'MISSED'
        : found.length
          ? 'FALSE FLAG'
          : 'clean ok';
    savePng(`probe-${pr.name.replace(/\W+/g, '-')}`, pr.png);
    delete pr.png;
    console.log(
      `   ${pr.verdict.padEnd(10)} ${pr.name}: ${found.length ? pr.hits.map((h) => `${h.concept} ${Math.round(h.share * 100)}%`).join(', ') : 'nothing'}  raw=${JSON.stringify(pr.raw)}${pr.error ? ` error=${pr.error}` : ''}`,
    );
  }
  report.probes = probes;
  save();

  // 3. Full reskins with the check on: what it flags, whether the repaint fixed it, and the cost.
  if (!process.env.SAM_LIVE_SKIP_RESKIN) {
    console.log('3. Full reskins with the SAM check on');
    const themes = (process.env.SAM_LIVE_THEMES ?? 'pirate|astronaut|happy clown|knight in armor').split('|');
    const models = [{ name: 'test avatar', bytes: null }];
    if (process.env.SAM_LIVE_GLB)
      models.push({
        name: process.env.SAM_LIVE_GLB.split('/').pop(),
        bytes: [...readFileSync(process.env.SAM_LIVE_GLB)],
      });
    for (const m of models) {
      for (const theme of themes) {
        const run = await page.evaluate(
          async ({ bytes, theme, name }) => {
            const p = window.reskin.plugin;
            if (!bytes) {
              const mod = await import('/src/sampleModel.js');
              bytes = Array.from(new Uint8Array(await mod.buildAvatarTestGlb({ oneMesh: true })));
            }
            await p.postModel(new Uint8Array(bytes).buffer, { name });
            const warnings = [];
            const timings = [];
            const offW = p.on('warning', (e) => warnings.push(e.message));
            const offT = p.on('timing', (e) => /^sam /.test(e.step) && timings.push(e.ms));
            const t0 = performance.now();
            let error = null;
            let res = null;
            try {
              res = await p.postPrompt(theme, { variants: 1, assetClass: 'avatar', samCheck: true });
            } catch (err) {
              error = String(err?.message ?? err);
            }
            offW?.();
            offT?.();
            const u = p.getUsage();
            const sam = warnings.filter((w) => /SAM 3\.1/.test(w));
            const atlas = (res?.slots ?? []).filter((s) => s.canvas).map((s) => s.canvas.toDataURL('image/png'));
            return {
              theme,
              model: name,
              error,
              seconds: Math.round((performance.now() - t0) / 1000),
              samWarnings: sam,
              flagged: sam.filter((w) => /found .* repainting once/.test(w)).length,
              repaintUsed: sam.filter((w) => /using the repaint/.test(w)).length,
              passed: sam.filter((w) => /check passed/.test(w)).length,
              turnedOff: sam.some((w) => /turned off/.test(w)),
              samCallMs: timings,
              usage: u.text ?? null,
              reskinCost: u.reskinCost,
              samCalls: u.reskin?.byModel?.['sam-3.1']?.segments ?? 0,
              atlas,
            };
          },
          { bytes: m.bytes, theme, name: m.name },
        );
        await page.screenshot({
          path: `${outDir}view-${m.name.replace(/\W+/g, '-')}-${theme.replace(/\W+/g, '-')}.png`,
        });
        run.atlas.forEach((d, i) =>
          savePng(`reskin-${m.name.replace(/\W+/g, '-')}-${theme.replace(/\W+/g, '-')}-${i}`, d),
        );
        delete run.atlas;
        report.reskins.push(run);
        save();
        console.log(
          `   ${m.name} / ${theme}: ${run.error ? `ERROR ${run.error}` : `${run.flagged} flagged, ${run.repaintUsed} repaints kept, ${run.passed} passed, ${run.samCalls} SAM calls, ${run.usage}`}`,
        );
        for (const w of run.samWarnings) console.log(`      ${w}`);
      }
    }
  }
  report.usage = await page.evaluate(() => window.reskin.plugin.getUsage().text ?? null);
  save();
  console.log(`\nSession usage: ${report.usage}\nReport: ${outDir}report.json`);
} finally {
  await browser.close();
  await server.close();
}
