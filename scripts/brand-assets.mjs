/**
 * Builds the site's brand files from the two logo sources in assets/:
 *
 *   streamotter-brand.svg             the flat brand system, a vector trace of the brand
 *                                     spread: stacked lockup, mark, app icon, horizontal lockup
 *   streamotter-logo-transparent.png  the detailed swimming-otter logo (1536 × 1024)
 *
 * Into apps/site/src/assets/brand/, imported by the pages:
 *
 *   lockup-horizontal.svg, lockup-stacked.svg, mark.svg
 *       Themable: paths with class "bi" (the S body and "Stream") take --brand-ink, and
 *       paths with class "bw" (the whiskers that cross onto the ground) take --brand-whisker,
 *       so one file serves light and dark grounds.
 *   otter-mark.png   the detailed otter and water without the wordmark, for the home hero
 *
 * Into apps/site/public/:
 *
 *   brand/streamotter-lockup.svg, brand/streamotter-lockup-dark.svg
 *       the stacked lockup with fixed colors for light and dark grounds, for the README
 *       and anyone linking to the logo
 *   favicon.svg, favicon.ico   a glyph reduced for 16–48 px: the S and a solid head, no whiskers or splash
 *   apple-touch-icon.png       180 × 180, full bleed (iOS rounds it)
 *   icon-192.png, icon-512.png, icon-maskable-512.png   for site.webmanifest
 *   social-preview.png         1200 × 630, the link card
 *
 * The SVGs need only Node. The PNGs are drawn by Playwright's Chromium (a dev dependency);
 * with `--svg-only` they're skipped.
 *
 *   node scripts/brand-assets.mjs [--svg-only]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync, inflateSync } from "node:zlib";

const ROOT = new URL("../", import.meta.url);
const BRAND = new URL("assets/streamotter-brand.svg", ROOT);
const LOGO = new URL("assets/streamotter-logo-transparent.png", ROOT);
const OUT = new URL("apps/site/src/assets/brand/", ROOT);
const PUBLIC = new URL("apps/site/public/", ROOT);
const FONTS = new URL("node_modules/@fontsource-variable/", ROOT);

// Brand colors. The dark-ground values match the site's dark --ink and --ink-2.
const INK = "#04183f";
const LIGHT_INK = "#e9f2fc";
const WHISKER_ON_DARK = "#a9bad5";
const AZURE = "#048dfc";
const BROWN_ON_NAVY = "#a0705f";
/** The trace's paint order, so shapes keep their stacking when paths are regrouped. */
const PAINT_ORDER = ["#04183f", "#048dfc", "#04bdfd", "#7f5447", "#ebe6df", "#264069", "#ffffff"];

// --- The traced spread, as subpaths with bounding boxes -------------------------------------

/** Splits every `<path>` into its subpaths (the trace uses only absolute M, C, and Z). */
function subpaths(svg) {
  const out = [];
  for (const [, attributes] of svg.matchAll(/<path([^>]*)\/?>/g)) {
    const fill = /fill="(#[0-9a-f]{6})"/.exec(attributes)[1];
    const d = / d="([^"]+)"/.exec(attributes)[1];
    for (const part of d.trim().split(/(?=M)/)) {
      const numbers = part.match(/-?\d+(?:\.\d+)?/g).map(Number);
      const xs = numbers.filter((_, i) => i % 2 === 0);
      const ys = numbers.filter((_, i) => i % 2 === 1);
      out.push({ fill, d: part.trim(), box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    }
  }
  return out;
}

const area = ([x0, y0, x1, y1]) => (x1 - x0) * (y1 - y0);
const inside = ([x0, y0, x1, y1], [rx0, ry0, rx1, ry1]) => rx0 <= x0 && x1 <= rx1 && ry0 <= y0 && y1 <= ry1;
/** Specks the tracer left behind: slivers of deep blue and anything under 12 square units. */
const noise = part => (part.fill === "#264069" && area(part.box) < 60) || area(part.box) < 12;
const bounds = parts => [
  Math.min(...parts.map(p => p.box[0])), Math.min(...parts.map(p => p.box[1])),
  Math.max(...parts.map(p => p.box[2])), Math.max(...parts.map(p => p.box[3]))
];
const largest = parts => parts.reduce((a, b) => (area(a.box) > area(b.box) ? a : b));

