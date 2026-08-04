#!/usr/bin/env node

// Owned by figma-evidence; uses only Node.js built-ins.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function decodeRow(filter, encoded, previous, bytesPerPixel) {
  const row = Buffer.from(encoded);
  for (let index = 0; index < row.length; index += 1) {
    const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
    const up = previous?.[index] ?? 0;
    const upperLeft = index >= bytesPerPixel ? previous?.[index - bytesPerPixel] ?? 0 : 0;
    if (filter === 1) row[index] = (row[index] + left) & 255;
    else if (filter === 2) row[index] = (row[index] + up) & 255;
    else if (filter === 3) row[index] = (row[index] + Math.floor((left + up) / 2)) & 255;
    else if (filter === 4) row[index] = (row[index] + paeth(left, up, upperLeft)) & 255;
    else if (filter !== 0) throw new Error(`不支持的 PNG filter type：${filter}`);
  }
  return row;
}

function parseChunks(buffer) {
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('不是 PNG 文件');
  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new Error(`PNG chunk ${type} 不完整`);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([Buffer.from(type, 'ascii'), data]));
    if (actualCrc !== expectedCrc) throw new Error(`PNG chunk ${type} CRC 校验失败`);
    chunks.push({ type, data });
    offset = end;
    if (type === 'IEND') break;
  }
  return chunks;
}

export function inspectPng(buffer) {
  const chunks = parseChunks(buffer);
  const header = chunks.find((chunk) => chunk.type === 'IHDR')?.data;
  if (!header || header.length !== 13) throw new Error('缺少有效 IHDR');
  if (!chunks.some((chunk) => chunk.type === 'IDAT')) throw new Error('缺少 IDAT');
  if (!chunks.some((chunk) => chunk.type === 'IEND')) throw new Error('缺少 IEND');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  if (width < 1 || height < 1) throw new Error('PNG width/height 无效');
  return { chunks, header, width, height };
}

export async function analyzePng(path, { edgeMargin = 2 } = {}) {
  const { chunks, header, width, height } = inspectPng(await readFile(path));
  const bitDepth = header[8];
  const colorType = header[9];
  const interlace = header[12];
  if (bitDepth !== 8) throw new Error(`不支持的 bit depth：${bitDepth}，只接受 8-bit PNG`);
  if (interlace !== 0) throw new Error('暂不支持 interlaced PNG');

  const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(colorType);
  if (!channels) throw new Error(`不支持的 color type：${colorType}`);

  const transparency = chunks.find((chunk) => chunk.type === 'tRNS')?.data;
  const compressed = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
  if (compressed.length === 0) throw new Error('缺少 IDAT');
  const raw = inflateSync(compressed);
  const stride = width * channels;
  const expectedLength = height * (stride + 1);
  if (raw.length !== expectedLength) throw new Error(`像素数据长度无效：${raw.length}，预期 ${expectedLength}`);

  let offset = 0;
  let previous;
  let transparentPixels = 0;
  let visiblePixels = 0;
  const bounds = [width, height, -1, -1];

  for (let y = 0; y < height; y += 1) {
    const filter = raw[offset];
    offset += 1;
    const row = decodeRow(filter, raw.subarray(offset, offset + stride), previous, channels);
    offset += stride;
    previous = row;

    for (let x = 0; x < width; x += 1) {
      const pixel = row.subarray(x * channels, (x + 1) * channels);
      let alpha = 255;
      if (colorType === 4) alpha = pixel[1];
      else if (colorType === 6) alpha = pixel[3];
      else if (colorType === 3 && transparency && pixel[0] < transparency.length) alpha = transparency[pixel[0]];
      else if (colorType === 0 && transparency && pixel[0] === transparency.readUInt16BE(0)) alpha = 0;
      else if (
        colorType === 2
        && transparency
        && pixel[0] === transparency.readUInt16BE(0)
        && pixel[1] === transparency.readUInt16BE(2)
        && pixel[2] === transparency.readUInt16BE(4)
      ) alpha = 0;

      if (alpha === 0) {
        transparentPixels += 1;
      } else {
        visiblePixels += 1;
        bounds[0] = Math.min(bounds[0], x);
        bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x);
        bounds[3] = Math.max(bounds[3], y);
      }
    }
  }

  const hasTransparencyMetadata = colorType === 4 || colorType === 6 || Boolean(transparency);
  const edgeContact = visiblePixels > 0 && (
    bounds[0] < edgeMargin
    || bounds[1] < edgeMargin
    || bounds[2] >= width - edgeMargin
    || bounds[3] >= height - edgeMargin
  );
  const errors = [];
  const warnings = [];
  if (!hasTransparencyMetadata) errors.push('缺少 alpha channel 或透明元数据');
  if (transparentPixels === 0) errors.push('没有完全透明像素');
  if (visiblePixels === 0) errors.push('没有可见内容');
  if (edgeContact) warnings.push('可见内容接近或接触边缘，请检查是否裁切');

  return {
    path: String(path),
    width,
    height,
    hasTransparencyMetadata,
    transparentPixels,
    transparentRatio: Number((transparentPixels / (width * height)).toFixed(4)),
    visiblePixels,
    contentBounds: visiblePixels > 0 ? bounds : null,
    edgeContact,
    errors,
    warnings,
  };
}

async function main(arguments_) {
  const json = arguments_.includes('--json');
  const paths = arguments_.filter((argument) => argument !== '--json');
  if (paths.length === 0) {
    console.error('用法：node validate-png-assets.mjs [--json] <png>...');
    return 2;
  }

  const results = [];
  for (const path of paths) {
    try {
      results.push(await analyzePng(path));
    } catch (error) {
      results.push({ path, errors: [error instanceof Error ? error.message : String(error)], warnings: [] });
    }
  }

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      console.log(`${result.errors.length ? 'FAIL' : 'PASS'} ${result.path}`);
      if ('width' in result) console.log(`  ${result.width}x${result.height} transparent=${result.transparentRatio}`);
      for (const warning of result.warnings) console.log(`  WARN ${warning}`);
      for (const error of result.errors) console.log(`  ERROR ${error}`);
    }
  }
  return results.some((result) => result.errors.length > 0) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
