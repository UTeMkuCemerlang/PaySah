import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Server} from 'node:http';
import pg from 'pg';
import {migrate,seed} from './database.js';
import {createApp} from '../apps/api/src/app.js';
import {readConfig} from '../apps/api/src/config.js';

// This helper never contacts a hosted application or uses DATABASE_URL.
export async function withFinalistEnvironment<T>(run:(base:string,pool:pg.Pool)=>Promise<T>,options:{webRoot?:string;config?:Record<string,string>}={}){
 const url=process.env.TEST_DATABASE_URL;
 if(!url)throw Error('A dedicated TEST_DATABASE_URL is required');
 const parsed=new URL(url);
 if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))throw Error('Finalist automation is local-only');
 const admin=new pg.Pool({connectionString:url,connectionTimeoutMillis:3000});
 const schema=`finalist_${randomUUID().replaceAll('-','')}`;
 const storage=await mkdtemp(join(tmpdir(),'paysah-finalist-'));
 let pool:pg.Pool|undefined,server:Server|undefined;
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);
  parsed.searchParams.set('options',`-c search_path=${schema}`);
  pool=new pg.Pool({connectionString:parsed.toString(),connectionTimeoutMillis:3000});
  await migrate(pool);await seed(pool);
  server=createApp(readConfig({DATABASE_URL:parsed.toString(),RECEIPT_STORAGE_DIR:storage,EXTRACTOR_MODE:'fixture',...options.config}),options.webRoot,pool).listen(0,'127.0.0.1');
  await new Promise<void>((resolve,reject)=>{server!.once('listening',resolve);server!.once('error',reject);});
  const address=server.address();if(!address||typeof address==='string')throw Error('API did not bind');
  return await run(`http://127.0.0.1:${address.port}/api/v1`,pool);
 }finally{
  if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
  await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();
  await rm(storage,{recursive:true,force:true});
 }
}
