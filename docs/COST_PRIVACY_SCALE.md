# Cost, privacy and scale notes

Statements here come from the code and repository files. Anything not measured is marked "not measured"; anything not built is marked "planned". This is not legal advice and not a compliance certification.

## Cost

| Component | Billing basis | Where it appears |
| --- | --- | --- |
| Replit Reserved VM | Platform plan or credits | `docs/FINALIST_RUNBOOK.md` |
| PostgreSQL | Platform database | `src/apps/api/src/config.ts` (`DATABASE_URL`) |
| App Storage | Private bucket for receipt images | `STORAGE_DRIVER=replit`, `replit-storage.ts` |
| RunPod serverless | Per-second GPU time, per request | `EXTRACTOR_MODE=runpod`, `runpod.ts`, `runpod/README.md` |
| CPU OCR fallback | Runs on the VM, no separate charge | `src/apps/api/src/modules/receipts/ocr.ts` |

No per-receipt cost is stated. The formula, once data exists:

```
cost per receipt = (RunPod spend + attributable share of Replit spend) / receipts processed
```

Inputs must come from billing records for one stated period: RunPod console spend and request count, Replit billing for the same dates, and the receipt count from the database. A change in account balance, or whole-account usage, is not per-receipt cost.

| Value | Period | Figure |
| --- | --- | --- |
| RunPod spend | not measured | not measured |
| RunPod request count | not measured | not measured |
| Replit spend | not measured | not measured |
| Receipts processed | not measured | not measured |
| Cost per receipt | not measured | not measured |

Pricing is a hypothesis for the team to set: a per-shop monthly subscription. No amount has been decided.

Budget controls: RunPod active workers 0 and a short idle timeout (`runpod/README.md`), and CPU fallback when the endpoint fails (`fallback_reason` in `receipt.extracted`). Telegram quotas limit logical image submissions, not dollars (`docs/FINALIST_RUNBOOK.md`).

## Privacy

Synthetic business data (shops, orders, receipts, bank accounts) is fictional. Real identifiers and logs are different: Telegram user ids, chat metadata, webhook and server logs, and any real receipt image a person sends. The demo acknowledgement asks for synthetic samples only; a real receipt sent to RunPod leaves Replit for inference, so real receipts must not be used in the demo.

What the code does:

- Private image storage: objects are stored under tenant-prefixed keys with no public URL (`storage.ts`, `replit-storage.ts`). Images are served only through an authenticated route, with `Cache-Control: no-store` and an integrity hash check (`receipts/router.ts`).
- Sender hashing: Telegram sender ids are stored as an HMAC-SHA256 digest keyed by `INTAKE_HMAC_SECRET` (`intake/telegram.ts`). The secret must stay stable and is not in the repository.
- API responses carry `Cache-Control: no-store` (`app.ts`, `business.ts`, `intake/router.ts`).
- Tenant isolation: every query filters by `tenant_id`; cross-shop reads return 404.
- Orphan cleanup: `npm run storage:cleanup` removes stored objects older than 24 hours that no receipt row references (`receipts/cleanup.ts`). It does not delete receipts a shop still holds.

Mapping to the PDPA 2010 principles:

| Principle | Implemented | Planned |
| --- | --- | --- |
| General | Synthetic-only demo | Lawful-basis review |
| Notice and Choice | Synthetic-sample acknowledgement in the Telegram demo | Formal privacy notice and consent flow |
| Disclosure | Images go to RunPod only when `EXTRACTOR_MODE=runpod` | Processor terms and disclosure list |
| Security | Private storage, HMAC sender hash, no-store, tenant isolation, role checks | Security review |
| Retention | Orphan-object cleanup; reset keeps a 24-hour quota ledger | Automatic retention scheduler (none exists; the runbook says reset is not one) |
| Data Integrity | Correction history keeps before and after fields; image hash check | Data quality procedure |
| Access | Owner and Cashier roles | Data subject access and deletion procedure |

## Scale

Current implementation:

- One Replit VM, one API process, one receipt worker process that handles one extraction at a time (`receipts/worker.ts`, `worker-loop.ts`).
- Mutations take a per-tenant advisory lock named `m2:<tenant>` (`router.ts`, `worker.ts`), so writes within a shop are serialized.
- Receipt jobs use a database lease: a job is claimable when `PENDING` or when `RUNNING` with an expired lease. The lease is 180 seconds; a job that has been attempted twice becomes `ERROR` with `LEASE_EXHAUSTED`.
- Idle workers back off from 1 second up to 30 seconds.

Path to scale:

| Step | Status |
| --- | --- |
| More worker processes on the same lease queue | Planned; the lease and advisory lock are designed for it, but multi-worker runs are not tested |
| RunPod autoscaling beyond the current endpoint settings | Planned; not tested |
| Load on the shared per-tenant lock with many concurrent shops | not tested |

Throughput, latency under load and maximum shops are not measured; no repository file records them.
