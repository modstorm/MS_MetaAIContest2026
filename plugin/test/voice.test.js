import { describe, expect, it } from 'vitest';
import { encodeWav, readWavHeader, isTranscribeReadyWav } from '../src/audio/wav.js';
import { MuseClient } from '../src/muse/MuseClient.js';
import { addUsage, emptyUsage, formatUsage, usageCost } from '../src/muse/pricing.js';

describe('voice transcribe', () => {
  it('encodes a 16 kHz mono 16-bit WAV Muse accepts', async () => {
    const wav = encodeWav(new Float32Array(16000).fill(0.5));
    const bytes = new Uint8Array(await wav.arrayBuffer());
    expect(bytes.length).toBe(44 + 32000);
    const h = readWavHeader(bytes);
    expect(h).toEqual({ format: 1, channels: 1, sampleRate: 16000, bits: 16 });
    expect(isTranscribeReadyWav(h)).toBe(true);
    expect(isTranscribeReadyWav({ ...h, sampleRate: 44100 })).toBe(false);
    expect(readWavHeader(new Uint8Array(64))).toBeNull();
  });

  it('posts multipart to /asr/transcribe and returns the transcript', async () => {
    let seen;
    const usage = [];
    const client = new MuseClient({
      apiKey: 'k',
      fetch: async (url, init) => {
        seen = { url, init };
        return new Response(
          JSON.stringify({
            sessionId: 's',
            transcript: ' make it a rusty pirate car ',
            audioDurationMs: 2400,
            turns: [],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });
    client.onUsage = (u) => usage.push(u);
    const res = await client.transcribe({ audio: encodeWav(new Float32Array(100)) });
    expect(res).toEqual({ text: 'make it a rusty pirate car', durationMs: 2400, sessionId: 's' });
    expect(seen.url).toBe('https://api.meta.ai/v1/asr/transcribe');
    expect(seen.init.headers.Authorization).toBe('Bearer k');
    expect(seen.init.headers['Content-Type']).toBeUndefined();
    const req = JSON.parse(await seen.init.body.get('request').text());
    expect(req).toEqual({ model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', mode: 'PUSH_TO_TALK' });
    expect(seen.init.body.get('audio').type).toBe('audio/wav');
    expect(usage[0]).toMatchObject({ model: 'muse-voice-transcribe-1.0', audioSeconds: 2 });
  });

  it('prices speech at $3 per 1,000 minutes', () => {
    const u = addUsage(emptyUsage(), { model: 'muse-voice-transcribe-1.0', audioSeconds: 60 });
    expect(usageCost(u)).toBeCloseTo(0.003, 6);
    expect(formatUsage(u)).toBe('60 s of speech ≈ $0.003');
  });
});
