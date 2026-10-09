// Reed-Solomon over GF(256), primitive polynomial 0x11d, first root alpha^0.
// Codewords are message bytes followed by parity bytes.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

function mul(a, b) {
  return a && b ? EXP[LOG[a] + LOG[b]] : 0;
}

function div(a, b) {
  return a ? EXP[LOG[a] + 255 - LOG[b]] : 0;
}

const generators = new Map();
function generator(nsym) {
  let g = generators.get(nsym);
  if (!g) {
    g = [1];
    for (let j = 0; j < nsym; j++) {
      const next = new Array(g.length + 1).fill(0);
      for (let i = 0; i < g.length; i++) {
        next[i] ^= g[i];
        next[i + 1] ^= mul(g[i], EXP[j]);
      }
      g = next;
    }
    generators.set(nsym, g);
  }
  return g;
}

export function rsEncode(data, nsym) {
  const g = generator(nsym);
  const out = new Uint8Array(data.length + nsym);
  out.set(data);
  const rem = out.subarray(data.length);
  for (let i = 0; i < data.length; i++) {
    const fb = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[nsym - 1] = 0;
    if (fb) for (let j = 0; j < nsym; j++) rem[j] ^= mul(g[j + 1], fb);
  }
  return out;
}

function syndromes(code, nsym) {
  const s = new Uint8Array(nsym);
  let any = 0;
  for (let j = 0; j < nsym; j++) {
    let acc = 0;
    for (let i = 0; i < code.length; i++) acc = mul(acc, EXP[j]) ^ code[i];
    s[j] = acc;
    any |= acc;
  }
  return any ? s : null;
}

// Evaluate a polynomial stored lowest degree first.
function evalPoly(p, x) {
  let acc = 0;
  for (let i = p.length - 1; i >= 0; i--) acc = mul(acc, x) ^ p[i];
  return acc;
}

// Returns the corrected message bytes, or null if there are more than
// nsym / 2 byte errors.
export function rsDecode(received, nsym) {
  const code = Uint8Array.from(received);
  const n = code.length;
  const synd = syndromes(code, nsym);
  if (!synd) return code.slice(0, n - nsym);

  // Berlekamp-Massey: error locator, lowest degree first.
  let loc = [1];
  let prev = [1];
  let errors = 0;
  let shift = 1;
  let prevDelta = 1;
  for (let k = 0; k < nsym; k++) {
    let delta = synd[k];
    for (let i = 1; i <= errors; i++) delta ^= mul(loc[i] || 0, synd[k - i]);
    if (!delta) {
      shift++;
      continue;
    }
    const scale = div(delta, prevDelta);
    const next = loc.slice();
    for (let i = 0; i < prev.length; i++) {
      next[i + shift] = (next[i + shift] || 0) ^ mul(scale, prev[i]);
    }
    if (2 * errors <= k) {
      errors = k + 1 - errors;
      prev = loc;
      prevDelta = delta;
      shift = 1;
    } else {
      shift++;
    }
    loc = next;
  }
  if (2 * errors > nsym) return null;

  const omega = new Array(nsym).fill(0);
  for (let i = 0; i < nsym; i++) {
    for (let j = 0; j < loc.length && i + j < nsym; j++) {
      omega[i + j] ^= mul(synd[i], loc[j] || 0);
    }
  }
  const locDeriv = [];
  for (let i = 1; i < loc.length; i += 2) {
    locDeriv[i - 1] = loc[i] || 0;
    locDeriv[i] = 0;
  }

  // Chien search and Forney's formula.
  let found = 0;
  for (let i = 0; i < n; i++) {
    const power = (n - 1 - i) % 255;
    const xInv = EXP[(255 - power) % 255];
    if (evalPoly(loc, xInv)) continue;
    const denom = evalPoly(locDeriv, xInv);
    if (!denom) return null;
    code[i] ^= mul(EXP[power], div(evalPoly(omega, xInv), denom));
    found++;
  }
  if (found !== errors || syndromes(code, nsym)) return null;
  return code.slice(0, n - nsym);
}
