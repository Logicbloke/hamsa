// Renders the PNG app icons (same design as icons/icon.svg) with no dependencies.
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const BG = [0x62, 0x46, 0xea];
const FG = [255, 255, 255];
const SS = 4; // supersampling per axis

// Shapes in a 512-unit design space. `scale` shrinks the artwork toward the
// centre, to keep it inside the maskable safe zone.
function coverage(x, y, radius, scale) {
  const dx = Math.abs(x - 256) - (256 - radius);
  const dy = Math.abs(y - 256) - (256 - radius);
  if (dx > 0 && dy > 0 && Math.hypot(dx, dy) > radius) return null;

  const ax = (x - 256) / scale + 256;
  const ay = (y - 256) / scale + 256;
  const r = Math.hypot(ax - 150, ay - 256);
  if (r <= 36) return FG;
  const angle = Math.atan2(ay - 256, ax - 150);
  for (const arc of [100, 181, 262]) {
    if (Math.abs(angle) <= Math.PI / 4) {
      if (Math.abs(r - arc) <= 15) return FG;
    } else {
      // Round caps at the arc ends.
      const sign = Math.sign(angle);
      const cx = 150 + arc * Math.SQRT1_2;
      const cy = 256 + sign * arc * Math.SQRT1_2;
      if (Math.hypot(ax - cx, ay - cy) <= 15) return FG;
    }
  }
  return BG;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function png(size, { radius, scale }) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const unit = 512 / size;
  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1) + 1;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = coverage((px + (sx + 0.5) / SS) * unit, (py + (sy + 0.5) / SS) * unit, radius, scale);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      if (a) raw.set([r / a, g / a, b / a, (255 * a) / (SS * SS)].map(Math.round), row + px * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = new URL('../icons/', import.meta.url);
writeFileSync(new URL('icon-192.png', dir), png(192, { radius: 112, scale: 1 }));
writeFileSync(new URL('icon-512.png', dir), png(512, { radius: 112, scale: 1 }));
writeFileSync(new URL('maskable-512.png', dir), png(512, { radius: 0, scale: 0.72 }));
