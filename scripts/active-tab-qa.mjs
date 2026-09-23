import { createHash } from 'node:crypto';

export function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

const REQUIRED_MARKER_FIELDS = new Set([
  'schemaVersion',
  'outcome',
  'commit',
  'manifestSha256',
  'reviewer',
]);

export function validateManualActiveTabMarker(marker, expected) {
  if (!marker || typeof marker !== 'object') return { ok: false, error: 'marker must be a JSON object' };

  const markerKeys = Reflect.ownKeys(marker);
  if (
    markerKeys.length !== REQUIRED_MARKER_FIELDS.size
    || markerKeys.some((key) => typeof key !== 'string' || !REQUIRED_MARKER_FIELDS.has(key))
    || [...REQUIRED_MARKER_FIELDS].some((key) => !Object.hasOwn(marker, key))
  ) {
    return { ok: false, error: 'marker must contain exactly the required attestation fields' };
  }

  if (marker.schemaVersion !== 1) return { ok: false, error: 'marker schemaVersion must be 1' };
  if (marker.outcome !== 'passed') return { ok: false, error: 'marker outcome must be passed' };
  if (typeof marker.reviewer !== 'string' || marker.reviewer.trim() === '') return { ok: false, error: 'marker must include a reviewer sign-off' };
  if (marker.commit !== expected.commit) return { ok: false, error: 'marker does not attest to the current commit' };
  if (marker.manifestSha256 !== expected.manifestSha256) return { ok: false, error: 'marker does not attest to the current manifest' };
  return { ok: true };
}
