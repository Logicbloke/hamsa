// Text <-> frame symbols (nibbles). A frame is:
//   header: RS([length, id, from])         7 bytes
//   body:   RS(payload + CRC-16)           length + 2 + bodyParity(length) bytes
// `id` is the sender's message counter and `from` its random device id. The
// payload is the sender's name, a zero byte, then the text, all UTF-8. The top
// bit of the length byte marks a broadcast, which receivers must not answer.
//
// Control frames put a reserved value in place of the length:
//   ack, nack     [type, id being answered, from]             header alone
//   hello, here   [type, name length, from] + RS(name + CRC)  presence
//   range         [type, turnaround in microseconds, 16 bit]  header alone
// The preamble is added by the modulator.

import { rsEncode, rsDecode } from './reedsolomon.js';

export const MAX_BYTES = 120;
export const NAME_MAX_BYTES = 16;
const HEADER_PARITY = 4;
export const HEADER_NIBBLES = 2 * (3 + HEADER_PARITY);
const CONTROL = { range: 251, here: 252, hello: 253, ack: 254, nack: 255 };
const BROADCAST = 0x80;

// Corrects roughly one bad byte in eight.
function bodyParity(length) {
  return 2 * Math.ceil((length + 2) / 8) + 2;
}

export function bodyNibbles(length) {
  return 2 * (length + 2 + bodyParity(length));
}

export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function toNibbles(bytes) {
  const out = new Uint8Array(bytes.length * 2);
  bytes.forEach((b, i) => {
    out[2 * i] = b >> 4;
    out[2 * i + 1] = b & 15;
  });
  return out;
}

function toBytes(nibbles) {
  const out = new Uint8Array(nibbles.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = (nibbles[2 * i] << 4) | nibbles[2 * i + 1];
  return out;
}

export function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

// Header bytes plus an optional payload -> frame symbols.
function build(first, second, third, payload) {
  const header = rsEncode(Uint8Array.of(first, second, third), HEADER_PARITY);
  if (!payload?.length) return toNibbles(header);
  const body = new Uint8Array(payload.length + 2);
  body.set(payload);
  const crc = crc16(payload);
  body[payload.length] = crc >> 8;
  body[payload.length + 1] = crc & 255;
  const coded = rsEncode(body, bodyParity(payload.length));
  const out = new Uint8Array(2 * (header.length + coded.length));
  out.set(toNibbles(header));
  out.set(toNibbles(coded), 2 * header.length);
  return out;
}

function nameBytes(name) {
  const bytes = new TextEncoder().encode(name);
  if (bytes.length > NAME_MAX_BYTES || bytes.includes(0)) {
    throw new RangeError(`name must be at most ${NAME_MAX_BYTES} bytes`);
  }
  return bytes;
}

export function encodeFrame(text, { id = 0, from = 0, name = '', broadcast = false } = {}) {
  const who = nameBytes(name);
  const body = new TextEncoder().encode(text);
  const payload = new Uint8Array(who.length + 1 + body.length);
  if (!body.length || payload.length > MAX_BYTES) {
    throw new RangeError(`name and message must fit in ${MAX_BYTES - 1} bytes`);
  }
  payload.set(who);
  payload.set(body, who.length + 1);
  return build(payload.length | (broadcast ? BROADCAST : 0), id, from, payload);
}

// type is 'ack' or 'nack'; id is the message being answered.
export function encodeControl(type, id, from = 0) {
  return build(CONTROL[type], id, from);
}

// type is 'hello' (sent on arrival) or 'here' (the answer to it).
export function encodeAnnounce(type, from, name = '') {
  const who = nameBytes(name);
  return build(CONTROL[type], who.length, from, who);
}

export function encodeRange(micros) {
  return build(CONTROL.range, (micros >> 8) & 255, micros & 255);
}

// Returns null if the header is unreadable, otherwise one of
//   { type: 'message', id, from, length, broadcast }
//   { type: 'ack' | 'nack', id, from }
//   { type: 'hello' | 'here', from, length }
//   { type: 'range', micros }
// `length` is the number of payload bytes that follow.
export function decodeHeader(nibbles) {
  const header = rsDecode(toBytes(nibbles), HEADER_PARITY);
  if (!header) return null;
  const [first, second, third] = header;
  if (first === CONTROL.ack) return { type: 'ack', id: second, from: third };
  if (first === CONTROL.nack) return { type: 'nack', id: second, from: third };
  if (first === CONTROL.range) return { type: 'range', micros: (second << 8) | third };
  if (first === CONTROL.hello || first === CONTROL.here) {
    if (second > NAME_MAX_BYTES) return null;
    return { type: first === CONTROL.hello ? 'hello' : 'here', from: third, length: second };
  }
  const length = first & ~BROADCAST;
  if (length < 2 || length > MAX_BYTES) return null;
  return { type: 'message', id: second, from: third, length, broadcast: Boolean(first & BROADCAST) };
}

function decodePayload(nibbles, length) {
  const body = rsDecode(toBytes(nibbles), bodyParity(length));
  if (!body) return null;
  const payload = body.subarray(0, length);
  if (crc16(payload) !== ((body[length] << 8) | body[length + 1])) return null;
  return payload;
}

function utf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// Returns { name, text }, or null if the message could not be recovered.
export function decodeBody(nibbles, length) {
  const payload = decodePayload(nibbles, length);
  const split = payload ? payload.indexOf(0) : -1;
  if (split < 0 || split > NAME_MAX_BYTES) return null;
  const name = utf8(payload.subarray(0, split));
  const text = utf8(payload.subarray(split + 1));
  return name === null || !text ? null : { name, text };
}

// Returns the name in a hello or here frame, or null if it could not be recovered.
export function decodeName(nibbles, length) {
  const payload = decodePayload(nibbles, length);
  return payload && utf8(payload);
}
