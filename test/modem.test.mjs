import test from 'node:test';
import assert from 'node:assert/strict';
import { rsEncode, rsDecode } from '../modem/reedsolomon.js';
import {
  HEADER_NIBBLES, MAX_BYTES, NAME_MAX_BYTES, bodyNibbles, decodeBody, decodeHeader, decodeName,
  encodeAnnounce, encodeControl, encodeFrame, encodeRange,
} from '../modem/codec.js';
import { modulate } from '../modem/modulator.js';
import { Demodulator } from '../modem/demodulator.js';
import { PAD_SECONDS, symbolLength } from '../modem/config.js';
import { SELF_PATH, SPEED_OF_SOUND, distance, formatDistance, turnaroundMicros } from '../modem/ranging.js';

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

// A frame without its arrival time.
const bare = ({ at, ...frame }) => frame;

// Sample at which the preamble of modulate()'s output begins.
const preambleOffset = (sampleRate) => Math.round(PAD_SECONDS * sampleRate) + symbolLength(sampleRate);

// Run samples through a receiver in microphone-sized blocks. Messages are
// returned as their text, other frames as their type.
function receive(samples, sampleRate, blockSize = 2048) {
  const frames = [];
  const demod = new Demodulator(sampleRate, {
    onFrame: (f) => frames.push(f.type === 'message' ? f.text : f.type),
  });
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
  for (const text of ['a', 'hello world', 'héllo wörld 👋 همسة', 'x'.repeat(MAX_BYTES - 1)]) {
    const frame = encodeFrame(text, { id: 201, from: 77 });
    const { type, id, from, length } = decodeHeader(frame.subarray(0, HEADER_NIBBLES));
    assert.deepEqual([type, id, from], ['message', 201, 77]);
    assert.equal(length, new TextEncoder().encode(text).length + 1);
    assert.equal(frame.length, HEADER_NIBBLES + bodyNibbles(length));
    assert.deepEqual(decodeBody(frame.subarray(HEADER_NIBBLES), length), { name: '', text });
  }
});

test('codec rejects empty and oversized messages', () => {
  assert.throws(() => encodeFrame(''), RangeError);
  assert.throws(() => encodeFrame('x'.repeat(MAX_BYTES)), RangeError);
});

test('codec carries the sender name with the text', () => {
  for (const name of ['Taha', 'طه', 'n'.repeat(NAME_MAX_BYTES)]) {
    const text = 'x'.repeat(MAX_BYTES - 1 - new TextEncoder().encode(name).length);
    const frame = encodeFrame(text, { name });
    const { length } = decodeHeader(frame.subarray(0, HEADER_NIBBLES));
    assert.equal(length, MAX_BYTES);
    assert.deepEqual(decodeBody(frame.subarray(HEADER_NIBBLES), length), { name, text });
    assert.throws(() => encodeFrame(`${text}x`, { name }), RangeError);
  }
  assert.throws(() => encodeFrame('hi', { name: 'n'.repeat(NAME_MAX_BYTES + 1) }), RangeError);
  assert.throws(() => encodeFrame('hi', { name: 'a\0b' }), RangeError);
});

test('codec round-trips hello, here and range frames', () => {
  for (const type of ['hello', 'here']) {
    for (const name of ['', 'Sara', 'سارة']) {
      const frame = encodeAnnounce(type, 9, name);
      const header = decodeHeader(frame.subarray(0, HEADER_NIBBLES));
      assert.deepEqual(header, { type, from: 9, length: new TextEncoder().encode(name).length });
      if (name) assert.equal(decodeName(frame.subarray(HEADER_NIBBLES), header.length), name);
      else assert.equal(frame.length, HEADER_NIBBLES);
    }
  }
  for (const micros of [0, 1, 0x1234, 0xffff]) {
    assert.deepEqual(decodeHeader(encodeRange(micros)), { type: 'range', micros });
  }
});

test('codec repairs a few bad symbols and rejects a wrecked frame', () => {
  const text = 'the quick brown fox';
  const frame = encodeFrame(text);
  const { length } = decodeHeader(frame.subarray(0, HEADER_NIBBLES));
  const body = frame.slice(HEADER_NIBBLES);
  body[3] ^= 5;
  body[20] ^= 9;
  assert.equal(decodeBody(body, length).text, text);
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
    const text = 'z'.repeat(MAX_BYTES - 1);
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
  assert.deepEqual(receive(padded, sr), ['garbled']);
});

