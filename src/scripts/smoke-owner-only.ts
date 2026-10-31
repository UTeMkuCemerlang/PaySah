import {chromium,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {withFinalistEnvironment} from './finalist-environment.js';

// A shop owner working alone, on a disposable local schema: small payment, large payment, rejection and a blocked receipt.
const report=`evaluation/finalist/owner-only-${new Date().toISOString().replaceAll(':','-')}`;await mkdir(report,{recursive:true});
const tenant='10000000-0000-4000-8000-000000000001',owner='20000000-0000-4000-8000-000000000001';
await withFinalistEnvironment(async(base,pool)=>{
 await pool.query(await readFile('fixtures/finalist/bakery.sql','utf8'));
 const small=randomUUID(),large=randomUUID(),blocked=randomUUID();
 await pool.query("INSERT INTO orders(id,tenant_id,external_id,total_sen) VALUES ($1,$4,'OWNER-SMALL-128',12800),($2,$4,'OWNER-LARGE-780',78000),($3,$4,'OWNER-NOBANK-128',12800)",[small,large,blocked,tenant]);
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL??'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('dialog',d=>void d.accept());page.on('pageerror',e=>errors.push(e.message));
  const site=base.replace('/api/v1',''),shot=(name:string)=>page.screenshot({path:resolve(report,`${name}.png`),fullPage:true,animations:'disabled'});
  const status=async(category:string)=>expect(page.getByTestId('status-now')).toContainText(category,{timeout:12000});
  const click=(name:string)=>page.getByRole('button',{name,exact:true}).click();
  const open=(id:string)=>page.goto(`${site}/#orders/${id}`);
  async function check(fixture:string){await page.getByLabel('Synthetic receipt',{exact:true}).selectOption(fixture);await click('Attach synthetic receipt');await status('Ready to check');await click('Run checks');await expect(page.getByRole('status').filter({hasText:'Checks completed'})).toBeVisible();}
  await page.goto(site);await page.getByLabel('Demo account').selectOption(owner);await click('Open workspace');await expect(page.getByRole('heading',{name:'Orders',exact:true})).toBeVisible();

  // Small and clean: the owner still confirms, without the longer review.
  await open(small);await check('normal');await status('Ready to confirm');await shot('1-small-ready');
  await page.getByLabel('I checked the independent demo bank credit.').check();await click('Confirm payment');await status('Waiting for release');await click('Release order');await status('Complete');

  // Large: no separate review. The Owner confirms directly, after the think-twice prompt.
  await open(large);await check('high_value');await status('Ready to confirm');await expect(page.getByRole('button',{name:'Request Owner review',exact:true})).toHaveCount(0);await shot('2-large-ready');
  await page.getByLabel('I checked the independent demo bank credit.').check();await click('Confirm payment');await status('Waiting for release');await click('Release order');await status('Complete');await shot('4-large-complete');

  // A receipt with no bank credit: the Owner can approve it anyway. It is recorded and never shown as paid.
  await open(blocked);await check('no_bank');await status('No bank match');await expect(page.getByRole('button',{name:'Confirm payment',exact:true})).toHaveCount(0);await shot('5-no-bank');
  await page.getByLabel('Reason for approving anyway').fill('Owner knows this customer');await click('Approve anyway');await status('Waiting for release');await expect(page.getByTestId('owner-override')).toHaveCount(0);await click('Release order');await status('Complete');await expect(page.getByTestId('order-story')).toContainText('approved anyway');await shot('6-no-bank-approved-anyway');
  for(const name of ['Owner reviews','Shop settings'])await expect(page.getByRole('link',{name,exact:true})).toHaveCount(0);

  assert.deepEqual(errors,[]);
  await writeFile(resolve(report,'results.json'),JSON.stringify({status:'PASS',mode:'LOCAL_FIXTURE',browser_errors:0},null,2)+'\n');
  console.log(`PASS: one Owner account completed the small, large and approved-anyway routes (local fixture). ${report}`);
 }finally{await browser.close();}
},{webRoot:resolve('dist/web')});
