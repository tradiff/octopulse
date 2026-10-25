import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import sharp from 'sharp';

test('inline PR state icons have transparent backgrounds and colored glyphs at web size', async () => {
  for (const [state, color] of [['open', [195, 232, 141]], ['draft', [163, 172, 203]], ['closed', [255, 117, 127]], ['merged', [192, 153, 255]]] as const) {
    const { data } = await sharp(await readFile(new URL(`../../assets/git-${state}-inline.svg`, import.meta.url)))
      .resize(20, 20).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(data[3], 0, `${state}: no background at the corner`);
    const solid = [];
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 255) solid.push([...data.subarray(i, i + 3)]);
    assert.ok(solid.length > 0, `${state}: glyph is visible at 20px`);
    assert.ok(solid.every(pixel => pixel.every((channel, index) => Math.abs(channel - color[index]!) <= 1)), `${state}: glyph carries the state color rather than white`);
  }
});

test('blue and white octopus marks render with transparent backgrounds and open circuit pins at icon sizes', async () => {
  const holes = [[54, 185], [458, 185], [46, 319], [466, 319], [166, 400], [346, 400], [0, 0]] as const;
  for (const [file, color] of [['octopulse-mark-blue.svg', [130, 170, 255]], ['octopulse-mark-small-white.svg', [255, 255, 255]], ['octopulse-mark-small-blue.svg', [130, 170, 255]]] as const) {
    const image = sharp(await readFile(new URL(`../../assets/${file}`, import.meta.url)));
    const { data, info } = await image.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 512); assert.equal(info.height, 448);
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
    for (const [x, y] of holes) assert.equal(pixel(x, y)[3], 0, `${file}: transparent at ${x},${y}`);
    if (file.includes('-small-')) {
      assert.deepEqual(pixel(256, 139), [...color, 255], 'Small mark head is filled');
      assert.equal(pixel(218, 158)[3], 0, 'Left eye is a transparent cutout');
      assert.equal(pixel(294, 158)[3], 0, 'Right eye is a transparent cutout');
    } else {
      assert.equal(pixel(256, 139)[3], 0, 'Blue head remains hollow');
      assert.deepEqual(pixel(218, 158), [...color, 255], 'Left blue eye remains solid');
      assert.deepEqual(pixel(294, 158), [...color, 255], 'Right blue eye remains solid');
    }
    for (const size of [16, 22, 32]) {
      const small = await image.clone().resize(size, size, { fit: 'contain', background: '#00000000' }).ensureAlpha().raw().toBuffer();
      const opacity = [...small].filter((_, index) => index % 4 === 3);
      assert.ok(opacity.some(value => value > 200), `${file}: visible at ${size}px`);
      assert.equal(small[3], 0, `${file}: transparent corner at ${size}px`);
    }
  }
});
