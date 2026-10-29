import type { ReceiptFields, VerificationOutcome } from '../../../../../packages/contracts/src/index.js';

export const RULE_VERSION = 'rules.v2-tenant-policy';
export type BankRow = { id: string; account_identifier: string; active: boolean; version: number; bank_transaction_ref: string; amount_sen: number; currency: string; direction: string; status: string; booked_at: string | Date; allocated: boolean };
// model_unconfirmed: GPU vision fields that the independent CPU reading did not reproduce (the model may have guessed).
export type RuleInput = { total_sen: number; fields: ReceiptFields; accounts: string[]; transactions: BankRow[]; duplicate_evidence: boolean; duplicate_image?:boolean; duplicate_reference: boolean; manual: boolean; model_unconfirmed?: boolean; owner_review_threshold_sen?:number;policy_version?:number };
export function verify(input: RuleInput) {
  const { fields: f } = input;
  const flags: string[] = [];
  if (f.document_type === 'MONEY_REQUEST') flags.push('MONEY_REQUEST');
  else if (f.document_type !== 'TRANSFER_RECEIPT') flags.push('INVALID_RECEIPT');
  if (f.status !== 'SUCCESS') flags.push('TRANSFER_NOT_COMPLETE');
  if (f.amount_sen === null || f.occurred_at === null) flags.push('INVALID_RECEIPT');
  if (!f.recipient_account || f.recipient_account.includes('*')) flags.push('RECIPIENT_UNCERTAIN');
  else if (!input.accounts.includes(f.recipient_account)) flags.push('WRONG_RECIPIENT');
  if (!f.bank_transaction_ref) flags.push('AMBIGUOUS_MATCH');
  if (input.duplicate_evidence) flags.push('DUPLICATE_EVIDENCE');
  if(input.duplicate_image)flags.push('DUPLICATE_IMAGE');
  if (input.duplicate_reference) flags.push('DUPLICATE_REFERENCE');
  if (input.manual) flags.push('MANUAL_FIELDS');
  if (input.model_unconfirmed) flags.push('MODEL_UNCONFIRMED');
  const threshold=input.owner_review_threshold_sen??50000;
  if (input.total_sen > threshold || (f.amount_sen ?? 0) > threshold) flags.push('HIGH_VALUE');
  if (f.amount_sen !== null && f.amount_sen < input.total_sen) flags.push('PARTIAL_PAYMENT');
  if (f.amount_sen !== null && f.amount_sen > input.total_sen) flags.push('OVERPAYMENT');
  // Only the synthetic adapter's explicit bank_transaction_ref has compatible semantics.
  const related = input.transactions.filter(t => t.active && t.direction === 'CREDIT' && t.status === 'BOOKED' && t.currency === 'MYR' &&
    t.account_identifier === f.recipient_account && t.bank_transaction_ref === f.bank_transaction_ref &&
    f.occurred_at && Math.abs(new Date(t.booked_at).getTime() - Date.parse(f.occurred_at)) <= 86400000);
  if (related.some(t => t.allocated)) flags.push('TRANSACTION_ALREADY_USED');
  const candidates = related.filter(t => !t.allocated && t.amount_sen === f.amount_sen);
  if (related.some(t => t.amount_sen !== f.amount_sen)) flags.push('AMOUNT_MISMATCH');
  if (!related.length) flags.push('BANK_NOT_FOUND');
  if (candidates.length > 1) flags.push('AMBIGUOUS_MATCH');
  const reasons = [...new Set(flags)];
  const blockers = reasons.filter(x => !['HIGH_VALUE','DUPLICATE_REFERENCE','MANUAL_FIELDS','MODEL_UNCONFIRMED'].includes(x));
  const eligible = candidates.length === 1 && blockers.length === 0;
  const required_role = reasons.length ? 'OWNER' : 'CASHIER';
  const outcome: VerificationOutcome = eligible ? (reasons.length ? 'NEEDS_REVIEW' : 'MATCHED') :
    reasons.some(x => ['MONEY_REQUEST','TRANSFER_NOT_COMPLETE','WRONG_RECIPIENT','INVALID_RECEIPT'].includes(x)) ? 'INVALID_EVIDENCE' :
    reasons.length === 1 && reasons[0] === 'BANK_NOT_FOUND' ? 'AWAITING_BANK' : 'NEEDS_REVIEW';
  return { outcome, flags: reasons, candidates: candidates.map(t => t.id), matched_transaction_id: eligible ? candidates[0].id : null,
    eligible, required_role, evidence_source: 'SYNTHETIC_FEED' as const, rule_version: RULE_VERSION,policy_version:input.policy_version??1,owner_review_threshold_sen:threshold };
}
