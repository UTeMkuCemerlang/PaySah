import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {withFinalistEnvironment} from './finalist-environment.js';

const reportDir='evaluation/finalist/ui';await mkdir(reportDir,{recursive:true});
await withFinalistEnvironment(async(base,pool)=>{
 await pool.query(await readFile('fixtures/finalist/laundry.sql','utf8'));
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL??'chrome',headless:true});
 const errors:string[]=[];
 try{
  const context=await browser.newContext({viewport:{width:1480,height:1040}}),other=await browser.newContext({viewport:{width:1480,height:1040}});
  const activity=await context.newPage(),decision=await other.newPage();
  for(const p of [activity,decision])p.on('pageerror',e=>errors.push(e.message));
  async function login(page:typeof activity,account='20000000-0000-4000-8000-000000000001'){
   await page.goto(base.replace('/api/v1',''));await page.getByLabel('Demo account').selectOption(account);await page.getByRole('button',{name:'Open workspace',exact:true}).click();await expect(page.getByRole('heading',{name:'Orders',exact:true})).toBeVisible();
  }
  const loginResponse=await fetch(base+'/demo/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account_id:'20000000-0000-4000-8000-000000000001'})});const token=(await loginResponse.json()).token;
  async function api(path:string,body:unknown){const r=await fetch(base+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify(body)});const b=await r.json();assert.ok(r.ok,JSON.stringify(b));return b;}
  const order=(await api('/orders',{external_id:`FINAL-UI-${randomUUID()}`,total_sen:78000})).order;
  const receipt=(await api(`/orders/${order.id}/receipts`,{source:'FIXTURE',fixture_id:'high_value',expected_version:1})).receipt;
  const v=(await api(`/orders/${order.id}/verifications`,{receipt_id:receipt.id,expected_version:1})).verification;
  await api(`/verifications/${v.id}/approval-requests`,{expected_version:1});
  await login(activity);await activity.getByRole('link',{name:'Activity',exact:true}).click();
  await login(decision);await decision.goto(base.replace('/api/v1','')+`/#orders/${order.id}`);
  await expect(decision.getByLabel('Decision reason')).toBeVisible();await decision.getByLabel('Decision reason').fill('Synthetic owner rejection; draft survives polling');
  // Observe a real completed poll rather than using a fixed sleep.
  await decision.waitForResponse(r=>r.url().endsWith(`/orders/${order.id}/review`)&&r.status()===200,{timeout:12000});
  await expect(decision.getByLabel('Decision reason')).toHaveValue('Synthetic owner rejection; draft survives polling');
  const started=performance.now();await decision.getByRole('button',{name:'Reject receipt review',exact:true}).click();
  await expect(activity.getByText('Owner decision: Rejected',{exact:true})).toBeVisible({timeout:12000});
  const observedMs=Math.round(performance.now()-started);
  await activity.screenshot({path:resolve(reportDir,'activity-desktop.png'),fullPage:true});
  await decision.screenshot({path:resolve(reportDir,'owner-rejected.png'),fullPage:true});
  for(let i=0;i<23;i++)await api('/orders',{external_id:`FINAL-PAGE-${i}-${randomUUID()}`,total_sen:100});
  await activity.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(activity.getByRole('button',{name:'Next',exact:true})).toBeEnabled();
  const pageLoaded=activity.waitForResponse(r=>r.url().includes('/activity?limit=21&offset=20')&&r.status()===200,{timeout:10000});
  await activity.getByRole('button',{name:'Next',exact:true}).click();await pageLoaded;
  await expect(activity.getByText('Page 2',{exact:true})).toBeVisible();
  const before=await activity.locator('.timeline').innerText();
  await api('/orders',{external_id:`FINAL-NEW-${randomUUID()}`,total_sen:100});
  await expect(activity.getByRole('button',{name:'Show latest',exact:true})).toBeVisible({timeout:12000});
  assert.equal(await activity.locator('.timeline').innerText(),before);
  await activity.getByRole('button',{name:'Show latest',exact:true}).click();await expect(activity.getByText('Page 1',{exact:true})).toBeVisible();
  const mobile=await browser.newContext({viewport:{width:390,height:844}}),phone=await mobile.newPage();
  await login(phone,'20000000-0000-4000-8000-000000000006');await expect(phone.getByLabel('Shop settings')).toContainText('RM 200.00');
  await phone.screenshot({path:resolve(reportDir,'laundry-mobile.png'),fullPage:true});
  assert.ok(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await mobile.close();assert.deepEqual(errors,[]);
  await writeFile(resolve(reportDir,'results.json'),JSON.stringify({status:'PASS',owner_rejection_observed_ms:observedMs,draft_preserved:true,pagination_stable:true,laundry_mobile:true,page_errors:errors},null,2)+'\n');
  console.log(`PASS: two-window rejection visible in ${observedMs}ms, draft preserved across poll, stable pagination, Laundry mobile.`);
 }finally{await browser.close();}
},{webRoot:resolve('dist/web')});
