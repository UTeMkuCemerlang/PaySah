import {test} from 'node:test';
import {withFinalistEnvironment} from '../../scripts/finalist-environment.js';
import {demonstrateGate} from '../../scripts/demo-gate.js';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {verify} from '../../apps/api/src/modules/verification/rules.js';
import {fixtures} from '../../apps/api/src/modules/verification/fixtures.js';
import {demonstrateOrbyte} from '../../scripts/mock-orbyte.js';

test('Finalist direct API gate, denied audit, order timeline and incremental activity isolation',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 await withFinalistEnvironment(demonstrateGate);
});

test('tenant policy boundaries retain strictly greater-than semantics',()=>{
 for(const threshold of [20000,50000])for(const amount of [threshold,threshold+1]){
  const result=verify({total_sen:amount,fields:{...fixtures.normal,amount_sen:amount},accounts:['DEMO-ACCOUNT-A'],transactions:[],duplicate_evidence:false,duplicate_reference:false,manual:false,owner_review_threshold_sen:threshold,policy_version:7});
  assert.equal(result.flags.includes('HIGH_VALUE'),amount>threshold);assert.equal(result.policy_version,7);
 }
});
test('proposed Orbyte mock replays orders and consumes isolated ordered events',{skip:!process.env.TEST_DATABASE_URL},async()=>{await withFinalistEnvironment(demonstrateOrbyte);});

test('denied audit failure never changes the 403 or allocates payment',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 await withFinalistEnvironment(async(base,pool)=>{
  async function call(path:string,token='',body?:unknown){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
  const owner=(await call('/demo/sessions','',{account_id:'20000000-0000-4000-8000-000000000001'})).body.token;
  const cashier=(await call('/demo/sessions','',{account_id:'20000000-0000-4000-8000-000000000002'})).body.token;
  const o=(await call('/orders',owner,{external_id:`AUDIT-FAIL-${randomUUID()}`,total_sen:78000})).body.order;
  const r=(await call(`/orders/${o.id}/receipts`,owner,{source:'FIXTURE',fixture_id:'high_value',expected_version:1})).body.receipt;
  const v=(await call(`/orders/${o.id}/verifications`,owner,{receipt_id:r.id,expected_version:1})).body.verification;
  await pool.query("CREATE FUNCTION fail_denied_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='access.denied' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_denied BEFORE INSERT ON activity_events FOR EACH ROW EXECUTE FUNCTION fail_denied_audit()");
  const denied=await call(`/verifications/${v.id}/confirm`,cashier,{expected_version:1});assert.equal(denied.status,403);assert.equal(denied.body.code,'OWNER_APPROVAL_REQUIRED');
  assert.equal((await call(`/orders/${o.id}`,owner)).body.order.payment_state,'UNPAID');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment_allocations')).rows[0].n,0);
 });
});

test('Bakery and Laundry isolate policies, reject stale approvals and preserve other shops on reset',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 await withFinalistEnvironment(async(base,pool)=>{
  await pool.query(await readFile('fixtures/finalist/laundry.sql','utf8'));
  async function call(path:string,token='',body?:unknown){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
  const login=async(id:string)=>(await call('/demo/sessions','',{account_id:id})).body.token;
  const a=await login('20000000-0000-4000-8000-000000000002'),co=await login('20000000-0000-4000-8000-000000000005'),cc=await login('20000000-0000-4000-8000-000000000006');
  assert.equal((await call('/tenant/settings',cc)).body.settings.owner_review_threshold_sen,20000);
  assert.equal((await call('/tenant/settings',a)).body.settings.owner_review_threshold_sen,50000);
  const ao=(await call('/orders',a,{external_id:'FINAL-BAKERY-300',total_sen:30000})).body.order;
  await pool.query("INSERT INTO bank_transactions(id,tenant_id,account_id,provider_tx_id,bank_transaction_ref,amount_sen,currency,direction,status,booked_at,source_kind) VALUES ($1,'10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','FINAL-BAKERY-300','FINAL-BAKERY-300',30000,'MYR','CREDIT','BOOKED','2026-10-22T06:00:00Z','SYNTHETIC_FEED')",[randomUUID()]);
  const coid='41000000-0000-4000-8000-000000000301';
  async function evidence(order:string,fixture:string,token:string){const response=await call(`/orders/${order}/receipts`,token,{source:'FIXTURE',fixture_id:fixture,expected_version:1});assert.equal(response.status,201,JSON.stringify(response.body));const receipt=response.body.receipt;return {receipt,v:(await call(`/orders/${order}/verifications`,token,{receipt_id:receipt.id,expected_version:1})).body.verification};}
  const av=await evidence(ao.id,'bakery_300',a),cv=await evidence(coid,'laundry_300',cc);
  assert.equal(av.v.result.required_role,'CASHIER');assert.equal(cv.v.result.required_role,'OWNER');assert.equal(cv.v.result.eligible,true);
  assert.equal((await call(`/orders/${coid}`,a)).status,404);
  assert.equal((await call(`/verifications/${cv.v.id}/confirm`,cc,{expected_version:1})).status,403);
  const approval=(await call(`/verifications/${cv.v.id}/approval-requests`,cc,{expected_version:1})).body.approval;
  await pool.query("UPDATE tenant_settings SET policy_version=policy_version+1 WHERE tenant_id='10000000-0000-4000-8000-000000000003'");
  const stale=await call(`/approvals/${approval.id}/decision`,co,{expected_version:1,decision:'APPROVE',reason:'Synthetic policy change test'});assert.equal(stale.status,409);assert.equal(stale.body.code,'STALE_APPROVAL');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment_allocations WHERE order_id=$1',[coid])).rows[0].n,0);
  const fresh=(await call(`/orders/${coid}/verifications`,cc,{receipt_id:cv.receipt.id,expected_version:1})).body.verification;
  const next=(await call(`/verifications/${fresh.id}/approval-requests`,cc,{expected_version:1})).body.approval;
  assert.equal((await call(`/approvals/${next.id}/decision`,co,{expected_version:1,decision:'APPROVE',reason:'Synthetic bank credit verified'})).status,200);
  assert.equal((await call(`/orders/${coid}/release`,cc,{expected_version:2})).status,403);
  assert.equal((await call(`/orders/${coid}/release`,co,{expected_version:2})).status,200);
  assert.equal((await call(`/verifications/${av.v.id}/confirm`,a,{expected_version:1})).status,200);
  await pool.query("UPDATE tenant_settings SET release_owner_threshold_sen=20000,policy_version=policy_version+1 WHERE tenant_id='10000000-0000-4000-8000-000000000001'");
  assert.equal((await call(`/orders/${ao.id}/release`,a,{expected_version:2})).status,403);
  assert.equal((await call('/demo/reset',co,{})).status,200);
  assert.equal((await call(`/orders/${coid}`,cc)).body.order.payment_state,'UNPAID');
  assert.equal((await call(`/orders/${ao.id}`,a)).body.order.payment_state,'PAID');
  assert.equal((await call('/tenant/settings',cc)).body.settings.policy_version,2);
 });
});
