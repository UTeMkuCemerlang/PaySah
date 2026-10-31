import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {ReceiptStorage} from '../receipts/storage.js';
import {intakeTransaction} from '../intake/transaction.js';
import {verifyReceipt} from './service.js';
import {ApiError} from '../../business.js';

export async function processVerificationJob(pool:pg.Pool,storage:ReceiptStorage){
 const candidate=(await pool.query("SELECT id,tenant_id FROM verification_jobs WHERE status='PENDING' OR (status='RUNNING' AND lease_until<now()) ORDER BY created_at,id LIMIT 1")).rows[0];
 if(!candidate)return false;
 const job=await intakeTransaction(pool,candidate.tenant_id,storage,async c=>{
  const j=(await c.db.query("SELECT * FROM verification_jobs WHERE tenant_id=$1 AND id=$2 AND (status='PENDING' OR (status='RUNNING' AND lease_until<now())) FOR UPDATE",[candidate.tenant_id,candidate.id])).rows[0];
  if(!j)return null;
  if(j.attempts>=3){await c.db.query("UPDATE verification_jobs SET status='ERROR',last_error='ATTEMPTS_EXHAUSTED',lease_token=NULL,lease_until=NULL WHERE id=$1",[j.id]);return null;}
  const lease=randomUUID();await c.db.query("UPDATE verification_jobs SET status='RUNNING',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '60 seconds' WHERE id=$1",[j.id,lease]);return {...j,lease_token:lease};
 });
 if(!job)return true;
 try{
  await intakeTransaction(pool,job.tenant_id,storage,async c=>{
   if(!(await c.db.query("SELECT 1 FROM verification_jobs WHERE tenant_id=$1 AND id=$2 AND status='RUNNING' AND lease_token=$3 AND lease_until>now() FOR UPDATE",[job.tenant_id,job.id,job.lease_token])).rowCount)return;
   const order=(await c.db.query('SELECT * FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[job.tenant_id,job.order_id])).rows[0];
   const receipt=(await c.db.query('SELECT * FROM receipts WHERE tenant_id=$1 AND id=$2',[job.tenant_id,job.receipt_id])).rows[0];
   if(!order||!receipt||!['UNPAID','PARTIALLY_PAID'].includes(order.payment_state)||order.current_receipt_id!==receipt.id||receipt.revision!==job.expected_revision){await c.db.query("UPDATE verification_jobs SET status='CANCELLED',lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id]);return;}
   await verifyReceipt(c,{orderId:order.id,receiptId:receipt.id,expectedVersion:order.version,expectedRevision:job.expected_revision});
   await c.db.query("UPDATE verification_jobs SET status='COMPLETED',last_error=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id]);
  });
 }catch(e){
  await intakeTransaction(pool,job.tenant_id,storage,async c=>{
   const permanent=e instanceof ApiError&&[404,409].includes(e.status)&&e.code!=='EXTRACTION_NOT_READY';
   await c.db.query("UPDATE verification_jobs SET status=$4,last_error=$5,lease_token=NULL,lease_until=NULL WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING'",[job.tenant_id,job.id,job.lease_token,permanent?'CANCELLED':job.attempts+1>=3?'ERROR':'PENDING',e instanceof ApiError?e.code:'VERIFICATION_FAILED']);
  });
 }
 return true;
}
