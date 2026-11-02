import './styles.css';
import {
  ASSET_CLASSES,
  MuseProvider,
  ProceduralProvider,
  ReskinPlugin,
  formatDollars,
} from '@metaai26/reskin-plugin';
import { Viewer } from './viewer.js';
import { buildSampleGlb } from './sampleModel.js';

// Asset type choices come from the plugin's class registry.
for (const c of ASSET_CLASSES) {
  const o = document.createElement('option');
  o.value = c.id;
  o.textContent = c.label;
  document.getElementById('opt-asset-class').append(o);
}

/**
 * Test harness. It only does UI: load a file, ask for a prompt, show results.
 * Every model call and all mesh/texture work happens inside ReskinPlugin.
 */

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ settings

const STORE = 'muse-reskin-settings';

function loadSettings() {
  const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}');
  return {
    // Muse by default: the demo needs a key (MUSE_API_KEY in .env). Offline stays in Settings for testing.
    provider: saved.provider ?? 'muse',
    apiKey: saved.apiKey ?? '',
    useProxy: saved.useProxy ?? false,
    // Model for the suggest and review steps: '' = Muse Spark (default), or Muse Wonder.
    adviceModel: saved.adviceModel ?? '',
  };
}
let settings = loadSettings();

/** Muse is selected but no key is known: show how to add one. */
const missingKey = () => settings.provider === 'muse' && !(settings.apiKey || __MUSE_DEV_KEY__);
function updateKeyBanner(flash = false) {
  const el = $('key-banner');
  el.hidden = !missingKey();
  if (!__HAS_DEV_PROXY__)
    el.innerHTML =
      '<strong>AI reskins need a Meta Muse API key.</strong> Paste yours in Settings ⚙ (it stays in this browser only), or clone the repo and put <code>MUSE_API_KEY</code> in <code>.env</code>. Without a key you can still load a model and explore its texture layout, areas, facing map and animation.';
  if (flash && !el.hidden) {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
}

function makeProvider(s) {
  if (s.provider === 'offline') return new ProceduralProvider();
  const apiKey = s.apiKey || __MUSE_DEV_KEY__;
  return new MuseProvider({
    apiKey,
    baseUrl: s.useProxy && __HAS_DEV_PROXY__ ? '/api/muse' : __MUSE_API_BASE__,
    // In dev, fall back to the proxy if the browser call is blocked (e.g. CORS).
    fallbackBaseUrl: __HAS_DEV_PROXY__ ? '/api/muse' : undefined,
    imageModel: __MUSE_IMAGE_MODEL__,
    visionModel: __MUSE_VISION_MODEL__,
    adviceModel: s.adviceModel || undefined,
  });
}

// ------------------------------------------------------------------ plugin + viewer
const viewer = new Viewer($('viewport'));
const plugin = new ReskinPlugin({ provider: makeProvider(settings) });
window.reskin = { plugin, viewer }; // handy for the console and e2e tests

const statusEl = $('status');
const logEl = $('log');
function log(msg, kind = '') {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  if (kind) li.className = kind;
  logEl.prepend(li);
}

plugin.onUpdate((e) => {
  switch (e.type) {
    case 'status':
      statusEl.textContent = e.data.message;
      statusEl.classList.toggle('error', e.data.state === 'error');
      if (e.data.state !== 'reskinning') log(e.data.message, e.data.state === 'error' ? 'err' : '');
      break;
    case 'progress':
      $('prompt-bar').style.width = `${Math.round(e.data.progress * 100)}%`;
      $('prompt-stage').textContent = e.data.message;
      statusEl.textContent = e.data.message;
      break;
    case 'timing':
      log(
        `⏱ ${e.data.step}${e.data.slotName ? ` (${e.data.slotName})` : ''}: ${(e.data.ms / 1000).toFixed(1)}s${e.data.ok ? '' : ` (failed: ${e.data.error})`}`,
        e.data.ok ? '' : 'err',
      );
      break;
    case 'request':
      if ($('opt-debug').checked) {
        console.log('[Muse request]', e.data.url, e.data.status, e.data.request, e.data.error ?? '');
        log(
          `→ ${e.data.url.split('/v1')[1] ?? e.data.url} ${e.data.status}: ${JSON.stringify(e.data.request).slice(0, 1500)}`,
          e.data.error ? 'err' : '',
        );
      }
      break;
    case 'probe':
      addProbeResult(e.data);
      break;
    case 'warning':
      log(e.data.message, 'warn');
      break;
    case 'assetClass':
      log(`Asset type: ${e.data.label ?? e.data.id}`);
      break;
    case 'regions':
      refreshZones();
      log(`Painting ${e.data.regions.length} areas: ${e.data.regions.map((r) => r.name).join(', ')}`);
      break;
    case 'lessons':
      localStorage.setItem(LESSONS_KEY, JSON.stringify(e.data));
      if (document.activeElement !== $('lessons')) $('lessons').value = lessonsToText(e.data);
      break;
    case 'maps':
      $('generated').innerHTML = e.data.maps.length ? '' : '<span class="muted">Original textures.</span>';
      for (const m of e.data.maps) showGenerated(m.slotId, m.kind, m.canvas);
      break;
    case 'history':
      renderHistory(e.data);
      break;
    case 'partPainted':
      log(`Painted ${e.data.area}`);
      break;
    case 'review':
      renderReview(e.data);
      break;
    case 'usage':
      showUsage(e.data);
      break;
    case 'reskinned':
      if (e.data.usage?.reskin.calls) log(`💲 This reskin so far: ${e.data.usage.text}`);
      break;
    case 'idMap':
      $('btn-idmap').classList.toggle('on', e.data.on);
      break;
    case 'plan':
      if (e.data.plan) log(`Layout read: ${e.data.plan.subject} (${e.data.plan.regions.length} regions)`);
      break;
    case 'textureUpdated':
      showGenerated(e.data.slotId, e.data.kind, e.data.canvas);
      break;
    case 'loaded':
      renderLayout(e.data.layout);
      break;
    case 'locks':
      renderZones(e.data.areas);
      break;
  }
});

// ------------------------------------------------------------------ zones + locks
// Each paint area with its ID-map color. Locked zones keep their current paint when you
// run a new prompt; only the unlocked ones are repainted.
function refreshZones() {
  try {
    renderZones(plugin.listAreas());
  } catch (err) {
    log(`Zones unavailable: ${err.message}`, 'warn');
  }
}

function renderZones(areas) {
  const box = $('zones');
  box.innerHTML = '';
  $('zones-section').hidden = !areas.length;
  const n = areas.filter((a) => a.locked).length;
  $('zones-note').textContent = n ? `${n} locked, ${areas.length - n} will repaint` : 'click 🔓 to keep a zone';
  for (const a of areas) {
    const row = document.createElement('div');
    row.className = `zone${a.locked ? ' locked' : ''}`;
    row.dataset.name = a.name;
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = a.hex;
    sw.title = a.color;
    const label = document.createElement('span');
    label.className = 'zone-name';
    label.textContent = a.name;
    const btn = document.createElement('button');
    btn.className = 'zone-lock';
    btn.textContent = a.locked ? '🔒' : '🔓';
    btn.title = a.locked
      ? 'Locked: keeps its paint. Click to unlock.'
      : 'Click to lock: keeps its paint on the next prompt.';
    btn.onclick = () => plugin.setLocked(a.name, !a.locked);
    row.append(sw, label, btn);
    box.append(row);
  }
}

// ------------------------------------------------------------------ loading
async function load(input, name) {
  try {
    const { model } = await plugin.postModel(input, { name });
    viewer.setContent(model.scene, model.gltf.animations);
    if (viewer.clip)
      log(`Playing animation "${viewer.clip.name || 'unnamed'}" (${model.gltf.animations.length} in file)`);
    $('empty-state').hidden = true;
    $('generated').innerHTML = '<span class="muted">Nothing generated yet.</span>';
    setLoaded(true);
    refreshZones();
    openPrompt(); // the prompt pops up as soon as a model is in
  } catch (err) {
    log(`Load failed: ${err.message}`, 'err');
  }
}

function setLoaded(on) {
  $('btn-reskin').disabled = !on;
  $('btn-export').disabled = !on;
  $('btn-idmap').disabled = !on;
  $('btn-idmap').classList.remove('on');
  $('btn-review').disabled = true;
  $('review-section').hidden = true;
  $('history-section').hidden = true;
  $('btn-compare').disabled = true;
  $('btn-toggle').disabled = true;
  if (compareOn) setCompare(false);
}

$('btn-open').onclick = () => $('file-input').click();
$('file-input').onchange = (e) => {
  const files = Array.from(e.target.files ?? []);
  if (files.length) load(files);
  e.target.value = '';
};
const loadSample = async () => load(await buildSampleGlb(), 'sample-robot');
$('btn-sample').onclick = loadSample;
$('link-sample').onclick = (e) => {
  e.preventDefault();
  loadSample();
};

// Drag and drop anywhere in the window.
const overlay = $('drop-overlay');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  overlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    overlay.hidden = true;
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (!files.some((f) => /\.(glb|gltf)$/i.test(f.name))) {
    log('Drop a .glb or .gltf file (plus its .bin/textures for .gltf).', 'warn');
    return;
  }
  if (plugin.isBusy) return log('Busy, try again in a moment.', 'warn');
  load(files);
});

