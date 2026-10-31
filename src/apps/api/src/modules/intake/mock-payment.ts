import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod';
import type {Config} from '../../config.js';
import {ApiError} from '../../business.js';
import {fingerprint} from '../verification/fixtures.js';
import {event,payable,supersede,type Context} from '../verification/service.js';
import type {ReceiptFields} from '../../../../../packages/contracts/src/index.js';
import {intakeTransaction} from './transaction.js';

// A team-made payment simulator stands in for a payment gateway. No real money moves.
// Its signed event is synthetic bank evidence plus a receipt. It never confirms payment: PaySah's rules and a person still decide.
export const mockPaymentEnabled=(config:Config)=>!!config.MOCK_PAY_URL&&!!config.MOCK_PAY_API_KEY&&!!config.MOCK_PAY_WEBHOOK_SECRET;
const eventSchema=z.object({
 synthetic:z.literal(true),provider:z.literal('PAYSAH_MOCK'),orderId:z.uuid(),merchantId:z.uuid(),bank:z.string().min(1).max(250),
 amount:z.number().positive().max(1000000),currency:z.literal('MYR'),bankTransactionRef:z.string().min(1).max(100),customerReference:z.string().min(1).max(100),
 recipientAccount:z.string().min(1).max(100),occurredAt:z.iso.datetime(),status:z.literal('SUCCESS'),documentType:z.literal('TRANSFER_RECEIPT'),
}).strict();

export async function createPaymentLink(c:Context,config:Config,order:{id:string;external_id:string}){
 if(!mockPaymentEnabled(config))throw new ApiError(404,'NOT_FOUND','Mock payment is not available');
 const account=(await c.db.query('SELECT account_identifier FROM merchant_accounts WHERE tenant_id=$1 AND active ORDER BY created_at,id LIMIT 1',[c.actor.tenant_id])).rows[0];
 if(!account)throw new ApiError(409,'NO_ACCOUNT','This shop has no receiving account');
 const reference=`MOCK-${randomUUID()}`;
 let response:Response;
 try{
  response=await fetch(`${config.MOCK_PAY_URL!.replace(/\/+$/,'')}/api/mock/links`,{method:'POST',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json','X-API-Key':config.MOCK_PAY_API_KEY!},
   body:JSON.stringify({orderId:order.id,merchantId:c.actor.tenant_id,bank:'DEMO BANK',bankTransactionRef:reference,customerReference:order.external_id,recipientAccount:account.account_identifier,documentType:'TRANSFER_RECEIPT'})});
 }catch{throw new ApiError(503,'MOCK_PAY_UNAVAILABLE','The payment simulator is not reachable');}
 if(!response.ok)throw new ApiError(503,'MOCK_PAY_UNAVAILABLE','The payment simulator refused the request');
 const body=await response.json() as {paymentUrl?:unknown};
 if(typeof body.paymentUrl!=='string')throw new ApiError(503,'MOCK_PAY_UNAVAILABLE','The payment simulator gave no link');
 await event(c,'payment_link.created','order',order.id,order.id,{provider:'PAYSAH_MOCK',synthetic:true});
 return {url:body.paymentUrl,synthetic:true};
}

export function validMockSignature(config:Config,raw:Buffer,given:string|undefined){
 if(!config.MOCK_PAY_WEBHOOK_SECRET)return false;
 const expected=Buffer.from(createHmac('sha256',config.MOCK_PAY_WEBHOOK_SECRET).update(raw).digest('hex')),actual=Buffer.from(given??'');
 return actual.length===expected.length&&timingSafeEqual(actual,expected);
}

export async function receiveMockPayment(pool:pg.Pool,raw:Buffer){
 let parsed:unknown;
 try{parsed=JSON.parse(raw.toString('utf8'));}catch{throw new ApiError(422,'INVALID_INPUT','Invalid payment event');}
 const b=eventSchema.parse(parsed),amount_sen=Math.round(b.amount*100);
 const tenant=(await pool.query('SELECT id FROM tenants WHERE id=$1 AND is_demo',[b.merchantId])).rows[0];
 if(!tenant)throw new ApiError(404,'NOT_FOUND','Shop not found');
 return intakeTransaction(pool,b.merchantId,undefined,async c=>{
  const order=(await c.db.query('SELECT id,payment_state FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[b.merchantId,b.orderId])).rows[0];
  if(!order)throw new ApiError(404,'NOT_FOUND','Order not found');
  const account=(await c.db.query('SELECT id FROM merchant_accounts WHERE tenant_id=$1 AND account_identifier=$2 AND active',[b.merchantId,b.recipientAccount])).rows[0];
  if(!account)throw new ApiError(422,'INVALID_INPUT','Receiving account not found');
  const seen=(await c.db.query('SELECT id FROM bank_transactions WHERE tenant_id=$1 AND account_id=$2 AND provider_tx_id=$3',[b.merchantId,account.id,b.bankTransactionRef])).rowCount;
  if(seen)return {accepted:true,replayed:true};
  if(!payable(order.payment_state))throw new ApiError(409,'ORDER_NOT_PAYABLE','This order is no longer awaiting payment');
  const credit=randomUUID();
  await c.db.query(`INSERT INTO bank_transactions(id,tenant_id,account_id,provider_tx_id,bank_transaction_ref,customer_reference,amount_sen,currency,direction,status,booked_at,source_kind) VALUES ($1,$2,$3,$4,$4,$5,$6,'MYR','CREDIT','BOOKED',$7,'SYNTHETIC_FEED')`,[credit,b.merchantId,account.id,b.bankTransactionRef,b.customerReference,amount_sen,b.occurredAt]);
  await event(c,'bank_transaction.created','bank_transaction',credit,null,{source:'SYNTHETIC_FEED',provider:'PAYSAH_MOCK'});
  const fields:ReceiptFields={amount_sen,currency:'MYR',bank_transaction_ref:b.bankTransactionRef,customer_reference:b.customerReference,recipient_account:b.recipientAccount,occurred_at:b.occurredAt,status:'SUCCESS',document_type:'TRANSFER_RECEIPT'};
  await supersede(c,order.id);
  const receipt=(await c.db.query("INSERT INTO receipts(id,tenant_id,order_id,content_fingerprint,source,fixture_id,fields,fields_provider) VALUES ($1,$2,$3,$4,'FIXTURE','MOCK_PAYMENT',$5,'FIXTURE') RETURNING id",[randomUUID(),b.merchantId,order.id,fingerprint({source:'MOCK_PAYMENT',reference:b.bankTransactionRef}),JSON.stringify(fields)])).rows[0];
  await event(c,'mock_payment.received','receipt',receipt.id,order.id,{provider:'PAYSAH_MOCK',synthetic:true,amount_sen});
  await c.db.query('UPDATE orders SET current_receipt_id=$3 WHERE tenant_id=$1 AND id=$2',[b.merchantId,order.id,receipt.id]);
  return {accepted:true,replayed:false};
 });
}
