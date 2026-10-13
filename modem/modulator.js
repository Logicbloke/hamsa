import {
  AMPLITUDE, LEAD_IN, PAD_SECONDS, PREAMBLE, RAMP_SECONDS,
  symbolLength, toneFreq, toneIndex,
} from './config.js';

function symbolEnvelope(sampleRate) {
  const symLen = symbolLength(sampleRate);
  const ramp = Math.round(RAMP_SECONDS * sampleRate);
  const envelope = new Float32Array(symLen).fill(AMPLITUDE);
  for (let n = 0; n < ramp; n++) {
    const g = AMPLITUDE * 0.5 * (1 - Math.cos((Math.PI * (n + 0.5)) / ramp));
    envelope[n] = g;
    envelope[symLen - 1 - n] = g;
  }
  return envelope;
}

// Write symbol number `index` of a transmission, carrying `value`, at `offset`.
function writeSymbol(out, offset, index, value, sampleRate, envelope, wave = Math.sin) {
  const w = (2 * Math.PI * toneFreq(toneIndex(index, value))) / sampleRate;
  for (let n = 0; n < envelope.length; n++) out[offset + n] = envelope[n] * wave(w * n);
}

// Frame symbols (from encodeFrame) -> mono PCM samples at `sampleRate`.
export function modulate(frame, sampleRate) {
  const symLen = symbolLength(sampleRate);
  const pad = Math.round(PAD_SECONDS * sampleRate);
  const envelope = symbolEnvelope(sampleRate);
  const symbols = [LEAD_IN, ...PREAMBLE, ...frame];
  const out = new Float32Array(2 * pad + symbols.length * symLen);
  symbols.forEach((value, i) => {
    // The lead-in is symbol -1, so the preamble starts at index 0.
    writeSymbol(out, pad + i * symLen, i - 1, value, sampleRate, envelope);
  });
  return out;
}

// The preamble exactly as transmitted, and the same shifted a quarter cycle,
// for a receiver to correlate against when timing an arrival.
export function preambleTemplate(sampleRate) {
  const symLen = symbolLength(sampleRate);
  const envelope = symbolEnvelope(sampleRate);
  const sin = new Float64Array(PREAMBLE.length * symLen);
  const cos = new Float64Array(sin.length);
  PREAMBLE.forEach((value, i) => {
    writeSymbol(sin, i * symLen, i, value, sampleRate, envelope);
    writeSymbol(cos, i * symLen, i, value, sampleRate, envelope, Math.cos);
  });
  return { sin, cos };
}
