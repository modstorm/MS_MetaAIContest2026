import './styles.css';
import { MuseProvider, ProceduralProvider, ReskinPlugin } from '@metaai26/reskin-plugin';
import { Viewer } from './viewer.js';
import { buildSampleGlb } from './sampleModel.js';

/**
 * Test harness. It only does UI: load a file, ask for a prompt, show results.
 * Every model call and all mesh/texture work happens inside ReskinPlugin.
 */

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ settings

const STORE = 'muse-reskin-settings';

function loadSettings() {
  const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}');
  const hasKey = !!(saved.apiKey || __MUSE_DEV_KEY__);
  return {
    // Default to Muse when a key is known, otherwise offline so it works out of the box.
    provider: saved.provider ?? (hasKey ? 'muse' : 'offline'),
    apiKey: saved.apiKey ?? '',
    useProxy: saved.useProxy ?? false,
  };
}
let settings = loadSettings();

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
        `⏱ ${e.data.step}${e.data.slotName ? ` (${e.data.slotName})` : ''}: ${(e.data.ms / 1000).toFixed(1)}s${e.data.ok ? '' : ' (failed)'}`,
      );
      break;
    case 'warning':
      log(e.data.message, 'warn');
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
  }
});

// ------------------------------------------------------------------ loading
async function load(input, name) {
  try {
    const { model } = await plugin.postModel(input, { name });
    viewer.setContent(model.scene, model.gltf.animations);
    $('empty-state').hidden = true;
    $('generated').innerHTML = '<span class="muted">Nothing generated yet.</span>';
    setLoaded(true);
    openPrompt(); // the prompt pops up as soon as a model is in
  } catch (err) {
    log(`Load failed: ${err.message}`, 'err');
  }
}

function setLoaded(on) {
  $('btn-reskin').disabled = !on;
  $('btn-export').disabled = !on;
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
    thumbs.append(figure(prev.atlasWithUvs, slot.texture ? 'atlas + UVs' : 'UVs'), figure(prev.uvGuide, 'island mask'));
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
  const fig = figure(thumb(canvas, 256), kind);
  fig.dataset.kind = kind;
  thumbs.append(fig);
}

function figure(c, caption) {
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
$('opt-detail').oninput = (e) => ($('opt-detail-out').textContent = e.target.value);

function openPrompt() {
  const s = plugin.summary();
  $('prompt-model-info').textContent = s
    ? `${plugin.model?.name}: ${s.slots.length} texture slot(s), ${s.triangleCount.toLocaleString()} triangles`
    : '';
  $('provider-label').textContent = `Backend: ${plugin.getProvider().name}`;
  $('prompt-progress').hidden = true;
  setPromptBusy(false);
  if (!dialog.open) dialog.showModal();
  promptText.focus();
}

function setPromptBusy(busy) {
  $('prompt-go').disabled = busy;
  promptText.disabled = busy;
  $('prompt-cancel').textContent = busy ? 'Stop' : 'Cancel';
}

$('btn-reskin').onclick = openPrompt;
$('prompt-cancel').onclick = () => {
  if (plugin.isBusy) plugin.cancel();
  else dialog.close();
};
$('prompt-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = promptText.value.trim();
  if (!prompt) return;
  $('prompt-progress').hidden = false;
  $('prompt-bar').style.width = '0%';
  setPromptBusy(true);
  try {
    const res = await plugin.postPrompt(prompt, {
      detailPreserve: Number($('opt-detail').value),
      useVisionPlanning: $('opt-plan').checked,
      fast: $('opt-fast').checked,
      normalMaps: $('opt-normal').checked,
      roughnessMaps: $('opt-rough').checked,
      maxTextureSize: Number($('opt-size').value),
    });
    dialog.close();
    showingOriginal = false;
    $('btn-toggle').textContent = 'Show original';
    $('btn-toggle').disabled = false;
    log(
      `Reskinned "${res.prompt}": ${res.slots.length} texture(s), ${res.recoloredMaterials} recolored, ${(res.durationMs / 1000).toFixed(1)}s`,
    );
  } catch (err) {
    $('prompt-stage').textContent = `Failed: ${err.message}`;
  } finally {
    setPromptBusy(false);
  }
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
  };
  localStorage.setItem(STORE, JSON.stringify(settings));
  plugin.setProvider(makeProvider(settings));
  log(`Backend: ${plugin.getProvider().name}`);
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

log(`Ready. Backend: ${plugin.getProvider().name}. Drop a model or load the sample.`);
