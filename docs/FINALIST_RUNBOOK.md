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

Optional Laundry C data is in `fixtures/finalist/laundry.sql`. It is applied by isolated finalist tests, not the default application seed. It has distinct identities, account, RM300 order and credit. Any installation in a shared or production database needs a separately reviewed target and explicit data-write authorization. Synthetic PNGs are `bakery_300.png` and `laundry_300.png`. The matching Bakery order `FINAL-BAKERY-300` and its own synthetic credit are in the opt-in `fixtures/finalist/bakery.sql`; once installed, an Owner demo reset of Kedai A restores it clean, and a shop where it was never installed keeps its original five orders. Never reuse a receipt across shops to demonstrate policy differences.

## Migration and production release

1. Record release SHA, current production/development database identities, old migration checksums and backup/recovery availability without exposing credentials.
2. Review `006_tenant_settings.sql`: new policy table and default RM500 policies for existing tenants. It does not create Laundry C. Existing 001–005 SQL bytes must stay unchanged.
3. Keep `AUTO_MIGRATE=false`; startup with true runs both migration and seed. After target verification and authorization, run **only** the project `db:migrate` for development and production, using each correct connection separately. Do not assume the normal Shell URL targets production. Verify migration records and checksums afterward.
4. Inspect Replit publish schema diff: cancel if it proposes unexpected DROP or destructive changes. Do not replace production from development or fabricate migration records.
5. Build from the chosen verified release SHA. `/health.commit` resolves valid `PAYSAH_BUILD_COMMIT` first, then clean Git HEAD, then `.build-commit` when Git metadata is unavailable. Dirty Git without explicit injection stays `unknown`, even with an old marker. Build logs record env/git/file/unknown. The explicit value asserts the actual uploaded source version and must be updated each release, never copied from remote main without checking the source. The flat `npm run replit:bundle` archive writes a marker at its app root; in a full repository deployment the marker belongs at `src/.build-commit`. A generic GitHub download does not automatically contain this generated file. Prefer a clean Git pull, a generated archive, or verified per-build env injection.
6. Review queue counts and enabled extractors/channels before starting the full deployment. The worker can process queued images and use RunPod. No paid calls, webhook changes or external messaging are implicit in this local implementation task.
7. After approved release, verify `/health`, `/ready`, commit, both process logs, login, story fallback and independently authorised synthetic workflows. Preserve dated, redacted proof. No deployment has been performed by these implementation scripts.

Before publishing, run `cd src && npm run replit:preflight` in the actual Replit environment. It checks compiled commit metadata and real App Storage as well as platform/database readiness. A local dry run cannot pass the Replit/storage checks and is not deployment proof. The cloud-check script accepts FINALIST metadata, but it creates an order/uploads a receipt and may trigger inference; it is not a read-only substitute.

## Telegram rollout

Default `TELEGRAM_INTAKE_MODE=allowlist` continues to require `TELEGRAM_ALLOWED_SENDERS`. Deploy compatible code first, then deliberately select `demo_link` if approved. Do not remove the old allowlist first. `demo_link` accepts private messages only, requires a demo shop and a valid unrevoked order link, and retains webhook authentication. Sender rolling-hour and tenant/global UTC-day image reservation quotas run before download, after update deduplication. A database advisory lock serializes global reservation counting across instances. Retries of the same update reuse the reservation; quotas count logical image submissions, not actual GPU dollars or inference attempts. Existing bounded HTTP/sender gates also limit start/invalid requests and replies. Sender start quota is durable and includes its recent message attempts. Quota rejections return a recorded `RATE_LIMITED` result and are not automatically retried after a window resets.

Keep the sender HMAC secret stable. An open demo is not consent to upload real financial data; its acknowledgement asks for synthetic samples. Real external tests use only explicitly authorised accounts. CPU and fixture modes remain independent of GPU credentials.

Demo reset preserves the current 24-hour Telegram image quota/idempotency ledger as detached `REJECTED / DEMO_RESET_IMAGE` rows: sender HMAC, update identity and timestamps remain, while order, receipt and link references and leases are cleared. Late/replayed uploads cannot recreate deleted evidence or refund quotas. A later reset removes ledger rows older than 24 hours; this is not an automatic retention scheduler. Platform spending controls are still required: these counters cap logical Telegram submissions, not all application traffic or inference dollars.

## Actual evidence versus pending work

Raw local reports live under `src/evaluation/finalist/` and are ignored by Git. They are not real channel or personnel observations. Team members must collect file-action and timing observations with consent and anonymous IDs. Read `FINALIST_MEASUREMENT.md`; never fill missing measurements with estimates. Formal reports, signatures, sponsor redemption and current billing remain team work.
