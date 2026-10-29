import {createHmac,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import type {Config} from '../../config.js';
import {ApiError} from '../../business.js';
import type {ReceiptStorage} from '../receipts/storage.js';
import {MAX_IMAGE_BYTES} from '../receipts/images.js';
import {fingerprint} from '../verification/fixtures.js';
import {digest,intakeTransaction,receiveImage,validLink,type Connector} from './transaction.js';
import {event} from '../verification/service.js';

const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const file=z.object({file_id:z.string().min(1).max(256),file_size:integer.optional()});
const updateSchema=z.object({update_id:integer,message:z.object({message_id:integer,from:z.object({id:integer}),chat:z.object({id:z.number().int(),type:z.literal('private')}),text:z.string().max(256).optional(),photo:z.array(file).min(1).max(10).optional(),document:file.extend({mime_type:z.string().max(100).optional()}).optional()})});
export type TelegramDownloader=(id:string)=>Promise<Buffer>;
export type TelegramNotifier=(chatId:number,text:string)=>Promise<void>;
export function telegramNotifier(config:Config,fetcher:typeof fetch=fetch):TelegramNotifier{
 return async(chatId,text)=>{
  if(config.TELEGRAM_INTAKE_MODE==='allowlist'&&!config.TELEGRAM_ALLOWED_SENDERS?.split(',').includes(String(chatId)))return;
  const response=await fetcher(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text}),signal:AbortSignal.timeout(5000),redirect:'error'});
  if(!response.ok||(await response.json())?.ok!==true)throw Error('Acknowledgement failed');
 };
}
async function acknowledge(notify:TelegramNotifier,chatId:number,result:{status:string;replayed?:boolean;reason?:string|null},externalId?:string){
 if(result.replayed||result.status==='IGNORED')return;
 const reasons:Record<string,string>={RATE_LIMITED:'the demo submission limit has been reached; please try again later',LINK_INVALID:'the submission link is invalid or has expired',IMAGE_INVALID:'the image is invalid or not supported'};
 const text=result.status==='ACCEPTED'?(externalId?`Connected to order ${externalId.replace(/[\r\n]/g,' ')}. This is a demo. Send only sample receipt images, not real bank receipts.`:'Receipt received. The shop will check it. This does not mean the payment is confirmed.'):reasons[result.reason??'']?`Could not accept this: ${reasons[result.reason!]}.` :null;
 if(text)try{await notify(chatId,text);}catch{console.warn('Telegram acknowledgement failed; reception result retained.');}
}
export function telegramDownloader(config:Config,fetcher:typeof fetch=fetch):TelegramDownloader{
 return async id=>{
  const signal=AbortSignal.timeout(20000);
  async function bounded(response:Response,max:number){
   if(!response.ok)throw new ApiError(503,'INTAKE_RETRY','Telegram file unavailable');
   if(Number(response.headers.get('content-length')??0)>max){await response.body?.cancel();throw new ApiError(413,'IMAGE_INVALID','File too large');}
   const reader=response.body?.getReader();if(!reader)throw new ApiError(503,'INTAKE_RETRY','Empty download');
   const chunks:Uint8Array[]=[];let length=0;
   try{while(true){const item=await reader.read();if(item.done)break;length+=item.value.length;if(length>max)throw new ApiError(413,'IMAGE_INVALID','File too large');chunks.push(item.value);}}finally{await reader.cancel();}
   return Buffer.concat(chunks);
  }
  try{
   const meta=JSON.parse((await bounded(await fetcher(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getFile`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file_id:id}),signal,redirect:'error'}),16384)).toString());
   const path=meta?.result?.file_path;
   if(!meta.ok||typeof path!=='string'||!/^\w[\w./-]{0,255}$/.test(path)||path.split('/').some((s:string)=>!s||s==='.'||s==='..'))throw new ApiError(422,'IMAGE_INVALID','Unsupported file');
   if(meta.result.file_size>MAX_IMAGE_BYTES)throw new ApiError(413,'IMAGE_INVALID','File too large');
   return await bounded(await fetcher(`https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${path}`,{signal,redirect:'error'}),MAX_IMAGE_BYTES);
  }catch(e){if(e instanceof ApiError)throw e;throw new ApiError(503,'INTAKE_RETRY','Telegram file download interrupted');}
 };
}
export async function receiveTelegram(pool:pg.Pool,config:Config,storage:ReceiptStorage,body:unknown,download=telegramDownloader(config),notify=telegramNotifier(config)):Promise<{status:string;reason?:string|null;replayed?:boolean}>{
 const parsed=updateSchema.safeParse(body);
 if(!parsed.success)return {status:'IGNORED' as const};
 const update=parsed.data,m=update.message;
 if(m.chat.id!==m.from.id||(config.TELEGRAM_INTAKE_MODE==='allowlist'&&!config.TELEGRAM_ALLOWED_SENDERS?.split(',').includes(String(m.from.id))))return {status:'IGNORED' as const};
 if(!m.text?.startsWith('/start ')&&!m.document&&!m.photo)return {status:'IGNORED' as const};
 const connector:Connector={tenant:config.TELEGRAM_TENANT_ID!,channel:'TELEGRAM',id:config.TELEGRAM_CONNECTOR_ID};
 if(config.TELEGRAM_INTAKE_MODE==='demo_link'&&!(await pool.query('SELECT id FROM tenants WHERE id=$1 AND is_demo',[connector.tenant])).rowCount)throw new ApiError(503,'INTAKE_RETRY','Demo intake requires a demo shop');
 const sender=createHmac('sha256',config.INTAKE_HMAC_SECRET!).update(`${connector.id}:${m.from.id}`).digest('hex'),payload=fingerprint(body);
 if(m.text?.startsWith('/start ')){
  const token=m.text.slice(7);
  let externalId:string|undefined;
  const result=await intakeTransaction(pool,connector.tenant,storage,async c=>{
   const prior=(await c.db.query('SELECT * FROM intake_messages WHERE tenant_id=$1 AND channel=$2 AND connector_id=$3 AND external_id=$4',[connector.tenant,connector.channel,connector.id,String(update.update_id)])).rows[0];
   if(prior){
    if(prior.payload_hash!==payload){await event(c,'intake.rejected','intake',prior.id,prior.order_id,{reason:'IDEMPOTENCY_CONFLICT',channel:connector.channel});return {conflict:true as const};}
    return {status:prior.status,reason:prior.reason,replayed:true};
   }
   const starts=(await c.db.query("SELECT count(*)::int AS n FROM intake_messages WHERE tenant_id=$1 AND channel='TELEGRAM' AND sender_hash=$2 AND created_at>now()-interval '1 hour'",[connector.tenant,sender])).rows[0].n;
   if(config.TELEGRAM_INTAKE_MODE==='demo_link'&&starts>=config.TELEGRAM_MAX_STARTS_PER_HOUR){
    const id=randomUUID();await c.db.query("INSERT INTO intake_messages(id,tenant_id,channel,connector_id,external_id,payload_hash,sender_hash,status,reason) VALUES ($1,$2,'TELEGRAM',$3,$4,$5,$6,'REJECTED','RATE_LIMITED')",[id,connector.tenant,connector.id,String(update.update_id),payload,sender]);
    await event(c,'intake.rejected','intake',id,null,{reason:'RATE_LIMITED',channel:'TELEGRAM'});
    return {status:'REJECTED',reason:'RATE_LIMITED',replayed:false};
   }
   const link=/^[A-Za-z0-9_-]{43}$/.test(token)?await validLink(c,connector,token):null;
   const old=(await c.db.query('SELECT * FROM intake_bindings WHERE tenant_id=$1 AND channel=$2 AND connector_id=$3 AND sender_hash=$4',[connector.tenant,connector.channel,connector.id,sender])).rows[0];
   const stale=old&&(Number(old.last_update_id)>=update.update_id||Number(old.last_message_id)>=m.message_id);
   const reason=!link?'LINK_INVALID':stale?'STALE_MESSAGE':null;
   if(!reason)externalId=(await c.db.query('SELECT external_id FROM orders WHERE tenant_id=$1 AND id=$2',[connector.tenant,link.order_id])).rows[0].external_id;
   if(!reason)await c.db.query(`INSERT INTO intake_bindings(tenant_id,channel,connector_id,sender_hash,link_id,order_id,expires_at,last_update_id,last_message_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,channel,connector_id,sender_hash) DO UPDATE SET link_id=EXCLUDED.link_id,order_id=EXCLUDED.order_id,expires_at=EXCLUDED.expires_at,last_update_id=EXCLUDED.last_update_id,last_message_id=EXCLUDED.last_message_id`,[connector.tenant,connector.channel,connector.id,sender,link.id,link.order_id,link.expires_at,update.update_id,m.message_id]);
   const id=randomUUID();
   await c.db.query('INSERT INTO intake_messages(id,tenant_id,channel,connector_id,external_id,payload_hash,sender_hash,link_id,order_id,status,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,connector.tenant,connector.channel,connector.id,String(update.update_id),payload,sender,link?.id??null,link?.order_id??null,reason?'REJECTED':'ACCEPTED',reason]);
   if(reason&&(link?.order_id||reason!=='LINK_INVALID'))await event(c,'intake.rejected','intake',id,link?.order_id??null,{reason,channel:connector.channel});
   return {status:reason?'REJECTED':'ACCEPTED',reason,replayed:false};
  });
  if(result.conflict)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','Event content changed');
  await acknowledge(notify,m.from.id,result,externalId);
  return result;
 }
 const image=m.document??m.photo?.at(-1);
 const result=await receiveImage(pool,config,storage,connector,{externalId:String(update.update_id),payloadHash:payload,senderHash:sender,
  snapshot:async c=>{
   const b=(await c.db.query('SELECT * FROM intake_bindings WHERE tenant_id=$1 AND channel=$2 AND connector_id=$3 AND sender_hash=$4 AND expires_at>now()',[connector.tenant,connector.channel,connector.id,sender])).rows[0];
   if(!b||!await validLink(c,connector,b.link_id,true))return null;
   const stale=Number(b.last_update_id)>=update.update_id||Number(b.last_message_id)>=m.message_id;
   if(!stale)await c.db.query('UPDATE intake_bindings SET last_update_id=$5,last_message_id=$6 WHERE tenant_id=$1 AND channel=$2 AND connector_id=$3 AND sender_hash=$4',[connector.tenant,connector.channel,connector.id,sender,update.update_id,m.message_id]);
   return {link_id:b.link_id,order_id:b.order_id,...(stale?{reason:'STALE_MESSAGE'}:{})};
  },download:async()=>{if(!image||image.file_size&&image.file_size>MAX_IMAGE_BYTES)throw new ApiError(422,'IMAGE_INVALID','Provide one valid image');return download(image.file_id);}});
 await acknowledge(notify,m.from.id,result);
 return result;
}
