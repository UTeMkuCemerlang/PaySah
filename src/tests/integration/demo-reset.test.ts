import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {migrate,seed} from '../../scripts/database.js';
import {createApp} from '../../apps/api/src/app.js';
import {readConfig} from '../../apps/api/src/config.js';

const url=process.env.TEST_DATABASE_URL,tenantA='10000000-0000-4000-8000-000000000001',tenantB='10000000-0000-4000-8000-000000000002';
test('Owner demo reset returns only the own synthetic shop to the seeded starting point',{skip:!url},async()=>{
 assert.ok(url);const schema='test_reset_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});let server:Server|undefined;
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);await migrate(pool);await seed(pool);
  const config=readConfig({EXTRACTOR_MODE:'fixture',TELEGRAM_ENABLED:'true',TELEGRAM_TENANT_ID:tenantA,TELEGRAM_BOT_TOKEN:'123456:synthetic-token',TELEGRAM_WEBHOOK_SECRET:'synthetic-webhook-secret-0123456789abcdef',TELEGRAM_BOT_USERNAME:'paysah_test_bot',TELEGRAM_ALLOWED_SENDERS:'1',INTAKE_HMAC_SECRET:'synthetic-hmac-secret-0123456789abcdef'});
  server=createApp(config,undefined,pool).listen(0,'127.0.0.1');await new Promise<void>(r=>server!.once('listening',r));const a=server.address();assert.ok(a&&typeof a!=='string');const base=`http://127.0.0.1:${a.port}/api/v1`;
  async function post(path:string,body:unknown,token=''){return fetch(base+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify(body)});}
  const login=async(id:string)=>(await (await post('/demo/sessions',{account_id:id})).json()).token as string;
  const owner=await login('20000000-0000-4000-8000-000000000001'),cashier=await login('20000000-0000-4000-8000-000000000002'),ownerB=await login('20000000-0000-4000-8000-000000000003');
  const order=(id:string)=>pool.query('SELECT id,payment_state,fulfillment_state,version FROM orders WHERE external_id=$1',[id]).then(r=>r.rows[0]);
  // Dirty Kedai A: extra order, receipt on the protected order, an intake link and a used order.
  assert.equal((await post('/orders',{external_id:'TEST-RESET-1',total_sen:1000,currency:'MYR'},cashier)).status,201);
  assert.equal((await post(`/orders/${(await order('DEMO-A-128')).id}/receipts`,{source:'FIXTURE',fixture_id:'partial',expected_version:1},cashier)).status,201);
  assert.equal((await post(`/orders/${(await order('DEMO-A-TG1')).id}/intake-links`,{expected_version:1,channel:'TELEGRAM'},cashier)).status,201);
  await pool.query("UPDATE orders SET payment_state='PAID',fulfillment_state='RELEASED',version=3 WHERE external_id='DEMO-A-780'");
  await post('/orders',{external_id:'TEST-RESET-B',total_sen:2000,currency:'MYR'},ownerB);
  const beforeB=(await pool.query('SELECT * FROM orders WHERE tenant_id=$1 ORDER BY id',[tenantB])).rows,activityB=(await pool.query('SELECT count(*)::int AS n FROM activity_events WHERE tenant_id=$1',[tenantB])).rows[0].n;
  assert.equal((await post('/demo/reset',{},cashier)).status,403);
  const reset=await post('/demo/reset',{},owner);assert.equal(reset.status,200);assert.deepEqual(await reset.json(),{orders:5});
  const ordersA=(await pool.query('SELECT external_id,payment_state,fulfillment_state,version,current_receipt_id FROM orders WHERE tenant_id=$1 ORDER BY external_id',[tenantA])).rows;
  assert.deepEqual(ordersA.map(o=>o.external_id),['DEMO-A-128','DEMO-A-780','DEMO-A-GF1','DEMO-A-TG1','DEMO-A-TG2']);
  assert.ok(ordersA.every(o=>o.payment_state==='UNPAID'&&o.fulfillment_state==='ON_HOLD'&&o.version===1&&o.current_receipt_id===null));
  for(const table of ['receipts','intake_links','activity_events','verifications','payment_allocations'])assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`,[tenantA])).rows[0].n,0,table);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM bank_transactions WHERE tenant_id=$1',[tenantA])).rows[0].n,6);
  assert.deepEqual((await pool.query('SELECT * FROM orders WHERE tenant_id=$1 ORDER BY id',[tenantB])).rows,beforeB);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM activity_events WHERE tenant_id=$1',[tenantB])).rows[0].n,activityB);
  // Sessions survive, and the shop works again immediately.
  assert.equal((await post(`/orders/${(await order('DEMO-A-128')).id}/receipts`,{source:'FIXTURE',fixture_id:'normal',expected_version:1},cashier)).status,201);
  // The opt-in Bakery RM300 order returns clean after a reset once installed, and only then.
  await pool.query(await readFile('fixtures/finalist/bakery.sql','utf8'));
  assert.equal((await post(`/orders/${(await order('FINAL-BAKERY-300')).id}/receipts`,{source:'FIXTURE',fixture_id:'bakery_300',expected_version:1},cashier)).status,201);
  const again=await post('/demo/reset',{},owner);assert.equal(again.status,200);assert.deepEqual(await again.json(),{orders:6});
  const bakery=await order('FINAL-BAKERY-300');assert.equal(bakery.payment_state,'UNPAID');assert.equal(bakery.version,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM receipts WHERE tenant_id=$1',[tenantA])).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM bank_transactions WHERE tenant_id=$1 AND provider_tx_id='FINAL-BAKERY-300'",[tenantA])).rows[0].n,1);
 }finally{server?.closeAllConnections();if(server)await new Promise<void>(r=>server!.close(()=>r()));await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
});
