# Finalist integration and release runbook

Development uses the existing team Git checkout on branch `finalist`; application commands run from `src/`. The private development log and framework remain outside the public checkout. The starting remote main was `ffed857`; the exact formally submitted Phase 1 commit still requires team confirmation. No Phase 1 tag has been guessed or backdated.

## Local checks

Set `TEST_DATABASE_URL` to a dedicated local PostgreSQL database. Tests create disposable schemas and use synthetic records. Never supply a production URL. Run:

```sh
npm run typecheck
npm test
npm run build
npm run demo:gate
npm run mock:orbyte
npm run eval:e2e
npm run smoke:m3
npm run smoke:intake
npm run smoke:finalist
npm run smoke:deployment
```

Optional Laundry C data is in `fixtures/finalist/laundry.sql`. It is applied by isolated finalist tests, not the default application seed. It has distinct identities, account, RM300 order and credit. Any installation in a shared or production database needs a separately reviewed target and explicit data-write authorization. Synthetic PNGs are `bakery_300.png` and `laundry_300.png`; the Bakery fixture needs its own matching synthetic credit as demonstrated in the integration test. Never reuse a receipt across shops to demonstrate policy differences.

## Migration and production release

1. Record release SHA, current production/development database identities, old migration checksums and backup/recovery availability without exposing credentials.
2. Review `006_tenant_settings.sql`: new policy table and default RM500 policies for existing tenants. It does not create Laundry C. Existing 001–005 SQL bytes must stay unchanged.
3. Keep `AUTO_MIGRATE=false`; startup with true runs both migration and seed. After target verification and authorization, run **only** the project `db:migrate` for development and production, using each correct connection separately. Do not assume the normal Shell URL targets production. Verify migration records and checksums afterward.
4. Inspect Replit publish schema diff: cancel if it proposes unexpected DROP or destructive changes. Do not replace production from development or fabricate migration records.
5. Build from the chosen clean committed SHA. `/health.commit` is the build-time Git SHA when the tracked working tree is clean; it is `unknown` in source-only or dirty builds. A build copies this metadata beside the compiled API, never inferring the current remote main.
6. Review queue counts and enabled extractors/channels before starting the full deployment. The worker can process queued images and use RunPod. No paid calls, webhook changes or external messaging are implicit in this local implementation task.
7. After approved release, verify `/health`, `/ready`, commit, both process logs, login, story fallback and independently authorised synthetic workflows. Preserve dated, redacted proof. No deployment has been performed by these implementation scripts.

## Telegram rollout

Default `TELEGRAM_INTAKE_MODE=allowlist` continues to require `TELEGRAM_ALLOWED_SENDERS`. Deploy compatible code first, then deliberately select `demo_link` if approved. Do not remove the old allowlist first. `demo_link` accepts private messages only, requires a demo shop and a valid unrevoked order link, and retains webhook authentication. Sender rolling-hour and tenant/global UTC-day image reservation quotas run before download, after update deduplication. A database advisory lock serializes global reservation counting across instances. Retries of the same update reuse the reservation; quotas count logical image submissions, not actual GPU dollars or inference attempts. Existing bounded HTTP/sender gates also limit start/invalid requests and replies. Sender start quota is durable and includes its recent message attempts. Quota rejections return a recorded `RATE_LIMITED` result and are not automatically retried after a window resets.

Keep the sender HMAC secret stable. An open demo is not consent to upload real financial data; its acknowledgement asks for synthetic samples. Real external tests use only explicitly authorised accounts. CPU and fixture modes remain independent of GPU credentials.

## Actual evidence versus pending work

Raw local reports live under `src/evaluation/finalist/` and are ignored by Git. They are not real channel or personnel observations. Team members must collect file-action and timing observations with consent and anonymous IDs. Read `FINALIST_MEASUREMENT.md`; never fill missing measurements with estimates. Formal reports, signatures, sponsor redemption and current billing remain team work.
