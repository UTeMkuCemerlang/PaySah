import {mkdir,writeFile,access,readFile} from 'node:fs/promises';
import {APP_STAGE} from '../packages/contracts/src/index.js';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import {readConfig} from '../apps/api/src/config.js';
import {checkReady} from '../apps/api/src/ready.js';
import {createReceiptStorage} from '../apps/api/src/modules/receipts/storage-factory.js';
import {imageHash} from '../apps/api/src/modules/receipts/storage.js';

// Run in the Replit Shell after build, migrate and seed. Records names and PASS/FAIL only, never secret values.
// Probe tenant is not a real tenant; its single object is written, read back and deleted.
const PROBE_TENANT='00000000-0000-4000-8000-0000000000ff';
const checks:Array<{name:string;status:'PASS'|'FAIL';detail:string}>=[];
async function check(name:string,run:()=>Promise<string>){
  try{checks.push({name,status:'PASS',detail:await run()});}
  catch(e){checks.push({name,status:'FAIL',detail:(e as Error).message.slice(0,200)});}
}
const env=process.env;
await check('running on Replit',async()=>{if(!env.REPL_ID)throw Error('REPL_ID not set; run this in the Replit Shell');return 'REPL_ID present';});
await check('Node 24',async()=>{if(!process.version.startsWith('v24.'))throw Error(`found ${process.version}`);return process.version;});
await check('platform',async()=>`${process.platform}-${process.arch}`);
await check('required variables are set',async()=>{
  const missing=['DATABASE_URL','REPLIT_STORAGE_BUCKET_ID'].filter(k=>!env[k]);
  if(missing.length)throw Error(`missing: ${missing.join(', ')}`);
  if(env.EXTRACTOR_MODE!=='cpu_ocr'&&env.EXTRACTOR_MODE!=='runpod')throw Error(`EXTRACTOR_MODE=${env.EXTRACTOR_MODE??'unset'}, expected runpod or cpu_ocr`);
  if(env.EXTRACTOR_MODE==='runpod'&&(!env.RUNPOD_API_KEY||!env.RUNPOD_ENDPOINT_ID))throw Error('runpod mode: RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID must be set as Secrets');
  if(env.STORAGE_DRIVER!=='replit')throw Error(`STORAGE_DRIVER=${env.STORAGE_DRIVER??'unset'}, expected replit`);
  if(env.HOST!=='0.0.0.0')throw Error(`HOST=${env.HOST??'unset'}, expected 0.0.0.0`);
  return `DATABASE_URL, REPLIT_STORAGE_BUCKET_ID set; ${env.EXTRACTOR_MODE}; replit storage; HOST 0.0.0.0`;
});
await check('configuration parses',async()=>{const c=readConfig(env);return `prefix ${c.REPLIT_STORAGE_PREFIX}; upload ${c.UPLOAD_ACCESS_KEY?'enabled':'disabled'}`;});
await check('compiled deployment entry exists',async()=>{await access(resolve('dist/apps/api/src/deployment.js'));await access(resolve('dist/web/index.html'));return 'dist present';});
await check('compiled commit metadata',async()=>{const meta=JSON.parse(await readFile(resolve('dist/apps/api/src/build-version.json'),'utf8'));if(!/^[0-9a-f]{40}$/.test(meta.commit))throw Error('Build commit is unknown; build verified source with PAYSAH_BUILD_COMMIT or a clean Git checkout/archive marker');return `commit ${meta.commit}; source ${meta.source??'legacy'}`;});
await check('sharp native module',async()=>{const png=await sharp({create:{width:8,height:8,channels:3,background:'#ffffff'}}).png().toBuffer();return `sharp ${sharp.versions.sharp}, ${png.length} byte probe`;});
await check('English OCR language data',async()=>{const {langPath}=createRequire(import.meta.url)('@tesseract.js-data/eng') as {langPath:string};await access(resolve(langPath,'eng.traineddata.gz'));return 'eng.traineddata.gz present';});
await check('database and migrations 001–006',async()=>{
  const pool=new pg.Pool({connectionString:env.DATABASE_URL,connectionTimeoutMillis:5000});
  try{await checkReady(pool);const n=(await pool.query("SELECT count(*) FROM orders WHERE external_id LIKE 'DEMO-%'")).rows[0].count;return `ready; ${n} seeded demo orders`;}
  finally{await pool.end();}
});
await check('private App Storage write/read/delete',async()=>{
  const config=readConfig(env);if(config.STORAGE_DRIVER!=='replit')throw Error('STORAGE_DRIVER is not replit; local disk is not App Storage');
  const storage=createReceiptStorage(config),bytes=await sharp({create:{width:4,height:4,channels:3,background:'#000000'}}).png().toBuffer();
  const key=await storage.put(PROBE_TENANT,bytes);
  try{const back=await storage.read(key);if(imageHash(back)!==imageHash(bytes))throw Error('read-back hash mismatch');}
  finally{await storage.remove(key);}
  return 'round trip matched SHA-256 and probe object removed';
});
const report={kind:'replit preflight; no secret values recorded',stage:APP_STAGE,at:new Date().toISOString(),passed:checks.filter(c=>c.status==='PASS').length,total:checks.length,checks};
// Off Replit (local dry run) nothing is written into the proof folder.
const dir=resolve(env.REPL_ID?'submission/proof/replit':'.local/replit-preflight-dry-run');await mkdir(dir,{recursive:true});
const file=resolve(dir,`preflight-${report.at.replaceAll(':','-').replace('.','-')}.json`);
await writeFile(file,JSON.stringify(report,null,2)+'\n');
for(const c of checks)console.log(`${c.status}: ${c.name} — ${c.detail}`);
console.log(`${report.passed}/${report.total} PASS. Saved ${file}`);
if(report.passed!==report.total)process.exitCode=1;