// ------------------------------------------------------------------ layout panel
function renderLayout(layout) {
  $('layout-summary').textContent =
    `${layout.meshCount} meshes · ${layout.materialCount} materials · ${layout.triangleCount.toLocaleString()} triangles · ${layout.slots.length} texture slot(s)`;
  const slotsEl = $('slots');
  slotsEl.innerHTML = '';
  for (const slot of layout.slots) {
    const div = document.createElement('div');
    div.className = 'slot';
    div.dataset.slot = slot.id;
    div.innerHTML = `<div class="slot-head">${escapeHtml(slot.name)}<span>${slot.texture ? `${slot.width}×${slot.height}` : 'untextured'}</span></div>`;
    const thumbs = document.createElement('div');
    thumbs.className = 'thumbs';
    const prev = plugin.slotPreview(slot.id, 256);
    thumbs.append(
      figure(prev.atlasWithUvs, slot.texture ? 'atlas + UVs' : 'UVs', `${slot.name}+atlas`),
      figure(prev.partMap, 'areas', `${slot.name} areas`),
    );
    if (prev.facingMap) thumbs.append(figure(prev.facingMap, 'facing (green front, blue back)', `${slot.name} facing`));
    const o = prev.orientation;
    if (o && (o.rot || o.flipX)) {
      const note = document.createElement('div');
      note.className = 'stats warn-text';
      note.textContent = `"${o.reason}" is stored ${o.rot ? `rotated ${o.rot}°` : ''}${o.flipX ? ' mirrored' : ''}: it will be painted upright and turned back.`;
      thumbs.after(note);
    }
    div.append(thumbs);
    const stats = document.createElement('div');
    stats.className = 'stats';
    stats.innerHTML = [
      `${slot.meshes.length} mesh(es)`,
      `${slot.islands.length} UV islands`,
      `${(slot.coverage.coverage * 100).toFixed(1)}% coverage`,
      `${(slot.coverage.overlap * 100).toFixed(1)}% overlap`,
      slot.tiled ? 'tiled' : '',
      slot.missingUvs ? 'missing UVs' : '',
      slot.otherMaps.length ? slot.otherMaps.join(', ') : '',
    ]
      .filter(Boolean)
      .map((s) => `<span>${s}</span>`)
      .join('');
    div.append(stats);
    slotsEl.append(div);
  }
  $('warnings').innerHTML = layout.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
}

