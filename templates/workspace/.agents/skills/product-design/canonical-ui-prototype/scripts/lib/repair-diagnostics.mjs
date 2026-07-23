import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function createRepairDiagnostic(gateId, diagnostic) {
  const body = {
    gateId,
    blockerCode: diagnostic.blockerCode,
    defectClass: diagnostic.defectClass,
    message: diagnostic.message,
    location: diagnostic.location,
    scope: diagnostic.scope,
    check: diagnostic.check,
    evidence: diagnostic.evidence,
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    ...(diagnostic.difference ? { difference: diagnostic.difference } : {}),
  };
  const digest = createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex').slice(0, 16);
  return {
    kind: 'repair-diagnostic',
    diagnosticId: 'REPAIR-DIAG-' + digest,
    ...body,
  };
}
