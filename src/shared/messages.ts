import type { AnalysisResult } from '../core/types';

export const CLEARCHOICE_ANALYZE = 'CLEARCHOICE_ANALYZE' as const;

export interface AnalyzeRequest {
  type: typeof CLEARCHOICE_ANALYZE;
}

export type AnalyzeResponse = AnalysisResult;
