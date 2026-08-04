import { extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { repositoryFile } from '../../../../runtime/project.mjs';
import { sha256, stableJson } from '../../../visual-spec/scripts/lib/visual-spec.mjs';
import { inspectPng } from '../validate-png-assets.mjs';

const IMAGE_FORMATS = new Set(['svg', 'png', 'webp', 'jpg']);
const EXTENSIONS = Object.freeze({
  svg: ['.svg'],
  png: ['.png'],
  webp: ['.webp'],
  jpg: ['.jpg', '.jpeg'],
  woff: ['.woff'],
  woff2: ['.woff2'],
});

function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(bytes) {
  const kind = bytes.toString('ascii', 12, 16);
  if (kind === 'VP8X' && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const packed = bytes.readUInt32LE(21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function svgDimensions(bytes) {
  const source = bytes.toString('utf8');
  if (!/<svg(?:\s|>)/i.test(source)) return null;
  const width = /\bwidth=["']([0-9]+)(?:px)?["']/i.exec(source)?.[1];
  const height = /\bheight=["']([0-9]+)(?:px)?["']/i.exec(source)?.[1];
  if (width && height) return { width: Number(width), height: Number(height) };
  const viewBox = /\bviewBox=["']([^"']+)["']/i.exec(source)?.[1]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  return viewBox?.length === 4 && viewBox.every(Number.isFinite)
    ? { width: Math.round(viewBox[2]), height: Math.round(viewBox[3]) }
    : null;
}

export function inspectAsset(bytes, format) {
  if (format === 'png') {
    try {
      const metadata = inspectPng(bytes);
      return { width: metadata.width, height: metadata.height };
    } catch {
      return null;
    }
  }
  if (format === 'jpg') {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    return jpegDimensions(bytes);
  }
  if (format === 'webp') {
    if (bytes.length < 16 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
    return webpDimensions(bytes);
  }
  if (format === 'svg') return svgDimensions(bytes);
  if (format === 'woff') return bytes.toString('ascii', 0, 4) === 'wOFF' ? {} : null;
  if (format === 'woff2') return bytes.toString('ascii', 0, 4) === 'wOF2' ? {} : null;
  return null;
}

export async function validateAssetEvidence(root, asset) {
  const errors = [];
  const extension = extname(asset.path ?? '').toLowerCase();
  if (!(EXTENSIONS[asset.format] ?? []).includes(extension)) {
    errors.push(`path 扩展名与 format=${asset.format} 不一致`);
  }
  let bytes;
  try {
    bytes = await readFile(repositoryFile(root, asset.path));
  } catch (error) {
    return [`正式文件不可读：${error.message}`];
  }
  if (sha256(bytes) !== asset.digest) errors.push('digest 与正式文件字节不匹配');
  const metadata = inspectAsset(bytes, asset.format);
  if (!metadata) {
    errors.push(`文件内容不是有效的 ${asset.format}`);
  } else if (IMAGE_FORMATS.has(asset.format)) {
    if (!Number.isInteger(asset.width) || !Number.isInteger(asset.height)) {
      errors.push('图片 Asset 必须声明 width/height');
    } else if (metadata.width !== asset.width || metadata.height !== asset.height) {
      errors.push(`尺寸不匹配：声明 ${asset.width}x${asset.height}，实际 ${metadata.width ?? '?'}x${metadata.height ?? '?'}`);
    }
  } else if (asset.width !== null || asset.height !== null) {
    errors.push('字体 Asset 的 width/height 必须为 null');
  }
  return errors;
}

export function evidenceRecordDigest(record) {
  const content = Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !['digest', 'itemRefs'].includes(key)),
  );
  return sha256(Buffer.from(stableJson(content)));
}
