# Local evidence

These reports were generated locally on 30 October 2026 from source commit `a97d56f7fd0e14b80cb1386d4b9dc4d8c53a5302`, using a dedicated local PostgreSQL test database and synthetic records. They contacted no production system, RunPod endpoint or messaging service.

| Run ID | Command (from `src/`) | Result | File |
| --- | --- | --- | --- |
| `2026-10-30T14-39-03.363Z` | `npm run demo:gate` | PASS: Cashier confirm 403 `OWNER_APPROVAL_REQUIRED`, release of unpaid order 409 `RELEASE_BLOCKED`, Cashier decision 403 `FORBIDDEN`, Owner approve 200 (PAID, ON_HOLD), separate release 200 (RELEASED) | [gate](gate/2026-10-30T14-39-03.363Z.json) |
| `2026-10-30T14-39-09.264Z` | `npm run eval:e2e` | 8/8 known-answer decisions; 0 false admissions; 0 wrong releases; 0 false blocks | [summary](e2e/summary.md), [results](e2e/results.json) |
| `2026-10-30T14-53-00.809Z` | `npm run demo:exceptions` | Six blocked fixtures stay UNPAID and ON_HOLD with Owner confirm 409 `EVIDENCE_BLOCKED`; duplicate evidence blocked; high value needs the Owner; rejected and superseded approvals return 409 `STALE_APPROVAL`; simulated failed read returns 409 `EXTRACTION_NOT_READY` until corrected, then needs the Owner; another shop gets 404 | [exceptions](exceptions/2026-10-30T14-53-00.809Z.json) |
| `2026-10-30T14:52:31.840Z` | `npm run eval:ocr-expanded` | CPU OCR on 36 synthetic images: 190/252 fields, 18/36 exact, 21/21 expected blocks held (0 false eligible), 9 of 15 expected-valid cases were ineligible (false blocks) | [summary](cpu-ocr/2026-10-30-summary.json) |

The first two and the CPU OCR run used a clean `a97d56f` application source. The exception run used the same application source plus the added walkthrough script, which changes no application code. Failed read in the exception run is simulated.

## What these do not show

The gate, fixture and exception reports are structured workflows through the real API and database. The CPU OCR run measures one engine on the same synthetic set used for earlier diagnostics, so it is not a held-out test. None of these is GPU accuracy, real channel delivery, employee time or business impact measurements, and zero error counts apply only to this test set. The latency figures in the results are local request times and cannot be used as employee time.

Not yet measured: human processing time, observed employee file actions, new GPU reading accuracy, live channel latency and platform cost. See the [measurement protocol](../FINALIST_MEASUREMENT.md). Run live checks separately and record their own commit and run ID here.

## Metric interpretation

`valid_but_blocked` counts expected-valid images with `eligible=false`. These cases need evidence correction or supplementation and a fresh verification; Owner approval cannot override a hard blocker. It is not a count of cases successfully resolved by human review.

The offline model comparison's `cashier_wrongly_eligible` measures Cashier eligibility only. `MODEL_UNCONFIRMED` requires Owner review but is not a hard blocker. These pure-rule evaluations do not execute payment confirmation or release, and cannot establish zero erroneous releases. CPU-only results do not measure the effect of GPU/CPU cross-checking.
