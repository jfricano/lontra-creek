/**
 * Cuts the site's brand images out of assets/streamotter-logo-transparent.png
 * (1536 × 1024, transparent background) at full resolution, with no image tools
 * beyond Node. Astro resizes them and converts them to AVIF and WebP at build time.
 *
 *   otter-mark.png       the otter and water alone
 *   wordmark-light.png   "StreamOtter" for light backgrounds
 *   wordmark-dark.png    the same with "Stream" in light ink, for dark backgrounds
 *   logo-light.png       the whole logo, for light backgrounds
 *   logo-dark.png        the whole logo, for dark backgrounds
 *
 * and, into apps/site/public, social-preview.png: the dark logo on the live
 * panel's deep water, 1200 × 630, for link previews.
 *
 *   node scripts/brand-assets.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync, inflateSync } from "node:zlib";

const SOURCE = new URL("../assets/streamotter-logo-transparent.png", import.meta.url);
const OUT = new URL("../apps/site/src/assets/brand/", import.meta.url);
const PUBLIC = new URL("../apps/site/public/", import.meta.url);
/** Rows 697–713 are empty: the art is above them, the wordmark below. */
const ART_BOTTOM = 697;
const WORDMARK_TOP = 714;
const LIGHT_INK = [233, 242, 252];

function decode(buffer) {
  let position = 8;
  let width = 0;
  let height = 0;
  const chunks = [];
  while (position < buffer.length) {
    const length = buffer.readUInt32BE(position);
    const type = buffer.toString("ascii", position + 4, position + 8);
    const data = buffer.subarray(position + 8, position + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error("Expected 8-bit RGBA");
    }
    if (type === "IDAT") chunks.push(data);
    position += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const above = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? row[x - 4] : 0;
      const b = above ? above[x] : 0;
      const c = above && x >= 4 ? above[x - 4] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = value & 255;
    }
  }
  return { width, height, pixels };
}

function encode({ width, height, pixels }) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/** The smallest box around pixels at least `threshold` opaque, within rows [top, bottom). */
function bounds(image, top, bottom, threshold = 16) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = top; y < bottom; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.pixels[(y * image.width + x) * 4 + 3] >= threshold) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function crop(image, box, pad) {
  const width = box.width + 2 * pad;
  const height = box.height + 2 * pad;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < box.height; y++) {
    const from = ((box.y + y) * image.width + box.x) * 4;
    image.pixels.copy(pixels, ((y + pad) * width + pad) * 4, from, from + box.width * 4);
  }
  return { width, height, pixels };
}

/** Recolors the navy "Stream" to light ink, leaving the blue "Otter" gradient alone. */
function lightenWordmark(image, fromRow) {
  const pixels = Buffer.from(image.pixels);
  for (let y = fromRow; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const [r, g, b, a] = pixels.subarray(i, i + 4);
      if (a > 0 && r < 60 && g < 70 && b < 110) pixels.set(LIGHT_INK, i);
    }
  }
  return { width: image.width, height: image.height, pixels };
}

/**
 * Scales an image down by area averaging (each output pixel is the
 * coverage-weighted mean of the source pixels under it), with premultiplied
 * alpha so transparent edges don't darken.
 */
function downscale(image, width, height) {
  const sx = image.width / width;
  const sy = image.height / height;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = y * sy, y1 = y0 + sy;
    for (let x = 0; x < width; x++) {
      const x0 = x * sx, x1 = x0 + sx;
      let r = 0, g = 0, b = 0, a = 0, area = 0;
      for (let v = Math.floor(y0); v < Math.min(Math.ceil(y1), image.height); v++) {
        const wy = Math.min(v + 1, y1) - Math.max(v, y0);
        for (let u = Math.floor(x0); u < Math.min(Math.ceil(x1), image.width); u++) {
          const w = wy * (Math.min(u + 1, x1) - Math.max(u, x0));
          const i = (v * image.width + u) * 4;
          const alpha = image.pixels[i + 3] / 255;
          r += image.pixels[i] * alpha * w;
          g += image.pixels[i + 1] * alpha * w;
          b += image.pixels[i + 2] * alpha * w;
          a += alpha * w;
          area += w;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) pixels.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((a / area) * 255)], o);
    }
  }
  return { width, height, pixels };
}

/** The live panel's water: a radial gradient from #0a3d86 near the top left through #04173a to #020a1c. */
function water(width, height) {
  const stops = [[0, [10, 61, 134]], [0.55, [4, 23, 58]], [1, [2, 10, 28]]];
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = Math.min(1, Math.hypot((x - 0.2 * width) / (1.2 * width), y / (0.9 * height)));
      const k = stops.findIndex(([at]) => at >= t);
      const [a0, c0] = stops[Math.max(0, k - 1)];
      const [a1, c1] = stops[k];
      const f = a1 === a0 ? 0 : (t - a0) / (a1 - a0);
      pixels.set([...c0.map((c, i) => Math.round(c + (c1[i] - c) * f)), 255], (y * width + x) * 4);
    }
  }
  return { width, height, pixels };
}

function over(base, image, left, top) {
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const alpha = image.pixels[i + 3] / 255;
      if (alpha === 0) continue;
      const o = ((top + y) * base.width + left + x) * 4;
      for (let c = 0; c < 3; c++) base.pixels[o + c] = Math.round(image.pixels[i + c] * alpha + base.pixels[o + c] * (1 - alpha));
    }
  }
  return base;
}

function socialPreview(logo) {
  const width = 1200, height = 630;
  const scale = Math.min(1040 / logo.width, 520 / logo.height);
  const scaled = downscale(logo, Math.round(logo.width * scale), Math.round(logo.height * scale));
  return over(water(width, height), scaled, Math.round((width - scaled.width) / 2), Math.round((height - scaled.height) / 2));
}

const source = decode(readFileSync(SOURCE));
const all = bounds(source, 0, source.height);
const art = bounds(source, 0, ART_BOTTOM);
const lettering = bounds(source, WORDMARK_TOP, source.height);
const full = crop(source, all, 24);
const wordmark = crop(source, lettering, 8);

const outputs = [
  ["otter-mark.png", crop(source, art, 16)],
  ["wordmark-light.png", wordmark],
  ["wordmark-dark.png", lightenWordmark(wordmark, 0)],
  ["logo-light.png", full],
  ["logo-dark.png", lightenWordmark(full, WORDMARK_TOP - all.y + 24)]
];
mkdirSync(OUT, { recursive: true });
for (const [name, image] of outputs) {
  writeFileSync(new URL(name, OUT), encode(image));
  console.log(`${name}  ${image.width} × ${image.height}`);
}
const preview = socialPreview(outputs.find(([name]) => name === "logo-dark.png")[1]);
writeFileSync(new URL("social-preview.png", PUBLIC), encode(preview));
console.log(`social-preview.png  ${preview.width} × ${preview.height}`);
