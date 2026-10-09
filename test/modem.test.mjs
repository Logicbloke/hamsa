import test from 'node:test';
import assert from 'node:assert/strict';
import { rsEncode, rsDecode } from '../modem/reedsolomon.js';
import {
  HEADER_NIBBLES, MAX_BYTES, bodyNibbles, decodeBody, decodeHeader, encodeFrame,
} from '../modem/codec.js';
import { modulate } from '../modem/modulator.js';
import { Demodulator } from '../modem/demodulator.js';

// Deterministic PRNG so failures are reproducible.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
}

// Run samples through a receiver in microphone-sized blocks.
function receive(samples, sampleRate, blockSize = 2048) {
  const frames = [];
  const demod = new Demodulator(sampleRate, { onFrame: (f) => frames.push(f) });
  for (let i = 0; i < samples.length; i += blockSize) {
    demod.push(samples.subarray(i, i + blockSize));
  }
  return frames;
}

// Simulated air path: delay, attenuation, echoes and white noise.
function channel(signal, sampleRate, { lead = 0.3, gain = 1, noise = 0, echoes = [], seed = 1 }) {
  const rand = rng(seed);
  const offset = Math.round(lead * sampleRate);
  const out = new Float32Array(offset + signal.length + sampleRate);
  for (let i = 0; i < signal.length; i++) out[offset + i] += gain * signal[i];
  for (const [delay, level] of echoes) {
    const d = offset + Math.round(delay * sampleRate);
    for (let i = 0; i < signal.length; i++) out[d + i] += gain * level * signal[i];
  }
  if (noise) for (let i = 0; i < out.length; i++) out[i] += noise * gaussian(rand);
  return out;
}

test('reed-solomon corrects up to nsym/2 byte errors', () => {
  const rand = rng(7);
  for (let trial = 0; trial < 200; trial++) {
    const nsym = 2 * (1 + Math.floor(rand() * 16));
    const data = Uint8Array.from({ length: 1 + Math.floor(rand() * 120) }, () => rand() * 256);
    const code = rsEncode(data, nsym);
    const positions = new Set();
    const errors = Math.floor(rand() * (nsym / 2 + 1));
    while (positions.size < errors) positions.add(Math.floor(rand() * code.length));
    for (const p of positions) code[p] ^= 1 + Math.floor(rand() * 255);
    assert.deepEqual(rsDecode(code, nsym), data, `trial ${trial}: ${errors} errors, nsym ${nsym}`);
  }
});

test('reed-solomon rejects a codeword with too many errors', () => {
  const data = Uint8Array.from({ length: 40 }, (_, i) => i * 7);
  const code = rsEncode(data, 8);
  for (let i = 0; i < 12; i++) code[i * 3] ^= 0x5a;
  const decoded = rsDecode(code, 8);
  assert.ok(decoded === null || !decoded.every((b, i) => b === data[i]));
});

test('codec round-trips text, including multi-byte characters', () => {
  for (const text of ['a', 'hello world', 'héllo wörld 👋 همسة', 'x'.repeat(MAX_BYTES)]) {
    const frame = encodeFrame(text);
    const length = decodeHeader(frame.subarray(0, HEADER_NIBBLES));
    assert.equal(length, new TextEncoder().encode(text).length);
    assert.equal(frame.length, HEADER_NIBBLES + bodyNibbles(length));
    assert.equal(decodeBody(frame.subarray(HEADER_NIBBLES), length), text);
  }
});

test('codec rejects empty and oversized messages', () => {
  assert.throws(() => encodeFrame(''), RangeError);
  assert.throws(() => encodeFrame('x'.repeat(MAX_BYTES + 1)), RangeError);
});

test('codec repairs a few bad symbols and rejects a wrecked frame', () => {
  const text = 'the quick brown fox';
  const frame = encodeFrame(text);
  const length = decodeHeader(frame.subarray(0, HEADER_NIBBLES));
  const body = frame.slice(HEADER_NIBBLES);
  body[3] ^= 5;
  body[20] ^= 9;
  assert.equal(decodeBody(body, length), text);
  for (let i = 0; i < body.length; i += 2) body[i] ^= 3;
  assert.equal(decodeBody(body, length), null);
});

