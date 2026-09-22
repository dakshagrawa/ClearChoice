export type FindingKind = 'recurring-charge' | 'preselected-addon';
export type Severity = 'info' | 'notice';

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  title: string;
  explanation: string;
  evidence: string;
  selector: string;
}

export interface AnalysisResult {
  findings: Finding[];
  analyzedAt: string;
  pageTitle: string;
}