function showGenerated(slotId, kind, canvas) {
  const host = $('generated');
  if (host.querySelector('.muted')) host.innerHTML = '';
  let group = host.querySelector(`[data-slot="${slotId}"]`);
  if (!group) {
    group = document.createElement('div');
    group.className = 'slot';
    group.dataset.slot = slotId;
    const name = plugin.layout?.slots.find((s) => s.id === slotId)?.name ?? slotId;
    group.innerHTML = `<div class="slot-head">${escapeHtml(name)}</div><div class="thumbs"></div>`;
    host.append(group);
  }
  const thumbs = group.querySelector('.thumbs');
  thumbs.querySelector(`[data-kind="${kind}"]`)?.remove();
  const slotName = plugin.layout?.slots.find((s) => s.id === slotId)?.name ?? slotId;
  const fig = figure(named(thumb(canvas, 256), `${slotName} ${kind}`, canvas), kind);
  fig.dataset.kind = kind;
  thumbs.append(fig);
}

function figure(c, caption, saveName) {
  if (saveName) named(c, saveName);
  const f = document.createElement('figure');
  const cap = document.createElement('figcaption');
  cap.textContent = caption;
  f.append(c, cap);
  return f;
}

function thumb(src, size) {
  const s = Math.min(1, size / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * s));
  c.height = Math.max(1, Math.round(src.height * s));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// ------------------------------------------------------------------ prompt popup
const PRESETS = [
  'haunted Halloween pumpkin, glowing orange cracks',
  'frozen ice crystal, frost and snow',
  'molten lava rock with glowing magma veins',
  'cyberpunk neon, chrome and magenta',
  'mossy ancient stone ruin',
  'gold and royal blue ceremonial armor',
  'pastel candy, sprinkles and frosting',
  'rusted steampunk copper and brass',
];
const dialog = $('prompt-dialog');
const runDialog = $('run-dialog');
const promptText = $('prompt-text');
const chips = $('prompt-chips');
for (const p of PRESETS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = p.split(',')[0];
  b.title = p;
  b.onclick = () => {
    promptText.value = p;
    promptText.focus();
  };
  chips.append(b);
}