const all = subpaths(readFileSync(BRAND, "utf8"));
// The large stacked lockup at the top of the spread: its mark, then its wordmark just below.
const mark = all.filter(p => inside(p.box, [450, 85, 910, 410]) && p.box[1] < 395 && !noise(p));
const word = all.filter(p => inside(p.box, [225, 395, 1120, 530]) && !noise(p));
const markInk = mark.filter(p => p.fill === INK);
const sBody = largest(markInk);
const whiskers = markInk.filter(p => p.box[0] >= 855);
const eye = markInk.find(p => p.box[0] >= 755 && p.box[0] <= 765);
const nose = markInk.find(p => p.box[0] >= 795 && p.box[0] <= 805 && area(p.box) > 1000);
const upperS = largest(mark.filter(p => p.fill === AZURE));
const head = mark.filter(p => (p.fill === "#7f5447" || p.fill === "#ebe6df") && area(p.box) > 250);
if (!eye || !nose || whiskers.length !== 3 || head.length === 0) throw new Error("The brand trace no longer matches the expected shapes.");

// --- Geometry: placements are baked into the coordinates, rounded, from the origin ----------

/** Maps each coordinate pair of an absolute M/C/Z path through `(x, y) => [x, y]`. */
function mapPath(d, map, digits) {
  const round = value => String(+value.toFixed(digits));
  return d.replace(/(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)/g, (_, x, y) => {
    const [mx, my] = map(Number(x), Number(y));
    return `${round(mx)} ${round(my)}`;
  }).replace(/ ?([MCZ]) ?/g, "$1").replace(/ -/g, "-");
}

/** Places `parts` so the corner of `box` lands at (x, y), scaled by k. */
const place = (parts, k, x, y, box = bounds(parts)) => ({ parts, map: (px, py) => [x + (px - box[0]) * k, y + (py - box[1]) * k] });

/**
 * Serializes placed groups into paths, one per paint and role. `paint(part)` returns
 * { fill, role }: a role ("bi" or "bw") makes the path themable; otherwise its fill is fixed.
 */
function paths(groups, paint, digits) {
  const byKey = new Map();
  for (const { parts, map } of groups) {
    for (const part of parts) {
      const { fill, role } = paint(part);
      const key = `${fill}|${role ?? ""}`;
      if (!byKey.has(key)) byKey.set(key, { fill, role, d: [] });
      byKey.get(key).d.push(mapPath(part.d, map, digits));
    }
  }
  const rank = ({ fill }) => (PAINT_ORDER.includes(fill) ? PAINT_ORDER.indexOf(fill) : 0);
  return [...byKey.values()]
    .sort((a, b) => rank(a) - rank(b))
    .map(({ fill, role, d }) => `<path${role ? ` class="${role}"` : ""} fill="${fill}" stroke="${fill}" stroke-width=".25" stroke-linejoin="round" fill-rule="evenodd" d="${d.join("")}"/>`)
    .join("");
}

const themableMark = part => ({ fill: part.fill, role: part === sBody ? "bi" : whiskers.includes(part) ? "bw" : undefined });
const themableWord = part => ({ fill: part.fill, role: part.fill === INK ? "bi" : undefined });
const darkMark = part => ({ fill: part === sBody ? LIGHT_INK : whiskers.includes(part) ? WHISKER_ON_DARK : part.fill });
const darkWord = part => ({ fill: part.fill === INK ? LIGHT_INK : part.fill });

const mb = bounds(mark), wb = bounds(word);
const [mw, mh, ww, wh] = [mb[2] - mb[0], mb[3] - mb[1], wb[2] - wb[0], wb[3] - wb[1]];
const PAD = 4;

/** The mark alone. */
function markSvg(onDark) {
  return { body: paths([place(mark, 1, PAD, PAD)], onDark ? darkMark : themableMark, 1), width: mw + 2 * PAD, height: mh + 2 * PAD };
}

/** The mark above the wordmark: the mark is 0.68× the wordmark's width, and 0.15× its own height above it. */
function stackedSvg(onDark) {
  const k = mw / (0.68 * ww);
  const width = ww * k;
  const wordY = PAD + mh * 1.15;
  const body = paths([place(mark, 1, PAD + (width - mw) / 2, PAD)], onDark ? darkMark : themableMark, 1)
    + paths([place(word, k, PAD, wordY)], onDark ? darkWord : themableWord, 1);
  return { body, width: width + 2 * PAD, height: wordY + wh * k + PAD };
}

/** The mark beside the wordmark: the wordmark is 0.59× the mark's height, 0.25× that height away, centered on the S. */
function horizontalSvg(onDark) {
  const k = (0.59 * mh) / wh;
  const s = bounds([upperS, sBody]);
  const wordX = PAD + mw + 0.25 * mh;
  const wordY = PAD + ((s[1] + s[3]) / 2 - mb[1]) - (wh * k) / 2;
  const body = paths([place(mark, 1, PAD, PAD)], onDark ? darkMark : themableMark, 1)
    + paths([place(word, k, wordX, wordY)], onDark ? darkWord : themableWord, 1);
  return { body, width: wordX + ww * k + PAD, height: mh + 2 * PAD };
}

