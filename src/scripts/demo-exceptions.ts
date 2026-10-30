import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import type pg from 'pg';
import {withFinalistEnvironment} from './finalist-environment.js';

// Walks docs/EXCEPTION_DEMO.md through the real API in a disposable local schema.
export async function demonstrateExceptions(base:string,pool:pg.Pool){
 const records:Array<Record<string,unknown>>=[];
 async function request(path:string,token='',body?:unknown){
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 }
 const accounts=(await request('/demo/accounts')).body.accounts;
 const ownerAccount=accounts.find((a:any)=>a.role==='OWNER'),cashierAccount=accounts.find((a:any)=>a.role==='CASHIER'&&a.tenant_name===ownerAccount.tenant_name);
 const otherAccount=accounts.find((a:any)=>a.role==='OWNER'&&a.tenant_name!==ownerAccount.tenant_name);
 const login=async(id:string)=>(await request('/demo/sessions','',{account_id:id})).body.token;
 const owner=await login(ownerAccount.id),cashier=await login(cashierAccount.id),other=await login(otherAccount.id);
 const newOrder=async(total_sen:number)=>(await request('/orders',cashier,{external_id:`EXC-${randomUUID()}`,total_sen})).body.order;
 const attach=async(orderId:string,fixture_id:string)=>(await request(`/orders/${orderId}/receipts`,cashier,{source:'FIXTURE',fixture_id,expected_version:1})).body.receipt;
 const verify=async(orderId:string,receiptId:string,expected_version=1)=>(await request(`/orders/${orderId}/verifications`,cashier,{receipt_id:receiptId,expected_version})).body.verification;
 const payment=async(orderId:string)=>(await request(`/orders/${orderId}`,owner)).body.order;

 // Each blocked case: neither role can pay, whatever the fixture says.
 for(const [name,fixture_id,total_sen,flag,outcome] of [
  ['partial_payment','partial',12800,'PARTIAL_PAYMENT','NEEDS_REVIEW'],
  ['overpayment','normal',10000,'OVERPAYMENT','NEEDS_REVIEW'],
  ['wrong_recipient','wrong_account',12800,'WRONG_RECIPIENT','INVALID_EVIDENCE'],
  ['scheduled_transfer','scheduled',12800,'TRANSFER_NOT_COMPLETE','INVALID_EVIDENCE'],
  ['no_bank_credit','no_bank',12800,'BANK_NOT_FOUND','AWAITING_BANK'],
  ['money_request','money_request',12800,'MONEY_REQUEST','INVALID_EVIDENCE']
 ] as const){
  const order=await newOrder(total_sen),receipt=await attach(order.id,fixture_id),v=await verify(order.id,receipt.id);
  assert.equal(v.result.eligible,false,name);assert.ok(v.result.flags.includes(flag),`${name}: ${v.result.flags}`);assert.equal(v.result.outcome,outcome,name);
  const denied=await request(`/verifications/${v.id}/confirm`,owner,{expected_version:1});
  assert.equal(denied.status,409,name);assert.equal(denied.body.code,'EVIDENCE_BLOCKED',name);
  const state=await payment(order.id);assert.equal(state.payment_state,'UNPAID',name);assert.equal(state.fulfillment_state,'ON_HOLD',name);
  records.push({case:name,fixture_id,total_sen,flags:v.result.flags,outcome:v.result.outcome,owner_confirm_status:denied.status,owner_confirm_code:denied.body.code,payment:state.payment_state,fulfillment:state.fulfillment_state});
 }

 // Same evidence on a second order in the shop is blocked.
 const firstOrder=await newOrder(12800),firstReceipt=await attach(firstOrder.id,'normal');
 const secondOrder=await newOrder(12800),secondReceipt=await attach(secondOrder.id,'normal');
 const duplicate=await verify(secondOrder.id,secondReceipt.id);
 assert.equal(duplicate.result.eligible,false);assert.ok(duplicate.result.flags.includes('DUPLICATE_EVIDENCE'),String(duplicate.result.flags));
 records.push({case:'duplicate_receipt',flags:duplicate.result.flags,outcome:duplicate.result.outcome,first_receipt_attached:Boolean(firstReceipt.id),payment:(await payment(secondOrder.id)).payment_state});

 // High value: Owner rejects, nothing is paid, and the old approval cannot be reused.
 const highOrder=await newOrder(78000),highReceipt=await attach(highOrder.id,'high_value'),high=await verify(highOrder.id,highReceipt.id);
 assert.equal(high.result.eligible,true);assert.equal(high.result.required_role,'OWNER');assert.ok(high.result.flags.includes('HIGH_VALUE'));
 const cashierConfirm=await request(`/verifications/${high.id}/confirm`,cashier,{expected_version:1});
 assert.equal(cashierConfirm.status,403);assert.equal(cashierConfirm.body.code,'OWNER_APPROVAL_REQUIRED');
 const approval=(await request(`/verifications/${high.id}/approval-requests`,cashier,{expected_version:1})).body.approval;
 const rejected=await request(`/approvals/${approval.id}/decision`,owner,{decision:'REJECT',reason:'Request new evidence',expected_version:1});
 assert.equal(rejected.status,200);
 const retry=await request(`/approvals/${approval.id}/decision`,owner,{decision:'APPROVE',reason:'Retry after rejection',expected_version:1});
 assert.notEqual(retry.status,200);
 const afterReject=await payment(highOrder.id);assert.equal(afterReject.payment_state,'UNPAID');
 const highEvents=(await request(`/activity?order_id=${highOrder.id}&limit=100`,owner)).body.events.map((e:any)=>e.action);
 assert.ok(highEvents.includes('access.denied'));assert.ok(highEvents.includes('approval.decided'));assert.ok(!highEvents.includes('payment.confirmed'));
 records.push({case:'high_value_owner_reject',flags:high.result.flags,required_role:high.result.required_role,cashier_confirm_status:cashierConfirm.status,cashier_confirm_code:cashierConfirm.body.code,reject_status:rejected.status,retry_old_approval_status:retry.status,retry_old_approval_code:retry.body.code,payment:afterReject.payment_state,activity:highEvents});

 // A correction voids a pending approval, and manual fields keep the Owner in the loop.
 const correctedOrder=await newOrder(12800),correctedReceipt=await attach(correctedOrder.id,'normal');
 const beforeCorrection=await verify(correctedOrder.id,correctedReceipt.id);
 const pending=(await request(`/verifications/${beforeCorrection.id}/approval-requests`,cashier,{expected_version:1})).body.approval;
 const correction=await request(`/receipts/${correctedReceipt.id}/corrections`,cashier,{fields:{...correctedReceipt.fields,customer_reference:'CORRECTED'},expected_revision:1,expected_version:1,reason:'Correct synthetic note'});
 assert.equal(correction.status,200);
 const stale=pending?await request(`/approvals/${pending.id}/decision`,owner,{decision:'APPROVE',reason:'Approve old evidence',expected_version:1}):undefined;
 const afterCorrection=await verify(correctedOrder.id,correctedReceipt.id,correction.body.order?.version??1);
 assert.ok(afterCorrection.result.flags.includes('MANUAL_FIELDS'),String(afterCorrection.result.flags));assert.equal(afterCorrection.result.required_role,'OWNER');
 const correctedEvents=(await request(`/activity?order_id=${correctedOrder.id}&limit=100`,owner)).body.events.map((e:any)=>e.action);
 assert.ok(correctedEvents.includes('receipt.corrected'));
 records.push({case:'manual_correction_and_stale_approval',approval_requested:Boolean(pending),stale_approve_status:stale?.status??null,stale_approve_code:stale?.body.code??null,flags_after:afterCorrection.result.flags,required_role_after:afterCorrection.result.required_role,payment:(await payment(correctedOrder.id)).payment_state,activity:correctedEvents});

 // Fixture mode always reads the image, so a failed read is simulated directly in this disposable schema.
 const imageOrder=await newOrder(12800);
 const image=await request(`/orders/${imageOrder.id}/demo-receipt-images`,cashier,{fixture_id:'normal',expected_version:1});
 assert.equal(image.status,201,JSON.stringify(image.body));
 await pool.query("UPDATE receipts SET extraction_state='ERROR' WHERE id=$1",[image.body.receipt.id]);
 const unread=await request(`/orders/${imageOrder.id}/verifications`,cashier,{receipt_id:image.body.receipt.id,expected_version:1});
 assert.equal(unread.status,409);assert.equal(unread.body.code,'EXTRACTION_NOT_READY');
 const repaired=await request(`/receipts/${image.body.receipt.id}/corrections`,cashier,{fields:image.body.receipt.fields,expected_revision:image.body.receipt.revision??1,expected_version:1,reason:'Staff read the image'});
 const reread=repaired.status===200?await request(`/orders/${imageOrder.id}/verifications`,cashier,{receipt_id:image.body.receipt.id,expected_version:repaired.body.order?.version??1}):undefined;
 records.push({case:'failed_read_then_correction',failed_read_simulated:true,verify_status:unread.status,verify_code:unread.body.code,correction_status:repaired.status,correction_code:repaired.body.code??null,verify_after_status:reread?.status??null,flags_after:reread?.body.verification?.result.flags??null,required_role_after:reread?.body.verification?.result.required_role??null,payment:(await payment(imageOrder.id)).payment_state});

 // Another shop sees nothing.
 const foreignRead=await request(`/orders/${highOrder.id}`,other),foreignWrite=await request(`/verifications/${high.id}/confirm`,other,{expected_version:1});
 assert.equal(foreignRead.status,404);assert.equal(foreignWrite.status,404);
 records.push({case:'cross_shop',read_status:foreignRead.status,write_status:foreignWrite.status});

 assert.equal(Number((await pool.query("SELECT count(*) FROM activity_events WHERE action='payment.confirmed'")).rows[0].count),0);
 return {mode:'LOCAL_FIXTURE',records,payments_confirmed_in_run:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const result=await withFinalistEnvironment(demonstrateExceptions);
 const run_id=new Date().toISOString().replaceAll(':','-');await mkdir('evaluation/finalist/exceptions',{recursive:true});
 await writeFile(`evaluation/finalist/exceptions/${run_id}.json`,JSON.stringify({run_id,...result},null,2)+'\n');
 console.log(JSON.stringify({run_id,...result},null,1));
}
