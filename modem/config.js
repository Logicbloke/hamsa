// Air-interface constants. Both ends must agree on everything in this file.

// 32 tones from 18.000 kHz to 20.325 kHz: above most adults' hearing, below
// the Nyquist limit of a 44.1 kHz sound card.
export const BASE_FREQ = 18000;
export const TONE_SPACING = 75;
export const TONE_COUNT = 32;
export const MIN_SAMPLE_RATE = 44100;

// 16-FSK: each symbol carries one nibble. Even and odd symbols use two
// interleaved sets of 16 tones, so the echo of the previous symbol never lands
// on a tone the current symbol could be using.
export const SET_SIZE = 16;
export const SYMBOL_SECONDS = 0.04;
// Raised-cosine fade at each symbol edge; hard tone switches click audibly.
export const RAMP_SECONDS = 0.005;
export const AMPLITUDE = 0.8;
export const PAD_SECONDS = 0.08;

// Known symbol values sent before every frame for detection and timing.
export const PREAMBLE = [0, 15, 5, 10, 3, 12, 6, 9];
// Sent before the preamble so speaker amplifiers are awake when it starts.
export const LEAD_IN = 8;

export const HOPS_PER_SYMBOL = 4;

export function symbolLength(sampleRate) {
  return Math.round(SYMBOL_SECONDS * sampleRate);
}

// Tone index for value `value` (0-15) in the `index`-th symbol of a
// transmission, counting the first preamble symbol as 0.
export function toneIndex(index, value) {
  return 2 * value + (index & 1);
}

export function toneFreq(tone) {
  return BASE_FREQ + TONE_SPACING * tone;
}
