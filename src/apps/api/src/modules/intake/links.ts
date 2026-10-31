import {randomBytes,randomUUID} from 'node:crypto';
import {mockPaymentEnabled} from './mock-payment.js';
import {payable} from '../verification/service.js';
import type {Router} from 'express';
import type pg from 'pg';
import {z} from 'zod';
import type {Config} from '../../config.js';
import {ApiError} from '../../business.js';
import type {Write} from '../verification/router.js';
import {event} from '../verification/service.js';
import {intakeLinkSchema,versionSchema} from '../../../../../packages/contracts/src/index.js';
import {digest} from './transaction.js';
export function connectorFor(config:Config,channel:string){return channel==='TELEGRAM'?{enabled:config.TELEGRAM_ENABLED==='true',tenant:config.TELEGRAM_TENANT_ID,id:config.TELEGRAM_CONNECTOR_ID}:{enabled:config.GOOGLE_FORM_ENABLED==='true',tenant:config.GOOGLE_FORM_TENANT_ID,id:config.GOOGLE_FORM_CONNECTOR_ID};}
export function installIntakeLinks(router:Router,pool:pg.Pool,write:Write,config:Config){
 router.get('/orders/:id/intake-links',async(req,res)=>{
  const tenant=res.locals.actor.tenant_id,id=z.uuid().parse(req.params.id);
  if(!(await pool.query('SELECT 1 FROM orders WHERE tenant_id=$1 AND id=$2',[tenant,id])).rowCount)throw new ApiError(404,'NOT_FOUND','Order not found');
  const channels=['TELEGRAM','GOOGLE_FORM'].filter(ch=>{const c=connectorFor(config,ch);return c.enabled&&c.tenant===tenant;});
  const links=(await pool.query('SELECT id AS link_id,channel,expires_at,revoked_at FROM intake_links WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at DESC LIMIT 20',[tenant,id])).rows;
  res.json({channels,links,mock_payment:mockPaymentEnabled(config)});
 });
 router.post('/orders/:id/intake-links',async(req,res,next)=>{
  let created:string|undefined;
  try{await write(intakeLinkSchema,async(c,b)=>{
   const id=z.uuid().parse(req.params.id),connector=connectorFor(config,b.channel);
   if(!connector.enabled||connector.tenant!==c.actor.tenant_id)throw new ApiError(404,'CHANNEL_DISABLED','Channel unavailable');
   const order=(await c.db.query('SELECT * FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[c.actor.tenant_id,id])).rows[0];
   if(!order)throw new ApiError(404,'NOT_FOUND','Order not found');
   if(order.version!==b.expected_version)throw new ApiError(409,'STALE_VERSION','Order changed');
   if(!payable(order.payment_state))throw new ApiError(409,'PAYMENT_STATE_CONFLICT','Order is not awaiting payment');
   const token=randomBytes(32).toString('base64url'),linkId=randomUUID();
   const replaced=await c.db.query('UPDATE intake_links SET revoked_at=now() WHERE tenant_id=$1 AND order_id=$2 AND channel=$3 AND connector_id=$4 AND revoked_at IS NULL RETURNING id',[c.actor.tenant_id,id,b.channel,connector.id]);
   for(const old of replaced.rows)await event(c,'intake.link_revoked','intake_link',old.id,id,{reason:'REPLACED',channel:b.channel});
   const row=(await c.db.query("INSERT INTO intake_links(id,tenant_id,order_id,channel,connector_id,token_hash,expires_at,created_by) VALUES ($1,$2,$3,$4,$5,$6,now()+interval '24 hours',$7) RETURNING expires_at",[linkId,c.actor.tenant_id,id,b.channel,connector.id,digest(token),c.actor.id])).rows[0];
   created=b.channel==='TELEGRAM'?`https://t.me/${config.TELEGRAM_BOT_USERNAME}?start=${token}`:config.GOOGLE_FORM_PREFILL_URL!.replace('{token}',token);
   await event(c,'intake.link_created','intake_link',linkId,id,{channel:b.channel});
   return {link_id:linkId,url:null,expires_at:row.expires_at};
  },201,(body:any)=>({...body,url:created??null}))(req,res);
  }catch(e){next(e);}
 });
 router.post('/orders/:id/intake-links/:linkId/revoke',write(z.object({expected_version:versionSchema}).strict(),async(c,b,req)=>{
  const id=z.uuid().parse(req.params.id),linkId=z.uuid().parse(req.params.linkId);
  const order=(await c.db.query('SELECT * FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[c.actor.tenant_id,id])).rows[0];
  if(!order)throw new ApiError(404,'NOT_FOUND','Order not found');
  if(order.version!==b.expected_version)throw new ApiError(409,'STALE_VERSION','Order changed');
  if(!payable(order.payment_state))throw new ApiError(409,'PAYMENT_STATE_CONFLICT','Order is not awaiting payment');
  const changed=await c.db.query('UPDATE intake_links SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1 AND order_id=$2 AND id=$3 RETURNING id',[c.actor.tenant_id,id,linkId]);
  if(!changed.rowCount)throw new ApiError(404,'NOT_FOUND','Link not found');
  await event(c,'intake.link_revoked','intake_link',linkId,id,{});return {link_id:linkId,revoked:true};
 }));
}
