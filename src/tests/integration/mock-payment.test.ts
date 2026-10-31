import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {createHmac,randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {setTimeout as wait} from 'node:timers/promises';
import pg from 'pg';
import {migrate,seed} from '../../scripts/database.js';
import {createApp} from '../../apps/api/src/app.js';
import {readConfig} from '../../apps/api/src/config.js';
import {startEmbeddedMockPay} from '../../apps/api/src/mock-pay-process.js';

const url=process.env.TEST_DATABASE_URL;
const freePort=()=>new Promise<number>(done=>{const s=createServer().listen(0,'127.0.0.1',()=>{const a=s.address();s.close(()=>done(typeof a==='object'&&a?a.port:0));});});

test('Mock customer payment: signed event becomes evidence, rules decide, a person still confirms',{skip:!url},async t=>{
 const admin=new pg.Pool({connectionString:url,connectionTimeoutMillis:3000}),schema=`test_${randomUUID().replaceAll('-','')}`;
 const key='synthetic-mock-key',secret='synthetic-mock-secret',providerPort=await freePort();
 let pool:pg.Pool|undefined,server:Server|undefined,disabled:Server|undefined,provider:ChildProcess|undefined;
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const parsed=new URL(url!);parsed.searchParams.set('options',`-c search_path=${schema}`);
  pool=new pg.Pool({connectionString:parsed.toString(),connectionTimeoutMillis:3000});await migrate(pool);await seed(pool);
  const listen=async(extra:Record<string,string>)=>{const s=createApp(readConfig({DATABASE_URL:parsed.toString(),EXTRACTOR_MODE:'fixture',...extra}),undefined,pool).listen(0,'127.0.0.1');await new Promise<void>(r=>s.once('listening',r));const a=s.address();assert.ok(a&&typeof a!=='string');return {s,base:`http://127.0.0.1:${a.port}/api/v1`};};
  const on=await listen({MOCK_PAY_URL:`http://127.0.0.1:${providerPort}`,MOCK_PAY_API_KEY:key,MOCK_PAY_WEBHOOK_SECRET:secret}),off=await listen({});server=on.s;disabled=off.s;
  provider=spawn(process.execPath,['integrations/mock-payment/PaySah_Amount_Mock.cjs'],{env:{...process.env,PORT:String(providerPort),BASE_URL:`http://127.0.0.1:${providerPort}`,MOCK_API_KEY:key,WEBHOOK_SECRET:secret,PAYSAH_WEBHOOK_URL:`${on.base}/intake/mock-payment`},stdio:'ignore'});
  for(let i=0;i<50;i++){try{if((await fetch(`http://127.0.0.1:${providerPort}/`)).ok)break;}catch{}await wait(100);}
  const call=async(path:string,token:string,body?:unknown,base=on.base)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const login=async(account_id:string)=>(await call('/demo/sessions','',{account_id})).body.token;
  const owner=await login('20000000-0000-4000-8000-000000000001'),cashier=await login('20000000-0000-4000-8000-000000000002'),other=await login('20000000-0000-4000-8000-000000000003');
  const order=async(total_sen:number)=>(await call('/orders',owner,{external_id:`PAY-${randomUUID()}`,total_sen})).body.order;
  const link=async(id:string)=>{const r=await call(`/orders/${id}/payment-links`,cashier,{expected_version:1});assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(r.body.synthetic,true);return r.body.url as string;};
  const pay=async(payment:string,amount:string)=>fetch(`${payment}/complete`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({amount})});
  const paid=async(total:number,amount:string)=>{
   const o=await order(total),payment=await link(o.id);assert.equal((await fetch(payment)).status,200);
   const done=await pay(payment,amount);assert.equal(done.status,200);assert.match(await done.text(),/accepted by the configured PaySah callback/);
   const review=(await call(`/orders/${o.id}/review`,owner)).body,receipt=review.receipts[0];assert.equal(receipt.fixture_id,'MOCK_PAYMENT');
   assert.equal(review.order.payment_state,'UNPAID');
   const verification=(await call(`/orders/${o.id}/verifications`,cashier,{receipt_id:receipt.id,expected_version:1})).body.verification;
   return {o,payment,verification};
  };

  await t.test('full payment matches but is not paid until a person confirms',async()=>{
   const {o,verification}=await paid(12800,'128.00');
   assert.equal(verification.result.eligible,true);assert.equal(verification.result.required_role,'CASHIER');assert.deepEqual(verification.result.flags,[]);
   assert.equal((await call(`/orders/${o.id}`,owner)).body.order.payment_state,'UNPAID');
   const confirmed=await call(`/verifications/${verification.id}/confirm`,cashier,{expected_version:1});assert.equal(confirmed.status,200);
   const state=(await call(`/orders/${o.id}`,owner)).body.order;assert.equal(state.payment_state,'PAID');assert.equal(state.fulfillment_state,'ON_HOLD');
  });
  await t.test('underpayment and overpayment stay blocked, even for the Owner',async()=>{
   for(const [amount,flag] of [['50.00','PARTIAL_PAYMENT'],['200.00','OVERPAYMENT']] as const){
    const {verification}=await paid(12800,amount);
    assert.equal(verification.result.eligible,false);assert.ok(verification.result.flags.includes(flag));
    const denied=await call(`/verifications/${verification.id}/confirm`,owner,{expected_version:1});assert.equal(denied.status,409);assert.equal(denied.body.code,'EVIDENCE_BLOCKED');
   }
  });
  await t.test('short payment: Owner records it, the same order takes another payment, and the total settles it',async()=>{
   const {o,verification}=await paid(12800,'50.00');
   assert.equal(verification.result.partial_eligible,true);
   assert.equal((await call(`/verifications/${verification.id}/record-partial`,cashier,{expected_version:1})).status,403);
   const recorded=await call(`/verifications/${verification.id}/record-partial`,owner,{expected_version:1});assert.equal(recorded.status,200);
   assert.equal(recorded.body.order.payment_state,'PARTIALLY_PAID');assert.equal(recorded.body.order.fulfillment_state,'ON_HOLD');
   assert.equal((await call(`/orders/${o.id}/release`,owner,{expected_version:2})).status,409);
   const second=await call(`/orders/${o.id}/payment-links`,cashier,{expected_version:2});assert.equal(second.status,201);
   assert.equal((await pay(second.body.url,'100.00')).status,200);
   const tooMuch=(await call(`/orders/${o.id}/review`,owner)).body.receipts[0];
   const over=(await call(`/orders/${o.id}/verifications`,cashier,{receipt_id:tooMuch.id,expected_version:2})).body.verification;
   assert.ok(over.result.flags.includes('OVERPAYMENT'));assert.equal(over.result.eligible,false);assert.equal(over.result.due_sen,7800);
   const third=await call(`/orders/${o.id}/payment-links`,cashier,{expected_version:2});assert.equal((await pay(third.body.url,'78.00')).status,200);
   const rest=(await call(`/orders/${o.id}/review`,owner)).body.receipts[0];
   const final=(await call(`/orders/${o.id}/verifications`,cashier,{receipt_id:rest.id,expected_version:2})).body.verification;
   assert.equal(final.result.eligible,true);assert.equal(final.result.required_role,'CASHIER');
   const confirmed=await call(`/verifications/${final.id}/confirm`,cashier,{expected_version:2});assert.equal(confirmed.status,200);assert.equal(confirmed.body.order.payment_state,'PAID');
   const allocations=(await pool!.query('SELECT sum(amount_sen)::int AS total,count(*)::int AS n FROM payment_allocations WHERE order_id=$1',[o.id])).rows[0];assert.deepEqual(allocations,{total:12800,n:2});
  });
  await t.test('Owner can accept a difference only after a real credit, with a reason, and it is never shown as fully paid',async()=>{
   const {o,verification}=await paid(12000,'110.00');
   assert.equal((await call(`/orders/${o.id}/accept-shortfall`,owner,{expected_version:1,reason:'Regular customer'})).status,409);
   assert.equal((await call(`/verifications/${verification.id}/record-partial`,owner,{expected_version:1})).status,200);
   assert.equal((await call(`/orders/${o.id}/accept-shortfall`,cashier,{expected_version:2,reason:'Regular customer'})).status,403);
   assert.equal((await call(`/orders/${o.id}/accept-shortfall`,owner,{expected_version:2,reason:''})).status,422);
   const accepted=await call(`/orders/${o.id}/accept-shortfall`,owner,{expected_version:2,reason:'Regular customer'});assert.equal(accepted.status,200);assert.equal(accepted.body.order.payment_state,'MANUALLY_CONFIRMED');
   assert.equal((await call(`/orders/${o.id}/release`,cashier,{expected_version:3})).status,403);
   const released=await call(`/orders/${o.id}/release`,owner,{expected_version:3});assert.equal(released.status,200);assert.equal(released.body.order.fulfillment_state,'RELEASED');assert.equal(released.body.order.payment_state,'MANUALLY_CONFIRMED');
   const logged=(await call(`/activity?order_id=${o.id}&limit=50`,owner)).body.events.find((e:any)=>e.action==='payment.shortfall_accepted');assert.equal(logged.payload.shortfall_sen,1000);assert.equal(logged.payload.reason,'Regular customer');
  });
  await t.test('no bank credit means no part payment, even for the Owner',async()=>{
   const o=await order(12800),receipt=(await call(`/orders/${o.id}/receipts`,owner,{source:'FIXTURE',fixture_id:'no_bank',expected_version:1})).body.receipt;
   const v=(await call(`/orders/${o.id}/verifications`,owner,{receipt_id:receipt.id,expected_version:1})).body.verification;
   assert.equal(v.result.partial_eligible,false);
   const denied=await call(`/verifications/${v.id}/record-partial`,owner,{expected_version:1});assert.equal(denied.status,409);assert.equal(denied.body.code,'EVIDENCE_BLOCKED');
   assert.equal((await call(`/orders/${o.id}/accept-shortfall`,owner,{expected_version:1,reason:'Trust the customer'})).status,409);
   assert.equal((await call(`/orders/${o.id}/release`,owner,{expected_version:1})).status,409);
  });
  await t.test('a large payment still needs the Owner',async()=>{
   const {verification}=await paid(78000,'780.00');assert.equal(verification.result.eligible,true);assert.equal(verification.result.required_role,'OWNER');
   assert.equal((await call(`/verifications/${verification.id}/confirm`,cashier,{expected_version:1})).status,403);
  });
  await t.test('a link is single use, and another shop cannot create one',async()=>{
   const {o,payment}=await paid(12800,'128.00');assert.equal((await pay(payment,'128.00')).status,409);
   assert.equal((await call(`/orders/${o.id}/payment-links`,other,{expected_version:1})).status,404);
   assert.equal((await pool!.query('SELECT count(*)::int AS n FROM receipts WHERE order_id=$1',[o.id])).rows[0].n,1);
  });
  const signed=(payload:string,signature=createHmac('sha256',secret).update(payload).digest('hex'),base=on.base)=>fetch(`${base}/intake/mock-payment`,{method:'POST',headers:{'Content-Type':'application/json','X-Mock-Signature':signature},body:payload});
  const event=(id:string,amount=128,reference=`MOCK-${randomUUID()}`)=>JSON.stringify({synthetic:true,provider:'PAYSAH_MOCK',orderId:id,merchantId:'10000000-0000-4000-8000-000000000001',bank:'DEMO BANK',amount,currency:'MYR',bankTransactionRef:reference,customerReference:'X',recipientAccount:'DEMO-ACCOUNT-A',occurredAt:new Date().toISOString(),status:'SUCCESS',documentType:'TRANSFER_RECEIPT'});
  await t.test('webhook rejects a bad signature and changed content, and a replay adds nothing',async()=>{
   const o=await order(12800),payload=event(o.id),count=async()=>(await pool!.query('SELECT count(*)::int AS n FROM bank_transactions WHERE bank_transaction_ref=$1',[JSON.parse(payload).bankTransactionRef])).rows[0].n;
   assert.equal((await signed(payload,'0'.repeat(64))).status,401);
   assert.equal((await signed(payload.replace('128','999'),createHmac('sha256',secret).update(payload).digest('hex'))).status,401);
   assert.equal(await count(),0);
   assert.equal((await signed(payload)).status,200);
   const again=await signed(payload);assert.equal(again.status,200);assert.equal((await again.json()).replayed,true);assert.equal(await count(),1);
  });
  await t.test('webhook refuses a real-looking event: not synthetic, wrong account, or a paid order',async()=>{
   const o=await order(12800);
   assert.equal((await signed(JSON.stringify({...JSON.parse(event(o.id)),synthetic:false}))).status,422);
   assert.equal((await signed(JSON.stringify({...JSON.parse(event(o.id)),recipientAccount:'DEMO-WRONG-ACCOUNT'}))).status,422);
   const done=await paid(12800,'128.00');await call(`/verifications/${done.verification.id}/confirm`,cashier,{expected_version:1});
   assert.equal((await signed(event(done.o.id))).status,409);
  });
  await t.test('embedded simulator: customer pages through the API, and the API survives it stopping',async()=>{
   const appPort=await freePort(),localPort=await freePort(),publicUrl=`http://127.0.0.1:${appPort}`;
   const config=readConfig({DATABASE_URL:parsed.toString(),EXTRACTOR_MODE:'fixture',MOCK_PAY_URL:`http://127.0.0.1:${localPort}`,MOCK_PAY_PUBLIC_URL:publicUrl,MOCK_PAY_API_KEY:key,MOCK_PAY_WEBHOOK_SECRET:secret});
   const embedded=createApp(config,undefined,pool).listen(appPort,'127.0.0.1');await new Promise<void>(r=>embedded.once('listening',r));
   const running=startEmbeddedMockPay(config,appPort,200),api=`${publicUrl}/api/v1`;
   try{
    const up=async(path:string,want:number)=>{for(let i=0;i<60;i++){const r=await fetch(publicUrl+path).catch(()=>null);if(r?.status===want)return true;await wait(100);}return false;};
    assert.equal(await up('/pay/00000000-0000-4000-8000-000000000000',404),true);
    const o=await order(12800),created=await call(`/orders/${o.id}/payment-links`,cashier,{expected_version:1},api);assert.equal(created.status,201);assert.ok(created.body.url.startsWith(`${publicUrl}/pay/`));
    assert.equal((await fetch(created.body.url)).status,200);assert.equal((await pay(created.body.url,'128.00')).status,200);
    assert.equal((await call(`/orders/${o.id}/review`,owner,undefined,api)).body.receipts[0].fixture_id,'MOCK_PAYMENT');
    running.kill();await wait(50);
    assert.equal((await fetch(`${api}/health`)).status,200);
    assert.equal(await up('/pay/00000000-0000-4000-8000-000000000000',404),true);
    const again=await order(12800);assert.equal((await call(`/orders/${again.id}/payment-links`,cashier,{expected_version:1},api)).status,201);
    assert.throws(()=>readConfig({DATABASE_URL:url,MOCK_PAY_URL:'https://example.test',MOCK_PAY_PUBLIC_URL:publicUrl,MOCK_PAY_API_KEY:key,MOCK_PAY_WEBHOOK_SECRET:secret}));
   }finally{running.stop();await new Promise<void>(r=>embedded.close(()=>r()));}
  });
  await t.test('without configuration the routes are off',async()=>{
   const o=await order(12800);
   assert.equal((await call(`/orders/${o.id}/payment-links`,cashier,{expected_version:1},off.base)).status,404);
   assert.equal((await signed(event(o.id),undefined,off.base)).status,404);
   assert.throws(()=>readConfig({DATABASE_URL:url,MOCK_PAY_URL:'http://127.0.0.1:1'}));
  });
 }finally{
  provider?.kill();
  for(const s of [server,disabled])if(s)await new Promise<void>(r=>s.close(()=>r()));
  await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();
 }
});
