export const CLEARCHOICE_ANALYZE = 'CLEARCHOICE_ANALYZE' as const;
export const CLEARCHOICE_RESTORE = 'CLEARCHOICE_RESTORE' as const;

export interface AnalyzeRequest {
  type: typeof CLEARCHOICE_ANALYZE;
}

export interface RestoreRequest {
  type: typeof CLEARCHOICE_RESTORE;
}

export type ContentRequest = AnalyzeRequest | RestoreRequest;
export type AnalyzeResponse =
  | { ok: true; status: 'supported'; findingCount: number }
  | { ok: true; status: 'unsupported-context'; findingCount: 0 }
  | { ok: false; error: 'restricted-page' | 'injection-failed' | 'request-failed' };
export type RestoreResponse = { ok: true } | { ok: false; error: 'request-failed' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isAnalyzeResponse(value: unknown): value is AnalyzeResponse {
  if (!isRecord(value)) return false;
  if (value.ok === false) {
    return Object.keys(value).length === 2
      && (value.error === 'restricted-page' || value.error === 'injection-failed' || value.error === 'request-failed');
  }
  if (value.ok !== true || Object.keys(value).length !== 3) return false;
  return (value.status === 'supported' && typeof value.findingCount === 'number' && Number.isInteger(value.findingCount) && value.findingCount >= 0)
    || (value.status === 'unsupported-context' && value.findingCount === 0);
}

export function isRestoreResponse(value: unknown): value is RestoreResponse {
  return isRecord(value)
    && ((value.ok === true && Object.keys(value).length === 1)
      || (value.ok === false && value.error === 'request-failed'));
}