test('reports sync and progress before the frame', () => {
  const sr = 48000;
  const events = [];
  const demod = new Demodulator(sr, {
    onSync: (n) => events.push(['sync', n]),
    onProgress: (f) => events.length < 2 && events.push(['progress', f > 0 && f < 1]),
    onFrame: (f) => events.push(['frame', f]),
  });
  demod.push(channel(modulate(encodeFrame('hi', { id: 7, from: 3, name: 'Al' }), sr), sr, {}));
  events[2][1] = bare(events[2][1]);
  assert.deepEqual(events, [
    ['sync', 5], ['progress', true],
    ['frame', { type: 'message', id: 7, from: 3, broadcast: false, name: 'Al', text: 'hi' }],
  ]);
});

test('header survives two bad bytes and rejects garbage', () => {
  const header = encodeFrame('hello', { id: 42, from: 8 }).slice(0, HEADER_NIBBLES);
  header[0] ^= 7;
  header[5] ^= 1;
  assert.deepEqual(decodeHeader(header), { type: 'message', id: 42, from: 8, length: 6, broadcast: false });
  header[8] ^= 3;
  header[10] ^= 3;
  assert.notDeepEqual(decodeHeader(header), { type: 'message', id: 42, from: 8, length: 6, broadcast: false });
});

test('ack and nack frames carry the message id through noise and echo', () => {
  const sr = 44100;
  for (const type of ['ack', 'nack']) {
    for (let seed = 1; seed <= 5; seed++) {
      const frames = [];
      const demod = new Demodulator(sr, { onFrame: (f) => frames.push(f) });
      demod.push(channel(modulate(encodeControl(type, 37 + seed, 5), sr), sr, {
        gain: 0.01, noise: 0.02, echoes: [[0.02, 0.5]], seed,
      }));
      assert.deepEqual(frames.map(bare), [{ type, id: 37 + seed, from: 5 }]);
    }
  }
});

test('a message followed by its ack', () => {
  const sr = 48000;
  const a = channel(modulate(encodeFrame('ping', { id: 9 }), sr), sr, {});
  const b = channel(modulate(encodeControl('ack', 9), sr), sr, {});
  const audio = new Float32Array(a.length + b.length);
  audio.set(a);
  audio.set(b, a.length);
  assert.deepEqual(receive(audio, sr), ['ping', 'ack']);
});

test('broadcast flag survives the air, at any length', () => {
  const sr = 48000;
  for (const text of ['b', 'to everyone', 'y'.repeat(MAX_BYTES - 1)]) {
    const frames = [];
    const demod = new Demodulator(sr, { onFrame: (f) => frames.push(f) });
    demod.push(channel(modulate(encodeFrame(text, { id: 3, broadcast: true }), sr), sr, { gain: 0.05, noise: 0.01 }));
    assert.deepEqual(frames.map(bare), [{ type: 'message', id: 3, from: 0, broadcast: true, name: '', text }]);
  }
});

test('a cut-off broadcast is reported as a garbled broadcast', () => {
  const sr = 48000;
  const signal = modulate(encodeFrame('this broadcast gets cut off halfway through', { id: 4, broadcast: true }), sr);
  const audio = channel(signal.subarray(0, signal.length >> 1), sr, {});
  const frames = [];
  const demod = new Demodulator(sr, { onFrame: (f) => frames.push(f) });
  demod.push(audio);
  demod.push(new Float32Array(sr * 2).map((_, i) => 0.001 * Math.sin(i)));
  assert.deepEqual(frames.map(bare), [{ type: 'garbled', id: 4, from: 0, broadcast: true }]);
});

test('hello, here and range frames survive the air', () => {
  const sr = 44100;
  const sent = [
    [encodeAnnounce('hello', 21, 'Taha'), { type: 'hello', from: 21, name: 'Taha' }],
    [encodeAnnounce('here', 22, ''), { type: 'here', from: 22, name: '' }],
    [encodeRange(54321), { type: 'range', micros: 54321 }],
  ];
  for (const [frame, expected] of sent) {
    const frames = [];
    const demod = new Demodulator(sr, { onFrame: (f) => frames.push(f) });
    demod.push(channel(modulate(frame, sr), sr, { gain: 0.02, noise: 0.01, echoes: [[0.02, 0.4]] }));
    assert.deepEqual(frames.map(bare), [expected]);
  }
});

test('a hello cut off inside the name still announces the device', () => {
  const sr = 48000;
  const signal = modulate(encodeAnnounce('hello', 30, 'Abdurrahman'), sr);
  const frames = [];
  const demod = new Demodulator(sr, { onFrame: (f) => frames.push(f) });
  demod.push(channel(signal.subarray(0, Math.round(signal.length * 0.7)), sr, {}));
  demod.push(new Float32Array(sr * 2).map((_, i) => 0.001 * Math.sin(i)));
  assert.deepEqual(frames.map(bare), [{ type: 'hello', from: 30, name: '' }]);
});