const svgFile = ({ body, width, height }) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${+width.toFixed(1)} ${+height.toFixed(1)}">${body}</svg>\n`;

/** The ink ground every icon sits on, lit slightly from the top so it holds its edge on dark tab bars. */
const GROUND = '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a2a66"/><stop offset="1" stop-color="#04183f"/></linearGradient></defs>';

/** `parts` (painted by `paint`) centered on a square of `size`, spanning `fill` of it; `radius` is a fraction of the size. */
function iconSvg(parts, paint, size, radius, fill) {
  const box = bounds(parts);
  const k = (size * fill) / Math.max(box[2] - box[0], box[3] - box[1]);
  const x = (size - (box[2] - box[0]) * k) / 2;
  const y = (size - (box[3] - box[1]) * k) / 2;
  const rect = `<rect width="${size}" height="${size}"${radius ? ` rx="${+(size * radius).toFixed(2)}"` : ""} fill="url(#g)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${GROUND}${rect}${paths([place(parts, k, x, y, box)], paint, 2)}</svg>\n`;
}

/** The favicon glyph: both strokes of the S and a solid head with its nose; the eye only from 32 px up. */
function faviconSvg(size) {
  const parts = [upperS, sBody, ...head, nose, ...(size >= 32 ? [eye] : [])];
  const paint = part => ({ fill: part === sBody ? LIGHT_INK : head.includes(part) ? BROWN_ON_NAVY : part.fill });
  return iconSvg(parts, paint, size, 0.22, size <= 16 ? 0.9 : 0.86);
}

const appIcon = size => iconSvg(mark, darkMark, size, 0.225, 0.72);
const fullBleedIcon = (size, fill) => iconSvg(mark, darkMark, size, 0, fill);

mkdirSync(OUT, { recursive: true });
for (const [name, svg] of [["mark.svg", markSvg(false)], ["lockup-stacked.svg", stackedSvg(false)], ["lockup-horizontal.svg", horizontalSvg(false)]]) {
  writeFileSync(new URL(name, OUT), svgFile(svg));
  console.log(`${name}  ${svg.width.toFixed(1)} × ${svg.height.toFixed(1)}`);
}
mkdirSync(new URL("brand/", PUBLIC), { recursive: true });
writeFileSync(new URL("brand/streamotter-lockup.svg", PUBLIC), svgFile(stackedSvg(false)).replaceAll(/ class="b[iw]"/g, ""));
writeFileSync(new URL("brand/streamotter-lockup-dark.svg", PUBLIC), svgFile(stackedSvg(true)));
writeFileSync(new URL("favicon.svg", PUBLIC), faviconSvg(32));
console.log("brand/streamotter-lockup.svg, brand/streamotter-lockup-dark.svg, favicon.svg");

// --- The detailed otter for the home hero, cut from the transparent logo --------------------

function decodePng(buffer) {
  let position = 8, width = 0, height = 0;
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

function encodePng({ width, height, pixels }) {
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

/** Rows 697–713 of the logo are empty: the art is above them, the wordmark below. */
const ART_BOTTOM = 697;

/** The art above the wordmark, trimmed to its opaque pixels plus `pad`. */
function cropArt(image, pad) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < ART_BOTTOM; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.pixels[(y * image.width + x) * 4 + 3] >= 16) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  const [w, h] = [maxX - minX + 1, maxY - minY + 1];
  const width = w + 2 * pad, height = h + 2 * pad;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < h; y++) {
    const from = ((minY + y) * image.width + minX) * 4;
    image.pixels.copy(pixels, ((y + pad) * width + pad) * 4, from, from + w * 4);
  }
  return { width, height, pixels };
}

const otter = cropArt(decodePng(readFileSync(LOGO)), 16);
writeFileSync(new URL("otter-mark.png", OUT), encodePng(otter));
console.log(`otter-mark.png  ${otter.width} × ${otter.height}`);

// --- PNGs, drawn by Chromium ---------------------------------------------------------------

if (process.argv.includes("--svg-only")) process.exit(0);

const { chromium } = await import("@playwright/test");
const browser = await chromium.launch();
const page = await browser.newPage();

