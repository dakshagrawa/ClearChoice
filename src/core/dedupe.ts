import type { Finding, FindingKind, FindingReason, Severity } from './types';

export function deterministicFindingId(
  kind: FindingKind,
  reason: FindingReason,
  evidence: string,
  selector: string,
): string {
  const value = `${kind}\u0000${reason}\u0000${evidence}\u0000${selector}`;
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${kind}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function makeFinding(
  kind: FindingKind,
  reason: FindingReason,
  severity: Severity,
  title: string,
  explanation: string,
  evidence: string,
  selector: string,
): Finding {
  return {
    id: deterministicFindingId(kind, reason, evidence, selector),
    kind,
    reason,
    severity,
    title,
    explanation,
    evidence,
    selector,
  };
}

export function dedupeNestedTextFindings(findings: Finding[]): Finding[] {
  return findings.filter(
    (finding, index) =>
      !findings.slice(0, index).some(
        (previous) =>
          previous.kind === finding.kind
          && previous.reason === finding.reason
          && previous.evidence === finding.evidence
          && finding.selector.startsWith(`${previous.selector} > `),
      ),
  );
}
