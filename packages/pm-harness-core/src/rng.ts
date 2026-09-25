/**
 * Deterministic PRNG (xoshiro128**, seeded via splitmix32). Anything random in the simulator must
 * draw from one of these so that the same data + config + seed replays byte-identically.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number | string) {
    let x = typeof seed === "number" ? seed >>> 0 : hashString(seed);
    const next = () => {
      // splitmix32
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
  }

  /** Uniform 32-bit unsigned integer. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    this.s0 >>>= 0;
    this.s1 >>>= 0;
    this.s2 >>>= 0;
    this.s3 >>>= 0;
    return result;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform integer in [lo, hi). */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo));
  }

  /** Independent child stream, e.g. one per sweep config or per market: `rng.fork("mode:base")`. */
  fork(label: string): Rng {
    return new Rng((this.nextU32() ^ hashString(label)) >>> 0);
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** FNV-1a 32-bit. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