// ---- step 1: the prompt popup (theme + style; everything else under Advanced)
function openPrompt() {
  if (plugin.isBusy) return runDialog.open || runDialog.show();
  const s = plugin.summary();
  $('prompt-model-info').textContent = s
    ? `${plugin.model?.name}: ${s.slots.length} texture slot(s), ${s.triangleCount.toLocaleString()} triangles`
    : '';
  $('provider-label').textContent = `Backend: ${plugin.getProvider().name}`;
  $('suggest-row').hidden = !plugin.canSuggest;
  if (runDialog.open) runDialog.close();
  updateGoLabel();
  if (!dialog.open) dialog.showModal();
  promptText.focus();
}

$('btn-reskin').onclick = openPrompt;
$('prompt-cancel').onclick = () => dialog.close();

function suggestEnabled() {
  return plugin.canSuggest && $('opt-suggest').checked;
}

function updateGoLabel() {
  $('prompt-go').textContent = suggestEnabled() ? 'Get Muse suggestion' : 'Reskin';
}
$('opt-suggest').addEventListener('change', updateGoLabel);

$('prompt-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const prompt = promptText.value.trim();
  if (!prompt) return;
  if (missingKey()) {
    dialog.close();
    updateKeyBanner(true);
    log('No Muse API key: add MUSE_API_KEY to .env and restart "npm run dev" (or paste a key in Settings).', 'error');
    return;
  }
  dialog.close();
  openRun(prompt);
  if (suggestEnabled()) runSuggest(prompt);
  else runReskin(prompt);
});

// ---- step 2: the progress panel (progress, Muse's detailed prompt, variations, errors)
// The suggestion waiting for the user's OK (art-director step), if any.
let pending = null;

function openRun(prompt) {
  pending = null;
  $('run-title').textContent = 'Painting';
  $('run-theme').textContent = `"${prompt}"`;
  $('suggestion').hidden = true;
  $('variations').hidden = true;
  $('variation-list').innerHTML = '';
  $('prompt-bar').style.width = '0%';
  $('prompt-stage').textContent = '';
  setRunButtons({ go: false });
  hideError();
  if (!runDialog.open) runDialog.show();
}

function setRunButtons({ go = false, busy = false, done = false } = {}) {
  $('run-go').hidden = !go;
  $('prompt-original').hidden = !go;
  $('run-go').textContent = 'Paint with this prompt';
  $('sugg-prompt').disabled = !go;
  $('run-cancel').textContent = busy ? 'Stop' : done ? 'Done' : 'Close';
}

$('run-cancel').onclick = () => {
  if (plugin.isBusy) plugin.cancel();
  else {
    runDialog.close();
    if (pickedReview) {
      pickedReview = false;
      if ($('opt-review').checked && plugin.canReview) runReview();
    }
  }
};

function showSuggestion(s) {
  pending = s;
  const sheet = $('sugg-sheet');
  sheet.innerHTML = '';
  if (s.sheet) sheet.append(named(thumb(s.sheet, 900), 'muse views', s.sheet));
  if (s.idSheet) sheet.append(named(thumb(s.idSheet, 900), 'muse views ID map', s.idSheet));
  $('sugg-subject').textContent = s.subject || 'not sure';
  $('sugg-parts').innerHTML = (s.parts ?? [])
    .map((p) => `<span title="${escapeHtml(p.description ?? '')}">${escapeHtml(p.name)}</span>`)
    .join('');
  $('sugg-prompt').value = s.prompt;
  $('sugg-tips').textContent = s.tips ?? '';
  const regions = Object.entries(s.plans ?? {}).flatMap(([slotId, plan]) => {
    const name = plugin.layout?.slots.find((x) => x.id === slotId)?.name ?? slotId;
    return plan.regions.map(
      (r) => `<li><b>${escapeHtml(name)} / ${escapeHtml(r.name)}</b>: ${escapeHtml(r.description ?? '')}</li>`,
    );
  });
  $('sugg-regions').innerHTML = regions.join('') || '<li>No region plan returned.</li>';
  $('suggestion').hidden = false;
  $('run-title').textContent = 'Muse suggests';
  setRunButtons({ go: true });
  $('sugg-prompt').focus();
}

let retryAction = null;

function hideError() {
  $('prompt-error').hidden = true;
  retryAction = null;
}

