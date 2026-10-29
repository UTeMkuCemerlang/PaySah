import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

assert.ok(process.env.TEST_DATABASE_URL,'Dedicated TEST_DATABASE_URL required; no production database');
assert.ok(process.env.npm_execpath,'Run using npm run verify:local');
const checkedAt=new Date().toISOString(),dir=resolve('evaluation/acceptance',checkedAt.replaceAll(':','-').replaceAll('.','-'));
await mkdir(dir,{recursive:true});
const checks:Array<{name:string;command:string[];status:'PASS'|'FAIL';exit_code:number|null;log:string;tests?:number;skipped?:number}>=[];
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const sources:Record<string,string>={};
async function collect(directory:string){
  for(const item of await readdir(directory,{withFileTypes:true})){
    const file=join(directory,item.name);
    if(item.isDirectory())await collect(file);
    else if(item.isFile())sources[file.replaceAll('\\','/')]=sha(await readFile(file));
  }
}
for(const directory of ['apps','packages','db','scripts','tests','fixtures','integrations'])await collect(directory);
for(const file of ['package.json','package-lock.json','tsconfig.json','.env.example','.replit'])sources[file]=sha(await readFile(file));
await writeFile(join(dir,'source-sha256.json'),JSON.stringify(sources,null,2)+'\n');
async function run(name:string,args:string[]){
  console.log(`Checking ${name}...`);
  const child=spawn(process.execPath,args,{cwd:process.cwd(),env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const output:Buffer[]=[];child.stdout.on('data',(data:Buffer)=>output.push(data));child.stderr.on('data',(data:Buffer)=>output.push(data));
  const timer=setTimeout(()=>child.kill('SIGKILL'),180000);
  let code:number|null;
  try{code=await new Promise((resolveExit,reject)=>{child.once('error',reject);child.once('exit',resolveExit);});}
  finally{clearTimeout(timer);}
  const text=Buffer.concat(output).toString('utf8'),log=`${name}.log`;
  await writeFile(join(dir,log),text);
  const check={name,command:['node',...args],status:code===0?'PASS' as const:'FAIL' as const,exit_code:code,log};checks.push(check);
  console.log(`${name}: ${check.status}`);
  assert.equal(code,0,`${name} failed; inspect ${dir}/${log}`);
  return text;
}
let status='RUNNING',error:string|undefined;
await writeFile(join(dir,'results.json'),JSON.stringify({checked_at:checkedAt,status,checks},null,2)+'\n');
try{
  await run('build',[process.env.npm_execpath,'run','build']);
  const testFiles=(await readdir('tests/integration')).filter(file=>file.endsWith('.test.ts')).sort().map(file=>resolve('tests/integration',file));
  const tap=await run('tests',['--import','tsx','--env-file-if-exists=.env','--test','--test-reporter=tap',...testFiles]);
  const count=(label:string)=>Number(tap.match(new RegExp(`^# ${label} (\\d+)`,'m'))?.[1]??NaN);
  assert.ok(count('tests')>0);assert.equal(count('fail'),0);assert.equal(count('skipped'),0,'Database tests must not be skipped');
  Object.assign(checks.at(-1)!,{tests:count('tests'),skipped:count('skipped')});
  await run('deployment',[process.env.npm_execpath,'run','smoke:deployment']);
  await run('browser',[process.env.npm_execpath,'run','smoke:m3']);
  const browser=JSON.parse(await readFile('evaluation/m3/browser-checks.json','utf8'));
  assert.equal(browser.status,'PASS');assert.equal(browser.results.length,11);assert.ok(browser.results.every((r:{status:string})=>r.status==='PASS'));
  assert.deepEqual(browser.page_errors,[]);assert.ok(Date.parse(browser.checked_at)>=Date.parse(checkedAt));
  await copyFile('evaluation/m3/browser-checks.json',join(dir,'browser-checks.json'));
  // Detect concurrent source edits rather than claim the old fingerprint covers them.
  for(const [file,hash]of Object.entries(sources))assert.equal(sha(await readFile(file)),hash,`Source changed during checks: ${file}`);
  status='PASS';
}catch(e){status='FAIL';error=e instanceof Error?e.message:'Local verification failed';console.error(error);process.exitCode=1;}
finally{
  await writeFile(join(dir,'results.json'),JSON.stringify({checked_at:checkedAt,finished_at:new Date().toISOString(),status,scope:'Existing Windows host, installed Node/Chrome and local PostgreSQL; not a clean install or cloud acceptance',source_manifest:'source-sha256.json',checks,error,not_run:['clean source install','Replit/cloud','merchant usability/benefit study','public links/collaborator']},null,2)+'\n');
  await writeFile('evaluation/acceptance/latest.json',JSON.stringify({run:dir.slice(process.cwd().length+1).replaceAll('\\','/'),status,checked_at:checkedAt},null,2)+'\n');
  console.log(`Evidence: ${dir}`);
}
