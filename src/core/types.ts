export type FindingKind = 'recurring-charge' | 'preselected-addon';
export type FindingReason =
  | 'price-cadence'
  | 'renewal-language'
  | 'subscription-language'
  | 'checked-paid-control';
export type Severity = 'info' | 'notice';

export interface Finding {
  id: string;
  kind: FindingKind;
  reason: FindingReason;
  severity: Severity;
  title: string;
  explanation: string;
  evidence: string;
  selector: string;
}

export interface AnalysisResult {
  findings: Finding[];
}
