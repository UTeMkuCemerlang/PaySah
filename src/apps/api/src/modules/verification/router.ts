import {installIntakeLinks} from '../intake/links.js';
import {auditDenied} from './denied.js';
import {replyDraft} from './reply-draft.js';
import {tenantPolicy} from './policy.js';
import {createPaymentLink} from '../intake/mock-payment.js';
import {event,supersede,evaluate,verifyReceipt,type Context} from './service.js';
export {event,supersede} from './service.js';
import {payable} from './service.js';
import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { bankEventSchema, receiptFieldsSchema, receiptIntakeSchema, versionSchema,receiptFixtureLabels } from '../../../../../packages/contracts/src/index.js';
import { ApiError, type Actor } from '../../business.js';
import { fixtures, fingerprint } from './fixtures.js';
import { verify, RULE_VERSION, type BankRow } from './rules.js';
import type {Config} from '../../config.js';
import {installImageRoutes,publicReceipt} from '../receipts/router.js';
import {imageHash,type ReceiptStorage} from '../receipts/storage.js';
import {orderReview} from './review.js';

const versionBody = z.object({ expected_version: versionSchema }).strict();
const shortfallBody = z.object({ expected_version: versionSchema, reason: z.string().trim().min(3).max(500) }).strict();
const policyBody = z.object({ owner_review_threshold_sen: z.number().int().min(0).max(100000000), expected_policy_version: versionSchema, reason: z.string().trim().min(3).max(500) }).strict();
const verificationBody = z.object({ receipt_id: z.uuid(), expected_version: versionSchema }).strict();
const correctionBody = z.object({ expected_revision: versionSchema, expected_version: versionSchema, fields: receiptFieldsSchema, reason: z.string().trim().min(3).max(500) }).strict();
const decisionBody = z.object({ decision: z.enum(['APPROVE','REJECT']), reason: z.string().trim().min(3).max(500), expected_version: versionSchema }).strict();
const page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict();
export type {Context} from './service.js';
export type Write = (schema:z.ZodType,handler:(c:Context,body:any,req:Request)=>Promise<unknown>,status?:number,present?:(body:any)=>unknown)=>(req:Request,res:Response)=>Promise<void>;
const fail = (code: string, message: string): never => { throw new ApiError(409, code, message); };
const owner = (actor: Actor) => { if (actor.role !== 'OWNER') throw new ApiError(403, 'FORBIDDEN', 'Owner approval required'); };
const one = async (db: pg.PoolClient | pg.Pool, sql: string, args: unknown[]) => {
  const result = await db.query(sql, args);
  if (!result.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Resource not found');
  return result.rows[0];
};
const lockOrder = (c: Context, id: string) => one(c.db, 'SELECT * FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [c.actor.tenant_id, id]);
function checkVersion(order: { version: number }, version: number) { if (order.version !== version) fail('STALE_VERSION', 'Order changed; reload and verify again'); }
function unpaid(order: { payment_state: string }) { if (!payable(order.payment_state)) fail('PAYMENT_STATE_CONFLICT', 'This order is not awaiting payment'); }
export function verificationRouter(pool: pg.Pool,config:Config,storage:ReceiptStorage) {
  const router = Router();
  // One transaction-scoped tenant lock orders all M2 mutations across API instances.
  // This conservative demo design also prevents feed/intake/approval races.
  function write(schema: z.ZodType, handler: (c: Context, body: any, req: Request) => Promise<unknown>, status = 200,present?:(body:any)=>unknown) {
    return async (req: Request, res: Response) => {
      const body = schema.parse(req.body);
      const key = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).parse(req.get('Idempotency-Key'));
      const actor: Actor = res.locals.actor;
      const route = `${req.method}:${req.path}`;
      const requestHash = fingerprint(body);
      const db = await pool.connect();
      const afterRollback:Array<()=>Promise<void>>=[];
      let committing=false;
      try {
        await db.query('BEGIN');
        await db.query("SET LOCAL lock_timeout='5s'");
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`m2:${actor.tenant_id}`]);
        const currentActor = await one(db, 'SELECT id,tenant_id,role,display_name FROM users WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE', [actor.tenant_id, actor.id]);
        if (!['OWNER','CASHIER'].includes(currentActor.role)||currentActor.role !== actor.role) throw new ApiError(403, 'FORBIDDEN', 'Role changed; sign in again');
        const prior = await db.query('SELECT request_hash,response FROM idempotency_keys WHERE tenant_id=$1 AND user_id=$2 AND route=$3 AND key=$4', [actor.tenant_id, actor.id, route, key]);
        if (prior.rowCount) {
          if (prior.rows[0].request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT', 'Idempotency key reused with different input');
          await db.query('COMMIT'); res.set('Idempotency-Replayed', 'true').json(present?present(prior.rows[0].response):prior.rows[0].response); return;
        }
        const response = await handler({ db, actor, correlation: res.locals.correlationId,storage,afterRollback }, body, req);
        await db.query('INSERT INTO idempotency_keys(tenant_id,user_id,route,key,request_hash,response) VALUES ($1,$2,$3,$4,$5,$6)', [actor.tenant_id, actor.id, route, key, requestHash, JSON.stringify(response)]);
        committing=true;await db.query('COMMIT'); res.status(status).json(present?present(response):response);
      } catch (e) {
        try{await db.query('ROLLBACK');}finally{
          // A COMMIT network error has an unknown outcome. Preserve the object;
          // the orphan reconciler can inspect database references later.
          if(!committing)for(const cleanup of afterRollback)try{await cleanup();}catch{console.error('Receipt object cleanup pending');}
        }
        await auditDenied(db,actor,req.path,e,res.locals.correlationId);
        throw e;
      } finally { db.release(); }
    };
  }
  installImageRoutes(router,pool,write,config,storage);
  installIntakeLinks(router,pool,write,config);
  router.get('/orders/:id/review',async(req,res)=>res.json(await orderReview(pool,res.locals.actor.tenant_id,z.uuid().parse(req.params.id))));
  router.get('/demo/receipt-fixtures', (_req, res) => res.json({ source: 'FIXTURE', fixtures: Object.entries(fixtures).map(([id, fields]) => ({ id,label:receiptFixtureLabels[id]??`Synthetic receipt · RM ${((fields.amount_sen??0)/100).toFixed(2)}`,amount_sen:fields.amount_sen,fields })), note: 'Predefined synthetic fields; no OCR or uploaded image.' }));
  router.get('/bank-accounts', async (_req, res) => {
    const result = await pool.query('SELECT id,account_identifier,active,version FROM merchant_accounts WHERE tenant_id=$1 ORDER BY id', [res.locals.actor.tenant_id]);
    res.json({ accounts: result.rows });
  });
  router.get('/bank-transactions', async (req, res) => {
    const { limit, offset } = page.parse(req.query);
    const result = await pool.query('SELECT id,account_id,bank_transaction_ref,customer_reference,amount_sen,currency,direction,status,booked_at,source_kind FROM bank_transactions WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3', [res.locals.actor.tenant_id, limit, offset]);
    res.json({ transactions: result.rows, limit, offset });
  });
  router.post('/demo/bank-events', write(bankEventSchema, async (c, b) => {
    owner(c.actor);
    const account = await one(c.db, 'SELECT * FROM merchant_accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [c.actor.tenant_id, b.account_id]);
    if (!account.active || account.version !== b.expected_account_version) fail('STALE_ACCOUNT', 'Account changed');
    const id = randomUUID();
    await c.db.query(`INSERT INTO bank_transactions(id,tenant_id,account_id,provider_tx_id,bank_transaction_ref,customer_reference,amount_sen,currency,direction,status,booked_at,source_kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'SYNTHETIC_FEED')`, [id,c.actor.tenant_id,b.account_id,b.provider_tx_id,b.bank_transaction_ref,b.customer_reference,b.amount_sen,b.currency,b.direction,b.status,b.booked_at]);
    await event(c, 'bank_transaction.created', 'bank_transaction', id, null, { source: 'SYNTHETIC_FEED' });
    return { transaction_id: id, source: 'SYNTHETIC_FEED' };
  }, 201));
  router.post('/orders/:id/receipts', write(receiptIntakeSchema, async (c, b, req) => {
    const order = await lockOrder(c, z.uuid().parse(req.params.id)); checkVersion(order, b.expected_version); unpaid(order);
    let fields;
    if (b.source === 'FIXTURE') { if (!Object.hasOwn(fixtures,b.fixture_id)) throw new ApiError(404, 'NOT_FOUND', 'Fixture not found'); fields = fixtures[b.fixture_id]; }
    else fields = b.fields;
    const digest = fingerprint({ source: b.source, fields });
    const prior = await c.db.query('SELECT id,revision FROM receipts WHERE tenant_id=$1 AND order_id=$2 AND content_fingerprint=$3', [c.actor.tenant_id,order.id,digest]);
    if (prior.rowCount) return { receipt: prior.rows[0], source: b.source, reused: true };
    await supersede(c, order.id);
    const receipt = await c.db.query('INSERT INTO receipts(id,tenant_id,order_id,content_fingerprint,source,fixture_id,fields,fields_provider) VALUES ($1,$2,$3,$4,$5,$6,$7,$5) RETURNING *', [randomUUID(),c.actor.tenant_id,order.id,digest,b.source,b.fixture_id ?? null,JSON.stringify(fields)]);
    await event(c, 'receipt.created', 'receipt', receipt.rows[0].id, order.id, { source: b.source, revision: 1, fingerprint_kind: 'STRUCTURED_FIELDS' });
    await c.db.query('UPDATE orders SET current_receipt_id=$3 WHERE tenant_id=$1 AND id=$2',[c.actor.tenant_id,order.id,receipt.rows[0].id]);
    return { receipt: receipt.rows[0], fingerprint_kind: 'STRUCTURED_FIELDS' };
  }, 201));
  router.get('/orders/:id/receipts', async (req, res) => {
    const orderId = z.uuid().parse(req.params.id);
    await one(pool, 'SELECT id FROM orders WHERE tenant_id=$1 AND id=$2', [res.locals.actor.tenant_id,orderId]);
    res.json({ receipts: (await pool.query('SELECT * FROM receipts WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at,id', [res.locals.actor.tenant_id,orderId])).rows.map(publicReceipt) });
  });
  // Asks the payment simulator for a customer link. Bank evidence arrives later through the signed webhook.
  router.post('/orders/:id/payment-links', write(versionBody, async (c, b, req) => {
    const order = await lockOrder(c, z.uuid().parse(req.params.id)); checkVersion(order,b.expected_version); unpaid(order);
    return await createPaymentLink(c,config,order);
  },201));
  // Owner sets the shop's review limit. A new policy version makes earlier checks and pending approvals stale; existing payments stay paid.
  router.post('/tenant/settings', write(policyBody, async (c, b) => {
    owner(c.actor);
    if(!(await c.db.query("SELECT 1 FROM schema_migrations WHERE name='007_policy_audit.sql'")).rowCount)throw new ApiError(503,'POLICY_CHANGE_UNAVAILABLE','Shop settings cannot be changed until the database is updated');
    const before=await tenantPolicy(c.db,c.actor.tenant_id);
    if(before.policy_version!==b.expected_policy_version)fail('STALE_POLICY','Shop settings changed. Reload and try again');
    const row=(await c.db.query('UPDATE tenant_settings SET owner_review_threshold_sen=$2,policy_version=policy_version+1 WHERE tenant_id=$1 RETURNING business_type,owner_review_threshold_sen,release_owner_threshold_sen,policy_version',[c.actor.tenant_id,b.owner_review_threshold_sen])).rows[0];
    await event(c,'policy.changed','tenant_settings',c.actor.tenant_id,null,{before_sen:before.owner_review_threshold_sen,after_sen:row.owner_review_threshold_sen,policy_version:row.policy_version,reason:b.reason});
    return {settings:row};
  }));
  // Staff retry after a failed read. Guarded by state and version, so repeats cannot queue a second job.
  router.post('/receipts/:id/retry-reading', write(versionBody, async (c, b, req) => {
    const receipt = await one(c.db, 'SELECT * FROM receipts WHERE tenant_id=$1 AND id=$2', [c.actor.tenant_id,z.uuid().parse(req.params.id)]);
    const order = await lockOrder(c, receipt.order_id); checkVersion(order,b.expected_version); unpaid(order);
    if(order.current_receipt_id!==receipt.id)fail('STALE_RECEIPT','Newer evidence exists');
    if(receipt.extraction_state!=='ERROR')fail('NOT_RETRYABLE','Only a failed reading can be tried again');
    const job=await c.db.query("UPDATE receipt_jobs SET status='PENDING',attempts=0,expected_revision=$3,last_error=NULL,lease_token=NULL,lease_until=NULL WHERE tenant_id=$1 AND receipt_id=$2",[c.actor.tenant_id,receipt.id,receipt.revision]);
    if(!job.rowCount)fail('NOT_RETRYABLE','This receipt has no image to read');
    const row=(await c.db.query("UPDATE receipts SET extraction_state='PENDING' WHERE tenant_id=$1 AND id=$2 RETURNING *",[c.actor.tenant_id,receipt.id])).rows[0];
    await event(c,'receipt.retry_requested','receipt',receipt.id,order.id,{revision:receipt.revision});
    return {receipt:publicReceipt(row)};
  }));
  router.post('/receipts/:id/corrections', write(correctionBody, async (c, b, req) => {
    const receipt = await one(c.db, 'SELECT * FROM receipts WHERE tenant_id=$1 AND id=$2', [c.actor.tenant_id,z.uuid().parse(req.params.id)]);
    const order = await lockOrder(c, receipt.order_id); checkVersion(order,b.expected_version); unpaid(order);
    if(order.current_receipt_id!==receipt.id)fail('STALE_RECEIPT','Newer evidence exists');
    if (receipt.revision !== b.expected_revision) fail('STALE_REVISION', 'Receipt changed');
    await c.db.query('INSERT INTO receipt_corrections(id,tenant_id,receipt_id,actor_id,previous_revision,new_revision,before_fields,after_fields,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(),c.actor.tenant_id,receipt.id,c.actor.id,receipt.revision,receipt.revision+1,JSON.stringify(receipt.fields),JSON.stringify(b.fields),b.reason]);
    await c.db.query("UPDATE receipts SET fields=$3,revision=revision+1,fields_provider='MANUAL',extraction_state='COMPLETED' WHERE tenant_id=$1 AND id=$2", [c.actor.tenant_id,receipt.id,JSON.stringify(b.fields)]);
    await c.db.query("UPDATE receipt_jobs SET status='CANCELLED',lease_token=NULL,lease_until=NULL WHERE tenant_id=$1 AND receipt_id=$2 AND status IN ('PENDING','RUNNING')",[c.actor.tenant_id,receipt.id]);
    await supersede(c, order.id);
    await event(c,'receipt.corrected','receipt',receipt.id,order.id,{ before:receipt.fields,after:b.fields,revision:receipt.revision+1,reason:b.reason });
    return { receipt_id: receipt.id, revision: receipt.revision+1, requires_reverification: true };
  }));
  router.post('/orders/:id/verifications', write(verificationBody, async (c,b,req) => {
    return verifyReceipt(c,{orderId:z.uuid().parse(req.params.id),receiptId:b.receipt_id,expectedVersion:b.expected_version});
  },201));
  router.get('/verifications/:id', async (req,res) => res.json({ verification: await one(pool,'SELECT * FROM verifications WHERE tenant_id=$1 AND id=$2',[res.locals.actor.tenant_id,z.uuid().parse(req.params.id)]) }));
  async function current(c: Context, id: string) {
    const v = await one(c.db,'SELECT * FROM verifications WHERE tenant_id=$1 AND id=$2',[c.actor.tenant_id,id]);
    const order = await lockOrder(c,v.order_id); unpaid(order);
    const receipt = await one(c.db,'SELECT * FROM receipts WHERE tenant_id=$1 AND id=$2',[c.actor.tenant_id,v.receipt_id]);
    if (!v.active || v.order_version!==order.version || v.evidence_revision!==receipt.revision || v.rule_version!==RULE_VERSION) fail('STALE_APPROVAL','Evidence changed; verify again');
    const evaluated = await evaluate(c,order,receipt);
    if (evaluated.evidence_hash!==v.evidence_hash || fingerprint(evaluated.result)!==fingerprint(v.result)) fail('STALE_APPROVAL','Bank or receipt evidence changed; verify again');
    return { v, order, result:evaluated.result };
  }
  async function pay(c: Context, state: Awaited<ReturnType<typeof current>>) {
    const {v,order,result}=state;
    if (!result.eligible) fail('EVIDENCE_BLOCKED','Evidence cannot establish full payment');
    if (result.required_role==='OWNER') owner(c.actor);
    await c.db.query('INSERT INTO payment_allocations(id,tenant_id,order_id,bank_transaction_id,verification_id,amount_sen) VALUES ($1,$2,$3,$4,$5,$6)',[randomUUID(),c.actor.tenant_id,order.id,result.matched_transaction_id,v.id,result.due_sen]);
    const paid = (await c.db.query("UPDATE orders SET payment_state='PAID',version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING *",[c.actor.tenant_id,order.id])).rows[0];
    await event(c,'payment.confirmed','order',order.id,order.id,{ before:order.payment_state,after:'PAID',verification_id:v.id,source:'SYNTHETIC_FEED',version:paid.version });
    await supersede(c,order.id);
    return { order:paid };
  }
  router.post('/verifications/:id/confirm',write(versionBody,async(c,b,req)=>{
    const state=await current(c,z.uuid().parse(req.params.id));checkVersion(state.order,b.expected_version);
    // Blocked evidence is reported as blocked first. The Owner uses accept-shortfall to approve it anyway.
    if (!state.result.eligible) fail('EVIDENCE_BLOCKED','Evidence cannot establish full payment');
    if (state.result.required_role==='OWNER'&&c.actor.role!=='OWNER') throw new ApiError(403,'OWNER_APPROVAL_REQUIRED','Only the Owner can confirm this payment');
    return pay(c,state);
  }));
  // Owner keeps a short but real bank credit on the order. The balance stays due and the order stays on hold.
  router.post('/verifications/:id/record-partial',write(versionBody,async(c,b,req)=>{
    owner(c.actor);
    if(!(await c.db.query("SELECT 1 FROM schema_migrations WHERE name='008_partial_payments.sql'")).rowCount)throw new ApiError(503,'PART_PAYMENT_UNAVAILABLE','Part payments are unavailable until the database is updated');
    const state=await current(c,z.uuid().parse(req.params.id));checkVersion(state.order,b.expected_version);
    if(!state.result.partial_eligible)fail('EVIDENCE_BLOCKED','Only a real, unused bank credit can be recorded as part payment');
    await c.db.query('INSERT INTO payment_allocations(id,tenant_id,order_id,bank_transaction_id,verification_id,amount_sen) VALUES ($1,$2,$3,$4,$5,$6)',[randomUUID(),c.actor.tenant_id,state.order.id,state.result.partial_transaction_id,state.v.id,state.result.partial_amount_sen]);
    const updated=(await c.db.query("UPDATE orders SET payment_state='PARTIALLY_PAID',version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING *",[c.actor.tenant_id,state.order.id])).rows[0];
    await event(c,'payment.partial_recorded','order',state.order.id,state.order.id,{before:state.order.payment_state,after:'PARTIALLY_PAID',amount_sen:state.result.partial_amount_sen,due_sen:state.result.due_sen-state.result.partial_amount_sen!,verification_id:state.v.id,source:'SYNTHETIC_FEED',version:updated.version});
    await supersede(c,state.order.id);
    return {order:updated};
  }));
  // Owner refuses a short payment. The order stays unpaid and open for new evidence; nothing is allocated.
  router.post('/verifications/:id/reject-short',write(shortfallBody,async(c,b,req)=>{
    owner(c.actor);
    const state=await current(c,z.uuid().parse(req.params.id));checkVersion(state.order,b.expected_version);
    if(!state.result.partial_eligible)fail('EVIDENCE_BLOCKED','Only a short payment can be rejected here');
    const approval=(await c.db.query("INSERT INTO approvals(id,tenant_id,order_id,verification_id,requested_by,decided_by,reason,status,decided_at) VALUES ($1,$2,$3,$4,$5,$5,$6,'REJECTED',now()) RETURNING id",[randomUUID(),c.actor.tenant_id,state.order.id,state.v.id,c.actor.id,b.reason])).rows[0];
    await event(c,'approval.decided','approval',approval.id,state.order.id,{decision:'REJECTED',reason:b.reason,short_payment:true});
    await supersede(c,state.order.id);
    return {approval_id:approval.id,status:'REJECTED'};
  }));
  // Highest permission: the Owner may approve any order on their own responsibility, with or without bank evidence.
  // A reason is required, the shortfall is logged, and the order is never shown as fully paid.
  router.post('/orders/:id/accept-shortfall',write(shortfallBody,async(c,b,req)=>{
    owner(c.actor);
    const order=await lockOrder(c,z.uuid().parse(req.params.id));checkVersion(order,b.expected_version);
    unpaid(order);
    const paid_sen=(await c.db.query('SELECT COALESCE(sum(amount_sen),0)::int AS n FROM payment_allocations WHERE tenant_id=$1 AND order_id=$2',[c.actor.tenant_id,order.id])).rows[0].n as number;
    const updated=(await c.db.query("UPDATE orders SET payment_state='MANUALLY_CONFIRMED',version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING *",[c.actor.tenant_id,order.id])).rows[0];
    await event(c,'payment.shortfall_accepted','order',order.id,order.id,{before:order.payment_state,after:'MANUALLY_CONFIRMED',paid_sen,total_sen:order.total_sen,shortfall_sen:order.total_sen-paid_sen,reason:b.reason,version:updated.version});
    await supersede(c,order.id);
    return {order:updated};
  }));
  router.post('/verifications/:id/approval-requests',write(versionBody,async(c,b,req)=>{
    const state=await current(c,z.uuid().parse(req.params.id));checkVersion(state.order,b.expected_version);
    const approval=(await c.db.query('INSERT INTO approvals(id,tenant_id,order_id,verification_id,requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),c.actor.tenant_id,state.order.id,state.v.id,c.actor.id])).rows[0];
    await event(c,'approval.requested','approval',approval.id,state.order.id,{ verification_id:state.v.id });
    return { approval };
  },201));
  router.get('/approvals',async(req,res)=>{
    owner(res.locals.actor);const {limit,offset}=page.parse(req.query);
    res.json({approvals:(await pool.query('SELECT a.*,o.external_id,o.total_sen,v.result FROM approvals a JOIN orders o ON o.tenant_id=a.tenant_id AND o.id=a.order_id JOIN verifications v ON v.tenant_id=a.tenant_id AND v.id=a.verification_id WHERE a.tenant_id=$1 ORDER BY a.created_at DESC,a.id LIMIT $2 OFFSET $3',[res.locals.actor.tenant_id,limit,offset])).rows,limit,offset});
  });
  router.post('/approvals/:id/decision',write(decisionBody,async(c,b,req)=>{
    const approval=await one(c.db,'SELECT * FROM approvals WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[c.actor.tenant_id,z.uuid().parse(req.params.id)]);
    owner(c.actor);
    if (approval.version!==b.expected_version || approval.status!=='PENDING') fail('STALE_APPROVAL','Approval changed');
    const state=await current(c,approval.verification_id);
    if (b.decision==='APPROVE' && !state.result.eligible) fail('EVIDENCE_BLOCKED','Owner approval cannot replace bank evidence');
    const status=b.decision==='APPROVE'?'APPROVED':'REJECTED';
    await c.db.query('UPDATE approvals SET status=$3,decided_by=$4,reason=$5,decided_at=now(),version=version+1 WHERE tenant_id=$1 AND id=$2',[c.actor.tenant_id,approval.id,status,c.actor.id,b.reason]);
    await event(c,'approval.decided','approval',approval.id,state.order.id,{ decision:status,reason:b.reason });
    if(b.decision==='APPROVE')return {...await pay(c,state),approval_id:approval.id,status};
    await supersede(c,state.order.id);
    return {approval_id:approval.id,status};
  }));
  router.post('/orders/:id/release',write(versionBody,async(c,b,req)=>{
    const order=await lockOrder(c,z.uuid().parse(req.params.id));checkVersion(order,b.expected_version);
    if(!['PAID','MANUALLY_CONFIRMED'].includes(order.payment_state)||order.fulfillment_state!=='ON_HOLD')fail('RELEASE_BLOCKED','Only confirmed orders on hold can be released');
    if(order.payment_state==='MANUALLY_CONFIRMED')owner(c.actor);
    if(order.total_sen>(await tenantPolicy(c.db,c.actor.tenant_id)).release_owner_threshold_sen)owner(c.actor);
    const updated=(await c.db.query("UPDATE orders SET fulfillment_state='RELEASED',version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING *",[c.actor.tenant_id,order.id])).rows[0];
    await event(c,'fulfillment.released','order',order.id,order.id,{ before:'ON_HOLD',after:'RELEASED',version:updated.version });
    return {order:updated};
  }));
  router.get('/orders/:id/reply-draft',async(req,res)=>{
    res.json(await replyDraft(pool,res.locals.actor,z.uuid().parse(req.params.id),storage));
  });
  return router;
}