for (const sampleRate of [44100, 48000]) {
  test(`arrival time is found to a fraction of a sample at ${sampleRate} Hz`, () => {
    const rand = rng(sampleRate + 1);
    const signal = modulate(encodeControl('ack', 1, 2), sampleRate);
    for (let trial = 0; trial < 20; trial++) {
      const lead = 0.2 + rand() * 0.3;
      const frames = [];
      const demod = new Demodulator(sampleRate, { onFrame: (f) => frames.push(f) });
      const audio = channel(signal, sampleRate, { lead, gain: 0.05, noise: 0.005, seed: trial + 1 });
      const blockSize = 128 + Math.floor(rand() * 4096);
      for (let i = 0; i < audio.length; i += blockSize) demod.push(audio.subarray(i, i + blockSize));
      const expected = Math.round(lead * sampleRate) + preambleOffset(sampleRate);
      assert.equal(frames.length, 1, `trial ${trial}`);
      assert.ok(Math.abs(frames[0].at * sampleRate - expected) < 0.5,
        `trial ${trial}: off by ${frames[0].at * sampleRate - expected} samples`);
    }
  });
}

test('arrival time survives room echo', () => {
  const sr = 48000;
  const frames = [];
  const demod = new Demodulator(sr, { onFrame: (f) => frames.push(f) });
  demod.push(channel(modulate(encodeFrame('echo'), sr), sr, {
    gain: 0.1, noise: 0.005, echoes: [[0.011, 0.6], [0.027, 0.4], [0.049, 0.25]],
  }));
  const expected = Math.round(0.3 * sr) + preambleOffset(sr);
  assert.ok(Math.abs(frames[0].at * sr - expected) < 3, `off by ${frames[0].at * sr - expected} samples`);
});

test('ranging arithmetic', () => {
  // 1 m apart: the answer comes back 2 m of travel later than B's turnaround.
  const travel = (2 * (1 - SELF_PATH)) / SPEED_OF_SOUND;
  for (const turnaround of [0.7, 1.234567, 9.9]) {
    const micros = turnaroundMicros(100, 100 + turnaround);
    assert.ok(Math.abs(distance(5, 5 + turnaround + travel, micros) - 1) < 0.001);
  }
  // Slightly negative readings are noise around zero; anything else is rejected.
  assert.equal(distance(5, 5.7, turnaroundMicros(0, 0.7003)), 0);
  assert.equal(distance(5, 5.7, turnaroundMicros(0, 0.703)), null);
  assert.equal(distance(5, 5.76, turnaroundMicros(0, 0.7)), null);
  assert.equal(formatDistance(0.034), '3 cm');
  assert.equal(formatDistance(1.26), '1.3 m');
});

test('two devices measure the distance between them', () => {
  // Each device records at its own rate and hears its own speaker loudly and
  // the other one faintly. Arrival samples are picked per device; the
  // distance they imply follows from the ranging formula.
  const hear = (sampleRate, arrivals, seed) => {
    const rand = rng(seed);
    const audio = new Float32Array(sampleRate * 6);
    for (const [frame, at, gain] of arrivals) {
      const signal = modulate(frame, sampleRate);
      const start = at - preambleOffset(sampleRate);
      for (let i = 0; i < signal.length; i++) audio[start + i] += gain * signal[i];
    }
    for (let i = 0; i < audio.length; i++) audio[i] += 0.003 * gaussian(rand);
    const frames = [];
    const demod = new Demodulator(sampleRate, { onFrame: (f) => frames.push(f) });
    for (let i = 0; i < audio.length; i += 2048) demod.push(audio.subarray(i, i + 2048));
    return frames;
  };
  const message = encodeFrame('how far?', { id: 5, from: 1, name: 'A' });
  const ack = encodeControl('ack', 5, 2);
  const [fa, fb] = [48000, 44100];
  for (const extra of [0, 13, 140, 700]) {
    const a = [30000, 30000 + 3 * fa + extra];
    const b = [52000, 52000 + 3 * fb];
    const heardA = hear(fa, [[message, a[0], 0.9], [ack, a[1], 0.03]], 11);
    const heardB = hear(fb, [[message, b[0], 0.03], [ack, b[1], 0.9]], 12);
    assert.deepEqual(heardA.map((f) => f.type), ['message', 'ack']);
    assert.deepEqual(heardB.map((f) => f.type), ['message', 'ack']);
    const measured = distance(heardA[0].at, heardA[1].at, turnaroundMicros(heardB[0].at, heardB[1].at));
    const expected = (SPEED_OF_SOUND * (extra / fa)) / 2 + SELF_PATH;
    assert.ok(Math.abs(measured - expected) < 0.01, `expected ${expected} m, measured ${measured} m`);
  }
});
