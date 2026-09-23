import { createHash } from 'node:crypto';

export function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export function validateManualActiveTabMarker(marker, expected) {
  if (!marker || typeof marker !== 'object') return { ok: false, error: 'marker must be a JSON object' };
  if (marker.schemaVersion !== 1) return { ok: false, error: 'marker schemaVersion must be 1' };
  if (marker.outcome !== 'passed') return { ok: false, error: 'marker outcome must be passed' };
  if (typeof marker.reviewer !== 'string' || marker.reviewer.trim() === '') return { ok: false, error: 'marker must include a reviewer sign-off' };
  if (marker.commit !== expected.commit) return { ok: false, error: 'marker does not attest to the current commit' };
  if (marker.manifestSha256 !== expected.manifestSha256) return { ok: false, error: 'marker does not attest to the current manifest' };
  return { ok: true };
}
