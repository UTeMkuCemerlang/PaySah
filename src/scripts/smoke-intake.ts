import {chromium,expect as baseExpect,type Browser,type Page} from '@playwright/test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve,sep} from 'node:path';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import type {Server} from 'node:http';
import pg from 'pg';
import sharp from 'sharp';
import {migrate,seed} from './database.js';
import {readConfig} from '../apps/api/src/config.js';
import {createApp} from '../apps/api/src/app.js';
import {LocalReceiptStorage} from '../apps/api/src/modules/receipts/storage.js';
import {processReceiptJob} from '../apps/api/src/modules/receipts/worker.js';
import {processVerificationJob} from '../apps/api/src/modules/verification/worker.js';

const expect=baseExpect.configure({timeout:20000});
assert.ok(process.env.TEST_DATABASE_URL,'Dedicated TEST_DATABASE_URL required');
const schema='web_intake_'+randomUUID().replaceAll('-',''),root=resolve('.local','web_intake_'+randomUUID()),report=resolve('evaluation/intake');
const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,connectionTimeoutMillis:3000}),storage=new LocalReceiptStorage(root);
let pool:pg.Pool|undefined,server:Server|undefined,browser:Browser|undefined,page:Page|undefined;
const results:Array<{name:string;status:string}>=[],errors:string[]=[];
await mkdir(report,{recursive:true});
try{
 await admin.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,connectionTimeoutMillis:3000});await migrate(pool);await seed(pool);
 const secret='synthetic-form-key-for-browser-only-123456';
 const config=readConfig({EXTRACTOR_MODE:'cpu_ocr',GOOGLE_FORM_ENABLED:'true',GOOGLE_FORM_TENANT_ID:'10000000-0000-4000-8000-000000000001',GOOGLE_FORM_INGEST_KEY:secret,GOOGLE_FORM_PREFILL_URL:'https://docs.google.com/forms/d/e/mock/viewform?entry.1={token}'});
 server=createApp(config,resolve('dist/web'),pool,storage).listen(0,'127.0.0.1');await new Promise<void>(r=>server!.once('listening',r));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
 async function post(path:string,body:unknown,token=''){const response=await fetch(base+'/api/v1'+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID(),'X-Intake-Key':secret},body:JSON.stringify(body)});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;}
 const login=await post('/demo/sessions',{account_id:'20000000-0000-4000-8000-000000000001'}),order=(await post('/orders',{external_id:'INTAKE-BROWSER-'+randomUUID(),total_sen:1900},login.token)).order;
 browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL??'chrome',headless:true});const context=await browser.newContext({viewport:{width:1480,height:1040}});
 await context.addInitScript(token=>sessionStorage.setItem('paysah.demo.session',token),login.token);
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);
 await page.goto(base+'/#orders/'+order.id);await expect(page.getByRole('heading',{name:order.external_id,exact:true})).toBeVisible();
 await expect(page.getByRole('img',{name:'Original synthetic receipt'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Create Telegram link'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Create mock payment link',exact:true})).toBeDisabled();await expect(page.getByText('Mock payment is not turned on for this server.')).toBeVisible();
 await page.getByRole('button',{name:'Create Google Form link',exact:true}).click();const input=page.getByLabel('Copy receipt submission link');await expect(input).toBeVisible();
 const token=new URL(await input.inputValue()).searchParams.get('entry.1');assert.ok(token);
 const img=await sharp({create:{width:60,height:40,channels:3,background:'yellow'}}).png().toBuffer();
 const accepted=await post('/intake/google-form',{response_id:'browser_first',submission_token:token,mime_type:'image/png',image_base64:img.toString('base64')});assert.equal(accepted.status,'ACCEPTED');
 // No Refresh click: the first receipt must arrive through the 10-second visible-page poll.
 await expect(page.getByRole('img',{name:'Original synthetic receipt'})).toBeVisible();await expect(page.getByTestId('intake-source')).toContainText('Google Form');
 results.push({name:'Enabled links only; first external receipt appears without manual refresh',status:'PASS'});
 await processReceiptJob(pool,storage,{extract:async()=>''});await processVerificationJob(pool,storage);
 await expect(page.getByRole('status').filter({hasText:'More evidence needed · payment remains blocked'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Confirm payment',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Release order',exact:true})).toHaveCount(0);
 await page.screenshot({path:resolve(report,'intake-desktop.png'),fullPage:true});results.push({name:'Durable auto-check updates review status; no automated payment/release',status:'PASS'});
 await page.getByRole('button',{name:'Correct fields',exact:true}).click();const reason=page.getByLabel('Correction reason');await reason.fill('Keep this independent correction draft');await reason.focus();
 const next=await sharp({create:{width:60,height:40,channels:3,background:'blue'}}).png().toBuffer();
 await post('/intake/google-form',{response_id:'browser_second',submission_token:token,mime_type:'image/png',image_base64:next.toString('base64')});
 await expect(page.getByRole('status').filter({hasText:'New evidence received. Your correction draft is preserved'})).toBeVisible();await expect(reason).toHaveValue('Keep this independent correction draft');await expect(reason).toBeFocused();
 results.push({name:'New image during editing preserves draft and keyboard focus and warns about stale evidence',status:'PASS'});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile overflow');await page.screenshot({path:resolve(report,'intake-mobile.png'),fullPage:true});
 // A cancelled old extraction can retain RUNNING on its historical receipt; it must not hold the current review in Reading.
 await pool.query("UPDATE receipts SET extraction_state='RUNNING' WHERE order_id=$1 AND id<>(SELECT current_receipt_id FROM orders WHERE id=$1)",[order.id]);
 await processReceiptJob(pool,storage,{extract:async()=>''});await processVerificationJob(pool,storage);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'More evidence needed · payment remains blocked'})).toBeVisible();
 await post('/intake/google-form',{response_id:'browser_older_image',submission_token:token,mime_type:'image/png',image_base64:img.toString('base64')});
 await expect(page.getByText('Older receipt resubmitted; current evidence unchanged.',{exact:true})).toBeVisible();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'older-image activity mobile overflow');
 await page.screenshot({path:resolve(report,'intake-older-image-mobile.png'),fullPage:true});
 results.push({name:'Older image resubmission visibly states that current evidence is unchanged',status:'PASS'});
 await page.getByRole('button',{name:'Revoke Google Form link',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Submission link revoked.'})).toBeVisible();
 results.push({name:'390px viewport has no horizontal overflow; link revocation is available',status:'PASS'});
 const state=(await pool.query('SELECT payment_state,fulfillment_state FROM orders WHERE id=$1',[order.id])).rows[0];assert.equal(state.payment_state,'UNPAID');assert.equal(state.fulfillment_state,'ON_HOLD');assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment_allocations')).rows[0].n,0);
 assert.deepEqual(errors,[]);console.log('Intake browser '+results.length+'/'+results.length+' PASS; mock channel only, no external messages or requests.');
}catch(e){if(page)await page.screenshot({path:resolve(report,'failure.png'),fullPage:true}).catch(()=>{});console.error(e instanceof Error?e.message:'Intake browser failed');process.exitCode=1;}
finally{
 await writeFile(resolve(report,'browser-checks.json'),JSON.stringify({checked_at:new Date().toISOString(),status:process.exitCode?'FAIL':'PASS',results,page_errors:errors,scope:'Local synthetic Google Form HTTP mock and fake text extractor; not Google/Telegram connectivity or real GPU evidence'},null,2)+'\n');
 await browser?.close();server?.closeAllConnections();if(server)await new Promise<void>(r=>server!.close(()=>r()));await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();assert.ok(root.startsWith(resolve('.local')+sep));await rm(root,{recursive:true,force:true});
}

