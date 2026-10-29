import type pg from 'pg';
import {ApiError,type Actor} from '../../business.js';
import type {ReceiptStorage} from '../receipts/storage.js';
import {evaluate} from './service.js';
import {fingerprint} from './fixtures.js';
import {RULE_VERSION} from './rules.js';

type State='MISSING_EVIDENCE'|'CHECKING'|'BLOCKED'|'MATCHED'|'PAID'|'RELEASED';
export async function replyDraft(pool:pg.Pool,actor:Actor,id:string,storage:ReceiptStorage){
 const db=await pool.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const order=(await db.query('SELECT * FROM orders WHERE tenant_id=$1 AND id=$2',[actor.tenant_id,id])).rows[0];
  if(!order)throw new ApiError(404,'NOT_FOUND','Order not found');
  let state:State='CHECKING';
  if(order.payment_state==='PAID')state=order.fulfillment_state==='RELEASED'?'RELEASED':'PAID';
  else if(order.payment_state!=='UNPAID')state='BLOCKED';
  else if(!order.current_receipt_id)state='MISSING_EVIDENCE';
  else{
   const receipt=(await db.query('SELECT * FROM receipts WHERE tenant_id=$1 AND order_id=$2 AND id=$3',[actor.tenant_id,id,order.current_receipt_id])).rows[0];
   const v=(await db.query('SELECT * FROM verifications WHERE tenant_id=$1 AND order_id=$2 AND receipt_id=$3 ORDER BY active DESC,created_at DESC,id DESC LIMIT 1',[actor.tenant_id,id,order.current_receipt_id])).rows[0];
   if(receipt&&v?.active&&v.order_version===order.version&&v.evidence_revision===receipt.revision&&v.rule_version===RULE_VERSION){
    try{
     // Same pure evidence evaluation as confirmation; no events, queue or model calls.
     const fresh=await evaluate({db,actor,storage,correlation:'reply-draft'},order,receipt);
     if(fresh.evidence_hash===v.evidence_hash&&fingerprint(fresh.result)===fingerprint(v.result)){
      if(fresh.result.eligible)state='MATCHED';
      else if(fresh.result.outcome!=='AWAITING_BANK')state='BLOCKED';
     }
    }catch(error){if(!(error instanceof ApiError&&['IMAGE_UNAVAILABLE','EXTRACTION_NOT_READY'].includes(error.code)))throw error;}
   }
  }
  const paid=`Payment of RM ${(order.total_sen/100).toFixed(2)} confirmed using demo bank evidence.`;
  const text:Record<State,string>={
   MISSING_EVIDENCE:`We have not received a payment receipt for order ${order.external_id} yet. Please send it through the link provided.`,
   CHECKING:'We received your receipt and are checking it against our records. This is not a payment confirmation yet.',
   BLOCKED:'We could not confirm this payment from the receipt provided. Please contact the shop for assistance.',
   MATCHED:'Your payment matches our records and is awaiting final confirmation.',
   PAID:paid,
   RELEASED:`${paid} Your order has been released and is ready for collection.`
  };
  await db.query('COMMIT');return {text:text[state],state,source:'SYNTHETIC_DEMO' as const,sent:false as const};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
