import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../apps/api/src/app.js';
import { readConfig } from '../../apps/api/src/config.js';
import { healthSchema,APP_STAGE } from '../../packages/contracts/src/index.js';
import {resolve} from 'node:path';

for (const mode of ['fixture', 'manual']) {
  test(`${mode} health runs without database or GPU keys; writes are unavailable`, async () => {
    const server = createApp(readConfig({ EXTRACTOR_MODE: mode })).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      const response = await fetch(`${base}/api/v1/health`);
      assert.equal(response.status, 200);
      const health = healthSchema.parse(await response.json());
      assert.equal(health.extractor_mode, mode);
      assert.equal(health.database, 'not_configured');
      assert.equal(health.stage,APP_STAGE);
      const write = await fetch(`${base}/api/v1/orders`, { method: 'POST' });
      assert.equal(write.status, 503);
    } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  });
}
test('unsupported production and RunPod modes fail closed', () => {
  assert.throws(() => readConfig({ DEMO_MODE: 'false' }));
  assert.throws(() => readConfig({ EXTRACTOR_MODE: 'runpod' }));
});

test('private receipt files cannot be configured under public web assets',()=>{
  assert.throws(()=>createApp(readConfig({RECEIPT_STORAGE_DIR:resolve('dist/web/receipts')}),resolve('dist/web')),/outside the public web directory/);
});
