const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sectionRegions } = require("../vision-regions.cjs");
function table() {
  const width = 600, height = 900, data = Buffer.alloc(width * height * 3, 255);
  const pixel = (x, y, color) => color.forEach((v, c) => { data[(y * width + x) * 3 + c] = v; });
  for (const top of [50, 300, 600]) for (let y = top; y < top + 25; y++) for (let x = 10; x <= 590; x++) pixel(x, y, [0, 165, 220]);
  for (const x of [10, 110, 210, 310, 410, 510, 590]) for (let y = 10; y < 890; y++) pixel(x, y, [10, 10, 10]);
  return { data, width, height, channels: 3 };
}
test("colored table sections split at headers, retaining title and every pixel in order", () => {
  const input = table(), regions = sectionRegions(input);
  assert.equal(regions.length, 3); assert.equal(regions[0].top, 0);
  assert.equal(regions[1].top, 300); assert.equal(regions[2].top, 600);
  assert.equal(regions.reduce((sum, r) => sum + r.height, 0), input.height);
  for (let i = 1; i < regions.length; i++) assert.equal(regions[i - 1].top + regions[i - 1].height, regions[i].top);
});
test("photos without grid columns and plain text are left as a single image", () => {
  const input = table();
  for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) {
    const at = (y * input.width + x) * 3;
    if (input.data[at] === 10) input.data.fill(255, at, at + 3);
  }
  assert.equal(sectionRegions(input).length, 1);
  input.data.fill(255); assert.equal(sectionRegions(input).length, 1);
});

test("a different-colored main title stays in the first crop instead of becoming a separate section", () => {
  const input = table();
  for (let y = 0; y < 30; y++) for (let x = 10; x < 590; x++) {
    const at = (y * input.width + x) * 3;
    input.data[at] = 240; input.data[at + 1] = 240; input.data[at + 2] = 0;
  }
  assert.deepEqual(sectionRegions(input).map(region => region.top), [0, 300, 600]);
});
