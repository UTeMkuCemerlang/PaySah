import { webRoot } from './paths.js';
import {APP_STAGE} from '../../../packages/contracts/src/index.js';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import pg from 'pg';
import {startEmbeddedMockPay} from './mock-pay-process.js';

const parsed = (() => {
  try { return readConfig(process.env); }
  catch { console.error('Invalid configuration. Check .env.example; demo fixture/manual/cpu_ocr only.'); process.exit(1); }
})();
const pool = parsed.DATABASE_URL ? new pg.Pool({ connectionString: parsed.DATABASE_URL, connectionTimeoutMillis: 3000 }) : undefined;
pool?.on('error', () => console.error('Database connection interrupted.'));
const server = createApp(parsed, webRoot, pool).listen(parsed.PORT, parsed.HOST, () => {
  console.log(`PaySah ${APP_STAGE}: http://${parsed.HOST}:${parsed.PORT} (demo / ${parsed.EXTRACTOR_MODE})`);
  process.send?.({type:'ready',role:'api'});
});
const mockPay=parsed.MOCK_PAY_PUBLIC_URL?startEmbeddedMockPay(parsed,parsed.PORT):undefined;
let closing=false;
function shutdown(){
  if(closing)return;closing=true;mockPay?.stop();
  server.close(async()=>{try{await pool?.end();process.exit(0);}catch{process.exit(1);}});
  setTimeout(()=>process.exit(1),5000).unref();
}
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,shutdown);
process.on('message',(value:unknown)=>{if((value as {type?:string})?.type==='shutdown')shutdown();});
