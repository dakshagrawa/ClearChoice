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
  'accessibility',
  'commit',
  'manifestSha256',
  'archiveSha256',
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

  if (marker.schemaVersion !== 3) return { ok: false, error: 'marker schemaVersion must be 3' };
  if (!/^[a-f0-9]{40}$/.test(marker.commit) || !/^[a-f0-9]{64}$/.test(marker.manifestSha256) || !/^[a-f0-9]{64}$/.test(marker.archiveSha256)) {
    return { ok: false, error: 'marker commit and hashes must be fixed-format lowercase hex' };
  }
  if (marker.archiveSha256 !== expected.archiveSha256) return { ok: false, error: 'marker does not attest to the current archive' };
  if (marker.outcome !== 'passed') return { ok: false, error: 'marker outcome must be passed' };
  if (marker.cleanFixtureIntegrity !== 'passed') return { ok: false, error: 'marker must attest that clean fixture integrity passed' };
  if (marker.dynamicFixtureIntegrity !== 'passed') return { ok: false, error: 'marker must attest that dynamic fixture integrity passed' };
  if (marker.accessibility !== true) return { ok: false, error: 'marker must attest that active-tab panel accessibility passed' };
  if (marker.reviewer !== LOCAL_HUMAN_ATTESTATION) return { ok: false, error: 'marker reviewer must be the local human attestation token' };
  if (marker.commit !== expected.commit) return { ok: false, error: 'marker does not attest to the current commit' };
  if (marker.manifestSha256 !== expected.manifestSha256) return { ok: false, error: 'marker does not attest to the current manifest' };
  return { ok: true };
}
