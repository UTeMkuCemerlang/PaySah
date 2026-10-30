# Local evidence

These reports were generated locally on 30 October 2026 from source commit `a97d56f7fd0e14b80cb1386d4b9dc4d8c53a5302`, using a dedicated local PostgreSQL test database and synthetic records. They contacted no production system, RunPod endpoint or messaging service.

| Run ID | Command (from `src/`) | Result | File |
| --- | --- | --- | --- |
| `2026-10-30T14-39-03.363Z` | `npm run demo:gate` | PASS: Cashier confirm 403 `OWNER_APPROVAL_REQUIRED`, release of unpaid order 409 `RELEASE_BLOCKED`, Cashier decision 403 `FORBIDDEN`, Owner approve 200 (PAID, ON_HOLD), separate release 200 (RELEASED) | [gate](gate/2026-10-30T14-39-03.363Z.json) |
| `2026-10-30T14-39-09.264Z` | `npm run eval:e2e` | 8/8 known-answer decisions; 0 false admissions; 0 wrong releases; 0 false blocks | [summary](e2e/summary.md), [results](e2e/results.json) |

## What these do not show

These are structured fixture workflows through the real API and database. They are not vision accuracy, real channel delivery, employee time or business impact measurements, and zero error counts apply only to this test set. The latency figures in the results are local request times and cannot be used as employee time.

Not yet measured: human processing time, observed employee file actions, new GPU and CPU reading accuracy, live channel latency and platform cost. See the [measurement protocol](../FINALIST_MEASUREMENT.md). Run live checks separately and record their own commit and run ID here.
