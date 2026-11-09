// Removes a near-white studio backdrop via border flood-fill (keeps interior whites).
// Usage: node scripts/cutout.mjs <src> <out.png> [threshold=238]
import sharp from "sharp";

const [SRC, OUT, T] = process.argv.slice(2);
const THRESH = Number(T ?? 238);
const FEATHER = 2;

const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const white = (k) => { const i = k * 4; return data[i + 3] === 0 || (data[i] >= THRESH && data[i + 1] >= THRESH && data[i + 2] >= THRESH); };

const seen = new Uint8Array(W * H);
const stack = [];
const push = (x, y) => { const k = y * W + x; if (!seen[k] && white(k)) { seen[k] = 1; stack.push(k); } };
for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
while (stack.length) {
  const k = stack.pop(), x = k % W, y = (k - x) / W;
  if (x > 0) push(x - 1, y); if (x < W - 1) push(x + 1, y);
  if (y > 0) push(x, y - 1); if (y < H - 1) push(x, y + 1);
}

const dist = new Int16Array(W * H).fill(-1);
for (let k = 0; k < W * H; k++) if (seen[k]) { data[k * 4 + 3] = 0; dist[k] = 0; }
for (let d = 0; d < FEATHER; d++) for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
  const k = y * W + x;
  if (dist[k] !== -1) continue;
  if (dist[k - 1] === d || dist[k + 1] === d || dist[k - W] === d || dist[k + W] === d) {
    dist[k] = d + 1;
    data[k * 4 + 3] = Math.min(data[k * 4 + 3], Math.round(255 * (d + 1) / (FEATHER + 1)));
  }
}
await sharp(data, { raw: { width: W, height: H, channels: 4 } }).trim().png({ compressionLevel: 9 }).toFile(OUT);
console.log(`removed ${(seen.reduce((s, v) => s + v, 0) / (W * H) * 100).toFixed(1)}% -> ${OUT}`);