/** Shows a failure with Retry / Edit prompt (and Skip suggestion for the suggest step). */
function showError(err, retry, { canSkip = false } = {}) {
  const filtered =
    err.code === 'content_policy_violation' ||
    /content (management |moderation )?polic|filtered due to/i.test(err.message);
  $('err-title').textContent = filtered ? "Muse's safety filter rejected this request" : 'Muse request failed';
  const step = err.step ? ` (step: ${err.step})` : '';
  $('err-text').textContent = filtered
    ? `${err.message}${step}. Tip: describe dark themes with gentler words ("spooky", "eerie", "Halloween") and avoid blood, gore, injuries and weapons.`
    : `${err.message}${step}`;
  $('err-skip').hidden = !canSkip;
  $('err-probe').hidden = !filtered;
  $('prompt-error').hidden = false;
  $('prompt-stage').textContent = '';
  if (!runDialog.open) runDialog.show();
  retryAction = retry;
}

$('err-retry').onclick = () => {
  const r = retryAction;
  hideError();
  r?.();
};
$('err-edit').onclick = () => {
  hideError();
  if (pending) {
    setRunButtons({ go: true });
    $('sugg-prompt').focus();
  } else openPrompt();
};
$('err-skip').onclick = () => {
  hideError();
  $('opt-suggest').checked = false;
  pending = null;
  $('suggestion').hidden = true;
  runReskin(promptText.value.trim());
};

function paintOptions() {
  return {
    detailPreserve: 0,
    useVisionPlanning: $('opt-plan').checked,
    fast: $('opt-fast').checked,
    orientation: $('opt-orient').value,
    paintMode: $('opt-paint-mode').value,
    assetClass: $('opt-asset-class').value,
    variants: Number($('opt-variations').value),
    cleanTinyIslands: $('opt-tiny').checked,
    edgePadding: $('opt-pad').checked ? 12 : 0,
    normalMaps: $('opt-normal').checked,
    roughnessMaps: $('opt-rough').checked,
    maxTextureSize: Number($('opt-size').value),
  };
}

// Set when the user still has to pick a variation; the review runs after they close the panel.
let pickedReview = false;

async function runReskin(text, suggestion) {
  hideError();
  if (!runDialog.open) openRun(text);
  $('run-title').textContent = 'Painting';
  $('prompt-bar').style.width = '0%';
  setRunButtons({ busy: true });
  if (suggestion) $('sugg-prompt').disabled = true;
  try {
    const res = await plugin.postPrompt(text, { suggestion, ...paintOptions() });
    afterPaint();
    log(
      `Reskinned "${res.prompt}": ${res.slots.length} texture(s), ${res.recoloredMaterials} recolored, ${(res.durationMs / 1000).toFixed(1)}s`,
    );
    if ((res.variations?.length ?? 1) > 1) {
      showVariations(res.variations);
      pickedReview = true;
      setRunButtons({ done: true });
      $('run-title').textContent = 'Done';
      $('prompt-stage').textContent = `${res.variations.length} variations ready.`;
    } else {
      runDialog.close();
      if ($('opt-review').checked && plugin.canReview) runReview();
    }
  } catch (err) {
    setRunButtons({});
    if (err.name === 'AbortError') $('prompt-stage').textContent = 'Cancelled';
    else showError(err, () => runReskin(text, suggestion));
  }
}

function afterPaint() {
  if (compareOn) setCompare(true); // refresh the "after" side
  $('btn-toggle').disabled = false;
  $('btn-compare').disabled = false;
  $('btn-review').disabled = !plugin.canReview;
  showingOriginal = false;
  $('btn-toggle').textContent = 'Show original';
}

function showVariations(list) {
  const host = $('variation-list');
  host.innerHTML = '';
  list.forEach((v, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = v.id;
    if (v.thumb) b.append(named(thumb(v.thumb, 200), `variation ${i + 1}`, v.thumb));
    const cap = document.createElement('span');
    cap.textContent = `Variation ${i + 1}`;
    b.append(cap);
    b.onclick = () => {
      plugin.applyHistory(v.id);
      host.querySelectorAll('button').forEach((x) => x.classList.toggle('picked', x === b));
      if (compareOn) setCompare(true);
    };
    if (i === 0) b.classList.add('picked');
    host.append(b);
  });
  $('variations').hidden = false;
}

