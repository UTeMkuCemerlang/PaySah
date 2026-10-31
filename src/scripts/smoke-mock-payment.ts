import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {withFinalistEnvironment} from './finalist-environment.js';

// The Owner sends a mock link, a customer pays too little and then the full amount, on a disposable local schema.
const report=`evaluation/finalist/mock-payment-${new Date().toISOString().replaceAll(':','-')}`;await mkdir(report,{recursive:true});
const providerPort=await new Promise<number>(done=>{const s=createServer().listen(0,'127.0.0.1',()=>{const a=s.address();s.close(()=>done(typeof a==='object'&&a?a.port:0));});});
const key='synthetic-mock-key',secret='synthetic-mock-secret',tenant='10000000-0000-4000-8000-000000000001';
await withFinalistEnvironment(async(base,pool)=>{
 const provider=spawn(process.execPath,['integrations/mock-payment/PaySah_Amount_Mock.cjs'],{env:{...process.env,PORT:String(providerPort),BASE_URL:`http://127.0.0.1:${providerPort}`,MOCK_API_KEY:key,WEBHOOK_SECRET:secret,PAYSAH_WEBHOOK_URL:`${base}/intake/mock-payment`},stdio:'ignore'});
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL??'chrome',headless:true});
 try{
  for(let i=0;i<50;i++){try{if((await fetch(`http://127.0.0.1:${providerPort}/`)).ok)break;}catch{}await wait(100);}
  const refused=randomUUID(),short=randomUUID(),full=randomUUID(),split=randomUUID(),shortfall=randomUUID();
  await pool.query("INSERT INTO orders(id,tenant_id,external_id,total_sen) VALUES ($1,$3,'MOCK-SHORT-128',12800),($2,$3,'MOCK-FULL-128',12800),($4,$3,'MOCK-SPLIT-128',12800),($5,$3,'MOCK-SHORT-120',12000),($6,$3,'MOCK-REFUSED-128',12800)",[short,full,tenant,split,shortfall,refused]);
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors:string[]=[];const prompts:string[]=[];page.on('dialog',d=>{prompts.push(d.message());void d.accept();});page.on('pageerror',e=>errors.push(e.message));
  const site=base.replace('/api/v1',''),shot=(name:string,p=page)=>p.screenshot({path:resolve(report,`${name}.png`),fullPage:true,animations:'disabled'});
  const status=(category:string)=>expect(page.getByTestId('status-now')).toContainText(category,{timeout:12000});
  const click=(name:string)=>page.getByRole('button',{name,exact:true}).click();
  await page.goto(site);await page.getByLabel('Demo account').selectOption('20000000-0000-4000-8000-000000000001');await click('Open workspace');await expect(page.getByRole('heading',{name:'Orders',exact:true})).toBeVisible();
  async function customerPays(order:string,amount:string,name:string,auto=false){
   await page.goto(`${site}/#orders/${order}`);
   await expect(page.getByRole('region',{name:'Receipt submission links'}).getByRole('button',{name:'Create mock payment link',exact:true})).toBeEnabled();await click('Create mock payment link');const link=await page.getByLabel('Mock payment link').inputValue();await shot(`${name}-link`);
   const customer=await context.newPage();await customer.goto(link);await customer.getByLabel('Amount (RM)').fill(amount);await shot(`${name}-customer`,customer);
   await customer.getByRole('button',{name:'Pay Now (Demo)'}).click();await expect(customer.getByRole('heading',{name:'Payment Submitted'})).toBeVisible();await expect(customer.getByText('accepted by the configured PaySah callback')).toBeVisible();await shot(`${name}-customer-receipt`,customer);await customer.close();
   if(auto){await expect(page.getByRole('status').filter({hasText:'New payment checked against the balance'})).toBeVisible({timeout:12000});return;}
   await status('Ready to check');await expect(page.getByText('Mock customer payment',{exact:true})).toBeVisible();await click('Run checks');await expect(page.getByRole('status').filter({hasText:'Checks completed'})).toBeVisible();
  }
  // The customer misses a zero. The Owner refuses it, and the same order still takes the right amount.
  await customerPays(refused,'12.80','0-missed-zero');await status('Short payment');await expect(page.getByTestId('short-payment')).toContainText('Short by RM 115.20');await page.getByLabel('Reason for rejecting').fill('Customer missed a zero');await shot('0-short-panel');await click('Reject this payment');await status('Rejected');await expect(page.getByTestId('rejected-review')).toContainText('Customer missed a zero');await shot('0-rejected');
  await customerPays(refused,'128.00','0-right-amount');await status('Ready to confirm');await shot('0-right-amount-ready');
  await customerPays(short,'50.00','1-short');await status('Short payment');await expect(page.getByRole('button',{name:'Confirm payment',exact:true})).toHaveCount(0);await shot('1-short-blocked');
  await customerPays(full,'128.00','2-full');await status('Ready to confirm');await shot('2-full-ready');
  await page.getByLabel('I checked the independent demo bank credit.').check();await click('Confirm payment');await status('Waiting for release');await click('Release order');await status('Complete');
  await expect(page.getByTestId('order-story')).toContainText('Customer paid by mock link');await shot('3-complete');
  // Short payment, recorded, then the rest on the same order.
  await customerPays(split,'50.00','4-split-first');await status('Short payment');await click('Keep RM 50.00 and open another submission');await status('Part paid');await expect(page.getByTestId('part-paid')).toContainText('RM 50.00 of RM 128.00');await shot('4-split-part-paid');
  await customerPays(split,'78.00','5-split-rest',true);await status('Ready to confirm');await expect(page.getByTestId('part-paid')).toContainText('RM 50.00 + RM 78.00 = RM 128.00');await expect(page.getByTestId('bank-amount')).toHaveText('RM 128.00');await expect(page.getByText('Ask the customer for the remaining')).toHaveCount(0);await expect(page.getByLabel('Reply draft')).not.toHaveValue(/send the rest/,{timeout:12000});await shot('5-split-combined');await page.getByLabel('I checked the independent demo bank credit.').check();await click('Confirm payment');await status('Waiting for release');await click('Release order');await status('Complete');await shot('5-split-complete');
  // RM110 on RM120: the Owner accepts the difference after a prompt.
  await customerPays(shortfall,'110.00','6-shortfall');await click('Keep RM 110.00 and open another submission');await status('Part paid');
  await page.getByLabel('Reason for approving anyway').fill('Regular customer, small difference');await shot('6-shortfall-form');await click('Approve anyway');await status('Waiting for release');
  assert.ok(prompts.some(p=>p.startsWith('Think twice before you approve this anyway')),'prompt not shown');await expect(page.getByText('The Owner approved this with RM 110.00 of RM 120.00',{exact:false})).toBeVisible();await click('Release order');await status('Complete');await expect(page.getByText('Not covered by bank evidence: RM 10.00')).toBeVisible();await shot('6-shortfall-complete');
  assert.deepEqual(errors,[]);
  await writeFile(resolve(report,'results.json'),JSON.stringify({status:'PASS',mode:'LOCAL_MOCK_PROVIDER',browser_errors:0},null,2)+'\n');
  console.log(`PASS: mock link, customer short payment blocked, full payment matched then confirmed and released by a person; part payment settled over two payments; difference accepted after a prompt (local). ${report}`);
 }finally{await browser.close();provider.kill();}
},{webRoot:resolve('dist/web'),config:{MOCK_PAY_URL:`http://127.0.0.1:${providerPort}`,MOCK_PAY_API_KEY:key,MOCK_PAY_WEBHOOK_SECRET:secret}});
