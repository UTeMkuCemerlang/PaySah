import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {withFinalistEnvironment} from './finalist-environment.js';
import {createOrderSchema} from '../packages/contracts/src/index.js';

// Proposed adapter only. There is no connection to a real Orbyte service.
export function mapOrbyteOrder(input:{external_order_id:string;amount_sen:number;currency:'MYR'}){
 return createOrderSchema.parse({external_id:input.external_order_id,total_sen:input.amount_sen,currency:input.currency});
}
export async function demonstrateOrbyte(base:string){
 const call=async(path:string,token='',body?:unknown,key:string=randomUUID())=>{
  const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':key},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await r.json();assert.ok(r.ok,`${path}: ${r.status} ${value.code??''}`);return value;
 };
 const token=(await call('/demo/sessions','',{account_id:'20000000-0000-4000-8000-000000000001'})).token;
 const other=(await call('/demo/sessions','',{account_id:'20000000-0000-4000-8000-000000000003'})).token;
 const input={external_order_id:`MOCK-ORBYTE-${randomUUID()}`,amount_sen:12800,currency:'MYR' as const};
 const key=createHash('sha256').update(input.external_order_id).digest('hex'),mapped=mapOrbyteOrder(input);
 const created=(await call('/orders',token,mapped,key)).order,replayed=(await call('/orders',token,mapped,key)).order;
 assert.equal(created.id,replayed.id);
 const receipt=(await call(`/orders/${created.id}/receipts`,token,{source:'FIXTURE',fixture_id:'normal',expected_version:1})).receipt;
 const v=(await call(`/orders/${created.id}/verifications`,token,{receipt_id:receipt.id,expected_version:1})).verification;
 assert.equal(v.result.eligible,true);
 assert.equal((await call(`/orders/${created.id}`,token)).order.payment_state,'UNPAID');
 const before=(await call(`/activity?order_id=${created.id}&after_seq=0`,token));
 const paid=(await call(`/verifications/${v.id}/confirm`,token,{expected_version:1})).order;
 await call(`/orders/${created.id}/release`,token,{expected_version:paid.version});
 const seen=new Set<string>();let cursor='0';const projected:Array<Record<string,unknown>>=[];
 for(let page=0;page<20;page++){
  const data=await call(`/activity?order_id=${created.id}&after_seq=${cursor}&limit=2`,token);
  for(const event of data.events){if(seen.has(event.id))continue;seen.add(event.id);if(['verification.completed','payment.confirmed','fulfillment.released'].includes(event.action))projected.push({event_id:event.id,seq:event.seq,action:event.action,occurred_at:event.created_at,entity_version:event.payload.version??null,evidence_source:event.payload.evidence_source??event.payload.source??null,correlation_id:event.correlation_id});}
  cursor=data.last_seq;if(data.events.length<2)break;
 }
 assert.deepEqual(projected.map(e=>e.action),['verification.completed','payment.confirmed','fulfillment.released']);
 const otherEvents=(await call('/activity?after_seq=0&limit=100',other)).events;assert.ok(otherEvents.every((e:any)=>e.order_id!==created.id));
 return {mode:'PROPOSED_ORBYTE_MOCK_LOCAL_FIXTURE',input,mapped,duplicate_order_prevented:true,unpaid_after_verification:true,pre_payment_last_seq:before.last_seq,last_seq:cursor,events:projected};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length>2)throw Error('This mock only supports an isolated local environment');
 console.log(JSON.stringify(await withFinalistEnvironment(demonstrateOrbyte),null,2));
}