async function runSuggest(prompt) {
  hideError();
  $('run-title').textContent = 'Muse is studying the model';
  setRunButtons({ busy: true });
  try {
    showSuggestion(
      await plugin.postSuggest(prompt, { fast: $('opt-fast').checked, orientation: $('opt-orient').value }),
    );
    $('prompt-stage').textContent = 'Edit the prompt if you like, then paint.';
  } catch (err) {
    setRunButtons({});
    if (err.name === 'AbortError') $('prompt-stage').textContent = 'Cancelled';
    else showError(err, () => runSuggest(prompt), { canSkip: true });
  }
}

$('run-go').onclick = () => runReskin($('sugg-prompt').value.trim() || promptText.value.trim(), pending);
$('prompt-original').onclick = () => runReskin(promptText.value.trim(), pending);

// ------------------------------------------------------------------ filter probe
function addProbeResult(r) {
  const ul = $('probe-results');
  ul.hidden = false;
  const li = document.createElement('li');
  li.innerHTML = `<span class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓ passed' : r.filtered ? '✗ filtered' : '✗ failed'}</span> <b>${escapeHtml(r.name)}</b>: ${escapeHtml(r.description)} <span class="muted">(${(r.ms / 1000).toFixed(1)}s)</span>${r.ok ? '' : `<br><span class="muted">${escapeHtml(r.error ?? '')}</span>`}`;
  ul.append(li);
  log(`Probe ${r.ok ? 'passed' : 'FAILED'}: ${r.name}${r.ok ? '' : ` (${r.error})`}`, r.ok ? '' : 'err');
}

async function runProbe() {
  const theme = promptText.value.trim();
  if (!theme) return promptText.focus();
  if (typeof plugin.getProvider().probeFilter !== 'function')
    return log('The filter probe needs the Meta Muse backend.', 'warn');
  hideError();
  $('probe-results').innerHTML = '';
  $('probe-results').hidden = false;
  $('probe-results').closest('details')?.setAttribute('open', '');
  $('btn-probe').disabled = true;
  const note = (t) => {
    const li = document.createElement('li');
    li.innerHTML = `<b>${escapeHtml(t)}</b>`;
    $('probe-results').append(li);
  };
  try {
    const results = await plugin.postProbe(theme);
    const failed = results.filter((r) => !r.ok).map((r) => r.name);
    note(failed.length ? `Blocked: ${failed.join(', ')}` : 'Every probe passed.');
  } catch (err) {
    note(`Probe failed: ${err.message}`);
  } finally {
    $('btn-probe').disabled = false;
  }
}
$('btn-probe').onclick = runProbe;
$('err-probe').onclick = () => {
  runDialog.close();
  openPrompt();
  $('advanced').open = true;
  runProbe();
};

// ------------------------------------------------------------------ review & fix
async function runReview() {
  $('btn-review').disabled = true;
  $('btn-reskin').disabled = true;
  try {
    const { passes } = await plugin.postReview({ passes: 1 });
    const fixed = passes.flatMap((p) => p.repainted);
    log(fixed.length ? `Review & fix: repainted ${fixed.join(', ')}` : 'Review: no problems found');
  } catch (err) {
    if (err.name !== 'AbortError') log(`Review failed: ${err.message}`, 'err');
  } finally {
    $('btn-review').disabled = !plugin.canReview;
    $('btn-reskin').disabled = false;
  }
}
$('btn-review').onclick = runReview;

function renderReview(r) {
  $('review-section').hidden = false;
  const host = $('review');
  host.innerHTML = '';
  const p = document.createElement('div');
  p.className = 'muted';
  p.textContent = r.summary || (r.issues.length ? '' : 'Looks good.');
  const ul = document.createElement('ul');
  ul.className = 'review-notes';
  ul.innerHTML = r.issues
    .map(
      (x) =>
        `<li><b>${escapeHtml(x.area || 'general')}</b>: ${escapeHtml(x.problem)}${x.fix ? ` → <i>${escapeHtml(x.fix)}</i>` : ''}</li>`,
    )
    .join('');
  const fig = document.createElement('div');
  fig.className = 'review-sheet';
  fig.append(named(thumb(r.sheet, 640), 'review views', r.sheet));
  host.append(p, ul, fig);
  for (const x of r.issues) log(`Review: ${x.area || 'general'}: ${x.problem}`, 'warn');
  for (const l of r.learned ?? []) log(`Learned tip saved: ${l}`);
  if (r.learned?.length) {
    const t = document.createElement('p');
    t.className = 'muted';
    t.textContent = `Saved for next time: ${r.learned.join(' · ')}`;
    host.append(t);
  }
}

// ------------------------------------------------------------------ ID map
$('btn-idmap').onclick = () => {
  const on = !plugin.idMapVisible;
  plugin.showIdMap(on);
  $('btn-idmap').classList.toggle('on', on);
};

