import { expect, it } from 'vitest';

import { CLEARCHOICE_ANALYZE } from './messages';
import type { AnalyzeRequest, AnalyzeResponse } from './messages';

it('defines the analysis request and response contract around AnalysisResult', () => {
  const request: AnalyzeRequest = { type: CLEARCHOICE_ANALYZE };
  const response: AnalyzeResponse = {
    findings: [
      {
        id: 'finding-1',
        kind: 'recurring-charge',
        severity: 'notice',
        title: 'Possible recurring charge',
        explanation: 'Check the schedule.',
        evidence: '$12 per month',
        selector: 'section',
      },
    ],
    analyzedAt: '2026-09-22T00:00:00.000Z',
    pageTitle: 'Mock checkout',
  };

  expect(request.type).toBe('CLEARCHOICE_ANALYZE');
  expect(response.findings[0]?.evidence).toBe('$12 per month');
});
