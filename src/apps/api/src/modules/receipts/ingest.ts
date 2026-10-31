import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {IntakeChannel} from '../../../../../packages/contracts/src/index.js';
import type {Config} from '../../config.js';
import {ApiError} from '../../business.js';
import {event,supersede,type Context,enqueueVerification} from '../verification/service.js';
import {fixtures,fingerprint} from '../verification/fixtures.js';
import {validateImage} from './images.js';
import {imageHash,type ReceiptStorage} from './storage.js';
import {emptyFields} from './fields.js';
import {publicReceipt} from './router.js';
export type PreparedImage={tenant:string;key:string;meta:Awaited<ReturnType<typeof validateImage>>;sha:string;byteSize:number;referenced:boolean};
// This phase must run outside the tenant transaction, for employee and channel uploads alike.
export async function prepareReceiptImage(storage:ReceiptStorage,tenant:string,bytes:Buffer,mime?:string):Promise<PreparedImage>{
    const meta=await validateImage(bytes);
    if(mime&&meta.mime_type!==mime)throw new ApiError(422,'IMAGE_INVALID','Image type does not match');
    const sha=imageHash(bytes);
    let key:string;try{key=await storage.put(tenant,bytes);}catch{throw new ApiError(503,'STORAGE_UNAVAILABLE','Could not save receipt image');}
    return {tenant,key,meta,sha,byteSize:bytes.length,referenced:false};
}
export async function discardUnusedImage(storage:ReceiptStorage,image:PreparedImage|undefined){
    if(image&&!image.referenced)try{await storage.remove(image.key);}catch{console.error('Receipt object cleanup pending');}
}
export async function ingestReceiptImage(c:Context,config:Config,storage:ReceiptStorage,id:string,expected:number,image:PreparedImage,fixtureId?:string,channel:IntakeChannel='DASHBOARD',messageId?:string){
    if(image.tenant!==c.actor.tenant_id)throw new ApiError(403,'FORBIDDEN','Image tenant mismatch');
    const order=(await c.db.query('SELECT * FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[c.actor.tenant_id,z.uuid().parse(id)])).rows[0];
    if(!order)throw new ApiError(404,'NOT_FOUND','Order not found');
    if(order.version!==expected)throw new ApiError(409,'STALE_VERSION','Order changed');
    if(order.payment_state!=='UNPAID'&&order.payment_state!=='PARTIALLY_PAID')throw new ApiError(409,'PAYMENT_STATE_CONFLICT','Order is not awaiting payment');
    const {meta,sha,key}=image;
    const prior=await c.db.query('SELECT * FROM receipts WHERE tenant_id=$1 AND order_id=$2 AND image_sha256=$3',[c.actor.tenant_id,id,sha]);
    if(prior.rowCount)return {receipt:publicReceipt(prior.rows[0]),reused:true};
    c.afterRollback?.push(()=>storage.remove(key));
    // Preserve a possibly committed object on an unknown COMMIT outcome. Known rollbacks use afterRollback.
    image.referenced=true;
    // Both reading modes queue a worker job; the worker records which provider actually produced the fields.
    const cpu=config.EXTRACTOR_MODE==='cpu_ocr'||config.EXTRACTOR_MODE==='runpod';
    const fields=!cpu&&fixtureId?fixtures[fixtureId]:emptyFields;
    const provider=config.EXTRACTOR_MODE==='runpod'?'RUNPOD_VLM':cpu?'CPU_OCR':fixtureId?'FIXTURE':'MANUAL';
    const state=cpu?'PENDING':fixtureId?'COMPLETED':'NEEDS_REVIEW';
    await supersede(c,id);
    const row=(await c.db.query(`INSERT INTO receipts(id,tenant_id,order_id,content_fingerprint,source,fixture_id,fields,image_sha256,storage_key,storage_state,mime_type,byte_size,fields_provider,extraction_state,intake_channel,intake_message_id)
      VALUES ($1,$2,$3,$4,'IMAGE',$5,$6,$7,$8,'READY',$9,$10,$11,$12,$13,$14) RETURNING *`,[randomUUID(),c.actor.tenant_id,id,fingerprint({source:'IMAGE',sha}),fixtureId??null,JSON.stringify(fields),sha,key,meta.mime_type,image.byteSize,provider,state,channel,messageId??null])).rows[0];
    await c.db.query('UPDATE orders SET current_receipt_id=$3 WHERE tenant_id=$1 AND id=$2',[c.actor.tenant_id,id,row.id]);
    let jobId:string|null=null;
    if(cpu){jobId=randomUUID();await c.db.query('INSERT INTO receipt_jobs(id,tenant_id,receipt_id,expected_revision) VALUES ($1,$2,$3,1)',[jobId,c.actor.tenant_id,row.id]);}
    await event(c,'receipt.image_saved','receipt',row.id,id,{source:'IMAGE',sha256:sha,provider,extraction_state:state,channel});
    if(!cpu&&channel!=='DASHBOARD')await enqueueVerification(c,row);
    return {receipt:publicReceipt(row),job_id:jobId};
  }