// ------------------------------------------------------------------ image save names
// Right-click an image: save it under a name that says what it is (e.g. "Body+atlas.png").
const fullSize = new WeakMap();
function named(c, name, source) {
  c.dataset.saveName = name;
  if (source) fullSize.set(c, source);
  return c;
}
const imgMenu = $('img-menu');
let menuTarget = null;
document.addEventListener('contextmenu', (e) => {
  const c = e.target.closest?.('canvas[data-save-name]');
  if (!c) return;
  e.preventDefault();
  menuTarget = c;
  $('img-save').textContent = `Save "${fileName(c.dataset.saveName)}"`;
  imgMenu.hidden = false;
  imgMenu.style.left = `${Math.min(e.clientX, innerWidth - 220)}px`;
  imgMenu.style.top = `${Math.min(e.clientY, innerHeight - 90)}px`;
});
document.addEventListener('click', (e) => {
  if (!imgMenu.contains(e.target)) imgMenu.hidden = true;
});
function fileName(name) {
  return `${name.replace(/[\\/:*?"<>|]+/g, '_').trim()}.png`;
}
function menuBlob() {
  const src = fullSize.get(menuTarget) ?? menuTarget;
  return new Promise((r) => src.toBlob(r, 'image/png'));
}
$('img-save').onclick = async () => {
  imgMenu.hidden = true;
  const url = URL.createObjectURL(await menuBlob());
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName(menuTarget.dataset.saveName);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
$('img-open').onclick = async () => {
  imgMenu.hidden = true;
  window.open(URL.createObjectURL(await menuBlob()), '_blank');
};

// ------------------------------------------------------------------ learned tips
// Lessons Muse writes during review & fix; kept in this browser and sent with future prompts.
const LESSONS_KEY = 'muse-reskin-lessons';
function lessonsToText(l) {
  return Object.entries(l)
    .flatMap(([k, list]) => list.map((t) => `${k}: ${t}`))
    .join('\n');
}
function textToLessons(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([a-z][\w-]*)\s*:\s*(.+)$/i);
    const [k, t] = m ? [m[1].toLowerCase(), m[2]] : ['all', line.trim()];
    if (t.trim()) (out[k] ??= []).push(t.trim());
  }
  return out;
}
try {
  plugin.setLessons(JSON.parse(localStorage.getItem(LESSONS_KEY) || '{}'));
} catch {
  /* ignore broken storage */
}
$('lessons').value = lessonsToText(plugin.getLessons());
$('lessons').addEventListener('change', () => plugin.setLessons(textToLessons($('lessons').value)));
$('lessons-clear').onclick = () => plugin.setLessons({});
$('lessons-export').onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(plugin.getLessons(), null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = 'muse-reskin-learned-tips.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
$('lessons-import').onclick = () => $('lessons-file').click();
$('lessons-file').onchange = async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  try {
    const add = JSON.parse(await f.text());
    const cur = plugin.getLessons();
    for (const [k, list] of Object.entries(add)) cur[k] = [...(cur[k] ?? []), ...(Array.isArray(list) ? list : [])];
    plugin.setLessons(cur);
  } catch (err) {
    log(`Could not import tips: ${err.message}`, 'err');
  }
};