/** Renders `html` in a `width` × `height` box and returns the PNG, transparent where the page is. */
async function render(html, width, height) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  return page.screenshot({ clip: { x: 0, y: 0, width, height }, omitBackground: true });
}
const sized = (svg, size) => svg.replace("<svg ", `<svg width="${size}" height="${size}" style="display:block" `);

/** Packs PNGs into an .ico with PNG-compressed entries, which every current browser reads. */
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((png, i) => {
    const size = png.readUInt32BE(16);
    const entry = 6 + 16 * i;
    header.writeUInt8(size % 256, entry);
    header.writeUInt8(size % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs]);
}

/** The link card: the dark stacked lockup beside the tagline on the live panel's water, with code lines below. */
function socialCard() {
  const font = (file, family) => {
    const data = readFileSync(new URL(file, FONTS)).toString("base64");
    return `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${data}) format("woff2");font-weight:100 900}`;
  };
  const lockup = stackedSvg(true);
  // Rows of code-line dashes, as in the water of the detailed logo: [x, width, color].
  const rows = [
    [[64, 120, "#01e1fc"], [200, 260, "#048dfc"], [476, 80, "#e9f2fc"], [572, 190, "#01e1fc"], [778, 120, "#048dfc"], [914, 220, "#04bdfd"]],
    [[112, 60, "#e9f2fc"], [188, 180, "#04bdfd"], [384, 300, "#01e1fc"], [700, 90, "#e9f2fc"], [806, 260, "#048dfc"]],
    [[64, 200, "#048dfc"], [280, 90, "#01e1fc"], [386, 160, "#e9f2fc"], [562, 280, "#04bdfd"], [858, 140, "#01e1fc"], [1014, 120, "#048dfc"]]
  ];
  const dashes = rows.flatMap((row, r) => row.map(([x, w, color]) =>
    `<rect x="${x}" y="${r * 22}" width="${w}" height="9" rx="4.5" fill="${color}" opacity="${(0.55 - r * 0.12).toFixed(2)}"/>`)).join("");
  return `<style>${font("figtree/files/figtree-latin-wght-normal.woff2", "Figtree")}${font("jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2", "JetBrains Mono")}
    .card{position:relative;width:1200px;height:630px;overflow:hidden;font-family:Figtree;color:#e9f2fc;
      background:radial-gradient(120% 90% at 20% 0%,#0a3d86 0%,#04173a 55%,#020a1c 100%)}
    .lockup{position:absolute;left:84px;top:132px;width:300px}
    .copy{position:absolute;left:452px;top:128px;width:680px}
    h1{margin:0;font-weight:800;font-size:62px;line-height:1.04;letter-spacing:-.025em}
    h1 span{color:#48b5ff}
    .install{display:inline-block;margin-top:34px;padding:14px 20px;border-radius:12px;background:rgba(2,10,28,.6);
      border:1px solid rgba(4,189,253,.35);font:500 26px/1 "JetBrains Mono";color:#e9f2fc}
    .install b{color:#01e1fc;font-weight:500}
    .url{margin-top:22px;font-weight:600;font-size:24px;color:#a9bad5}
    .water{position:absolute;left:0;bottom:36px}</style>
    <div class="card">
      <svg class="lockup" viewBox="0 0 ${lockup.width.toFixed(1)} ${lockup.height.toFixed(1)}">${lockup.body}</svg>
      <div class="copy"><h1>Live state from Kafka to the browser. <span>Never silently wrong.</span></h1>
        <div class="install"><b>$</b> npm install streamotter</div><div class="url">streamotter.dev</div></div>
      <svg class="water" width="1200" height="64">${dashes}</svg>
    </div>`;
}

const outputs = [
  ["favicon.ico", ico([
    await render(sized(faviconSvg(16), 16), 16, 16),
    await render(sized(faviconSvg(32), 32), 32, 32),
    await render(sized(faviconSvg(48), 48), 48, 48)
  ])],
  ["apple-touch-icon.png", await render(sized(fullBleedIcon(180, 0.75), 180), 180, 180)],
  ["icon-192.png", await render(sized(appIcon(192), 192), 192, 192)],
  ["icon-512.png", await render(sized(appIcon(512), 512), 512, 512)],
  // Maskable icons may be cropped to a circle 80% of the square wide, so the mark stays well inside it.
  ["icon-maskable-512.png", await render(sized(fullBleedIcon(512, 0.56), 512), 512, 512)],
  ["social-preview.png", await render(socialCard(), 1200, 630)]
];
for (const [name, data] of outputs) {
  writeFileSync(new URL(name, PUBLIC), data);
  console.log(`${name}  ${(data.length / 1024).toFixed(1)} KB`);
}
await browser.close();
