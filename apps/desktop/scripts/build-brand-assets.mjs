import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const sourceRoot = path.join(repositoryRoot, "assets");
const outputRoot = path.join(desktopRoot, "dist", "branding");
// logo.png is the compact "[ ]*" mark (application icon, favicon, workbench
// header mark). splash.png is the text-free wordmark art (splash, first run,
// marker-stroke source). Swapping either asset only needs these two names.
const applicationIconSource = path.join(sourceRoot, "logo.png");
const wordmarkSource = path.join(sourceRoot, "splash.png");
const sourceNames = ["logo.png", "splash.png"];
const fontSourceRoot = path.join(desktopRoot, "assets", "fonts", "jost");
const fontNames = ["jost-latin-700-normal.woff2"];
// Optimized, HiDPI-capable derivative of the logo for renderer surfaces
// (header mark at ~26 CSS px, favicon): 128 px covers 4x at 32 CSS px.
const logoMarkSize = 128;

await rm(outputRoot, { recursive: true, force: true });
if (!existsSync(applicationIconSource)) {
  throw new Error(`Required application icon source is missing: ${applicationIconSource}`);
}
await mkdir(outputRoot, { recursive: true });

for (const name of sourceNames) {
  const source = path.join(sourceRoot, name);
  if (!existsSync(source)) {
    process.stdout.write(`Brand asset unavailable; using presentation fallback: ${name}\n`);
    continue;
  }
  await copyFile(source, path.join(outputRoot, name));
}

for (const name of fontNames) {
  const source = path.join(fontSourceRoot, name);
  if (!existsSync(source)) {
    process.stdout.write(`Bundled font unavailable; splash uses the system font stack: ${name}
`);
    continue;
  }
  await mkdir(path.join(outputRoot, "fonts"), { recursive: true });
  await copyFile(source, path.join(outputRoot, "fonts", name));
}

await writeFile(path.join(outputRoot, "logo-mark.png"), await createLogoMark(applicationIconSource, logoMarkSize));

if (existsSync(wordmarkSource)) {
  const marker = await extractMarkerStroke(wordmarkSource);
  if (marker !== null) {
    await writeFile(path.join(outputRoot, "marker-stroke.png"), marker);
  } else {
    process.stdout.write("Marker stroke could not be isolated; using the CSS marker fallback.\n");
  }
}

const icon = await createWindowsIcon(applicationIconSource);
await writeFile(path.join(outputRoot, "maginalia.ico"), icon);

process.stdout.write(`Brand assets prepared in ${outputRoot}\n`);

async function extractMarkerStroke(sourcePath) {
  const { data, info } = await sharp(sourcePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const columns = Array.from({ length: info.width }, () => null);
  let left = info.width;
  let right = -1;
  // Skip the asterisk accents in the upper part of the wordmark art; the
  // painted marker band sits in the lower half.
  const minimumMarkerY = Math.floor(info.height * 0.5);

  for (let offset = 0; offset < data.length; offset += 4) {
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const alpha = data[offset + 3];
    if (alpha < 12 || green < 150 || green - red < 35 || green - blue < 70) continue;

    const pixel = offset / 4;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    if (y < minimumMarkerY) continue;
    const bounds = columns[x] ?? { top: y, bottom: y };
    bounds.top = Math.min(bounds.top, y);
    bounds.bottom = Math.max(bounds.bottom, y);
    columns[x] = bounds;
    left = Math.min(left, x);
    right = Math.max(right, x);
  }

  if (right < left) return null;

  interpolateColumnBounds(columns, left, right);
  const smoothed = smoothColumnBounds(columns, left, right);
  const definedBounds = smoothed.slice(left, right + 1).filter((bounds) => bounds !== null);
  const top = Math.min(...definedBounds.map((bounds) => bounds.top));
  const bottom = Math.max(...definedBounds.map((bounds) => bounds.bottom));
  const width = right - left + 1;
  const height = bottom - top + 1;
  const output = Buffer.alloc(width * height * 4);
  for (let sourceX = left; sourceX <= right; sourceX += 1) {
    const bounds = smoothed[sourceX];
    if (bounds === null) continue;
    for (let sourceY = bounds.top; sourceY <= bounds.bottom; sourceY += 1) {
      const outputOffset = ((sourceY - top) * width + sourceX - left) * 4;
      output[outputOffset] = 193;
      output[outputOffset + 1] = 255;
      output[outputOffset + 2] = 45;
      output[outputOffset + 3] = 235;
    }
  }

  return sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

function interpolateColumnBounds(columns, left, right) {
  for (let x = left; x <= right; x += 1) {
    if (columns[x] !== null) continue;
    let previous = x - 1;
    while (previous >= left && columns[previous] === null) previous -= 1;
    let next = x + 1;
    while (next <= right && columns[next] === null) next += 1;
    if (previous < left || next > right || next - previous > 25) continue;
    const ratio = (x - previous) / (next - previous);
    columns[x] = {
      top: Math.round(columns[previous].top + (columns[next].top - columns[previous].top) * ratio),
      bottom: Math.round(columns[previous].bottom + (columns[next].bottom - columns[previous].bottom) * ratio),
    };
  }
}

function smoothColumnBounds(columns, left, right) {
  const result = columns.slice();
  // The logo letters cross the painted band. A broad moving median follows the
  // brush's slow outer contour while bridging those text-shaped interruptions.
  const radius = 55;
  for (let x = left; x <= right; x += 1) {
    if (columns[x] === null) continue;
    const neighbors = columns.slice(Math.max(left, x - radius), Math.min(right + 1, x + radius + 1))
      .filter((bounds) => bounds !== null);
    result[x] = {
      top: median(neighbors.map((bounds) => bounds.top)),
      bottom: median(neighbors.map((bounds) => bounds.bottom)),
    };
  }
  return result;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Square, transparent, ~6% safe margin on every side. */
async function createSquareTransparentIcon(sourcePath, size) {
  const pad = Math.round(size * 0.06);
  const inner = size - pad * 2;
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
  return sharp(sourcePath)
    .ensureAlpha()
    .resize(inner, inner, { fit: "contain", background: transparent })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: transparent })
    .png()
    .toBuffer();
}

async function createLogoMark(sourcePath, size) {
  return sharp(sourcePath)
    .ensureAlpha()
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function createWindowsIcon(sourcePath) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngImages = await Promise.all(sizes.map((size) => createSquareTransparentIcon(sourcePath, size)));

  const directory = Buffer.alloc(6);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);

  let imageOffset = 6 + sizes.length * 16;
  const entries = pngImages.map((png, index) => {
    const size = sizes[index];
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size;
    entry[1] = size === 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(imageOffset, 12);
    imageOffset += png.length;
    return entry;
  });

  return Buffer.concat([directory, ...entries, ...pngImages]);
}
