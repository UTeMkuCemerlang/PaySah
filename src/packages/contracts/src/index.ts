import { z } from 'zod';

export const APP_STAGE='FINALIST' as const;
export const receiptFixtureLabels:Record<string,string>={normal:'Normal · RM 128',high_value:'High value · RM 780',partial:'Partial payment · RM 50',wrong_account:'Wrong receiving account',scheduled:'Scheduled transfer',money_request:'Request for money',no_bank:'No matching bank credit',bakery_300:'Bakery order · RM 300',laundry_300:'Laundry order · RM 300'};
export const extractorModeSchema = z.enum(['fixture', 'manual', 'cpu_ocr', 'runpod']);
export const healthSchema = z.object({
  status: z.literal('ok'), service: z.literal('paysah-api'),
  stage: z.literal(APP_STAGE), demo: z.literal(true),
  commit:z.string().regex(/^(unknown|[0-9a-f]{40})$/),
  extractor_mode: extractorModeSchema,
  database: z.enum(['not_configured', 'not_checked']),
  business_features: z.enum(['identity_orders_verification', 'database_required']),
});
export type Health = z.infer<typeof healthSchema>;
export type PaymentState = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'MANUALLY_CONFIRMED' | 'RECONCILIATION_REQUIRED';
export type FulfillmentState = 'ON_HOLD' | 'RELEASED';
export type VerificationOutcome = 'PROCESSING' | 'MATCHED' | 'AWAITING_BANK' | 'NEEDS_REVIEW' | 'INVALID_EVIDENCE' | 'ERROR';

export const demoLoginSchema = z.object({ account_id: z.uuid() }).strict();
export const createOrderSchema = z.object({
  external_id: z.string().trim().min(1).max(100),
  customer_id: z.uuid().optional(),
  total_sen: z.number().int().positive().max(2147483647),
  currency: z.literal('MYR').default('MYR'),
}).strict();

export const receiptFieldsSchema = z.object({
  amount_sen: z.number().int().positive().max(2147483647).nullable(),
  currency: z.literal('MYR'),
  bank_transaction_ref: z.string().trim().min(1).max(100).nullable(),
  customer_reference: z.string().max(100).nullable(),
  recipient_account: z.string().trim().min(1).max(100).nullable(),
  occurred_at: z.iso.datetime({ offset: true }).nullable(),
  status: z.enum(['SUCCESS','PENDING','SCHEDULED','FAILED','UNKNOWN']),
  document_type: z.enum(['TRANSFER_RECEIPT','MONEY_REQUEST','OTHER','UNKNOWN']),
}).strict();
export type ReceiptFields = z.infer<typeof receiptFieldsSchema>;
export const versionSchema = z.number().int().positive();
export const receiptIntakeSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('FIXTURE'), fixture_id: z.string().max(100), expected_version: versionSchema }).strict(),
  z.object({ source: z.literal('MANUAL'), fields: receiptFieldsSchema, expected_version: versionSchema }).strict(),
]);
export const bankEventSchema = z.object({
  account_id: z.uuid(), provider_tx_id: z.string().trim().min(1).max(100),
  bank_transaction_ref: z.string().trim().min(1).max(100), customer_reference: z.string().max(100).nullable().default(null),
  amount_sen: z.number().int().positive().max(2147483647), currency: z.literal('MYR').default('MYR'),
  direction: z.enum(['CREDIT','DEBIT']).default('CREDIT'), status: z.enum(['BOOKED','PENDING','REVERSED']).default('BOOKED'),
  booked_at: z.iso.datetime({ offset: true }), expected_account_version: versionSchema,
}).strict();

export const intakeChannelSchema=z.enum(['DASHBOARD','TELEGRAM','GOOGLE_FORM']);
export type IntakeChannel=z.infer<typeof intakeChannelSchema>;
export const intakeLinkSchema=z.object({expected_version:versionSchema,channel:z.enum(['TELEGRAM','GOOGLE_FORM'])}).strict();
export const googleFormIntakeSchema=z.object({response_id:z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),submission_token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),mime_type:z.enum(['image/png','image/jpeg','image/webp']),image_base64:z.string().min(4).max(13981016)}).strict();
export type IntakeResult={status:'ACCEPTED'|'REJECTED';reason:string|null;replayed:boolean};
// Telegram alone ignores unsupported/unauthorized updates after authenticating its webhook secret.
// The Google Form response contract remains IntakeResult.
export type TelegramIntakeResult=IntakeResult|{status:'IGNORED'};
