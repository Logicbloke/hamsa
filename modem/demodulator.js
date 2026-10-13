import {
  HOPS_PER_SYMBOL, PREAMBLE, SET_SIZE, TONE_COUNT,
  symbolLength, toneFreq, toneIndex,
} from './config.js';
import { HEADER_NIBBLES, bodyNibbles, decodeBody, decodeHeader, decodeName } from './codec.js';
import { preambleTemplate } from './modulator.js';

const P = PREAMBLE.length;
const HISTORY = (P - 1) * HOPS_PER_SYMBOL + 1;
// Hops to keep looking for a better alignment after the preamble first matches.
const CONFIRM_HOPS = 6;
// Give up on a frame after this many consecutive symbols with no clear tone.
const LOST_SYMBOLS = 8;
const LOST_RATIO = 0.3;

// Streaming receiver: feed it microphone samples with push(); it reports
//   onSync(length, header)  a header was read, `length` payload bytes follow
//   onProgress(fraction)    while a body is arriving
//   onFrame(frame)          frame finished, one of
//                             { type: 'message', id, from, broadcast, name, text }
//                             { type: 'garbled', id, from, broadcast }  body unrecoverable
//                             { type: 'ack' | 'nack', id, from }
//                             { type: 'hello' | 'here', from, name }
//                             { type: 'range', micros }
//                           each with `at`, the moment its preamble began to
//                           arrive, in seconds of audio pushed so far (or
//                           undefined if that could not be measured)
//   onLevel(dbfs)           strongest in-band tone, for a signal meter
export class Demodulator {
  constructor(sampleRate, handlers = {}) {
    this.handlers = handlers;
    this.sampleRate = sampleRate;
    this.template = preambleTemplate(sampleRate);
    this.symLen = symbolLength(sampleRate);
    this.hop = Math.floor(this.symLen / HOPS_PER_SYMBOL);

    this.window = new Float64Array(this.symLen);
    for (let n = 0; n < this.symLen; n++) {
      this.window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (n + 0.5)) / this.symLen);
    }
    this.coeff = new Float64Array(TONE_COUNT);
    for (let t = 0; t < TONE_COUNT; t++) {
      this.coeff[t] = 2 * Math.cos((2 * Math.PI * toneFreq(t)) / sampleRate);
    }

    // Linear buffer of recent samples; buf[0] is absolute sample `base`.
    this.keep = this.symLen * (P + 6);
    this.buf = new Float32Array(2 * this.keep);
    this.scratch = new Float64Array(this.symLen);
    this.energy = new Float64Array(TONE_COUNT);
    this.history = Array.from({ length: HISTORY }, () => new Float64Array(TONE_COUNT));
    this.base = 0;
    this.len = 0;
    this.reset();
  }

  // Drop any partial frame and start searching from the next sample.
  reset() {
    this.receiving = false;
    this.candidate = null;
    this.historyCount = 0;
    this.historyPos = 0;
    this.nextEnd = this.base + this.len + this.symLen;
  }

  push(samples) {
    for (let offset = 0; offset < samples.length; offset += this.symLen) {
      const chunk = samples.subarray(offset, offset + this.symLen);
      if (this.len + chunk.length > this.buf.length) {
        this.buf.copyWithin(0, this.len - this.keep, this.len);
        this.base += this.len - this.keep;
        this.len = this.keep;
      }
      this.buf.set(chunk, this.len);
      this.len += chunk.length;
      this._process();
    }
  }

  _process() {
    const total = this.base + this.len;
    for (;;) {
      if (this.receiving) {
        if (this.dataStart + (this.nibbles.length + 1) * this.symLen > total) break;
        this._dataStep();
      } else {
        if (this.nextEnd > total) break;
        this._searchStep(this.nextEnd);
        this.nextEnd += this.hop;
      }
    }
  }

  // Goertzel power of every tone over one Hann-windowed symbol.
  _energies(start, out) {
    const { buf, window, scratch, coeff, symLen } = this;
    const o = start - this.base;
    for (let n = 0; n < symLen; n++) scratch[n] = buf[o + n] * window[n];
    for (let t = 0; t < TONE_COUNT; t++) {
      const c = coeff[t];
      let s1 = 0;
      let s2 = 0;
      for (let n = 0; n < symLen; n++) {
        const s = scratch[n] + c * s1 - s2;
        s2 = s1;
        s1 = s;
      }
      out[t] = s1 * s1 + s2 * s2 - c * s1 * s2;
    }
    return out;
  }

  _reportLevel(energy) {
    if (!this.handlers.onLevel) return;
    const peak = Math.max(...energy);
    this.handlers.onLevel(20 * Math.log10((4 * Math.sqrt(peak)) / this.symLen + 1e-9));
  }

  // Share of in-band energy sitting on the preamble's tones, if the preamble
  // ended at sample `end`. Peaks when `end` is the true start of the data.
  _preambleScore(end) {
    let hit = 0;
    let all = 0;
    for (let i = 0; i < P; i++) {
      const e = this._energies(end - (P - i) * this.symLen, this.energy);
      hit += e[toneIndex(i, PREAMBLE[i])];
      for (let t = 0; t < TONE_COUNT; t++) all += e[t];
    }
    return all ? hit / all : 0;
  }

  _searchStep(end) {
    this.historyPos = (this.historyPos + 1) % HISTORY;
    const latest = this._energies(end - this.symLen, this.history[this.historyPos]);
    this._reportLevel(latest);
    if (++this.historyCount < HISTORY) return;

    let matches = 0;
    let hit = 0;
    let all = 0;
    for (let i = 0; i < P; i++) {
      const back = (P - 1 - i) * HOPS_PER_SYMBOL;
      const e = this.history[(this.historyPos - back + HISTORY) % HISTORY];
      const expected = toneIndex(i, PREAMBLE[i]);
      let best = i & 1;
      for (let t = i & 1; t < TONE_COUNT; t += 2) if (e[t] > e[best]) best = t;
      if (best === expected && e[best] > 0) matches++;
      hit += e[expected];
      for (let t = 0; t < TONE_COUNT; t++) all += e[t];
    }
    const score = all ? hit / all : 0;
    const matched = matches >= P - 1;

    if (!this.candidate) {
      if (matched) this.candidate = { end, score, left: CONFIRM_HOPS };
      return;
    }
    if (matched && score > this.candidate.score) {
      this.candidate.end = end;
      this.candidate.score = score;
    }
    if (--this.candidate.left === 0) this._lock(this.candidate.end, this.candidate.score);
  }

  // Refine the hop-resolution estimate to a sixteenth of a symbol, then start
  // reading data symbols.
  _lock(coarse, coarseScore) {
    const total = this.base + this.len;
    const step = Math.floor(this.hop / 4);
    let start = coarse;
    let bestScore = coarseScore;
    for (let j = -3; j <= 3; j++) {
      const end = coarse + j * step;
      if (!j || end > total || end - P * this.symLen < this.base) continue;
      const score = this._preambleScore(end);
      if (score > bestScore) {
        bestScore = score;
        start = end;
      }
    }
    this.receiving = true;
    this.candidate = null;
    this.dataStart = start;
    this.nibbles = [];
    this.expected = HEADER_NIBBLES;
    this.header = null;
    this.lost = 0;
    this.at = undefined;
  }

  // Magnitude of the correlation between the known preamble and the audio
  // starting at buffer offset `start`. Phase is unknown, so both quadratures.
  _correlate(start) {
    const { buf } = this;
    const { sin, cos } = this.template;
    let i = 0;
    let q = 0;
    for (let n = 0; n < sin.length; n++) {
      const s = buf[start + n];
      i += s * sin[n];
      q += s * cos[n];
    }
    return Math.hypot(i, q);
  }

  // Time the preamble's arrival to a fraction of a sample: slide the known
  // preamble waveform across the audio and take the correlation peak. Echoes
  // drag the estimate from _lock late, so look further back than forward.
  _arrival() {
    const origin = this.dataStart - P * this.symLen - this.base;
    const from = Math.max(1, origin - (this.symLen >> 1));
    const to = Math.min(origin + (this.hop >> 1), this.len - this.template.sin.length - 1);
    if (to <= from) return undefined;
    // The peak is about 1 / bandwidth wide; a coarse pass cannot step over it.
    const step = Math.max(1, Math.round(this.sampleRate / 12000));
    let peak = from;
    let best = -1;
    const consider = (start) => {
      const power = this._correlate(start);
      if (power > best) {
        best = power;
        peak = start;
      }
    };
    for (let start = from; start <= to; start += step) consider(start);
    const coarse = peak;
    for (let start = Math.max(from, coarse - step + 1); start <= Math.min(to, coarse + step - 1); start++) {
      if (start !== coarse) consider(start);
    }
    // Parabola through the peak and its neighbours.
    const before = this._correlate(peak - 1);
    const after = this._correlate(peak + 1);
    const curve = before - 2 * best + after;
    const fraction = curve < 0 ? (0.5 * (before - after)) / curve : 0;
    return (this.base + peak + Math.max(-0.5, Math.min(0.5, fraction))) / this.sampleRate;
  }

  _dataStep() {
    const n = this.nibbles.length;
    if (!n) this.at = this._arrival();
    const e = this._energies(this.dataStart + n * this.symLen, this.energy);
    this._reportLevel(e);
    const parity = (P + n) & 1;
    let best = 0;
    let sum = 0;
    for (let v = 0; v < SET_SIZE; v++) {
      const power = e[2 * v + parity];
      sum += power;
      if (power > e[2 * best + parity]) best = v;
    }
    this.nibbles.push(best);
    this.lost = sum && e[2 * best + parity] / sum >= LOST_RATIO ? 0 : this.lost + 1;

    const { header } = this;
    // What to report if the body cannot be read. A hello still tells us who.
    const garbled = header && (header.type === 'message'
      ? { type: 'garbled', id: header.id, from: header.from, broadcast: header.broadcast }
      : { type: header.type, from: header.from, name: '' });
    if (this.lost >= LOST_SYMBOLS) return this._finish(garbled);
    if (this.nibbles.length < this.expected) {
      if (header) this.handlers.onProgress?.(this.nibbles.length / this.expected);
      return;
    }
    if (!header) {
      this.header = decodeHeader(this.nibbles);
      // An unreadable header is most likely a false alarm; stay quiet.
      if (!this.header?.length) {
        // A hello with no name has no body either.
        const { type, from } = this.header || {};
        return this._finish(this.header?.length === 0 ? { type, from, name: '' } : this.header);
      }
      this.expected += bodyNibbles(this.header.length);
      this.handlers.onSync?.(this.header.length, this.header);
      return;
    }
    const body = this.nibbles.slice(HEADER_NIBBLES);
    if (header.type === 'message') {
      const decoded = decodeBody(body, header.length);
      return this._finish(decoded ? { ...garbled, type: 'message', ...decoded } : garbled);
    }
    this._finish({ ...garbled, name: decodeName(body, header.length) ?? '' });
  }

  _finish(result) {
    const { at } = this;
    this.reset();
    if (result) this.handlers.onFrame?.({ ...result, at });
  }
}
