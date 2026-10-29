import {randomUUID,createHash} from 'node:crypto';
import type pg from 'pg';
import {ApiError} from '../../business.js';
import {event,type Context} from '../verification/service.js';
import {ingestReceiptImage,prepareReceiptImage,discardUnusedImage,type PreparedImage} from '../receipts/ingest.js';
import type {ReceiptStorage} from '../receipts/storage.js';
import type {Config} from '../../config.js';
import type {IntakeChannel,IntakeResult} from '../../../../../packages/contracts/src/index.js';

export const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export type Connector={tenant:string;channel:Exclude<IntakeChannel,'DASHBOARD'>;id:string};
export async function intakeTransaction<T>(pool:pg.Pool,tenant:string,storage:ReceiptStorage|undefined,fn:(c:Context)=>Promise<T>){
 const db=await pool.connect(),afterRollback:Array<()=>Promise<void>>=[];let committing=false;
 try{
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`m2:${tenant}`]);
  const actor=(await db.query("SELECT id,tenant_id,role,display_name FROM users WHERE tenant_id=$1 AND role='SYSTEM' AND active",[tenant])).rows[0];
  if(!actor)throw new ApiError(503,'INTAKE_RETRY','Internal intake identity not ready');
  const result=await fn({db,actor,correlation:randomUUID(),storage,afterRollback});
  committing=true;await db.query('COMMIT');return result;
 }catch(e){await db.query('ROLLBACK');if(!committing)for(const cleanup of afterRollback)try{await cleanup();}catch{}throw e;}finally{db.release();}
}
export async function validLink(c:Context,connector:Connector,tokenOrId:string,byId=false){
 return (await c.db.query(`SELECT l.*,o.payment_state FROM intake_links l JOIN orders o ON o.tenant_id=l.tenant_id AND o.id=l.order_id WHERE l.tenant_id=$1 AND l.channel=$2 AND l.connector_id=$3 AND ${byId?'l.id':'l.token_hash'}=$4 AND l.revoked_at IS NULL AND l.expires_at>now() AND o.payment_state='UNPAID'`,[connector.tenant,connector.channel,connector.id,byId?tokenOrId:digest(tokenOrId)])).rows[0];
}
const publicResult=(row:any,replayed:boolean):IntakeResult=>({status:row.status,reason:row.reason,replayed});
type Snapshot={link_id:string;order_id:string;reason?:string}|null;
export async function receiveImage(pool:pg.Pool,config:Config,storage:ReceiptStorage,connector:Connector,input:{externalId:string;payloadHash:string;senderHash?:string;snapshot:(c:Context)=>Promise<Snapshot>;download:()=>Promise<Buffer>;mime?:string}){
 const reservation=await intakeTransaction(pool,connector.tenant,storage,async c=>{
  const prior=(await c.db.query('SELECT * FROM intake_messages WHERE tenant_id=$1 AND channel=$2 AND connector_id=$3 AND external_id=$4 FOR UPDATE',[connector.tenant,connector.channel,connector.id,input.externalId])).rows[0];
  if(prior){
   if(prior.payload_hash!==input.payloadHash){
    await event(c,'intake.rejected','intake',prior.id,prior.order_id,{reason:'IDEMPOTENCY_CONFLICT',channel:connector.channel});
    return {conflict:true as const};
   }
   if(['ACCEPTED','REJECTED'].includes(prior.status))return {result:publicResult(prior,true)};
   if(prior.status==='RECEIVING'&&new Date(prior.lease_until).getTime()>Date.now())throw new ApiError(503,'INTAKE_RETRY','Event is being received');
   if(prior.attempts>=3){await c.db.query("UPDATE intake_messages SET status='REJECTED',reason='ATTEMPTS_EXHAUSTED',lease_token=NULL,lease_until=NULL WHERE id=$1",[prior.id]);await event(c,'intake.rejected','intake',prior.id,prior.order_id,{reason:'ATTEMPTS_EXHAUSTED',channel:connector.channel});return {result:{status:'REJECTED',reason:'ATTEMPTS_EXHAUSTED',replayed:false} as IntakeResult};}
   const lease=randomUUID();await c.db.query("UPDATE intake_messages SET status='RECEIVING',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '45 seconds' WHERE id=$1",[prior.id,lease]);return {message:{...prior,lease_token:lease}};
  }
  const pending=(await c.db.query("SELECT count(*)::int AS n FROM receipt_jobs WHERE tenant_id=$1 AND status IN ('PENDING','RUNNING')",[connector.tenant])).rows[0].n;
  if(pending>=20)throw new ApiError(503,'INTAKE_RETRY','Receipt queue is full');
  const binding=await input.snapshot(c),id=randomUUID(),lease=randomUUID();
  let reason=binding?.reason??(!binding?'LINK_INVALID':null);
  if(!reason&&connector.channel==='TELEGRAM'&&config.TELEGRAM_INTAKE_MODE==='demo_link'){
   // Serialise the shared daily budget even if future instances use another tenant.
   await c.db.query('SELECT pg_advisory_xact_lock(7215002)');
   const counts=(await c.db.query(`SELECT
    count(*) FILTER(WHERE tenant_id=$1 AND sender_hash=$2 AND created_at>now()-interval '1 hour')::int AS sender,
    count(*) FILTER(WHERE tenant_id=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS tenant,
    count(*) FILTER(WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS global
    FROM intake_messages WHERE channel='TELEGRAM' AND (receipt_id IS NOT NULL OR status IN ('RECEIVING','RETRYABLE') OR reason IN ('IMAGE_INVALID','ATTEMPTS_EXHAUSTED'))`,[connector.tenant,input.senderHash])).rows[0];
   if(counts.sender>=config.TELEGRAM_MAX_IMAGES_PER_HOUR||counts.tenant>=config.TELEGRAM_MAX_TENANT_IMAGES_PER_DAY||counts.global>=config.TELEGRAM_MAX_GLOBAL_IMAGES_PER_DAY)reason='RATE_LIMITED';
  }
  const message=(await c.db.query(`INSERT INTO intake_messages(id,tenant_id,channel,connector_id,external_id,payload_hash,sender_hash,link_id,order_id,status,lease_token,lease_until,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+interval '45 seconds',$12) RETURNING *`,[id,connector.tenant,connector.channel,connector.id,input.externalId,input.payloadHash,input.senderHash??null,binding?.link_id??null,binding?.order_id??null,reason?'REJECTED':'RECEIVING',reason?null:lease,reason])).rows[0];
  if(reason){if(binding?.order_id||reason!=='LINK_INVALID')await event(c,'intake.rejected','intake',id,binding?.order_id??null,{channel:connector.channel,reason});return {result:publicResult(message,false)};}
  return {message};
 });
 if(reservation.conflict)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','Event content changed');
 if(reservation.result)return reservation.result;
 const message=reservation.message!;
 let image:PreparedImage|undefined;
 try{
  const bytes=await input.download();
  image=await prepareReceiptImage(storage,connector.tenant,bytes,input.mime);
  return await intakeTransaction(pool,connector.tenant,storage,async c=>{
   const own=(await c.db.query("SELECT * FROM intake_messages WHERE tenant_id=$1 AND id=$2 AND status='RECEIVING' AND lease_token=$3 AND lease_until>now() FOR UPDATE",[connector.tenant,message.id,message.lease_token])).rows[0];
   if(!own)throw new ApiError(503,'INTAKE_RETRY','Reception lease changed');
   const link=await validLink(c,connector,message.link_id,true);
   if(!link){await c.db.query("UPDATE intake_messages SET status='REJECTED',reason='LINK_INVALID',lease_token=NULL,lease_until=NULL WHERE id=$1",[message.id]);await event(c,'intake.rejected','intake',message.id,message.order_id,{channel:connector.channel,reason:'LINK_INVALID'});return {status:'REJECTED',reason:'LINK_INVALID',replayed:false} as IntakeResult;}
   // The original snapshot is authoritative, including on a retry after a later /start.
   if(link.order_id!==message.order_id)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','Binding snapshot changed');
   const order=(await c.db.query('SELECT version,current_receipt_id FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[connector.tenant,message.order_id])).rows[0];
   const result=await ingestReceiptImage(c,config,storage,message.order_id,order.version,image!,undefined,connector.channel,message.id);
   await c.db.query("UPDATE intake_messages SET status='ACCEPTED',receipt_id=$2,reason=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1",[message.id,result.receipt.id]);
   await event(c,'intake.received','intake',message.id,message.order_id,{channel:connector.channel,receipt_id:result.receipt.id,...(result.reused?{reused:true,current:order.current_receipt_id===result.receipt.id}:{})});
   return {status:'ACCEPTED',reason:null,replayed:false} as IntakeResult;
  });
 }catch(e){
  const permanent=e instanceof ApiError&&[413,422].includes(e.status),reason=permanent?'IMAGE_INVALID':'INTAKE_RETRY';
  await intakeTransaction(pool,connector.tenant,storage,async c=>{const changed=await c.db.query("UPDATE intake_messages SET status=$4,reason=$5,lease_token=NULL,lease_until=NULL WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND status='RECEIVING' RETURNING id",[connector.tenant,message.id,message.lease_token,permanent?'REJECTED':'RETRYABLE',reason]);if(permanent&&changed.rowCount)await event(c,'intake.rejected','intake',message.id,message.order_id,{channel:connector.channel,reason});});
  if(permanent)return {status:'REJECTED',reason,replayed:false} as IntakeResult;
  throw new ApiError(503,'INTAKE_RETRY','Temporary reception error; retry same event');
 }finally{await discardUnusedImage(storage,image);}
}
