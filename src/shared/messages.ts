import type { AnalysisResult, Finding, FindingKind, Severity } from '../core/types';

export const CLEARCHOICE_ANALYZE = 'CLEARCHOICE_ANALYZE' as const;

export interface AnalyzeRequest {
  type: typeof CLEARCHOICE_ANALYZE;
}

export type AnalyzeResponse =
  | { ok: true; result: AnalysisResult }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFindingKind(value: unknown): value is FindingKind {
  return value === 'recurring-charge' || value === 'preselected-addon';
}

function isSeverity(value: unknown): value is Severity {
  return value === 'info' || value === 'notice';
}

function isFinding(value: unknown): value is Finding {
  return isRecord(value)
    && typeof value.id === 'string'
    && isFindingKind(value.kind)
    && isSeverity(value.severity)
    && typeof value.title === 'string'
    && typeof value.explanation === 'string'
    && typeof value.evidence === 'string'
    && typeof value.selector === 'string';
}

function isAnalysisResult(value: unknown): value is AnalysisResult {
  return isRecord(value)
    && Array.isArray(value.findings)
    && value.findings.every(isFinding)
    && typeof value.analyzedAt === 'string'
    && typeof value.pageTitle === 'string';
}

export function isAnalyzeResponse(value: unknown): value is AnalyzeResponse {
  return isRecord(value)
    && ((value.ok === true && isAnalysisResult(value.result))
      || (value.ok === false && typeof value.error === 'string'));
}
