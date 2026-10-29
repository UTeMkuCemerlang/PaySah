import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {detectBuildVersion,resolveBuildVersion} from '../../scripts/build-provenance.js';
import {defaultFixture} from '../../apps/web/src/fixture-selection.js';
import {fixtures} from '../../apps/api/src/modules/verification/fixtures.js';
import {receiptFixtureLabels,APP_STAGE} from '../../packages/contracts/src/index.js';
import {withFinalistEnvironment} from '../../scripts/finalist-environment.js';

const sha='a'.repeat(40),other='b'.repeat(40);
test('build identity precedence fails closed for invalid, dirty and unverifiable source',()=>{
 assert.deepEqual(resolveBuildVersion({explicit:sha,git:{state:'dirty',commit:other},archive:other}),{commit:sha,source:'env'});
 assert.deepEqual(resolveBuildVersion({git:{state:'clean',commit:sha},archive:other}),{commit:sha,source:'git'});
 assert.deepEqual(resolveBuildVersion({git:{state:'unavailable'},archive:sha}),{commit:sha,source:'file'});
 for(const git of [{state:'dirty'},{state:'unverifiable'}] as const)assert.equal(resolveBuildVersion({git,archive:sha}).commit,'unknown');
 assert.equal(resolveBuildVersion({explicit:'invalid',git:{state:'clean',commit:sha},archive:sha}).commit,'unknown');
 assert.equal(resolveBuildVersion({git:{state:'unavailable'},archive:'invalid'}).commit,'unknown');
});
test('source archive marker and actual build writer work without Git metadata',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'paysah-build-'));
 try{
  await writeFile(join(dir,'.build-commit'),sha+'\n');assert.deepEqual(await detectBuildVersion(dir,''),{commit:sha,source:'file'});
  execFileSync(process.execPath,['--import',import.meta.resolve('tsx'),resolve('scripts/write-build-version.ts')],{cwd:dir,env:{...process.env,PAYSAH_BUILD_COMMIT:other},windowsHide:true,stdio:'pipe'});
  assert.deepEqual(JSON.parse(await readFile(join(dir,'dist/apps/api/src/build-version.json'),'utf8')),{commit:other,source:'env'});
  await writeFile(join(dir,'.build-commit'),'not-a-sha');assert.equal((await detectBuildVersion(dir,'')).commit,'unknown');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('all receipt fixtures have readable labels and matching defaults preserve exception choices',()=>{
 const catalog=Object.entries(fixtures).map(([id,fields])=>({id,fields}));
 for(const {id} of catalog){assert.ok(receiptFixtureLabels[id]);assert.notEqual(receiptFixtureLabels[id],id);assert.ok(!receiptFixtureLabels[id].includes('_300'));}
 for(const [external_id,total_sen,expected]of [['FINAL-LAUNDRY-300',30000,'laundry_300'],['FINAL-BAKERY-300',30000,'bakery_300'],['DEMO-A-128',12800,'normal']] as const)assert.equal(defaultFixture({external_id,total_sen},catalog),expected);
 assert.equal(defaultFixture({external_id:'unique-amount',total_sen:5000},catalog),'partial');
 assert.equal(defaultFixture({external_id:'ambiguous-amount',total_sen:12800},catalog),'normal');
 assert.deepEqual(catalog.filter(f=>['partial','wrong_account','scheduled','money_request','no_bank'].includes(f.id)).length,5);
});
test('health, ready and fixture metadata expose the finalist contract',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 await withFinalistEnvironment(async base=>{
  for(const endpoint of ['health','ready'])assert.equal((await (await fetch(base+'/'+endpoint)).json()).stage,APP_STAGE);
  const login=await fetch(base+'/demo/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account_id:'20000000-0000-4000-8000-000000000001'})});const token=(await login.json()).token;
  const catalog=await (await fetch(base+'/demo/receipt-fixtures',{headers:{Authorization:`Bearer ${token}`}})).json();
  for(const row of catalog.fixtures){assert.equal(row.label,receiptFixtureLabels[row.id]);assert.equal(row.amount_sen,row.fields.amount_sen);}
 });
});
