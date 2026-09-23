import { createHash } from 'node:crypto';

export function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export const LOCAL_HUMAN_ATTESTATION = 'local-human-attestation';

const REQUIRED_MARKER_FIELDS = new Set([
  'schemaVersion',
  'outcome',
  'cleanFixtureIntegrity',
  'dynamicFixtureIntegrity',
  'commit',
  'manifestSha256',
  'reviewer',
]);

export function validateManualActiveTabMarker(marker, expected) {
  if (!marker || typeof marker !== 'object' || Object.getPrototypeOf(marker) !== Object.prototype) {
    return { ok: false, error: 'marker must be a JSON object' };
  }

  const markerKeys = Reflect.ownKeys(marker);
  if (
    markerKeys.length !== REQUIRED_MARKER_FIELDS.size
    || markerKeys.some((key) => typeof key !== 'string' || !REQUIRED_MARKER_FIELDS.has(key))
    || [...REQUIRED_MARKER_FIELDS].some((key) => !Object.hasOwn(marker, key))
  ) {
    return { ok: false, error: 'marker must contain exactly the required attestation fields' };
  }

  if (marker.schemaVersion !== 2) return { ok: false, error: 'marker schemaVersion must be 2' };
  if (marker.outcome !== 'passed') return { ok: false, error: 'marker outcome must be passed' };
  if (marker.cleanFixtureIntegrity !== 'passed') return { ok: false, error: 'marker must attest that clean fixture integrity passed' };
  if (marker.dynamicFixtureIntegrity !== 'passed') return { ok: false, error: 'marker must attest that dynamic fixture integrity passed' };
  if (marker.reviewer !== LOCAL_HUMAN_ATTESTATION) return { ok: false, error: 'marker reviewer must be the local human attestation token' };
  if (marker.commit !== expected.commit) return { ok: false, error: 'marker does not attest to the current commit' };
  if (marker.manifestSha256 !== expected.manifestSha256) return { ok: false, error: 'marker does not attest to the current manifest' };
  return { ok: true };
}
