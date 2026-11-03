/**
 * Audio helpers for Muse Voice Transcribe. Its file endpoint only takes RIFF/WAVE,
 * mono, 16-bit PCM at 16 kHz or 24 kHz, so browser recordings (webm/opus from Chrome,
 * mp4/aac from Safari) are decoded and resampled to 16 kHz mono first.
 */

export const TRANSCRIBE_RATE = 16000;

/** Mono float samples (-1..1) -> a 16-bit PCM WAV Blob. */
export function encodeWav(samples, sampleRate = TRANSCRIBE_RATE) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * Reads a WAV header. Returns { channels, sampleRate, bits, format } or null if the
 * bytes are not a RIFF/WAVE file.
 */
export function readWavHeader(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 36) return null;
  const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ') return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    format: v.getUint16(20, true),
    channels: v.getUint16(22, true),
    sampleRate: v.getUint32(24, true),
    bits: v.getUint16(34, true),
  };
}

/** True when Muse Voice Transcribe accepts this WAV as is. */
export function isTranscribeReadyWav(header) {
  return (
    !!header &&
    header.format === 1 &&
    header.channels === 1 &&
    header.bits === 16 &&
    (header.sampleRate === 16000 || header.sampleRate === 24000)
  );
}

/**
 * Any audio Blob the browser can decode -> a WAV Blob Muse Voice Transcribe accepts
 * (16 kHz, mono, 16-bit). A WAV that is already in that format is passed through.
 * Needs the Web Audio API (browser only).
 * @param {Blob} audio
 * @returns {Promise<{ wav: Blob, durationMs: number }>}
 */
export async function toTranscribeWav(audio) {
  const bytes = new Uint8Array(await audio.arrayBuffer());
  const header = readWavHeader(bytes);
  if (isTranscribeReadyWav(header)) {
    const durationMs = Math.round(((bytes.length - 44) / 2 / header.sampleRate) * 1000);
    return { wav: audio.type === 'audio/wav' ? audio : new Blob([bytes], { type: 'audio/wav' }), durationMs };
  }
  const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  const OAC = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
  if (!AC || !OAC) throw new Error('This browser cannot decode audio (no Web Audio API)');
  const ctx = new AC();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } finally {
    ctx.close?.();
  }
  const length = Math.max(1, Math.ceil(decoded.duration * TRANSCRIBE_RATE));
  const off = new OAC(1, length, TRANSCRIBE_RATE); // one channel: the mix-down happens here
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return {
    wav: encodeWav(rendered.getChannelData(0), TRANSCRIBE_RATE),
    durationMs: Math.round(decoded.duration * 1000),
  };
}
