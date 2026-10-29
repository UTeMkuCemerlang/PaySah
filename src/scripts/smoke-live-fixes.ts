import {chromium,expect} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {withFinalistEnvironment} from './finalist-environment.js';

const report=`evaluation/finalist/live-fixes-${new Date().toISOString().replaceAll(':','-')}`;await mkdir(report,{recursive:true});
await withFinalistEnvironment(async(base,pool)=>{
 await pool.query(await readFile('fixtures/finalist/laundry.sql','utf8'));
 const bakery=randomUUID(),otherLaundry=randomUUID();
 await pool.query("INSERT INTO orders(id,tenant_id,external_id,total_sen) VALUES ($1,'10000000-0000-4000-8000-000000000001','FINAL-BAKERY-300',30000),($2,'10000000-0000-4000-8000-000000000003','LAUNDRY-OTHER-128',12800)",[bakery,otherLaundry]);
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL??'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const site=base.replace('/api/v1','');
  async function login(account:string){await page.goto(site);await page.getByLabel('Demo account').selectOption(account);await page.getByRole('button',{name:'Open workspace',exact:true}).click();await expect(page.getByRole('heading',{name:'Orders',exact:true})).toBeVisible();}
  const menu=page.getByLabel('Synthetic receipt',{exact:true});
  async function open(id:string,expected:string){await page.goto(`${site}/#orders/${id}`);await expect(menu).toHaveValue(expected);const labels=await menu.locator('option').allTextContents();assert.equal(labels.length,9);assert.ok(labels.every(label=>!label.includes('_300')));await expect(page.getByLabel('Reply draft')).toHaveValue(/not received a payment receipt/);assert.equal((await pool.query('SELECT count(*)::int AS n FROM receipts WHERE order_id=$1',[id])).rows[0].n,0);}
  await login('20000000-0000-4000-8000-000000000006');await open('41000000-0000-4000-8000-000000000301','laundry_300');
  await page.screenshot({path:resolve(report,'laundry-default.png'),fullPage:true,animations:'disabled'});
  await menu.selectOption('partial');await page.waitForResponse(r=>r.url().endsWith('/41000000-0000-4000-8000-000000000301/review')&&r.status()===200,{timeout:12000});await expect(menu).toHaveValue('partial');
  await open(otherLaundry,'normal');
  await page.getByRole('button',{name:'Switch account',exact:true}).click();await login('20000000-0000-4000-8000-000000000002');
  await open(bakery,'bakery_300');await page.screenshot({path:resolve(report,'bakery-default.png'),fullPage:true,animations:'disabled'});
  await open('40000000-0000-4000-8000-000000000001','normal');
  const logout=page.waitForResponse(r=>r.request().method()==='DELETE'&&r.url().endsWith('/api/v1/session'));await page.getByRole('button',{name:'Switch account',exact:true}).click();assert.equal((await logout).status(),204);
  assert.deepEqual(errors,[]);await writeFile(resolve(report,'results.json'),JSON.stringify({status:'PASS',defaults:['laundry_300','bakery_300','normal'],manual_selection_preserved:true,no_auto_attach:true,logout:204,page_errors:errors},null,2)+'\n');
  console.log(`PASS: fixture labels/defaults/manual choice, no automatic attachment, state-specific draft and logout 204. ${report}`);
 }finally{await browser.close();}
},{webRoot:resolve('dist/web')});