for (const sampleRate of [44100, 48000]) {
  test(`clean loopback at ${sampleRate} Hz`, () => {
    const text = 'Hello over ultrasound!';
    const audio = channel(modulate(encodeFrame(text), sampleRate), sampleRate, {});
    assert.deepEqual(receive(audio, sampleRate), [text]);
  });

  test(`longest message at ${sampleRate} Hz`, () => {
    const text = 'z'.repeat(MAX_BYTES);
    const audio = channel(modulate(encodeFrame(text), sampleRate), sampleRate, {});
    assert.deepEqual(receive(audio, sampleRate), [text]);
  });

  test(`any start offset and block size at ${sampleRate} Hz`, () => {
    const rand = rng(sampleRate);
    const text = 'timing test ✓';
    const signal = modulate(encodeFrame(text), sampleRate);
    for (let trial = 0; trial < 25; trial++) {
      const audio = channel(signal, sampleRate, { lead: 0.2 + rand() * 0.2 });
      const blockSize = 128 + Math.floor(rand() * 4096);
      assert.deepEqual(receive(audio, sampleRate, blockSize), [text], `trial ${trial}`);
    }
  });

  test(`quiet signal in noise at ${sampleRate} Hz`, () => {
    const text = 'can you hear me?';
    const signal = modulate(encodeFrame(text), sampleRate);
    for (let seed = 1; seed <= 10; seed++) {
      // Tone at about -46 dBFS under broadband noise at -34 dBFS RMS.
      const audio = channel(signal, sampleRate, { gain: 0.006, noise: 0.02, seed });
      assert.deepEqual(receive(audio, sampleRate), [text], `seed ${seed}`);
    }
  });

  test(`room echo at ${sampleRate} Hz`, () => {
    const text = 'echo echo echo';
    const audio = channel(modulate(encodeFrame(text), sampleRate), sampleRate, {
      gain: 0.1,
      noise: 0.005,
      echoes: [[0.011, 0.6], [0.027, 0.4], [0.049, 0.25]],
    });
    assert.deepEqual(receive(audio, sampleRate), [text]);
  });
}

test('two messages in a row are both received', () => {
  const sr = 48000;
  const a = channel(modulate(encodeFrame('first'), sr), sr, {});
  const b = channel(modulate(encodeFrame('second'), sr), sr, {});
  const audio = new Float32Array(a.length + b.length);
  audio.set(a);
  audio.set(b, a.length);
  assert.deepEqual(receive(audio, sr), ['first', 'second']);
});

test('noise and audible sound alone produce no frames', () => {
  const sr = 48000;
  const rand = rng(99);
  const audio = new Float32Array(sr * 20);
  for (let i = 0; i < audio.length; i++) {
    audio[i] = 0.2 * gaussian(rand) + 0.3 * Math.sin((2 * Math.PI * 440 * i) / sr);
  }
  assert.deepEqual(receive(audio, sr), []);
});

test('a transmission cut off mid-frame is reported as unrecoverable', () => {
  const sr = 48000;
  const signal = modulate(encodeFrame('this message gets cut off halfway through'), sr);
  const audio = channel(signal.subarray(0, signal.length >> 1), sr, { noise: 0.001 });
  const padded = new Float32Array(audio.length + sr * 3);
  padded.set(audio);
  const rand = rng(3);
  for (let i = audio.length; i < padded.length; i++) padded[i] = 0.001 * gaussian(rand);
  assert.deepEqual(receive(padded, sr), [null]);
});

test('reports sync and progress before the frame', () => {
  const sr = 48000;
  const events = [];
  const demod = new Demodulator(sr, {
    onSync: (n) => events.push(['sync', n]),
    onProgress: (f) => events.length < 2 && events.push(['progress', f > 0 && f < 1]),
    onFrame: (t) => events.push(['frame', t]),
  });
  demod.push(channel(modulate(encodeFrame('hi'), sr), sr, {}));
  assert.deepEqual(events, [['sync', 2], ['progress', true], ['frame', 'hi']]);
});
