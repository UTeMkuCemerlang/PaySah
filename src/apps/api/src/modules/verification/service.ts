import {randomUUID} from 'node:crypto';
import {tenantPolicy} from './policy.js';
import type pg from 'pg';
import {receiptFieldsSchema} from '../../../../../packages/contracts/src/index.js';
import {ApiError,type Actor} from '../../business.js';
import {fingerprint} from './fixtures.js';
import {verify,RULE_VERSION,type BankRow} from './rules.js';
import {imageHash,type ReceiptStorage} from '../receipts/storage.js';
export type Context = { db: pg.PoolClient; actor: Actor; correlation: string; storage?:ReceiptStorage; afterRollback?:Array<()=>Promise<void>> };
export async function event(c: Context, action: string, type: string, id: string, orderId: string | null, payload: unknown) {
  await c.db.query('INSERT INTO activity_events(id,tenant_id,actor_id,action,entity_type,entity_id,order_id,payload,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(), c.actor.tenant_id, c.actor.id, action, type, id, orderId, JSON.stringify(payload), c.correlation]);
}
export const payable=(state:string)=>state==='UNPAID'||state==='PARTIALLY_PAID';
export async function supersede(c: Context, orderId: string) {
  await c.db.query('UPDATE verifications SET active=false WHERE tenant_id=$1 AND order_id=$2', [c.actor.tenant_id, orderId]);
  const changed = await c.db.query("UPDATE approvals SET status='SUPERSEDED',version=version+1 WHERE tenant_id=$1 AND order_id=$2 AND status='PENDING' RETURNING id", [c.actor.tenant_id, orderId]);
  for (const row of changed.rows) await event(c, 'approval.superseded', 'approval', row.id, orderId, {});
}
export async function evaluate(c: Context, order: { id: string; total_sen: number }, receipt: { id: string; fields: unknown; content_fingerprint: string; source: string; revision: number; image_sha256?:string; storage_key?:string; storage_state?:string; fields_provider?:string; extraction_state?:string }) {
  if(receipt.source==='IMAGE'){
    if(receipt.storage_state!=='READY'||!c.storage||!receipt.storage_key)throw new ApiError(503,'IMAGE_UNAVAILABLE','Receipt image unavailable');
    let bytes;try{bytes=await c.storage.read(receipt.storage_key);}catch{throw new ApiError(503,'IMAGE_UNAVAILABLE','Receipt image unavailable');}
    if(imageHash(bytes)!==receipt.image_sha256)throw new ApiError(503,'IMAGE_UNAVAILABLE','Receipt image integrity check failed');
    if(['PENDING','RUNNING','ERROR'].includes(receipt.extraction_state??''))(()=>{throw new ApiError(409,'EXTRACTION_NOT_READY','Wait for extraction or correct the fields')})();
  }
  const accounts = (await c.db.query('SELECT id,account_identifier,active,version FROM merchant_accounts WHERE tenant_id=$1 ORDER BY id', [c.actor.tenant_id])).rows;
  const transactions: BankRow[] = (await c.db.query(`SELECT t.*,a.account_identifier,a.active,a.version,EXISTS(SELECT 1 FROM payment_allocations p WHERE p.tenant_id=t.tenant_id AND p.bank_transaction_id=t.id) AS allocated
    FROM bank_transactions t JOIN merchant_accounts a ON a.id=t.account_id AND a.tenant_id=t.tenant_id WHERE t.tenant_id=$1 ORDER BY t.id`, [c.actor.tenant_id])).rows;
  const fields = receiptFieldsSchema.parse(receipt.fields);
  const duplicate = await c.db.query("SELECT content_fingerprint,fields,image_sha256 FROM receipts WHERE tenant_id=$1 AND order_id<>$2 ORDER BY id", [c.actor.tenant_id, order.id]);
  const corrected = await c.db.query('SELECT 1 FROM receipt_corrections WHERE tenant_id=$1 AND receipt_id=$2 LIMIT 1', [c.actor.tenant_id, receipt.id]);
  // GPU fields count as confirmed only when the same-revision CPU reading reproduced every compared field.
  const modelUnsure = receipt.fields_provider==='RUNPOD_VLM' && (await c.db.query("SELECT 1 FROM extraction_runs WHERE tenant_id=$1 AND receipt_id=$2 AND revision=$3 AND provider='RUNPOD_VLM' AND jsonb_array_length(COALESCE(field_candidates->'uncertain_fields','[]'::jsonb))>0 LIMIT 1", [c.actor.tenant_id, receipt.id, receipt.revision])).rowCount! > 0;
  const unconfirmed = receipt.fields_provider==='RUNPOD_VLM' && (await c.db.query("SELECT 1 FROM extraction_runs WHERE tenant_id=$1 AND receipt_id=$2 AND revision=$3 AND provider='RUNPOD_VLM' AND jsonb_array_length(COALESCE(field_candidates->'disagreements','[\"missing\"]'::jsonb))>0 LIMIT 1", [c.actor.tenant_id, receipt.id, receipt.revision])).rowCount! > 0;
  const policy=await tenantPolicy(c.db,c.actor.tenant_id);
  const paid_sen=(await c.db.query('SELECT COALESCE(sum(amount_sen),0)::int AS n FROM payment_allocations WHERE tenant_id=$1 AND order_id=$2',[c.actor.tenant_id,order.id])).rows[0].n as number;
  const result = verify({ total_sen: order.total_sen, paid_sen, fields, accounts: accounts.filter(a => a.active).map(a => a.account_identifier), transactions,owner_review_threshold_sen:policy.owner_review_threshold_sen,policy_version:policy.policy_version,
    duplicate_evidence: duplicate.rows.some(r => r.content_fingerprint === receipt.content_fingerprint),
    duplicate_image: !!receipt.image_sha256&&duplicate.rows.some(r=>r.image_sha256===receipt.image_sha256),
    duplicate_reference: !!fields.bank_transaction_ref && duplicate.rows.some(r => r.fields.bank_transaction_ref === fields.bank_transaction_ref && r.fields.recipient_account === fields.recipient_account),
    manual: receipt.source === 'MANUAL' || receipt.fields_provider==='MANUAL' || !!corrected.rowCount, model_unconfirmed: unconfirmed, model_unsure: modelUnsure });
  return { result, evidence_hash: fingerprint({ accounts, transactions, duplicate: duplicate.rows, fields, revision: receipt.revision }) };
}


export async function enqueueVerification(c:Context,receipt:{id:string;order_id:string;revision:number}){
 await c.db.query('INSERT INTO verification_jobs(id,tenant_id,order_id,receipt_id,expected_revision) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,receipt_id,expected_revision) DO NOTHING',[randomUUID(),c.actor.tenant_id,receipt.order_id,receipt.id,receipt.revision]);
}
export async function verifyReceipt(c:Context,input:{orderId:string;receiptId:string;expectedVersion:number;expectedRevision?:number}){
 const order=(await c.db.query('SELECT * FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[c.actor.tenant_id,input.orderId])).rows[0];
 if(!order)throw new ApiError(404,'NOT_FOUND','Order not found');
 if(order.version!==input.expectedVersion)throw new ApiError(409,'STALE_VERSION','Order changed');
 if(!payable(order.payment_state))throw new ApiError(409,'PAYMENT_STATE_CONFLICT','Order is not awaiting payment');
 const receipt=(await c.db.query('SELECT * FROM receipts WHERE tenant_id=$1 AND order_id=$2 AND id=$3',[c.actor.tenant_id,order.id,input.receiptId])).rows[0];
 if(!receipt)throw new ApiError(404,'NOT_FOUND','Receipt not found');
 if(order.current_receipt_id!==receipt.id)throw new ApiError(409,'STALE_RECEIPT','Newer evidence exists');
 if(input.expectedRevision!==undefined&&input.expectedRevision!==receipt.revision)throw new ApiError(409,'STALE_REVISION','Receipt changed');
 const evaluated=await evaluate(c,order,receipt);
 const prior=(await c.db.query('SELECT * FROM verifications WHERE tenant_id=$1 AND order_id=$2 AND active ORDER BY created_at DESC LIMIT 1',[c.actor.tenant_id,order.id])).rows[0];
 if(prior&&prior.receipt_id===receipt.id&&prior.order_version===order.version&&prior.evidence_revision===receipt.revision&&prior.rule_version===RULE_VERSION&&prior.evidence_hash===evaluated.evidence_hash&&fingerprint(prior.result)===fingerprint(evaluated.result))return {verification:prior,reused:true};
 await supersede(c,order.id);
 const verification=(await c.db.query('INSERT INTO verifications(id,tenant_id,order_id,receipt_id,order_version,evidence_revision,rule_version,evidence_hash,result) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[randomUUID(),c.actor.tenant_id,order.id,receipt.id,order.version,receipt.revision,RULE_VERSION,evaluated.evidence_hash,JSON.stringify(evaluated.result)])).rows[0];
 await event(c,'verification.completed','verification',verification.id,order.id,evaluated.result);return {verification};
}
