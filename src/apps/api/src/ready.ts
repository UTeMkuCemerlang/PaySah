import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type pg from 'pg';
import { projectRoot } from './paths.js';

export async function checkReady(pool: pg.Pool) {
  const required = ['001_identity_orders.sql','002_verification.sql','003_receipt_images.sql','004_runpod_extraction.sql','005_intake.sql','006_tenant_settings.sql'];
  const expected = await Promise.all(required.map(async name => ({ name, checksum: createHash('sha256').update(await readFile(join(projectRoot,'db/migrations',name),'utf8')).digest('hex') })));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='1500ms'");
    await client.query('SELECT 1');
    const applied = await client.query('SELECT name,checksum FROM schema_migrations WHERE name=ANY($1)', [required]);
    if (!expected.every(e => applied.rows.some(a => a.name===e.name && a.checksum===e.checksum))) throw new Error('Migration mismatch');
    await client.query('COMMIT');
  } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
