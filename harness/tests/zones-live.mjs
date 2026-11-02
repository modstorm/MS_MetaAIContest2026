// Live test of SAM 3.1 zone finding against the real Meta Model API (costs real money: about $0.50).
// Needs MUSE_API_KEY in the repo-root .env. Run: npm run test:zones-live
//   ZONES_LIVE_GLB="/path/a.glb|/path/b.glb"  also test your own models (no profile is loaded)
//   ZONES_LIVE_THEME="pirate"                  theme for the suggestion and the one reskin per model
//   ZONES_LIVE_SKIP_RESKIN=1                   only find zones (no paint)
//   ZONES_LIVE_MOCK=1                          dry run of this script (no API, SAM finds nothing)
// For each model: Muse suggestion (asset class + part names), SAM zones, the ID map, one reskin.
// Writes harness/test-results/zones-live/ (report.json, the SAM sheet, ID maps and renders).
// It never prints or saves the key.
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const harnessDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = fileURLToPath(new URL('../test-results/zones-live/', import.meta.url));
mkdirSync(outDir, { recursive: true });

process.env.NO_OPEN = '1';
const server = await createServer({
  root: harnessDir,
  configFile: `${harnessDir}/vite.config.js`,
  server: { port: 5197, strictPort: true, open: false },
  logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { startedAt: new Date().toISOString(), models: [], usage: null };
const save = () => writeFileSync(`${outDir}report.json`, JSON.stringify(report, null, 2));
const savePng = (name, dataUrl) =>
  dataUrl && writeFileSync(`${outDir}${name}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
const slugOf = (s) => s.replace(/\W+/g, '-');

try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  await ctx.addInitScript((mock) => {
    const s = { provider: 'muse', useProxy: false };
    if (mock) s.apiKey = 'mock'; // dry run: any key, every call is answered locally
    localStorage.setItem('muse-reskin-settings', JSON.stringify(s));
  }, !!process.env.ZONES_LIVE_MOCK);
  const page = await ctx.newPage();
  if (process.env.ZONES_LIVE_MOCK) {
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
  await page.goto('http://localhost:5197/');
  await page.waitForFunction(() => !!window.reskin);
  const ok = await page.evaluate(() => !!window.reskin.plugin.getProvider().client?.options?.apiKey);
  if (!ok && !process.env.ZONES_LIVE_MOCK) throw new Error('No MUSE_API_KEY: add it to the repo-root .env');

  const theme = process.env.ZONES_LIVE_THEME ?? 'pirate';
  const models = [
    { name: 'test avatar', builder: 'avatar' },
    { name: 'test car', builder: 'car' },
    { name: 'sample robot', builder: 'robot' },
  ];
  for (const path of (process.env.ZONES_LIVE_GLB ?? '').split('|').filter(Boolean))
    models.push({ name: path.split('/').pop(), bytes: [...readFileSync(path)] });

  for (const m of models) {
    console.log(`\n== ${m.name}`);
    const run = await page.evaluate(
      async ({ m, theme, skipReskin }) => {
        const p = window.reskin.plugin;
        let bytes = m.bytes;
        if (!bytes) {
          const mod = await import('/src/sampleModel.js');
          const buf =
            m.builder === 'avatar'
              ? await mod.buildAvatarTestGlb({ oneMesh: true })
              : m.builder === 'car'
                ? await mod.buildCarTestGlb()
                : await mod.buildSampleGlb();
          bytes = Array.from(new Uint8Array(buf));
        }
        p.setProfile(null);
        p.setSamZones(false); // found once below, not also inside the suggestion step
        const { model } = await p.postModel(new Uint8Array(bytes).buffer, { name: m.name });
        window.reskin.viewer.setContent(model.scene, model.gltf?.animations ?? []);
        window.reskin.viewer.setSpin?.(false);
        document.getElementById('empty-state')?.setAttribute('hidden', '');
        const out = { model: m.name, warnings: [], errors: [] };
        const offW = p.on('warning', (e) => out.warnings.push(e.message));
        let zonesEvent = null;
        const offZ = p.on('zones', (e) => (zonesEvent = e));
        const atlasSlots = () => p.layout.slots.filter((s) => s.texture && !s.tiled);
        out.usualAreas = atlasSlots().map((s) => ({ slot: s.name, areas: p.idRegions(s).map((r) => r.name) }));

        // 1. Muse suggestion: asset class and part names (the phrases for classes without a list).
        let suggestion = null;
        try {
          suggestion = await p.postSuggest(theme, {});
          out.subject = suggestion.subject;
          out.assetClass = suggestion.assetClass;
          out.parts = (suggestion.parts ?? []).map((x) => x.name);
        } catch (err) {
          out.errors.push(`suggest: ${err?.message ?? err}`);
        }

        // 2. SAM zones.
        const before = p.getUsage().session;
        const segBefore = before.segments ?? 0;
        const t0 = performance.now();
        try {
          out.zones = await p.postFindZones({ force: true, suggestion: suggestion ?? undefined });
        } catch (err) {
          out.errors.push(`zones: ${err?.message ?? err}`);
        }
        out.zoneSeconds = Math.round((performance.now() - t0) / 100) / 10;
        out.samImages = (p.getUsage().session.segments ?? 0) - segBefore;
        out.found = zonesEvent?.found ?? null;
        out.sheet = zonesEvent?.sheet?.toDataURL('image/png') ?? null;
        out.samAreas = atlasSlots().map((s) => ({ slot: s.name, areas: p.idRegions(s).map((r) => r.name) }));
        out.idMaps = [...p.idMapTextures(512).values()].map((t) => t.canvas.toDataURL('image/png'));
        out.idSheet = p.renderIdSheet({ size: 256 })?.toDataURL('image/png') ?? null;

        // 3. One reskin with the SAM zones (SAM check on too, as in the demo).
        if (!skipReskin) {
          const t1 = performance.now();
          try {
            const res = await p.postPrompt(suggestion?.prompt || theme, {
              suggestion: suggestion ?? undefined,
              variants: 1,
              samZones: true,
              samCheck: true,
            });
            out.painted = (res.slots ?? []).filter((s) => s.canvas).map((s) => s.canvas.toDataURL('image/png'));
            out.paintedAreas = p.areaNames();
          } catch (err) {
            out.errors.push(`reskin: ${err?.message ?? err}`);
          }
          out.reskinSeconds = Math.round((performance.now() - t1) / 1000);
          const u = p.getUsage();
          out.reskinUsage = u.text;
          out.reskinCost = u.reskinCost;
        }
        offW?.();
        offZ?.();
        return out;
      },
      {
        m: { name: m.name, builder: m.builder, bytes: m.bytes },
        theme,
        skipReskin: !!process.env.ZONES_LIVE_SKIP_RESKIN,
      },
    );
    const slug = slugOf(m.name);
    savePng(`${slug}-sam-sheet`, run.sheet);
    savePng(`${slug}-id-views`, run.idSheet);
    run.idMaps.forEach((d, i) => savePng(`${slug}-id-map-${i}`, d));
    (run.painted ?? []).forEach((d, i) => savePng(`${slug}-painted-${i}`, d));
    await page.screenshot({ path: `${outDir}${slug}-view.png` });
    for (const k of ['sheet', 'idSheet', 'idMaps', 'painted']) delete run[k];
    report.models.push(run);
    save();
    console.log(`   class: ${run.assetClass ?? '?'} (${run.subject ?? ''}); parts: ${(run.parts ?? []).join(', ')}`);
    console.log(`   usual areas: ${run.usualAreas.map((s) => s.areas.join(', ')).join(' | ')}`);
    console.log(`   SAM areas:   ${run.samAreas.map((s) => s.areas.join(', ')).join(' | ')}`);
    console.log(
      `   SAM: ${run.samImages} images in ${run.zoneSeconds}s; found ${(run.found ?? []).map((f) => `${f.concept}:${f.masks}`).join(' ')}`,
    );
    if (run.reskinUsage) console.log(`   reskin: ${run.reskinSeconds}s, ${run.reskinUsage}`);
    for (const e of run.errors) console.log(`   ERROR ${e}`);
    for (const w of run.warnings.filter((w) => /SAM/.test(w))) console.log(`      ${w}`);
  }
  report.usage = await page.evaluate(() => {
    const u = window.reskin.plugin.getUsage();
    const s = u.session;
    return `${s.images} images + ${s.segments ?? 0} SAM images + ${s.inputTokens + s.outputTokens} tokens ≈ $${u.sessionCost.toFixed(2)} (whole run)`;
  });
  save();
  console.log(`\nSession usage: ${report.usage}\nReport: ${outDir}report.json`);
} finally {
  await browser.close();
  await server.close();
}
