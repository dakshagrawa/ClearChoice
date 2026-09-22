import { expect, it } from 'vitest';

import { CLEARCHOICE_ANALYZE } from './messages';
import type { AnalyzeRequest, AnalyzeResponse } from './messages';

const result = {
  findings: [
    {
      id: 'finding-1',
      kind: 'recurring-charge' as const,
      severity: 'notice' as const,
      title: 'Possible recurring charge',
      explanation: 'Check the schedule.',
      evidence: '$12 per month',
      selector: 'section',
    },
  ],
  analyzedAt: '2026-09-22T00:00:00.000Z',
  pageTitle: 'Mock checkout',
};

it('defines successful analysis messages as an explicit success union member', () => {
  const request: AnalyzeRequest = { type: CLEARCHOICE_ANALYZE };
  const response: AnalyzeResponse = { ok: true, result };

  expect(request.type).toBe('CLEARCHOICE_ANALYZE');
  expect(response.ok).toBe(true);
  if (response.ok) expect(response.result.findings[0]?.evidence).toBe('$12 per month');
});

it('defines failed analysis messages as an explicit error union member', () => {
  const response: AnalyzeResponse = { ok: false, error: 'Analysis unavailable.' };

  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error).toBe('Analysis unavailable.');
});
