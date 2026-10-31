import {chromium,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {withFinalistEnvironment} from './finalist-environment.js';

// Walks docs/DEMO_REHEARSAL.md in a real browser on a disposable local schema: rejection, approval, release and two shops.
const report=`evaluation/finalist/rehearsal-${new Date().toISOString().replaceAll(':','-')}`;await mkdir(report,{recursive:true});
const owner='20000000-0000-4000-8000-000000000001',cashier='20000000-0000-4000-8000-000000000002',laundryCashier='20000000-0000-4000-8000-000000000006';
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

  await signIn(cashier);await page.goto(`${site}/#orders/${main}`);await status('No receipt yet');
  await attachAndCheck('high_value');await status('Needs the Owner');await shot('1-needs-owner');
  await click('Request Owner review');await status('Waiting for the Owner');

  await swap(owner,main);await status('Owner decision');
  const summary=page.getByTestId('decision-summary');await expect(summary).toContainText('RM 780.00');await expect(summary).toContainText('DEMO-BANK-780');await expect(summary).toContainText('Evidence still current');
  await expect(page.getByText('Approving confirms payment. Release is still a separate step.')).toBeVisible();await shot('2-owner-summary');
  await page.getByLabel('Decision reason').fill('Bank credit needs a second look');await click('Reject receipt review');await status('Rejected');
  await expect(page.getByTestId('rejected-review')).toContainText('Bank credit needs a second look');

  await swap(cashier,main);await status('Rejected');await shot('3-rejected-cashier');
  await click('Correct fields now');await expect(page.locator('.correction-compare')).toBeVisible();await shot('4-correction-compare');await click('Cancel');
  await click('Run checks');await status('Needs the Owner');await click('Request Owner review');await status('Waiting for the Owner');

  await swap(owner,main);await status('Owner decision');
  await page.getByLabel('Decision reason').fill('Credit matches the receipt');await page.getByLabel('I checked the independent demo bank credit.').check();await click('Approve & confirm payment');await status('Waiting for release');
  await click('Release order');await status('Complete');
  const story=page.getByTestId('order-story');await expect(story).toContainText('Demo A Cashier requested Owner review');await expect(story).toContainText('Demo A Owner rejected');await expect(story).toContainText('Demo A Owner approved');await expect(story).toContainText('Payment confirmed');await expect(story).toContainText('Demo A Owner released the order');
  await expect(page.getByText('Payment status: Unpaid → Paid')).toBeVisible();await shot('5-order-record');

  await swap(cashier,'41000000-0000-4000-8000-000000000300');await attachAndCheck('bakery_300');await status('Ready to confirm');await shot('6-bakery-300');
  await swap(laundryCashier,'41000000-0000-4000-8000-000000000301');await attachAndCheck('laundry_300');await status('Needs the Owner');await shot('7-laundry-300');
  // The Owner lowers the bakery limit, the same RM300 now needs the Owner, and a reset restores the demo.
  await swap(owner,'41000000-0000-4000-8000-000000000300');await page.getByRole('link',{name:'Shop settings',exact:true}).click();
  await expect(page.getByTestId('review-limit')).toHaveText('RM 500.00');await shot('8-shop-settings');
  await page.getByLabel('New Owner review limit (MYR)').fill('200.00');await page.getByLabel('Reason for this change').fill('Rehearse a lower limit');await click('Save limit');
  await expect(page.getByTestId('review-limit')).toHaveText('RM 200.00');
  await page.goto(`${site}/#orders/41000000-0000-4000-8000-000000000300`);await status('Ready to check');await click('Run checks');await status('Needs the Owner');
  await page.goto(`${site}/#activity`);await expect(page.getByText('Review above: RM 500.00 → RM 200.00')).toBeVisible();await shot('9-limit-in-activity');
  await swap(cashier,main);await expect(page.getByRole('link',{name:'Shop settings',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Switch account',exact:true}).click();await signIn(laundryCashier);await page.goto(`${site}/#orders/41000000-0000-4000-8000-000000000301`);await expect(page.locator('.intake-links')).toContainText('not connected to this shop');
  assert.deepEqual(errors,[]);
  await writeFile(resolve(report,'results.json'),JSON.stringify({status:'PASS',mode:'LOCAL_FIXTURE',browser_errors:0},null,2)+'\n');
  console.log(`PASS: main route, rejection route, order record and two-shop policy difference (local fixture). ${report}`);
 }finally{await browser.close();}
},{webRoot:resolve('dist/web')});
