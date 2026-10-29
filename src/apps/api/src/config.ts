import { z } from 'zod';
import { extractorModeSchema } from '../../../packages/contracts/src/index.js';

const schema = z.object({
  TELEGRAM_ENABLED:z.enum(['true','false']).default('false'),
  TELEGRAM_INTAKE_MODE:z.enum(['allowlist','demo_link']).default('allowlist'),
  TELEGRAM_MAX_IMAGES_PER_HOUR:z.coerce.number().int().min(1).max(100).default(10),
  TELEGRAM_MAX_TENANT_IMAGES_PER_DAY:z.coerce.number().int().min(1).max(1000).default(100),
  TELEGRAM_MAX_GLOBAL_IMAGES_PER_DAY:z.coerce.number().int().min(1).max(1000).default(200),
  TELEGRAM_MAX_STARTS_PER_HOUR:z.coerce.number().int().min(1).max(100).default(30),
  TELEGRAM_TENANT_ID:z.uuid().optional(),
  TELEGRAM_CONNECTOR_ID:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default('team-bot'),
  TELEGRAM_BOT_TOKEN:z.string().min(10).optional(),
  TELEGRAM_WEBHOOK_SECRET:z.string().min(32).max(256).optional(),
  TELEGRAM_BOT_USERNAME:z.string().regex(/^[A-Za-z0-9_]{5,32}$/).optional(),
  TELEGRAM_ALLOWED_SENDERS:z.string().regex(/^\d+(,\d+)*$/).optional(),
  INTAKE_HMAC_SECRET:z.string().min(32).optional(),
  GOOGLE_FORM_ENABLED:z.enum(['true','false']).default('false'),
  GOOGLE_FORM_TENANT_ID:z.uuid().optional(),
  GOOGLE_FORM_CONNECTOR_ID:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default('team-form'),
  GOOGLE_FORM_INGEST_KEY:z.string().min(32).max(256).optional(),
  GOOGLE_FORM_PREFILL_URL:z.url().refine(s=>s.startsWith('https://docs.google.com/forms/')&&s.includes('{token}')).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  DEMO_MODE: z.literal('true').default('true'),
  EXTRACTOR_MODE: extractorModeSchema.default('fixture'),
  STORAGE_DRIVER: z.enum(['local','replit']).default('local'),
  REPLIT_STORAGE_BUCKET_ID:z.string().min(1).optional(),
  REPLIT_STORAGE_PREFIX:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).default('paysah-receipts-v1'),
  WORKER_IDLE_MAX_MS:z.coerce.number().int().min(1000).max(60000).default(30000),
  DATABASE_URL: z.string().url().optional(),
  // Deployment launcher only: apply db/migrations and the idempotent synthetic seed before starting. Demo databases only.
  AUTO_MIGRATE: z.enum(['true','false']).default('false'),
  UPLOAD_ACCESS_KEY:z.preprocess(v=>v===''?undefined:v,z.string().min(32).max(256).optional()),
  RECEIPT_STORAGE_DIR:z.string().min(1).optional(),
  // runpod mode: GPU vision on a RunPod Serverless vLLM endpoint, CPU OCR as fallback. Key stays server-side.
  RUNPOD_API_KEY:z.preprocess(v=>v===''?undefined:v,z.string().min(10).max(200).optional()),
  RUNPOD_ENDPOINT_ID:z.preprocess(v=>v===''?undefined:v,z.string().regex(/^[A-Za-z0-9_-]{4,64}$/).optional()),
  RUNPOD_MODEL:z.string().min(1).max(200).default('Qwen/Qwen2.5-VL-7B-Instruct'),
  // With the 15 s model lookup and up to 30 s of CPU reading this stays inside the 180 s job lease.
  RUNPOD_TIMEOUT_MS:z.coerce.number().int().min(5000).max(80000).default(75000),
}).superRefine((value,ctx)=>{
  if(value.TELEGRAM_ENABLED==='true'&&(!value.TELEGRAM_TENANT_ID||!value.TELEGRAM_BOT_TOKEN||!value.TELEGRAM_WEBHOOK_SECRET||!value.TELEGRAM_BOT_USERNAME||!value.INTAKE_HMAC_SECRET||(value.TELEGRAM_INTAKE_MODE==='allowlist'&&!value.TELEGRAM_ALLOWED_SENDERS)))ctx.addIssue({code:'custom',message:'Telegram needs explicit tenant, bot, secret, sender HMAC and an allowlist in allowlist mode'});
  if(value.GOOGLE_FORM_ENABLED==='true'&&(!value.GOOGLE_FORM_TENANT_ID||!value.GOOGLE_FORM_INGEST_KEY||!value.GOOGLE_FORM_PREFILL_URL))ctx.addIssue({code:'custom',message:'Google Form needs explicit tenant, key and prefilled URL'});
  if(value.STORAGE_DRIVER==='replit'&&!value.REPLIT_STORAGE_BUCKET_ID)ctx.addIssue({code:'custom',path:['REPLIT_STORAGE_BUCKET_ID'],message:'Explicit private bucket required'});
  if(value.EXTRACTOR_MODE==='runpod'&&(!value.RUNPOD_API_KEY||!value.RUNPOD_ENDPOINT_ID))ctx.addIssue({code:'custom',path:['RUNPOD_API_KEY'],message:'runpod mode requires RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID'});
});
export function readConfig(env: NodeJS.ProcessEnv) { return schema.parse(env); }
export type Config = ReturnType<typeof readConfig>;
