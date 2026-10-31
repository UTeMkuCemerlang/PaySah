import {chromium,expect,type Browser,type Page} from '@playwright/test';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,sep,basename} from 'node:path';
import {performance} from 'node:perf_hooks';
import pg from 'pg';
import assert from 'node:assert/strict';
import {migrate,seed} from './database.js';

assert.ok(process.env.TEST_DATABASE_URL,'Dedicated TEST_DATABASE_URL required');
const schema=`web_${randomUUID().replaceAll('-','')}`,storageRoot=resolve('.local',`web_images_${randomUUID()}`);
const databaseUrl=new URL(process.env.TEST_DATABASE_URL);databaseUrl.searchParams.set('options',`-c search_path=${schema}`);
const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,connectionTimeoutMillis:3000});
let pool:pg.Pool|undefined,browser:Browser|undefined,page:Page|undefined;
const processes:ChildProcess[]=[],results:Array<{name:string;status:string;duration_ms:number}>=[],pageErrors:string[]=[];
const reportDir=resolve('evaluation/m3');await mkdir(reportDir,{recursive:true});
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const base='http://127.0.0.1:43131';
const env={...process.env,DATABASE_URL:databaseUrl.toString(),RECEIPT_STORAGE_DIR:storageRoot,EXTRACTOR_MODE:'fixture',HOST:'127.0.0.1'};
async function start(port:string,mode:string){
  const child=spawn(process.execPath,[resolve('dist/apps/api/src/server.js')],{env:{...env,PORT:port,EXTRACTOR_MODE:mode},windowsHide:true,stdio:['ignore','ignore','ignore']});processes.push(child);
  let lastStatus='not reachable';
  for(let n=0;n<300;n++){
    if(child.exitCode!==null)throw Error('API startup failed');
    try{const response=await fetch(`http://127.0.0.1:${port}/api/v1/ready`,{signal:AbortSignal.timeout(2000)});lastStatus=String(response.status);if(response.ok)return;}catch{}await pause(100);
  }throw Error(`API ready timeout (last HTTP status: ${lastStatus})`);
}
async function check(name:string,run:()=>Promise<void>){const start=performance.now();try{await run();results.push({name,status:'PASS',duration_ms:Math.round(performance.now()-start)});console.log(`PASS: ${name}`);}catch(e){results.push({name,status:'FAIL',duration_ms:Math.round(performance.now()-start)});throw e;}}
async function login(account:string,target=base){await page!.goto(target);await page!.getByLabel('Demo account').selectOption(account);await page!.getByRole('button',{name:'Open workspace'}).click();await expect(page!.getByRole('heading',{name:'Orders',exact:true})).toBeVisible();}
async function switchAccount(account:string){await page!.getByRole('button',{name:'Switch account'}).click();await expect(page!.getByRole('heading',{name:'Sign in to PaySah'})).toBeVisible();await page!.getByLabel('Demo account').selectOption(account);await page!.getByRole('button',{name:'Open workspace'}).click();await expect(page!.getByRole('heading',{name:'Orders',exact:true})).toBeVisible();}
async function open(reference:string){await page!.getByRole('link',{name:'Orders',exact:true}).click();await page!.getByRole('link',{name:reference,exact:true}).click();await expect(page!.getByRole('heading',{name:reference,exact:true})).toBeVisible();}
async function attach(fixture:string){await page!.getByLabel('Synthetic receipt',{exact:true}).selectOption(fixture);await page!.getByRole('button',{name:'Attach synthetic receipt'}).click();await expect(page!.getByRole('img',{name:'Original synthetic receipt'})).toBeVisible();}
async function checks(){await page!.getByRole('button',{name:'Run checks',exact:true}).click();await expect(page!.getByRole('status').filter({hasText:'Checks completed.'})).toBeVisible();}
async function create(reference:string,amount='128.00'){await page!.getByRole('link',{name:'Orders',exact:true}).click();await page!.getByRole('link',{name:'+ New order',exact:true}).click();await page!.getByLabel('Order reference').fill(reference);await page!.getByLabel('Amount due (MYR)').fill(amount);await page!.getByRole('button',{name:'Create synthetic order'}).click();await expect(page!.getByRole('heading',{name:reference,exact:true})).toBeVisible();}
const ownerA='20000000-0000-4000-8000-000000000001',cashierA='20000000-0000-4000-8000-000000000002',ownerB='20000000-0000-4000-8000-000000000003';
try{
  await admin.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:databaseUrl.toString(),connectionTimeoutMillis:3000});await migrate(pool);await seed(pool);await start('43131','fixture');
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL??'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1480,height:1040},permissions:['clipboard-read','clipboard-write']});page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));page.setDefaultTimeout(10000);
  await check('Cashier sign-in, synthetic shop isolation and exact penny input',async()=>{
    await page!.goto(base);await expect(page!).toHaveTitle('PaySah · Payment workspace');await page!.screenshot({path:resolve(reportDir,'login-desktop.png'),fullPage:true});await login(cashierA);
    await expect(page!.getByRole('link',{name:'DEMO-A-128',exact:true})).toBeVisible();await expect(page!.getByRole('link',{name:'DEMO-B-100',exact:true})).toHaveCount(0);
    await page!.getByRole('searchbox',{name:'Search orders on this page'}).fill('DEMO-A-128');
    await expect(page!.getByRole('link',{name:'DEMO-A-128',exact:true})).toBeVisible();
    await expect(page!.getByRole('link',{name:'DEMO-A-780',exact:true})).toHaveCount(0);
    await page!.getByRole('searchbox',{name:'Search orders on this page'}).fill('');
    await page!.getByRole('button',{name:/^Released/}).click();
    await expect(page!.getByRole('heading',{name:'No matching orders on this page'})).toBeVisible();
    await page!.getByRole('button',{name:/^All orders/}).click();
    await expect(page!.getByRole('link',{name:'DEMO-A-128',exact:true})).toBeVisible();
    await page!.screenshot({path:resolve(reportDir,'orders-desktop.png'),fullPage:true});
    await page!.getByRole('link',{name:'Open order',exact:true}).click();
    await expect(page!.getByRole('heading',{name:'DEMO-A-128',exact:true})).toBeVisible();
    await create('BROWSER-PENNY','0.01');await expect(page!.getByTestId('order-amount')).toHaveText('RM 0.01');
  });
  await check('Normal receipt, three evidence amounts, human payment confirmation, separate release and copy',async()=>{
    await open('DEMO-A-128');await attach('normal');await expect(page!.getByText('These fields are predefined, not OCR results.',{exact:true})).toBeVisible();
    await expect(page!.getByTestId('order-amount')).toHaveText('RM 128.00');await expect(page!.getByTestId('receipt-amount')).toHaveText('RM 128.00');await expect(page!.getByTestId('bank-amount')).toHaveText('Not established');await checks();
    await expect(page!.getByTestId('bank-amount')).toHaveText('RM 128.00');await expect(page!.getByRole('button',{name:'Confirm payment',exact:true})).toBeDisabled();
    await page!.screenshot({path:resolve(reportDir,'receipt-review-desktop.png'),fullPage:true});
    await page!.getByRole('checkbox',{name:'I checked the independent demo bank credit.'}).check();await page!.getByRole('button',{name:'Confirm payment',exact:true}).click();
    await expect(page!.getByRole('button',{name:'Release order',exact:true})).toBeVisible();await expect(page!.getByLabel('Reply draft')).toHaveValue(/RM 128.00/);
    await page!.getByRole('button',{name:'Copy draft',exact:true}).click();await expect(page!.getByRole('button',{name:'Copied',exact:true})).toBeVisible();assert.match(await page!.evaluate(()=>navigator.clipboard.readText()),/RM 128.00/);
    await page!.getByRole('button',{name:'Release order',exact:true}).click();await expect(page!.getByText('Order released. Both payment and fulfilment actions are recorded separately.',{exact:true})).toBeVisible();
    assert.equal((await pool!.query("SELECT count(*) FROM payment_allocations WHERE order_id='40000000-0000-4000-8000-000000000001'")).rows[0].count,'1');
  });
  await check('Reload restores server session and committed payment/fulfilment activity',async()=>{
    await page!.reload();await expect(page!.getByRole('heading',{name:'DEMO-A-128',exact:true})).toBeVisible();await expect(page!.getByText('Order released. Both payment and fulfilment actions are recorded separately.',{exact:true})).toBeVisible();
    await expect(page!.locator('.timeline').getByText('Payment confirmed',{exact:true})).toBeVisible();await expect(page!.getByText('Order released',{exact:true})).toBeVisible();
  });
  await check('RM780 Cashier-to-Owner handoff, disabled approval until checked and separate high-value release',async()=>{
    await open('DEMO-A-780');await attach('high_value');await checks();await expect(page!.getByRole('button',{name:'Confirm payment',exact:true})).toHaveCount(0);await expect(page!.locator('.reason-list').getByText('Above this shop’s review threshold. The Owner must review and confirm.',{exact:true})).toBeVisible();
    await page!.getByRole('button',{name:'Request Owner review',exact:true}).click();await expect(page!.getByRole('heading',{name:'Owner review pending'})).toBeVisible();
    await switchAccount(ownerA);await page!.getByRole('link',{name:'Owner reviews',exact:true}).click();await page!.getByRole('row').filter({hasText:'DEMO-A-780'}).getByRole('link',{name:'Review evidence ↗'}).click();
    await expect(page!.getByRole('button',{name:'Approve & confirm payment',exact:true})).toBeDisabled();await page!.getByLabel('Decision reason').fill('Checked the independent synthetic booked credit.');await page!.getByRole('checkbox',{name:'I checked the independent demo bank credit.'}).check();
    await page!.screenshot({path:resolve(reportDir,'owner-review-desktop.png'),fullPage:true});await page!.getByRole('button',{name:'Approve & confirm payment',exact:true}).click();await page!.getByRole('button',{name:'Release order',exact:true}).click();await expect(page!.getByText('Order released. Both payment and fulfilment actions are recorded separately.',{exact:true})).toBeVisible();
    assert.equal((await pool!.query("SELECT decided_by FROM approvals WHERE order_id='40000000-0000-4000-8000-000000000002'")).rows[0].decided_by,ownerA);
  });
  await check('Money request, scheduled, wrong account, partial, no-bank and duplicate images never expose confirmation',async()=>{
    for(const [fixture,reference]of [['money_request','BROWSER-REQUEST'],['scheduled','BROWSER-SCHEDULED'],['wrong_account','BROWSER-WRONG'],['partial','BROWSER-PARTIAL'],['no_bank','BROWSER-NO-BANK'],['normal','BROWSER-DUPLICATE']]){
      await create(reference);await attach(fixture);await checks();await expect(page!.getByText('Payment confirmation is blocked. Owner approval cannot replace missing or invalid evidence.',{exact:true})).toBeVisible();await expect(page!.getByRole('button',{name:'Confirm payment',exact:true})).toHaveCount(0);await expect(page!.getByRole('button',{name:'Release order',exact:true})).toHaveCount(0);
      await expect(page!.getByTestId('evidence-follow-up')).toContainText('keep this order unpaid and on hold');await expect(page!.getByRole('button',{name:'Request Owner review',exact:true})).toHaveCount(0);
      if(fixture==='partial'){
        await page!.screenshot({path:resolve(reportDir,'evidence-blocked-desktop.png'),fullPage:true});
        await page!.setViewportSize({width:390,height:844});assert.equal(await page!.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Blocked-evidence guidance fits mobile');
        await expect(page!.getByTestId('evidence-follow-up')).toBeVisible();await page!.screenshot({path:resolve(reportDir,'evidence-blocked-mobile.png'),fullPage:true});await page!.setViewportSize({width:1480,height:1040});
      }
        if(fixture==='money_request'){
        await page!.getByRole('button',{name:'Send evidence to Owner',exact:true}).click();await page!.getByLabel('Decision reason').fill('This image requests payment instead of proving a transfer.');await expect(page!.getByRole('button',{name:'Approve & confirm payment',exact:true})).toBeDisabled();await page!.getByRole('button',{name:'Reject receipt review',exact:true}).click();await expect(page!.getByRole('status').filter({hasText:'Receipt review rejected.'})).toBeVisible();
      }
    }
  });
  await check('Correction reason, audit history and recheck preserve no-bank blocking',async()=>{
    await open('BROWSER-NO-BANK');await page!.getByRole('button',{name:'Correct fields',exact:true}).click();await page!.getByLabel('Customer note',{exact:true}).fill('Checked by synthetic owner');await page!.getByLabel('Correction reason',{exact:true}).fill('Verified the note against the synthetic original.');await page!.getByRole('button',{name:'Save correction',exact:true}).click();await expect(page!.getByRole('status').filter({hasText:'Correction recorded.'})).toBeVisible();
    await expect(page!.getByRole('button',{name:'Confirm payment',exact:true})).toHaveCount(0);await checks();await expect(page!.locator('.reason-list').getByText('Fields were entered or corrected manually. The Owner must review.',{exact:true})).toBeVisible();await expect(page!.locator('.reason-list').getByText('No matching booked credit exists in the independent demo bank feed.',{exact:true})).toBeVisible();await expect(page!.getByText('Receipt fields corrected',{exact:true})).toBeVisible();
  });
  await check('Changed evidence returns conflict and keeps payment unconfirmed',async()=>{
    await create('BROWSER-STALE','500.01');await attach('high_value');await checks();
    const id=new URL(page!.url()).hash.split('/')[1];
    const requestReview=page!.getByRole('button',{name:'Send evidence to Owner',exact:true});
    await expect(requestReview).toBeVisible();
    await pool!.query('UPDATE orders SET version=version+1 WHERE id=$1',[id]);
    await requestReview.click();await expect(page!.getByRole('alert')).toContainText(/changed/i);
    assert.equal((await pool!.query('SELECT payment_state FROM orders WHERE id=$1',[id])).rows[0].payment_state,'UNPAID');
  });
  await check('Mobile layout fits viewport and remains operable',async()=>{
    await page!.setViewportSize({width:390,height:844});await open('DEMO-A-128');await expect(page!.getByRole('heading',{name:'DEMO-A-128',exact:true})).toBeVisible();
    assert.equal(await page!.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Page must not overflow horizontally');await page!.screenshot({path:resolve(reportDir,'receipt-review-mobile.png'),fullPage:true});await page!.setViewportSize({width:1480,height:1040});
  });
  await check('Shop switching clears evidence, blocks cross-tenant review and expires sessions safely',async()=>{
    await switchAccount(ownerB);await expect(page!.getByRole('link',{name:'DEMO-B-100',exact:true})).toBeVisible();await expect(page!.getByRole('link',{name:'DEMO-A-128',exact:true})).toHaveCount(0);
    await page!.goto(base+'/#orders/40000000-0000-4000-8000-000000000001');await expect(page!.getByRole('alert')).toHaveText('This record is unavailable for your shop.');await expect(page!.getByRole('img',{name:'Original synthetic receipt'})).toHaveCount(0);
    await pool!.query('UPDATE demo_sessions SET expires_at=now()-interval \'1 minute\' WHERE user_id=$1',[ownerB]);await page!.reload();await expect(page!.getByRole('heading',{name:'Sign in to PaySah'})).toBeVisible();
    await page!.getByLabel('Demo account').selectOption(cashierA);await page!.getByRole('button',{name:'Open workspace'}).click();await expect(page!.getByRole('heading',{name:'Orders',exact:true})).toBeVisible();await page!.goto(base+'/#approvals');await expect(page!.getByRole('heading',{name:'Owner access required'})).toBeVisible();
  });
  await check('Connection error is visible and refresh recovers real orders',async()=>{
    await page!.route('**/api/v1/orders?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'DATABASE_UNAVAILABLE'})}));await page!.getByRole('link',{name:'Orders',exact:true}).click();await expect(page!.getByRole('alert')).toContainText('demo data is temporarily unavailable');
    await page!.unroute('**/api/v1/orders?*');await page!.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page!.getByRole('link',{name:'DEMO-A-128',exact:true})).toBeVisible();
    await page!.getByRole('link',{name:'Activity',exact:true}).click();await expect(page!.getByRole('heading',{name:'Activity',exact:true})).toBeVisible();
  });
  await check('Real CPU mode polls reading state and displays actual OCR provenance',async()=>{
    await start('43132','cpu_ocr');await login(ownerA,'http://127.0.0.1:43132');await create('BROWSER-CPU');await attach('no_bank');await expect(page!.getByRole('status').filter({hasText:'Reading the receipt.'})).toBeVisible();await expect(page!.getByRole('button',{name:'Run checks',exact:true})).toBeDisabled();
    const worker=spawn(process.execPath,['--import','tsx',resolve('scripts/receipt-worker.ts'),'--once'],{env:{...env,EXTRACTOR_MODE:'cpu_ocr'},windowsHide:true,stdio:['ignore','ignore','ignore']});processes.push(worker);const timer=setTimeout(()=>worker.kill(),45000);const exit=await new Promise<number|null>((r,reject)=>{worker.once('exit',r);worker.once('error',reject);});clearTimeout(timer);assert.equal(exit,0);
    await expect(page!.getByText('Read from the image using local CPU OCR.',{exact:true})).toBeVisible({timeout:15000});await expect(page!.getByTestId('receipt-amount')).toHaveText('RM 128.00',{timeout:20000});await checks();await expect(page!.getByText('Payment confirmation is blocked. Owner approval cannot replace missing or invalid evidence.',{exact:true})).toBeVisible();await page!.screenshot({path:resolve(reportDir,'cpu-reading-desktop.png'),fullPage:true});
  });
  assert.deepEqual(pageErrors,[],'No unhandled browser page errors');
}catch(e){
  if(page)await page.screenshot({path:resolve(reportDir,'failure.png'),fullPage:true}).catch(()=>{});
  console.error(e instanceof Error?e.message:'Browser check failed');process.exitCode=1;
}finally{
  await writeFile(resolve(reportDir,'browser-checks.json'),JSON.stringify({checked_at:new Date().toISOString(),status:process.exitCode?'FAIL':'PASS',browser:'installed Chrome via Playwright',results,page_errors:pageErrors,limitations:'Synthetic data only; one desktop and one mobile viewport; not a merchant usability study or multi-browser validation.'},null,2)+'\n');
  await browser?.close();for(const child of processes)if(child.exitCode===null){const stopped=new Promise<void>(r=>child.once('exit',()=>r()));child.kill();await stopped;}
  await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();assert.ok(storageRoot.startsWith(resolve('.local')+sep)&&/^web_images_[a-f0-9-]+$/.test(basename(storageRoot)));await rm(storageRoot,{recursive:true,force:true});
}
