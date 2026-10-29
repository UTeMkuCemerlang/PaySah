import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {withFinalistEnvironment} from './finalist-environment.js';

export async function demonstrateGate(base:string){
 const records:Array<Record<string,unknown>>=[];
 async function request(path:string,token='',body?:unknown,key=randomUUID()){
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':key},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json(),replayed:response.headers.get('Idempotency-Replayed')};
 }
 const accounts=(await request('/demo/accounts')).body.accounts;
 const ownerAccount=accounts.find((a:any)=>a.role==='OWNER'),cashierAccount=accounts.find((a:any)=>a.role==='CASHIER'&&a.tenant_name===ownerAccount.tenant_name);
 const login=async(id:string)=>(await request('/demo/sessions','',{account_id:id})).body.token;
 const owner=await login(ownerAccount.id),cashier=await login(cashierAccount.id);
 const order=(await request('/orders',owner,{external_id:`GATE-${randomUUID()}`,total_sen:78000})).body.order;
 const receipt=(await request(`/orders/${order.id}/receipts`,owner,{source:'FIXTURE',fixture_id:'high_value',expected_version:1})).body.receipt;
 const v=(await request(`/orders/${order.id}/verifications`,owner,{receipt_id:receipt.id,expected_version:1})).body.verification;
 assert.equal(v.result.eligible,true);
 const approval=(await request(`/verifications/${v.id}/approval-requests`,cashier,{expected_version:1})).body.approval;
 for(const [path,token,body,status,code] of [
  [`/verifications/${v.id}/confirm`,cashier,{expected_version:1},403,'OWNER_APPROVAL_REQUIRED'],
  [`/orders/${order.id}/release`,owner,{expected_version:1},409,'RELEASE_BLOCKED'],
  [`/approvals/${approval.id}/decision`,cashier,{decision:'APPROVE',reason:'Gate demonstration',expected_version:1},403,'FORBIDDEN']
 ] as const){
  const result=await request(path,token,body);assert.equal(result.status,status);assert.equal(result.body.code,code);
  const state=(await request(`/orders/${order.id}`,owner)).body.order;
  assert.equal(state.payment_state,'UNPAID');assert.equal(state.fulfillment_state,'ON_HOLD');assert.equal(state.version,1);
  records.push({action:path.split('/').at(-1),status,code,correlation_id:result.body.correlation_id,payment:state.payment_state,fulfillment:state.fulfillment_state,version:state.version});
 }
 const paid=await request(`/approvals/${approval.id}/decision`,owner,{decision:'APPROVE',reason:'Verified synthetic independent credit',expected_version:1});
 assert.equal(paid.status,200);assert.equal(paid.body.order.payment_state,'PAID');assert.equal(paid.body.order.fulfillment_state,'ON_HOLD');
 const key=randomUUID(),body={expected_version:paid.body.order.version};
 const released=await request(`/orders/${order.id}/release`,owner,body,key);
 assert.equal(released.status,200);assert.equal(released.body.order.fulfillment_state,'RELEASED');
 const replay=await request(`/orders/${order.id}/release`,owner,body,key);assert.equal(replay.replayed,'true');assert.equal(replay.body.order.version,released.body.order.version);
 const events=(await request(`/activity?order_id=${order.id}&limit=100`,owner)).body.events;
 assert.equal(events.filter((e:any)=>e.action==='access.denied').length,2);
 assert.equal(events.filter((e:any)=>e.action==='payment.confirmed').length,1);
 assert.equal(events.filter((e:any)=>e.action==='fulfillment.released').length,1);
 const other=accounts.find((a:any)=>a.role==='OWNER'&&a.tenant_name!==ownerAccount.tenant_name);
 const otherToken=await login(other.id);
 assert.equal((await request(`/activity?order_id=${order.id}`,otherToken)).status,404);
 assert.equal((await request(`/orders/${order.id}/release`,otherToken,body)).status,404);
 const incremental=await request(`/activity?order_id=${order.id}&after_seq=0&limit=100`,owner);
 assert.equal(incremental.status,200);assert.ok(incremental.body.events.every((e:any,i:number,a:any[])=>i===0||BigInt(e.seq)>BigInt(a[i-1].seq)));
 assert.equal((await request('/activity?after_seq=0&offset=1',owner)).status,422);
 records.push({action:'approve',status:paid.status,payment:'PAID',fulfillment:'ON_HOLD',version:paid.body.order.version},{action:'release',status:released.status,fulfillment:'RELEASED',version:released.body.order.version});
 return {mode:'LOCAL_FIXTURE',records,events:events.map((e:any)=>({action:e.action,seq:e.seq,payload:e.payload})),replay_verified:true,cross_tenant_verified:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length>2)throw Error('Only isolated local runs are supported; no hosted --base option');
 const result=await withFinalistEnvironment(demonstrateGate);
 const run_id=new Date().toISOString().replaceAll(':','-');await mkdir('evaluation/finalist/gate',{recursive:true});
 await writeFile(`evaluation/finalist/gate/${run_id}.json`,JSON.stringify({run_id,...result},null,2)+'\n');
 console.log('PASS: direct API gates, post-rollback audit, separate paid/released, idempotency and tenant isolation (local fixture).');
}
