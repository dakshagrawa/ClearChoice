import type { Finding, FindingKind, Severity } from './types';

export function deterministicFindingId(
  kind: FindingKind,
  evidence: string,
  selector: string,
): string {
  const value = `${kind}\u0000${evidence}\u0000${selector}`;
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${kind}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function makeFinding(
  kind: FindingKind,
  severity: Severity,
  title: string,
  explanation: string,
  evidence: string,
  selector: string,
): Finding {
  return {
    id: deterministicFindingId(kind, evidence, selector),
    kind,
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
          previous.kind === finding.kind &&
          previous.evidence === finding.evidence &&
          finding.selector.startsWith(`${previous.selector} > `),
      ),
  );
}
