import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { repositoryFile } from '../../../../runtime/project.mjs';

function maskQuotedStrings(value) {
  let quote = null;
  let escaped = false;
  let masked = '';
  for (const character of value) {
    if (quote) {
      if (escaped) {
        escaped = false;
        masked += character === '\n' ? '\n' : ' ';
      } else if (character === '\\') {
        escaped = true;
        masked += ' ';
      } else if (character === quote) {
        quote = null;
        masked += character;
      } else {
        masked += character === '\n' ? '\n' : ' ';
      }
    } else {
      if (character === "'" || character === '"') quote = character;
      masked += character;
    }
  }
  if (quote) throw new Error('canonicalUi 包含未结束的字符串字面量。');
  return masked;
}

export async function extractStaticConst(root, path, exportName) {
  const source = await readFile(repositoryFile(root, path), 'utf8');
  const prefix = new RegExp(`export\\s+const\\s+${exportName}\\s*=\\s*`, 'm').exec(source);
  if (!prefix) throw new Error(`语义入口必须导出静态 const ${exportName}。`);
  const remainder = source.slice(prefix.index + prefix[0].length);
  const suffix = remainder.lastIndexOf('as const');
  if (suffix < 0 || remainder.slice(suffix + 'as const'.length).trim() !== ';') {
    throw new Error(`${exportName} 必须以静态对象字面量和 as const 结束。`);
  }
  const literal = remainder.slice(0, suffix).trim();
  if (!literal.startsWith('{') || !literal.endsWith('}')) throw new Error(`${exportName} 必须是对象字面量。`);
  if (/[`]|\$\{|\.\.\.|:\s*[*&!]/m.test(literal)) {
    throw new Error(`${exportName} 不允许模板字符串、展开、别名、标签或动态表达式。`);
  }
  const syntaxOnly = maskQuotedStrings(literal);
  for (const match of syntaxOnly.matchAll(/:\s*([A-Za-z_$][A-Za-z0-9_$.]*(?:\([^)]*\))?)/g)) {
    if (!['true', 'false', 'null'].includes(match[1])) {
      throw new Error(`${exportName} 的字符串值必须加引号，且不得引用变量或调用函数：` + match[1]);
    }
  }
  const value = parseYaml(literal);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${exportName} 静态对象无法解析。`);
  return value;
}

export async function extractCanonicalUi(root, path) {
  return extractStaticConst(root, path, 'canonicalUi');
}
