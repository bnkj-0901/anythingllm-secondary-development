const path = require("node:path");
const { createRequire } = require("node:module");
const { serverDirectory } = require("./dependencies.cjs");
const requireCollector = createRequire(path.resolve(serverDirectory, "../collector/package.json"));

// Only split tables with repeated full-width colored headers AND long grid
// columns. Crops cover every pixel in order; no text or product rules are used.
function sectionRegions({ data, width, height, channels }) {
  const whole = [{ left: 0, top: 0, width, height }], columns = new Uint32Array(width), bands = [];
  const gap = Math.max(3, Math.floor(height * 0.003));
  for (let y = 0; y < height; y++) {
    const hues = new Uint32Array(12);
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels, r = data[at], g = data[at + 1], b = data[at + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
      if (max < 110) columns[x]++;
      if (delta < 70 || max < 120) continue;
      const hue = (max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60;
      hues[Math.floor(((hue + 375) % 360) / 30)]++;
    }
    const hue = hues.findIndex(count => count >= width * 0.65);
    if (hue < 0) continue;
    const previous = bands[bands.length - 1];
    if (previous?.hue === hue && y - previous.end <= gap) { previous.end = y; previous.rows++; }
    else bands.push({ hue, top: y, end: y, rows: 1 });
  }
  let gridColumns = 0, lastColumn = -width;
  for (let x = 0; x < width; x++) {
    if (columns[x] >= height * 0.45 && x - lastColumn > Math.max(5, width * 0.04)) { gridColumns++; lastColumn = x; }
  }
  if (gridColumns < 3) return whole;
  const groups = Array.from({ length: 12 }, (_, hue) => bands.filter(band => band.hue === hue && band.rows >= Math.max(8, height * 0.003)));
  const headers = groups.sort((a, b) => b.length - a.length)[0];
  if (headers.length < 3 || headers.length > 12) return whole;
  const starts = [0, ...headers.slice(1).map(band => band.top)];
  return starts.map((top, i) => ({ left: 0, top, width, height: (starts[i + 1] ?? height) - top }));
}

async function imageRegions(buffer, mime) {
  const sharp = requireCollector("sharp");
  const { data, info } = await sharp(buffer, { limitInputPixels: 32_000_000, failOn: "error" }).rotate().flatten({ background: "#ffffff" }).toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const regions = sectionRegions({ data, ...info });
  if (regions.length === 1) return [{ buffer, mime }];
  const images = [];
  for (const region of regions) images.push({ buffer: await sharp(data, { raw: info }).extract(region).png().toBuffer(), mime: "image/png" });
  return images;
}
module.exports = { sectionRegions, imageRegions };
