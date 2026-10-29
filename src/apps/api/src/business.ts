import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { createOrderSchema, demoLoginSchema } from '../../../packages/contracts/src/index.js';
import { verificationRouter } from './modules/verification/router.js';
import type {Config} from './config.js';
import type {ReceiptStorage} from './modules/receipts/storage.js';
import {resetDemoTenant} from './database-setup.js';
import {projectRoot} from './paths.js';
import {tenantPolicy} from './modules/verification/policy.js';

export type Actor = { id: string; tenant_id: string; role: 'OWNER' | 'CASHIER' | 'SYSTEM'; display_name: string };
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const orderColumns = 'id, external_id, customer_id, total_sen, currency, payment_state, fulfillment_state, version, created_at';
const pagination = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict();
const activityQuery=pagination.extend({order_id:z.uuid().optional(),after_seq:z.string().regex(/^\d{1,18}$/).optional()}).superRefine((v,c)=>{if(v.after_seq!==undefined&&v.offset!==0)c.addIssue({code:'custom',message:'after_seq and offset are mutually exclusive'});});

export function businessRouter(pool: pg.Pool,config:Config,storage:ReceiptStorage) {
  const router = Router();
  // Single-instance demo limit. req.ip uses Express's default untrusted-proxy policy.
  const attempts = new Map<string, { count: number; until: number }>();
  let cleanupAfter = 0;
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.locals.correlationId = randomUUID(); next(); });
  // Demo account selection is intentionally public and only lists seeded synthetic tenants.
  router.get('/demo/accounts', async (_req, res) => {
    const result = await pool.query("SELECT u.id, u.display_name, u.role, t.name AS tenant_name FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE t.is_demo AND u.active AND u.role IN ($role$OWNER$role$,$role$CASHIER$role$) ORDER BY u.id");
    res.json({ accounts: result.rows });
  });
  router.post('/demo/sessions', async (req, res) => {
    const now = Date.now();
    for (const [ip, bucket] of attempts) if (bucket.until <= now) attempts.delete(ip);
    const ip = req.ip ?? 'unknown';
    const bucket = attempts.get(ip) ?? { count: 0, until: now + 60000 };
    if (bucket.count >= 60 || (!attempts.has(ip) && attempts.size >= 1000)) {
      res.set('Retry-After','60'); throw new ApiError(429,'RATE_LIMITED','Too many demo login attempts');
    }
    bucket.count++; attempts.set(ip,bucket);
    const { account_id } = demoLoginSchema.parse(req.body);
    const result = await pool.query('SELECT u.id, u.tenant_id, u.role, u.display_name FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=$1 AND u.active AND u.role IN ($role$OWNER$role$,$role$CASHIER$role$) AND t.is_demo', [account_id]);
    if (!result.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Demo account not found');
    const actor: Actor = result.rows[0];
    if (now >= cleanupAfter) {
      cleanupAfter = now + 60000;
      await pool.query('DELETE FROM demo_sessions WHERE token_hash IN (SELECT token_hash FROM demo_sessions WHERE expires_at<now() ORDER BY expires_at LIMIT 100)');
    }
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query('INSERT INTO demo_sessions(token_hash,tenant_id,user_id,expires_at) VALUES ($1,$2,$3,$4)', [hash(token), actor.tenant_id, actor.id, expires]);
    res.status(201).json({ token, expires_at: expires.toISOString(), actor });
  });
  router.use(async (req, res, next) => {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('Authorization') ?? '')?.[1];
    if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Choose a demo account first');
    const result = await pool.query('SELECT u.id,u.tenant_id,u.role,u.display_name FROM demo_sessions s JOIN users u ON u.id=s.user_id AND u.tenant_id=s.tenant_id JOIN tenants t ON t.id=u.tenant_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active AND u.role IN ($role$OWNER$role$,$role$CASHIER$role$) AND t.is_demo', [hash(token)]);
    if (!result.rowCount) throw new ApiError(401, 'UNAUTHENTICATED', 'Session is invalid or has expired');
    res.locals.actor = result.rows[0];
    res.locals.tokenHash = hash(token);
    next();
  });
  router.get('/session', (_req, res) => res.json({ actor: res.locals.actor }));
  router.get('/tenant/settings',async(_req,res)=>res.json({settings:await tenantPolicy(pool,res.locals.actor.tenant_id)}));
  router.delete('/session', async (_req, res) => {
    await pool.query('DELETE FROM demo_sessions WHERE token_hash=$1', [res.locals.tokenHash]);
    res.status(204).end();
  });
  router.get('/orders', async (req, res) => {
    const { limit, offset } = pagination.parse(req.query);
    const actor: Actor = res.locals.actor;
    const result = await pool.query(`SELECT ${orderColumns} FROM orders WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3`, [actor.tenant_id, limit, offset]);
    res.json({ orders: result.rows, limit, offset });
  });
  router.get('/orders/:id', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const result = await pool.query(`SELECT ${orderColumns} FROM orders WHERE tenant_id=$1 AND id=$2`, [res.locals.actor.tenant_id, id]);
    if (!result.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
    res.json({ order: result.rows[0] });
  });
  router.post('/orders', async (req, res) => {
    const actor: Actor = res.locals.actor;
    if (!['OWNER', 'CASHIER'].includes(actor.role)) throw new ApiError(403, 'FORBIDDEN', 'Not allowed to create orders');
    const body = createOrderSchema.parse(req.body);
    const key = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).parse(req.get('Idempotency-Key'));
    const requestHash = hash(JSON.stringify(body));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize the same actor/key, including requests on different API processes.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([actor.tenant_id, actor.id, '/orders', key])]);
      const prior = await client.query("SELECT request_hash,response FROM idempotency_keys WHERE tenant_id=$1 AND user_id=$2 AND route='/orders' AND key=$3", [actor.tenant_id, actor.id, key]);
      if (prior.rowCount) {
        if (prior.rows[0].request_hash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key reused with different input');
        await client.query('COMMIT');
        res.set('Idempotency-Replayed', 'true').status(200).json(prior.rows[0].response); return;
      }
      if (body.customer_id) {
        const customer = await client.query('SELECT id FROM customers WHERE tenant_id=$1 AND id=$2', [actor.tenant_id, body.customer_id]);
        if (!customer.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Customer not found');
      }
      const order = await client.query(`INSERT INTO orders(id,tenant_id,external_id,customer_id,total_sen,currency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${orderColumns}`, [randomUUID(), actor.tenant_id, body.external_id, body.customer_id ?? null, body.total_sen, body.currency]);
      const response = { order: order.rows[0] };
      await client.query('INSERT INTO activity_events(id,tenant_id,actor_id,action,entity_id,payload,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), actor.tenant_id, actor.id, 'order.created', response.order.id, JSON.stringify({ total_sen: body.total_sen, version: 1 }), res.locals.correlationId]);
      await client.query("INSERT INTO idempotency_keys(tenant_id,user_id,route,key,request_hash,response) VALUES ($1,$2,'/orders',$3,$4,$5)", [actor.tenant_id, actor.id, key, requestHash, JSON.stringify(response)]);
      await client.query('COMMIT');
      res.status(201).json(response);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });
  router.get('/activity', async (req, res) => {
    const {limit,offset,order_id,after_seq}=activityQuery.parse(req.query);
    const tenant=res.locals.actor.tenant_id;
    if(order_id&&!(await pool.query('SELECT id FROM orders WHERE tenant_id=$1 AND id=$2',[tenant,order_id])).rowCount)throw new ApiError(404,'NOT_FOUND','Order not found');
    const result = await pool.query(`SELECT e.id,e.actor_id,u.display_name AS actor_name,e.action,e.order_id,o.external_id,e.entity_type,e.entity_id,e.seq,e.payload,e.correlation_id,e.created_at FROM activity_events e JOIN users u ON u.tenant_id=e.tenant_id AND u.id=e.actor_id LEFT JOIN orders o ON o.tenant_id=e.tenant_id AND o.id=e.order_id WHERE e.tenant_id=$1 AND ($4::uuid IS NULL OR e.order_id=$4 OR (e.entity_type='order' AND e.entity_id=$4)) AND ($5::bigint IS NULL OR e.seq>$5) ORDER BY e.seq ${after_seq===undefined?'DESC':'ASC'} LIMIT $2 OFFSET $3`, [tenant,limit,offset,order_id??null,after_seq??null]);
    res.json({events:result.rows,limit,offset,...(after_seq!==undefined?{last_seq:result.rows.at(-1)?.seq??after_seq}:{})});
  });
  // Owner-only demo reset: the shop's synthetic orders, receipts and activity return to the seeded starting point.
  router.post('/demo/reset', async (_req, res) => {
    const actor: Actor = res.locals.actor;
    if (actor.role !== 'OWNER') throw new ApiError(403, 'FORBIDDEN', 'Only the Owner can reset demo data');
    res.json(await resetDemoTenant(pool, actor.tenant_id, projectRoot));
  });
  router.use(verificationRouter(pool,config,storage));
  return router;
}

