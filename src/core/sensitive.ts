const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PAN = /\b(?:\d[ -]?){12,19}\b/;
const MASKED_CARD = /\b(?:\*|x|X|•){4,}(?:[ -]?(?:\*|x|X|•){2,4}){0,3}[ -]?\d{2,4}\b/;
const ACCOUNT_NUMBER = /\b(?:account|acct)\s*(?:number|no\.?|#)?\s*[:#-]?\s*\d(?:[ -]?\d){3,}\b/i;
const BANK_OR_ROUTING_NUMBER = /\b(?:bank|routing)\s*(?:account\s*)?(?:number|no\.?)?\s*[:#-]?\s*\d(?:[ -]?\d){3,}\b/i;
const SECURITY_CODE = /\b(?:cvv2?|cvc|security\s*code)\b/i;

/**
 * Returns true when a static-text candidate could expose display-sensitive data.
 * Callers must discard the complete candidate rather than redact or retain it.
 */
export function hasSensitiveDisplayData(text: string): boolean {
  return EMAIL.test(text)
    || PAN.test(text)
    || MASKED_CARD.test(text)
    || ACCOUNT_NUMBER.test(text)
    || BANK_OR_ROUTING_NUMBER.test(text)
    || SECURITY_CODE.test(text);
}