// ------------------------------------------------------------------ before/after slider + turntable
let compareOn = false;
function setCompare(on) {
  compareOn = on;
  $('compare').hidden = !on;
  $('btn-compare').classList.toggle('on', on);
  $('btn-toggle').disabled = on || !plugin.lastResult;
  if (!on) {
    viewer.compare?.after();
    viewer.compare = null;
    return;
  }
  if (showingOriginal) $('btn-toggle').click();
  plugin.showIdMap(false);
  viewer.compare = plugin.compareStates();
  placeHandle();
}
function placeHandle() {
  $('compare-handle').style.left = `${viewer.split * 100}%`;
}
$('btn-compare').onclick = () => setCompare(!compareOn);
$('compare-handle').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const host = $('viewport');
  const move = (ev) => {
    const r = host.getBoundingClientRect();
    viewer.split = Math.min(0.98, Math.max(0.02, (ev.clientX - r.left) / r.width));
    placeHandle();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

viewer.onSpinChange = (on) => $('btn-spin').classList.toggle('on', on);
$('btn-spin').onclick = () => viewer.setSpin(!viewer.controls.autoRotate);

// ------------------------------------------------------------------ history + undo
function renderHistory(h) {
  $('history-section').hidden = !h.entries.length;
  const host = $('history');
  host.innerHTML = '';
  const add = (index, label, canvas) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `entry${index === h.index ? ' current' : ''}`;
    b.title = label;
    if (canvas) b.append(named(thumb(canvas, 160), label, canvas));
    const cap = document.createElement('span');
    cap.textContent = label;
    b.append(cap);
    b.onclick = () => {
      if (plugin.isBusy) return;
      plugin.goToHistory(index);
      if (compareOn) setCompare(true);
    };
    host.append(b);
  };
  add(-1, 'Original', null);
  h.entries.forEach((e, i) =>
    add(i, `${e.prompt}${e.of > 1 ? ` · v${e.variant + 1}` : ''}${e.fixes ? ' · fixed' : ''}`, e.thumb),
  );
  $('btn-undo').disabled = h.index < 0;
  $('btn-redo').disabled = h.index >= h.entries.length - 1;
  // Keep the variation picker in sync.
  const cur = h.entries[h.index];
  $('variation-list')
    .querySelectorAll('button')
    .forEach((b) => b.classList.toggle('picked', b.dataset.id === cur?.id));
}
const undo = () => {
  plugin.undo();
  if (compareOn) setCompare(true);
};
const redo = () => {
  plugin.redo();
  if (compareOn) setCompare(true);
};
$('btn-undo').onclick = undo;
$('btn-redo').onclick = redo;
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
  if (e.target.closest?.('textarea, input')) return;
  e.preventDefault();
  if (e.shiftKey) redo();
  else undo();
});

// ------------------------------------------------------------------ compare + export
let showingOriginal = false;
$('btn-toggle').onclick = () => {
  showingOriginal = !showingOriginal;
  plugin.showOriginal(showingOriginal);
  $('btn-toggle').textContent = showingOriginal ? 'Show reskin' : 'Show original';
};

$('btn-export').onclick = async () => {
  if (showingOriginal) $('btn-toggle').click();
  if (compareOn) setCompare(false);
  if (plugin.idMapVisible) $('btn-idmap').click();
  const { glb, filename } = await plugin.postExport();
  const url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};

// ------------------------------------------------------------------ settings dialog
const settingsDialog = $('settings-dialog');
$('btn-settings').onclick = () => {
  const form = $('settings-form');
  form.elements.namedItem('provider').value = settings.provider;
  $('set-key').value = settings.apiKey;
  $('set-proxy').checked = settings.useProxy;
  $('set-advice').value = settings.adviceModel;
  $('set-proxy').disabled = !__HAS_DEV_PROXY__;
  $('key-source').textContent = __MUSE_DEV_KEY__
    ? 'A key from .env is active (dev server). A key typed here overrides it.'
    : __HAS_DEV_PROXY__
      ? 'No MUSE_API_KEY in .env. Add one there, or paste a key here.'
      : 'Hosted build: paste your own key (stored only in this browser), or use the offline backend.';
  settingsDialog.showModal();
};
settingsDialog.addEventListener('close', () => {
  if (settingsDialog.returnValue !== 'save') return;
  const form = $('settings-form');
  settings = {
    provider: form.elements.namedItem('provider').value,
    apiKey: $('set-key').value.trim(),
    useProxy: $('set-proxy').checked,
    adviceModel: $('set-advice').value,
  };
  localStorage.setItem(STORE, JSON.stringify(settings));
  plugin.setProvider(makeProvider(settings));
  log(`Backend: ${plugin.getProvider().name}`);
  updateKeyBanner();
});

// ------------------------------------------------------------------ cost
/** Muse usage badge: this reskin (suggestion + paint + review) and the whole session. */
function showUsage(u) {
  const el = $('cost');
  el.hidden = !u.session.calls;
  $('cost-reskin').textContent = u.reskin.calls ? u.text : 'no Muse calls yet';
  $('cost-session').textContent = u.session.calls ? `Session ${formatDollars(u.sessionCost)}` : '';
  const models = Object.entries(u.reskin.byModel).map(
    ([m, x]) =>
      `${m}: ${x.calls} call(s)${x.images ? `, ${x.images} image(s)` : ''}${x.inputTokens || x.outputTokens ? `, ${x.inputTokens} in / ${x.outputTokens} out tokens` : ''}`,
  );
  el.title = [
    'Estimated Muse cost for this reskin (suggestion, paint and review & fix).',
    ...models,
    'Prices: dev.meta.ai/docs/pricing-rate-limits. Filtered or failed images are free.',
  ].join('\n');
}
$('cost-reset').onclick = () => plugin.resetUsage();

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

updateKeyBanner();
log(`Ready. Backend: ${plugin.getProvider().name}. Drop a model or load the sample.`);
