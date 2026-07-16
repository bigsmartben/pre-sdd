import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { analyzePng } from '../../templates/workspace/.agents/skills/capture-figma-design-source/scripts/validate-png-assets.mjs';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const roots = [];

test.after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function rgbaPng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]), Buffer.from(pixels.slice(y * width * 4, (y + 1) * width * 4)));
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function fixture(name, width, height, pixels) {
  const root = await mkdtemp(join(tmpdir(), 'pre-sdd-png-'));
  roots.push(root);
  const path = resolve(root, name);
  await writeFile(path, rgbaPng(width, height, pixels));
  return path;
}

test('PNG validator accepts visible content with real transparency', async () => {
  const pixels = new Array(4 * 4 * 4).fill(0);
  const center = (1 * 4 + 1) * 4;
  pixels.splice(center, 4, 70, 120, 180, 255);
  const result = await analyzePng(await fixture('transparent.png', 4, 4, pixels), { edgeMargin: 1 });
  assert.deepEqual(result.errors, []);
  assert.equal(result.visiblePixels, 1);
  assert.equal(result.transparentPixels, 15);
  assert.equal(result.edgeContact, false);
});

test('PNG validator rejects an opaque image without transparent pixels', async () => {
  const pixels = Array.from({ length: 4 * 4 }, () => [40, 50, 60, 255]).flat();
  const result = await analyzePng(await fixture('opaque.png', 4, 4, pixels));
  assert.ok(result.errors.includes('没有完全透明像素'));
});

test('PNG validator rejects an image with no visible content', async () => {
  const result = await analyzePng(await fixture('empty.png', 4, 4, new Array(4 * 4 * 4).fill(0)));
  assert.ok(result.errors.includes('没有可见内容'));
});

test('PNG validator warns when visible content touches an edge', async () => {
  const pixels = new Array(4 * 4 * 4).fill(0);
  pixels.splice(0, 4, 255, 255, 255, 255);
  const result = await analyzePng(await fixture('edge.png', 4, 4, pixels), { edgeMargin: 1 });
  assert.deepEqual(result.errors, []);
  assert.equal(result.edgeContact, true);
  assert.equal(result.warnings.length, 1);
});
