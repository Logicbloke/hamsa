import {
  AMPLITUDE, LEAD_IN, PAD_SECONDS, PREAMBLE, RAMP_SECONDS,
  symbolLength, toneFreq, toneIndex,
} from './config.js';

// Frame symbols (from encodeFrame) -> mono PCM samples at `sampleRate`.
export function modulate(frame, sampleRate) {
  const symLen = symbolLength(sampleRate);
  const ramp = Math.round(RAMP_SECONDS * sampleRate);
  const pad = Math.round(PAD_SECONDS * sampleRate);
  const envelope = new Float32Array(symLen).fill(AMPLITUDE);
  for (let n = 0; n < ramp; n++) {
    const g = AMPLITUDE * 0.5 * (1 - Math.cos((Math.PI * (n + 0.5)) / ramp));
    envelope[n] = g;
    envelope[symLen - 1 - n] = g;
  }

  const symbols = [LEAD_IN, ...PREAMBLE, ...frame];
  const out = new Float32Array(2 * pad + symbols.length * symLen);
  symbols.forEach((value, i) => {
    // The lead-in is symbol -1, so the preamble starts at index 0.
    const w = (2 * Math.PI * toneFreq(toneIndex(i - 1, value))) / sampleRate;
    const offset = pad + i * symLen;
    for (let n = 0; n < symLen; n++) out[offset + n] = envelope[n] * Math.sin(w * n);
  });
  return out;
}
