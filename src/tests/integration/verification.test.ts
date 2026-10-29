import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Server} from 'node:http';
import pg from 'pg';
import {migrate,seed} from '../../scripts/database.js';
import {createApp} from '../../apps/api/src/app.js';
import {readConfig} from '../../apps/api/src/config.js';
import {fixtures} from '../../apps/api/src/modules/verification/fixtures.js';
import {withFinalistEnvironment} from '../../scripts/finalist-environment.js';

const url=process.env.TEST_DATABASE_URL;
test('reply drafts reflect current evidence and payment without sending or writing',{skip:!url},async t=>{
 const cases=[['missing','MISSING_EVIDENCE'],['received','CHECKING'],['awaiting_bank','CHECKING'],['blocked','BLOCKED'],['matched','MATCHED'],['inactive','CHECKING'],['revision','CHECKING'],['rule','CHECKING'],['order','CHECKING'],['policy','CHECKING'],['bank','CHECKING'],['account','CHECKING'],['paid','PAID'],['released','RELEASED']] as const;
 for(const [mode,expected]of cases)await t.test(mode,async()=>{
  await withFinalistEnvironment(async(base,pool)=>{
   let token='';
   async function call(path:string,body?:unknown){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});const b=await r.json();assert.ok(r.ok,`${path}: ${r.status} ${JSON.stringify(b)}`);return b;}
   token=(await call('/demo/sessions',{account_id:'20000000-0000-4000-8000-000000000001'})).token;
   const o=(await call('/orders',{external_id:`DRAFT-${randomUUID()}`,total_sen:12800})).order;
   if(mode!=='missing'){
    let receipt:any;
    if(mode==='received'||mode==='awaiting_bank')receipt=(await call(`/orders/${o.id}/receipts`,{source:'FIXTURE',fixture_id:mode==='received'?'normal':'no_bank',expected_version:1})).receipt;
    else{
     const ref=randomUUID();await call('/demo/bank-events',{account_id:'50000000-0000-4000-8000-000000000001',provider_tx_id:ref,bank_transaction_ref:ref,amount_sen:12800,booked_at:fixtures.normal.occurred_at,expected_account_version:1});
     receipt=(await call(`/orders/${o.id}/receipts`,{source:'MANUAL',fields:{...fixtures.normal,bank_transaction_ref:ref,...(mode==='blocked'?{recipient_account:'WRONG-ACCOUNT'}:{})},expected_version:1})).receipt;
    }
    if(mode!=='received'){
     const v=(await call(`/orders/${o.id}/verifications`,{receipt_id:receipt.id,expected_version:1})).verification;
     if(mode==='awaiting_bank')assert.equal(v.result.outcome,'AWAITING_BANK');
     if(mode==='inactive')await pool.query('UPDATE verifications SET active=false WHERE id=$1',[v.id]);
     if(mode==='revision')await pool.query('UPDATE receipts SET revision=revision+1 WHERE id=$1',[receipt.id]);
     if(mode==='rule')await pool.query("UPDATE verifications SET rule_version='obsolete' WHERE id=$1",[v.id]);
     if(mode==='order')await pool.query('UPDATE orders SET version=version+1 WHERE id=$1',[o.id]);
     if(mode==='policy')await pool.query("UPDATE tenant_settings SET policy_version=policy_version+1 WHERE tenant_id='10000000-0000-4000-8000-000000000001'");
     if(mode==='bank')await pool.query("UPDATE bank_transactions SET status='REVERSED' WHERE id=$1",[v.result.matched_transaction_id]);
     if(mode==='account')await pool.query("UPDATE merchant_accounts SET active=false,version=version+1 WHERE id='50000000-0000-4000-8000-000000000001'");
     if(mode==='paid'||mode==='released'){
      const a=(await call(`/verifications/${v.id}/approval-requests`,{expected_version:1})).approval;
      await call(`/approvals/${a.id}/decision`,{decision:'APPROVE',reason:'Synthetic bank evidence verified',expected_version:1});
      if(mode==='released')await call(`/orders/${o.id}/release`,{expected_version:2});
     }
    }
   }
   const before=(await pool.query('SELECT count(*)::int AS n FROM activity_events')).rows[0].n;
   const draft=await call(`/orders/${o.id}/reply-draft`);
   assert.equal(draft.state,expected);assert.equal(draft.sent,false);assert.equal(draft.source,'SYNTHETIC_DEMO');
   if(mode==='missing'){assert.match(draft.text,/not received/);assert.doesNotMatch(draft.text,/being checked|checking/i);}
   if(mode==='blocked')assert.doesNotMatch(draft.text,/WRONG_RECIPIENT|WRONG-ACCOUNT|DUPLICATE/);
   if(mode==='released')assert.match(draft.text,/released.*collection/);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM activity_events')).rows[0].n,before);
   const other=(await call('/demo/sessions',{account_id:'20000000-0000-4000-8000-000000000003'})).token;
   assert.equal((await fetch(base+`/orders/${o.id}/reply-draft`,{headers:{Authorization:`Bearer ${other}`}})).status,404);
  });
 });
});
test('M2 PostgreSQL verification and approval safety', {skip:!url&&process.env.npm_lifecycle_event!=='test:db'},async t=>{
  assert.ok(url,'TEST_DATABASE_URL required');
  const schema=`test_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({connectionString:url,connectionTimeoutMillis:3000});
  let pool:pg.Pool|undefined, server:Server|undefined;
  let base='',owner='',cashier='',other='';
  async function start(){server=createApp(readConfig({DATABASE_URL:url}),undefined,pool).listen(0,'127.0.0.1');await new Promise<void>(r=>server!.once('listening',r));const a=server.address();assert.ok(a&&typeof a!=='string');base=`http://127.0.0.1:${a.port}/api/v1`;}
  const call=(path:string,token=owner,body?:unknown,key=randomUUID())=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':key},body:body===undefined?undefined:JSON.stringify(body)});
  const ok=async(path:string,body?:unknown,token=owner)=>{const r=await call(path,token,body);const b=await r.json();assert.ok(r.ok,`${path}: ${r.status} ${JSON.stringify(b)}`);return b;};
  const create=async(total_sen=12800)=>(await ok('/orders',{external_id:randomUUID(),total_sen})).order;
  const intake=async(orderId:string,fixture_id='normal')=>(await ok(`/orders/${orderId}/receipts`,{source:'FIXTURE',fixture_id,expected_version:1})).receipt;
  const run=async(orderId:string,receiptId:string)=>(await ok(`/orders/${orderId}/verifications`,{receipt_id:receiptId,expected_version:1})).verification;
  const request=async(v:string)=>(await ok(`/verifications/${v}/approval-requests`,{expected_version:1},cashier)).approval;
  const approve=(a:string,token=owner,key=randomUUID())=>call(`/approvals/${a}/decision`,token,{decision:'APPROVE',expected_version:1,reason:'Checked synthetic feed'},key);
  async function manual(total=12800,ref=randomUUID(),fields:Record<string,unknown>={}){
    const order=await create(total);
    await ok('/demo/bank-events',{account_id:'50000000-0000-4000-8000-000000000001',provider_tx_id:ref,bank_transaction_ref:ref,amount_sen:total,booked_at:fixtures.normal.occurred_at,expected_account_version:1});
    const receipt=(await ok(`/orders/${order.id}/receipts`,{source:'MANUAL',fields:{...fixtures.normal,amount_sen:total,bank_transaction_ref:ref,...fields},expected_version:1})).receipt;
    assert.equal(receipt.fields_provider,'MANUAL');
    const v=await run(order.id,receipt.id);return {order,receipt,v};
  }
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,connectionTimeoutMillis:3000});
    await migrate(pool);await seed(pool);await migrate(pool);await seed(pool);await start();
    const accounts=(await (await call('/demo/accounts','')).json()).accounts;
    for(const [i,set] of [[0,(s:string)=>owner=s],[1,(s:string)=>cashier=s],[2,(s:string)=>other=s]] as const){set((await ok('/demo/sessions',{account_id:accounts[i].id},'')).token);}
    await t.test('M1 remains compatible; ready checks migration checksums',async()=>{
      assert.equal((await call('/ready')).status,200);
      await pool!.query("UPDATE schema_migrations SET checksum='wrong' WHERE name='002_verification.sql'");
      assert.equal((await call('/ready')).status,503);
      await pool!.query("UPDATE schema_migrations SET checksum=$1 WHERE name='002_verification.sql'",[createHash('sha256').update(await readFile('db/migrations/002_verification.sql','utf8')).digest('hex')]);
      assert.equal((await call('/ready')).status,200);
    });
    await t.test('T01 normal fixture requires human confirmation and separate release; retries allocate once',async()=>{
      const order=await create();const receipt=await intake(order.id);const v=await run(order.id,receipt.id);
      assert.equal(v.result.outcome,'MATCHED');assert.equal((await ok(`/orders/${order.id}`)).order.payment_state,'UNPAID');
      const body={expected_version:1},key=randomUUID();
      const responses=await Promise.all([call(`/verifications/${v.id}/confirm`,cashier,body,key),call(`/verifications/${v.id}/confirm`,cashier,body,key)]);
      assert.ok(responses.every(r=>r.ok));
      assert.equal((await ok(`/orders/${order.id}`)).order.fulfillment_state,'ON_HOLD');
      assert.equal((await ok(`/orders/${order.id}/release`,{expected_version:2},cashier)).order.fulfillment_state,'RELEASED');
      assert.equal((await pool!.query('SELECT count(*) FROM payment_allocations WHERE order_id=$1',[order.id])).rows[0].count,'1');
      assert.match((await ok(`/orders/${order.id}/reply-draft`)).text,/128.00/);
      const events=(await ok('/activity')).events.filter((e:any)=>e.order_id===order.id);
      assert.ok(events.some((e:any)=>e.action==='payment.confirmed'));assert.ok(events.some((e:any)=>e.action==='fulfillment.released'));
    });
    await t.test('T02 RM500 vs RM500.01 rule boundary; T03 high-value cashier rejected, Owner approves',async()=>{
      const {verify}=await import('../../apps/api/src/modules/verification/rules.js');
      const input={fields:{...fixtures.normal,amount_sen:50000},total_sen:50000,accounts:['DEMO-ACCOUNT-A'],transactions:[],duplicate_evidence:false,duplicate_reference:false,manual:false};
      assert.ok(!verify(input).flags.includes('HIGH_VALUE'));assert.ok(verify({...input,total_sen:50001,fields:{...input.fields,amount_sen:50001}}).flags.includes('HIGH_VALUE'));
      const order=await create(78000),r=await intake(order.id,'high_value'),v=await run(order.id,r.id);
      assert.ok(v.result.flags.includes('HIGH_VALUE'));const a=await request(v.id);
      assert.equal((await approve(a.id,cashier)).status,403);
      assert.equal((await call(`/verifications/${v.id}/confirm`,cashier,{expected_version:1})).status,403);
      assert.equal((await approve(a.id)).status,200);
      assert.equal((await call(`/orders/${order.id}/release`,cashier,{expected_version:2})).status,403);
    });
    await t.test('T04/T05/T11/partial/no-bank evidence cannot be approved or released by Owner',async()=>{
      for(const fixture of ['money_request','scheduled','wrong_account','partial','no_bank']){
        const order=await create(),r=await intake(order.id,fixture),v=await run(order.id,r.id),a=await request(v.id);
        assert.equal(v.result.eligible,false);
        // Cashier is told the evidence is blocked, not sent to an Owner who cannot approve it either.
        const confirm=await call(`/verifications/${v.id}/confirm`,cashier,{expected_version:1});
        assert.equal(confirm.status,409);assert.equal((await confirm.json()).code,'EVIDENCE_BLOCKED');
        assert.equal((await approve(a.id)).status,409);
        assert.equal((await call(`/orders/${order.id}/release`,owner,{expected_version:1})).status,409);
        assert.equal((await ok(`/orders/${order.id}`)).order.payment_state,'UNPAID');
      }
    });
    await t.test('duplicate fixture fields and used bank transaction remain blocked',async()=>{
      const order=await create(),r=await intake(order.id),v=await run(order.id,r.id);
      assert.ok(v.result.flags.includes('DUPLICATE_EVIDENCE'));assert.ok(v.result.flags.includes('TRANSACTION_ALREADY_USED'));assert.equal(v.result.eligible,false);
    });
    await t.test('T14 cross-tenant receipt, verification, account, approval reads/writes and activity FK',async()=>{
      const {order,receipt,v}=await manual(),a=await request(v.id);
      assert.equal((await call(`/orders/${order.id}/receipts`,other)).status,404);
      assert.equal((await call(`/verifications/${v.id}`,other)).status,404);
      assert.equal((await approve(a.id,other)).status,404);
      assert.equal((await call(`/receipts/${receipt.id}/corrections`,other,{expected_revision:1,expected_version:1,fields:receipt.fields,reason:'Test isolation'})).status,404);
      assert.equal((await call(`/orders/${order.id}/verifications`,other,{receipt_id:receipt.id,expected_version:1})).status,404);
      await assert.rejects(pool!.query("INSERT INTO activity_events(id,tenant_id,actor_id,action,entity_type,entity_id,order_id,payload,correlation_id) VALUES ($1,'10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000003','bad','receipt',$2,'40000000-0000-4000-8000-000000000003','{}',$3)",[randomUUID(),receipt.id,randomUUID()]),(e:unknown)=>(e as {code:string}).code==='23503');
    });
    await t.test('T17/T26 corrections retain original fields, supersede approvals, reject stale concurrent revisions',async()=>{
      const {order,receipt,v}=await manual(),a=await request(v.id);
      const body={fields:{...receipt.fields,customer_reference:'CORRECTED'},expected_revision:1,expected_version:1,reason:'Correct synthetic note'};
      const results=await Promise.all([call(`/receipts/${receipt.id}/corrections`,cashier,body),call(`/receipts/${receipt.id}/corrections`,cashier,body)]);
      assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await approve(a.id)).status,409);
      const corrections=await pool!.query('SELECT * FROM receipt_corrections WHERE receipt_id=$1',[receipt.id]);assert.equal(corrections.rowCount,1);assert.equal(corrections.rows[0].before_fields.customer_reference,'DEMO-ORDER');
      assert.equal((await pool!.query('SELECT status FROM approvals WHERE id=$1',[a.id])).rows[0].status,'SUPERSEDED');
      const fresh=await run(order.id,receipt.id),newApproval=await request(fresh.id);assert.equal((await approve(newApproval.id)).status,200);
      assert.equal((await call(`/receipts/${receipt.id}/corrections`,owner,{...body,expected_revision:2,expected_version:2})).status,409);
    });
    await t.test('T17 changed order, rules, and bank evidence invalidate approval',async()=>{
      for(const kind of ['order','rule','bank']){
        const {order,v}=await manual(),a=await request(v.id);
        if(kind==='order')await pool!.query('UPDATE orders SET version=version+1 WHERE id=$1',[order.id]);
        if(kind==='rule')await pool!.query("UPDATE verifications SET rule_version='obsolete' WHERE id=$1",[v.id]);
        if(kind==='bank')await pool!.query("UPDATE bank_transactions SET status='REVERSED' WHERE id=$1",[v.result.matched_transaction_id]);
        assert.equal((await approve(a.id)).status,409);
      }
    });
    await t.test('T08 competing orders cannot allocate the same bank credit twice',async()=>{
      const first=await manual();
      const secondOrder=await create();
      const secondReceipt=(await ok(`/orders/${secondOrder.id}/receipts`,{source:'MANUAL',expected_version:1,fields:{...first.receipt.fields,customer_reference:'SECOND'}})).receipt;
      const one=await run(first.order.id,first.receipt.id),two=await run(secondOrder.id,secondReceipt.id);
      const a=await request(one.id),b=await request(two.id);
      const results=await Promise.all([approve(a.id),approve(b.id)]);
      assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===409).length,1);
      assert.equal((await pool!.query('SELECT count(*) FROM payment_allocations WHERE bank_transaction_id=$1',[one.result.matched_transaction_id])).rows[0].count,'1');
    });
    await t.test('T15 bank event retries, payload conflicts, role and amount constraints',async()=>{
      const ref=randomUUID(),key=randomUUID(),body={account_id:'50000000-0000-4000-8000-000000000001',provider_tx_id:ref,bank_transaction_ref:ref,amount_sen:100,booked_at:fixtures.normal.occurred_at,expected_account_version:1};
      assert.equal((await call('/demo/bank-events',cashier,body)).status,403);
      assert.equal((await call('/demo/bank-events',owner,body,key)).status,201);assert.equal((await call('/demo/bank-events',owner,body,key)).status,200);
      assert.equal((await call('/demo/bank-events',owner,{...body,amount_sen:200},key)).status,409);
      const duplicate=await call('/demo/bank-events',owner,body);assert.equal(duplicate.status,409);assert.equal((await duplicate.json()).code,'DUPLICATE_BANK_EVENT');
      assert.equal((await call('/demo/bank-events',owner,{...body,tenant_id:'forged'})).status,422);
    });
    await t.test('T18 audit failure rolls back approval, allocation, payment and idempotency',async()=>{
      const {order,v}=await manual(),a=await request(v.id),key=randomUUID();
      await pool!.query("ALTER TABLE activity_events ADD CONSTRAINT reject_payment CHECK(action<>'payment.confirmed') NOT VALID");
      assert.equal((await approve(a.id,owner,key)).status,500);
      assert.equal((await ok(`/orders/${order.id}`)).order.payment_state,'UNPAID');
      assert.equal((await pool!.query('SELECT status FROM approvals WHERE id=$1',[a.id])).rows[0].status,'PENDING');
      assert.equal((await pool!.query('SELECT count(*) FROM payment_allocations WHERE order_id=$1',[order.id])).rows[0].count,'0');
      assert.equal((await pool!.query('SELECT count(*) FROM idempotency_keys WHERE key=$1',[key])).rows[0].count,'0');
      await pool!.query('ALTER TABLE activity_events DROP CONSTRAINT reject_payment');
      assert.equal((await approve(a.id,owner,key)).status,200);
    });
    await t.test('T28 sales and deposit payable amounts share the same entry; rejection keeps balance',async()=>{
      const {order,v}=await manual(2000),a=await request(v.id);
      assert.equal((await call(`/approvals/${a.id}/decision`,owner,{decision:'REJECT',reason:'Request new evidence',expected_version:1})).status,200);
      assert.equal((await ok(`/orders/${order.id}`)).order.payment_state,'UNPAID');
      const v2=await run(order.id,v.receipt_id),a2=await request(v2.id);assert.equal((await approve(a2.id)).status,200);
    });
    await t.test('demo login limit ignores forged proxy headers',async()=>{
      const limited=createApp(readConfig({DATABASE_URL:url}),undefined,pool).listen(0,'127.0.0.1');
      await new Promise<void>(r=>limited.once('listening',r));const a=limited.address();assert.ok(a&&typeof a!=='string');
      try{for(let i=0;i<61;i++){
        const response:Response=await fetch(`http://127.0.0.1:${a.port}/api/v1/demo/sessions`,{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':`192.0.2.${i}`},body:JSON.stringify({account_id:accounts[0].id})});assert.equal(response.status,i<60?201:429);
      }}finally{await new Promise<void>(r=>limited.close(()=>r()));}
    });
    await t.test('M3 review snapshot includes linked evidence and actor names without cross-tenant disclosure',async()=>{
      const {order,receipt,v}=await manual();
      const snapshot=await ok(`/orders/${order.id}/review`);
      assert.equal(snapshot.order.id,order.id);assert.equal(snapshot.verification.id,v.id);
      assert.equal(snapshot.receipts[0].id,receipt.id);assert.equal(snapshot.receipts[0].storage_key,undefined);
      assert.equal(snapshot.bank_transactions[0].id,v.result.matched_transaction_id);
      assert.ok(snapshot.events.every((e:any)=>typeof e.actor_name==='string'));
      assert.equal((await call(`/orders/${order.id}/review`,cashier)).status,200);
      const denied=await call(`/orders/${order.id}/review`,other);assert.equal(denied.status,404);
      assert.ok(!JSON.stringify(await denied.json()).includes(order.external_id));
    });
  }finally{
    if(server)await new Promise<void>(r=>server!.close(()=>r()));await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();
  }
});
