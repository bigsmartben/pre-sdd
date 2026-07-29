const VISUAL_DECLARATION = /\b(background(?:-color|-image|-clip|-origin|-position|-repeat|-size)?|border(?:-(?:top|right|bottom|left))?(?:-(?:color|style|width|radius))?|box-shadow|text-shadow|filter|backdrop-filter|mask(?:-[a-z-]+)?|clip-path|outline|opacity|mix-blend-mode)\s*:\s*([^;}\n]+)/gi;

export function isNeutralFigmaVisualReset(property, rawValue) {
  const value = rawValue.trim().toLowerCase().replace(/\s*!important\s*$/, '');
  if (['none', 'transparent', '0', '0px'].includes(value)) return true;
  if (property.startsWith('background')) return /^(?:transparent|none)(?:\s+(?:transparent|none))*$/.test(value);
  if (property.startsWith('border') || property === 'outline') return /^(?:0|0px|none|transparent)(?:\s+(?:0|0px|none|transparent))*$/.test(value);
  return false;
}

export function findFigmaVisualBypasses(source) {
  const issues = [];
  for (const match of source.matchAll(VISUAL_DECLARATION)) {
    const property = match[1].toLowerCase();
    if (!isNeutralFigmaVisualReset(property, match[2])) {
      issues.push({ kind: 'css-property', property });
    }
  }
  for (const match of source.matchAll(/[^{}]*::(?:before|after)\b[^{}]*\{([^{}]*)\}/gi)) {
    const content = /\bcontent\s*:\s*([^;}\n]+)/i.exec(match[1])?.[1]?.trim().toLowerCase();
    if (content && !['none', 'normal', "''", '""'].includes(content.replace(/\s*!important\s*$/, ''))) {
      issues.push({ kind: 'pseudo-element' });
    }
  }
  if (/<svg\b|<canvas\b|createElement\s*\(\s*['"](?:svg|canvas)['"]\s*\)|createElementNS\s*\([^,]+,\s*['"]svg['"]\s*\)/i.test(source)) {
    issues.push({ kind: 'svg-or-canvas' });
  }
  return issues;
}
