import { createHash } from 'node:crypto';
import type { ReceiptFields } from '../../../../../packages/contracts/src/index.js';

// These are team-authored structured fixtures, never OCR output or bank facts.
const normal: ReceiptFields = { amount_sen: 12800, currency: 'MYR', bank_transaction_ref: 'DEMO-BANK-128', customer_reference: 'DEMO-ORDER', recipient_account: 'DEMO-ACCOUNT-A', occurred_at: '2026-10-22T06:00:00Z', status: 'SUCCESS', document_type: 'TRANSFER_RECEIPT' };
export const fixtures: Record<string, ReceiptFields> = {
  normal, partial: { ...normal, amount_sen: 5000, bank_transaction_ref: 'DEMO-BANK-50' },
  bakery_300:{...normal,amount_sen:30000,bank_transaction_ref:'FINAL-BAKERY-300',customer_reference:'FINAL-BAKERY'},
  laundry_300:{...normal,amount_sen:30000,bank_transaction_ref:'FINAL-LAUNDRY-300',recipient_account:'DEMO-ACCOUNT-C',customer_reference:'FINAL-LAUNDRY'},
  wrong_account: { ...normal, recipient_account: 'DEMO-WRONG-ACCOUNT' },
  scheduled: { ...normal, status: 'SCHEDULED' },
  money_request: { ...normal, document_type: 'MONEY_REQUEST' },
  no_bank: { ...normal, bank_transaction_ref: 'DEMO-NOT-BOOKED' },
  high_value: { ...normal, amount_sen: 78000, bank_transaction_ref: 'DEMO-BANK-780' },
};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
  return value;
}
// PostgreSQL jsonb normalizes object-key order. Evidence hashes must do the same.
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(JSON.parse(JSON.stringify(value))))).digest('hex');