export function apiErrorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  let status = 500, code = 'INTERNAL_ERROR', message = 'The service cannot process this request right now';
  if (error instanceof ApiError) { ({ status, code, message } = error); }
  else if (error instanceof z.ZodError || (error as { type?: string })?.type === 'entity.parse.failed') { status = 422; code = 'INVALID_INPUT'; message = 'Invalid request format or fields'; }
  else if ((error as { code?: string })?.code === '23505') {
    status = 409;
    const constraint = (error as { constraint?: string }).constraint;
    code = constraint === 'allocation_transaction_unique' ? 'TRANSACTION_ALREADY_USED' : constraint === 'bank_provider_unique' ? 'DUPLICATE_BANK_EVENT' : 'CONFLICT';
    message = 'Record already exists';
  }
  else if ((error as { code?: string })?.code === '55P03') { status = 409; code = 'RETRY_CONFLICT'; message = 'Concurrent update; retry with the same key'; }
  else if ((error as { type?: string })?.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body is too large'; }
  else if (['ECONNREFUSED', 'ETIMEDOUT', '57P01', '42P01'].includes((error as { code?: string })?.code ?? '')) { status = 503; code = 'DATABASE_UNAVAILABLE'; message = 'Database is not ready'; }
  res.status(status).json({ code, message, correlation_id: res.locals.correlationId ?? randomUUID() });
}
