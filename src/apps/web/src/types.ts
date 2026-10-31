import type {Health,ReceiptFields,PaymentState,FulfillmentState,VerificationOutcome} from '../../../packages/contracts/src/index.js';
export type {Health,ReceiptFields};
export interface Account {id:string;display_name:string;role:'OWNER'|'CASHIER';tenant_name:string}
export interface Actor {id:string;display_name:string;role:'OWNER'|'CASHIER';tenant_id:string}
export interface Session {token:string;actor:Actor}
export interface Order {id:string;external_id:string;total_sen:number;currency:'MYR';payment_state:PaymentState;fulfillment_state:FulfillmentState;version:number;created_at:string}
export interface Receipt {id:string;fixture_id?:string|null;order_id:string;source:'IMAGE'|'FIXTURE'|'MANUAL';fields:ReceiptFields;revision:number;fields_provider:'FIXTURE'|'MANUAL'|'CPU_OCR'|'RUNPOD_VLM';extraction_state:'PENDING'|'RUNNING'|'COMPLETED'|'NEEDS_REVIEW'|'ERROR';image_sha256:string|null;created_at:string;intake_channel:'DASHBOARD'|'TELEGRAM'|'GOOGLE_FORM'}
export interface RuleResult {outcome:VerificationOutcome;flags:string[];candidates:string[];matched_transaction_id:string|null;eligible:boolean;required_role:'OWNER'|'CASHIER';partial_eligible?:boolean;partial_amount_sen?:number|null;due_sen?:number;evidence_source:'SYNTHETIC_FEED';policy_version:number}
export interface ShopSettings {business_type:'BAKERY'|'LAUNDRY'|'GENERAL';owner_review_threshold_sen:number;release_owner_threshold_sen:number;policy_version:number}
export interface Verification {id:string;receipt_id:string;order_version:number;evidence_revision:number;active:boolean;result:RuleResult}
export interface Approval {id:string;order_id:string;verification_id:string;status:'PENDING'|'APPROVED'|'REJECTED'|'SUPERSEDED';version:number;reason:string|null;created_at:string;external_id?:string;total_sen?:number;result?:RuleResult}
export interface BankTransaction {id:string;account_identifier:string;bank_transaction_ref:string;amount_sen:number;direction:string;status:string;booked_at:string;source_kind:string}
export interface ActivityEvent {id:string;action:string;actor_name:string;order_id?:string;external_id?:string;created_at:string;payload:Record<string,unknown>;seq:string}
export interface Review {order:Order;receipts:Receipt[];verification:Verification|null;approvals:Approval[];allocations:Array<{bank_transaction_id:string;amount_sen:number}>;bank_transactions:BankTransaction[];events:ActivityEvent[];settings:ShopSettings}
export interface Extraction {id:string;provider:string;raw_text:string;status:string;missing_fields:string[];duration_ms:number;revision:number;fallback_reason?:string|null;field_candidates?:{uncertain_fields?:string[];third_reading?:{status:'OK';model:string;fields:Record<string,{gpu:unknown;cpu:unknown;third:unknown;supports:'GPU'|'CPU'|'NEITHER'}>}|{status:'UNAVAILABLE';reason:string}}|null}
