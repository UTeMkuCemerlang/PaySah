import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {readConfig} from '../../apps/api/src/config.js';

test('AUTO_MIGRATE is off by default and must be exactly true or false',()=>{
  assert.equal(readConfig({}).AUTO_MIGRATE,'false');
  assert.equal(readConfig({AUTO_MIGRATE:'true'}).AUTO_MIGRATE,'true');
  assert.throws(()=>readConfig({AUTO_MIGRATE:'yes'}));
});

const url=process.env.TEST_DATABASE_URL;
test('deployment launcher prepares an empty database when AUTO_MIGRATE=true, from another working directory',{skip:!url&&process.env.npm_lifecycle_event!=='test:db'},async()=>{
  assert.ok(url,'TEST_DATABASE_URL required');
  const schema=`test_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString:url,connectionTimeoutMillis:3000});
  const scoped=new URL(url);scoped.searchParams.set('options',`-c search_path=${schema}`);
  let child:ReturnType<typeof spawn>|undefined;
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const env={...process.env,DATABASE_URL:scoped.toString(),AUTO_MIGRATE:'true',EXTRACTOR_MODE:'fixture',STORAGE_DRIVER:'local',HOST:'127.0.0.1',PORT:'43161',REPL_ID:'',REPLIT_DEPLOYMENT:''};
    child=spawn(process.execPath,[resolve('dist/apps/api/src/deployment.js')],{cwd:tmpdir(),env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    child.stdout?.on('data',()=>{});child.stderr?.on('data',()=>{});
    let ready=false;child.on('message',m=>{if((m as {type?:string}).type==='ready')ready=true;});
    for(let n=0;n<200&&!ready;n++){if(child.exitCode!==null)throw Error('Launcher exited before ready');await new Promise(r=>setTimeout(r,100));}
    assert.ok(ready,'launcher did not become ready on an empty database');
    const scopedPool=new pg.Pool({connectionString:scoped.toString()});
    try{
      assert.equal((await scopedPool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n,7);
      assert.equal((await scopedPool.query("SELECT count(*)::int AS n FROM users WHERE role IN ($role$OWNER$role$,$role$CASHIER$role$)")).rows[0].n,4);
    }finally{await scopedPool.end();}
  }finally{
    if(child&&child.exitCode===null){const ended=new Promise<void>(r=>child!.once('exit',()=>r()));child.send?.({type:'shutdown'});await ended;}
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();
  }
});
