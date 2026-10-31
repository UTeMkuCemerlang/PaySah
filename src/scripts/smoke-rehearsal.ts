import {chromium,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {withFinalistEnvironment} from './finalist-environment.js';

// Walks docs/DEMO_REHEARSAL.md in a real browser on a disposable local schema: rejection, approval, release and two shops.
const report=`evaluation/finalist/rehearsal-${new Date().toISOString().replaceAll(':','-')}`;await mkdir(report,{recursive:true});
const owner='20000000-0000-4000-8000-000000000001',laundryOwner='20000000-0000-4000-8000-000000000005';
await withFinalistEnvironment(async(base,pool)=>{
 await pool.query(await readFile('fixtures/finalist/laundry.sql','utf8'));await pool.query(await readFile('fixtures/finalist/bakery.sql','utf8'));
 const main=randomUUID();
 await pool.query("INSERT INTO orders(id,tenant_id,external_id,total_sen) VALUES ($1,'10000000-0000-4000-8000-000000000001','REHEARSAL-780',78000)",[main]);
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL??'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('dialog',d=>void d.accept());page.on('pageerror',e=>errors.push(e.message));
  const site=base.replace('/api/v1',''),shot=(name:string)=>page.screenshot({path:resolve(report,`${name}.png`),fullPage:true,animations:'disabled'});
  const status=async(category:string)=>expect(page.getByTestId('status-now')).toContainText(category,{timeout:12000});
  async function signIn(account:string){await page.goto(site);await page.getByLabel('Demo account').selectOption(account);await page.getByRole('button',{name:'Open workspace'}).click();await expect(page.getByRole('heading',{name:'Orders',exact:true})).toBeVisible();}
  async function swap(account:string,order:string){await page.getByRole('button',{name:'Switch account',exact:true}).click();await signIn(account);await page.goto(`${site}/#orders/${order}`);}
  const click=(name:string)=>page.getByRole('button',{name,exact:true}).click();
  async function attachAndCheck(fixture:string){await page.getByLabel('Synthetic receipt',{exact:true}).selectOption(fixture);await click('Attach synthetic receipt');await status('Ready to check');await click('Run checks');await expect(page.getByRole('status').filter({hasText:'Checks completed'})).toBeVisible();}

  await signIn(owner);await page.goto(`${site}/#orders/${main}`);await status('No receipt yet');
  await attachAndCheck('high_value');await status('Ready to confirm');await shot('1-ready');
  await click('Correct fields');await expect(page.locator('.correction-compare')).toBeVisible();await shot('4-correction-compare');await click('Cancel');
  await page.getByLabel('I checked the independent demo bank credit.').check();await click('Confirm payment');await status('Waiting for release');
  await click('Release order');await status('Complete');
  const story=page.getByTestId('order-story');await expect(story).toContainText('Payment confirmed');await expect(story).toContainText('Demo A Owner released the order');
  await expect(page.getByText('Payment status: Unpaid → Paid')).toBeVisible();await shot('5-order-record');

  await page.goto(`${site}/#orders/41000000-0000-4000-8000-000000000300`);await attachAndCheck('bakery_300');await status('Ready to confirm');await shot('6-bakery-300');
  await swap(laundryOwner,'41000000-0000-4000-8000-000000000301');await attachAndCheck('laundry_300');await status('Ready to confirm');await shot('7-laundry-300');
  await expect(page.locator('.intake-links')).toContainText('not connected to this shop');
  assert.deepEqual(errors,[]);
  await writeFile(resolve(report,'results.json'),JSON.stringify({status:'PASS',mode:'LOCAL_FIXTURE',browser_errors:0},null,2)+'\n');
  console.log(`PASS: main route, order record and a second shop (local fixture). ${report}`);
 }finally{await browser.close();}
},{webRoot:resolve('dist/web')});
