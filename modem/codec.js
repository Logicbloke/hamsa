// Text <-> frame symbols (nibbles). A frame is:
//   header: RS([length])                   3 bytes
//   body:   RS(utf8 payload + CRC-16)      length + 2 + bodyParity(length) bytes
// The preamble is added by the modulator.

import { rsEncode, rsDecode } from './reedsolomon.js';

export const MAX_BYTES = 120;
const HEADER_PARITY = 2;
export const HEADER_NIBBLES = 2 * (1 + HEADER_PARITY);

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

export function encodeFrame(text) {
  const payload = new TextEncoder().encode(text);
  if (!payload.length || payload.length > MAX_BYTES) {
    throw new RangeError(`message must be 1-${MAX_BYTES} bytes`);
  }
  const body = new Uint8Array(payload.length + 2);
  body.set(payload);
  const crc = crc16(payload);
  body[payload.length] = crc >> 8;
  body[payload.length + 1] = crc & 255;
  const header = rsEncode(Uint8Array.of(payload.length), HEADER_PARITY);
  const coded = rsEncode(body, bodyParity(payload.length));
  const out = new Uint8Array(2 * (header.length + coded.length));
  out.set(toNibbles(header));
  out.set(toNibbles(coded), 2 * header.length);
  return out;
}

// Returns the payload length, or -1 if the header is unreadable.
export function decodeHeader(nibbles) {
  const header = rsDecode(toBytes(nibbles), HEADER_PARITY);
  if (!header || !header[0] || header[0] > MAX_BYTES) return -1;
  return header[0];
}

// Returns the message text, or null if it could not be recovered.
export function decodeBody(nibbles, length) {
  const body = rsDecode(toBytes(nibbles), bodyParity(length));
  if (!body) return null;
  const payload = body.subarray(0, length);
  if (crc16(payload) !== ((body[length] << 8) | body[length + 1])) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    return null;
  }
}
