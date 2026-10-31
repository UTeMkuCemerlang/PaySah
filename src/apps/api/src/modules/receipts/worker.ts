import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {event,supersede,enqueueVerification,type Context} from '../verification/service.js';
import {imageHash,type ReceiptStorage} from './storage.js';
import {CpuExtractor,OCR_ENGINE_VERSION,PREPROCESSING_VERSION} from './ocr.js';
import {parseReceiptText,PARSER_VERSION} from './parser.js';
import {emptyFields} from './fields.js';
import {readThird} from './third-reader.js';
import {RUNPOD_PARSER_VERSION,RunpodError,fieldDisagreements,type FallbackReason,type VisionExtractor} from './runpod.js';
import type {ReceiptFields} from '../../../../../packages/contracts/src/index.js';

export type TextExtractor={extract(bytes:Buffer,timeoutMs?:number):Promise<string|{text:string;preprocessed_sha256:string}>};
// Receipt jobs are durable, with one extraction per worker process and lease recovery.
export async function processReceiptJob(pool:pg.Pool,storage:ReceiptStorage,extractor:TextExtractor=new CpuExtractor(),vision?:VisionExtractor,third?:VisionExtractor){
  const candidate=(await pool.query("SELECT id,tenant_id FROM receipt_jobs WHERE status='PENDING' OR (status='RUNNING' AND lease_until<now()) ORDER BY created_at,id LIMIT 1")).rows[0];
  if(!candidate)return false;
  const client=await pool.connect();let job:any,receipt:any,actor:any;
  try{
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`m2:${candidate.tenant_id}`]);
    job=(await client.query("SELECT * FROM receipt_jobs WHERE tenant_id=$1 AND id=$2 AND (status='PENDING' OR (status='RUNNING' AND lease_until<now())) FOR UPDATE",[candidate.tenant_id,candidate.id])).rows[0];
    if(!job){await client.query('ROLLBACK');return false;}
    receipt=(await client.query('SELECT r.*,o.payment_state,o.current_receipt_id FROM receipts r JOIN orders o ON o.tenant_id=r.tenant_id AND o.id=r.order_id WHERE r.tenant_id=$1 AND r.id=$2',[job.tenant_id,job.receipt_id])).rows[0];
    if(!receipt||receipt.revision!==job.expected_revision||!['UNPAID','PARTIALLY_PAID'].includes(receipt.payment_state)||receipt.current_receipt_id!==receipt.id){
      await client.query("UPDATE receipt_jobs SET status='CANCELLED',lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id]);await client.query('COMMIT');return true;
    }
    if(job.attempts>=2){
      await client.query("UPDATE receipt_jobs SET status='ERROR',last_error='LEASE_EXHAUSTED',lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id]);
      await client.query("UPDATE receipts SET extraction_state='ERROR' WHERE tenant_id=$1 AND id=$2",[job.tenant_id,receipt.id]);await client.query('COMMIT');return true;
    }
    // Attribute extraction events to the original intake actor; not an approval identity.
    actor=(await client.query("SELECT u.* FROM activity_events e JOIN users u ON u.tenant_id=e.tenant_id AND u.id=e.actor_id WHERE e.tenant_id=$1 AND e.entity_type='receipt' AND e.entity_id=$2 AND e.action='receipt.image_saved' ORDER BY seq LIMIT 1",[job.tenant_id,receipt.id])).rows[0];
    job.lease_token=randomUUID();
    await client.query("UPDATE receipt_jobs SET status='RUNNING',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '180 seconds' WHERE id=$1",[job.id,job.lease_token]);
    await client.query("UPDATE receipts SET extraction_state='RUNNING' WHERE tenant_id=$1 AND id=$2",[job.tenant_id,receipt.id]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  const start=Date.now();let raw_text='',error_code:string|null=null,preprocessed_hash:string|null=null,bytes:Buffer|undefined;
  let provider:'CPU_OCR'|'RUNPOD_VLM'='CPU_OCR',engine=OCR_ENGINE_VERSION,parserVersion=PARSER_VERSION,preprocessing=PREPROCESSING_VERSION,requestId:string|null=null,fallback:FallbackReason|null=null;
  let parsed:{fields:ReceiptFields;missing_fields:string[];candidates:Record<string,unknown>}|undefined;
  try{const stored=await storage.read(receipt.storage_key);if(imageHash(stored)!==receipt.image_sha256)throw Error('IMAGE_INTEGRITY');bytes=stored;}
  catch{error_code='EXTRACTION_FAILED';}
  // GPU vision first when configured; any RunPod failure falls back to CPU OCR and the run records why.
  if(bytes&&vision){
    try{
      const result=await vision.extractFields(bytes,receipt.mime_type);
      provider='RUNPOD_VLM';engine=vision.engine;parserVersion=RUNPOD_PARSER_VERSION;preprocessing='none';requestId=result.request_id;raw_text=result.raw_text;
      // Independent CPU reading of the same bytes; differences are kept and send the receipt to Owner review.
      let cpuFields:ReceiptFields=emptyFields;
      try{const output=await extractor.extract(bytes);cpuFields=parseReceiptText(typeof output==='string'?output:output.text).fields;}catch{}
      const disagreements=fieldDisagreements(result.fields,cpuFields);
      const third_reading=await readThird(third,bytes,receipt.mime_type,result.fields,cpuFields,disagreements);
      parsed={fields:result.fields,missing_fields:result.missing_fields,candidates:{model:result.model,cpu_fields:cpuFields,disagreements,uncertain_fields:result.uncertain_fields,...(third_reading?{third_reading}:{})}};
    }catch(e){fallback=e instanceof RunpodError?e.reason:'RUNPOD_UNAVAILABLE';}
  }
  if(bytes&&!parsed){
    try{const output=await extractor.extract(bytes);raw_text=typeof output==='string'?output:output.text;preprocessed_hash=typeof output==='string'?null:output.preprocessed_sha256;if(raw_text.length>100000)throw Error('OCR_OUTPUT_LIMIT');parsed=parseReceiptText(raw_text);}
    catch(e){error_code=(e as Error).message==='OCR_TIMEOUT'?'OCR_TIMEOUT':'EXTRACTION_FAILED';}
  }
  if(!parsed)parsed={fields:emptyFields,missing_fields:['extraction'],candidates:{}};
  const state=error_code?'ERROR':parsed.missing_fields.length?'NEEDS_REVIEW':'COMPLETED';
  const db=await pool.connect();
  try{
    await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`m2:${job.tenant_id}`]);
    const current=(await db.query("SELECT j.id FROM receipt_jobs j JOIN receipts r ON r.tenant_id=j.tenant_id AND r.id=j.receipt_id JOIN orders o ON o.tenant_id=r.tenant_id AND o.id=r.order_id WHERE j.tenant_id=$1 AND j.id=$2 AND j.status='RUNNING' AND j.lease_token=$3 AND j.lease_until>now() AND r.revision=j.expected_revision AND o.payment_state IN ('UNPAID','PARTIALLY_PAID') AND o.current_receipt_id=r.id FOR UPDATE OF j,r,o",[job.tenant_id,job.id,job.lease_token])).rows[0];
    if(!current){await db.query("UPDATE receipt_jobs SET status='CANCELLED',lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",[job.id,job.lease_token]);await db.query('COMMIT');return true;}
    const context:Context={db,actor,correlation:randomUUID(),storage};
    await supersede(context,receipt.order_id);
    await db.query('INSERT INTO extraction_runs(id,tenant_id,receipt_id,revision,provider,engine_version,parser_version,preprocessing_version,language,raw_text,fields,missing_fields,status,duration_ms,error_code,field_candidates,preprocessed_sha256,provider_request_id,fallback_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,\'eng\',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',[randomUUID(),job.tenant_id,receipt.id,receipt.revision+1,provider,engine,parserVersion,preprocessing,raw_text.slice(0,100000),JSON.stringify(parsed.fields),JSON.stringify(parsed.missing_fields),state,Date.now()-start,error_code,JSON.stringify(parsed.candidates),preprocessed_hash,requestId,fallback]);
    await db.query("UPDATE receipts SET fields=$3,revision=revision+1,fields_provider=$5,extraction_state=$4 WHERE tenant_id=$1 AND id=$2",[job.tenant_id,receipt.id,JSON.stringify(parsed.fields),state,provider]);
    await db.query("UPDATE receipt_jobs SET status=$2,last_error=$3,lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id,error_code?'ERROR':'COMPLETED',error_code]);
    await event(context,'receipt.extracted','receipt',receipt.id,receipt.order_id,{provider,state,revision:receipt.revision+1,error_code,fallback_reason:fallback,missing_fields:parsed.missing_fields});
    if(receipt.intake_channel!=='DASHBOARD'&&!error_code)await enqueueVerification(context,{id:receipt.id,order_id:receipt.order_id,revision:receipt.revision+1});
    await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  return true;
}
