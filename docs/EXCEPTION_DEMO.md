# Exception path demo script

This is a script for a teammate to follow. All data is synthetic. It has not been run on a live deployment. `npm run demo:exceptions` (from `src/`, with a dedicated local `TEST_DATABASE_URL`) walks the fixture cases below through the real API in a disposable schema; the results of one local run are in [evidence](evidence/README.md). Rules are in `src/apps/api/src/modules/verification/rules.ts` (`rules.v2-tenant-policy`); routes are in `router.ts` and `service.ts` in the same folder.

## Rules for every demo

- Never use the protected recording orders `DEMO-A-128` and `DEMO-A-780`. Create a new order in the demo shop for each case, or use a separate demo tenant.
- An Owner demo reset (`POST /demo/reset`, Activity page) deletes the selected demo shop's orders, receipts, checks and activity history. Save screenshots or recordings first.
- Use only synthetic images from `src/fixtures/receipts/`. A receipt sent through the RunPod extractor leaves Replit for inference, so never upload a real receipt.
- Safe on a live deployment: read-only views, new synthetic orders, fixture or manual receipts, verification, denial and cross-shop checks. Local only: anything that edits the database directly, resets, or changes the extractor, and the stale-approval variants that need SQL (see the test file).
- Mutating calls need a unique `Idempotency-Key` header and the current `expected_version`. Roles: Demo A Owner, Demo A Cashier, Demo B Owner (`src/db/seeds/001_demo.sql`).
- Seeded credits (`002_verification.sql`): `DEMO-BANK-128` RM128, `DEMO-BANK-780` RM780, `DEMO-BANK-50` RM50, all in `DEMO-ACCOUNT-A`. A credit can be allocated once, so a confirmed case uses it up for later demos in that shop. Additional credits can be added by an Owner with `POST /demo/bank-events`.

## Fixtures

Receipt fields come from `src/apps/api/src/modules/verification/fixtures.ts` (`normal`, `partial`, `wrong_account`, `scheduled`, `money_request`, `no_bank`, `high_value`, `bakery_300`, `laundry_300`). Matching PNGs are in `src/fixtures/receipts/`. Channel images `DEMO-A-TG1/TG2/GF1` are for Telegram and Form demos only and can be confirmed once each.

## Cases

Create the order as Demo A Cashier unless stated. "Verify" means the verification call on the new order and its current receipt. Every verification writes `verification.completed` to Activity.

| Case | Fixture and order | Expected reason codes | Result |
| --- | --- | --- | --- |
| Partial payment | `partial` (RM50) on a new RM128 order | `PARTIAL_PAYMENT` | `NEEDS_REVIEW`, not eligible; confirm returns 409 `EVIDENCE_BLOCKED`; order stays UNPAID |
| Overpayment | `normal` (RM128) on a new RM100 order | `OVERPAYMENT` | Not eligible, same blocking |
| Wrong recipient | `wrong_account` on a new RM128 order | `WRONG_RECIPIENT`, `BANK_NOT_FOUND` | `INVALID_EVIDENCE`; Owner approval cannot override |
| Scheduled transfer | `scheduled` on a new RM128 order | `TRANSFER_NOT_COMPLETE` (plus `DUPLICATE_REFERENCE` if the reference was already used) | `INVALID_EVIDENCE` |
| No bank credit | `no_bank` on a new RM128 order | `BANK_NOT_FOUND` | `AWAITING_BANK` |
| Money request | `money_request` | `MONEY_REQUEST` (plus `DUPLICATE_REFERENCE` if the reference was already used) | `INVALID_EVIDENCE` |
| Duplicate receipt | Attach the same fixture or image to a second order in the same shop | `DUPLICATE_EVIDENCE`, `DUPLICATE_IMAGE` (images), `DUPLICATE_REFERENCE` | Blocked (`DUPLICATE_REFERENCE` alone only raises the role to Owner) |
| High value | `high_value` (RM780) on a new RM780 order | `HIGH_VALUE` (above the tenant threshold, default RM500) | Eligible, `required_role` OWNER |

Notes on the table: the order version at creation is 1. A fixture already used by another order in the shop will also show `DUPLICATE_EVIDENCE` and, once its credit is allocated, `TRANSACTION_ALREADY_USED`. Use a fresh credit or a fresh demo tenant to see a single code.

## Role and approval cases

1. Cashier denied. On the high-value verification, Cashier calls `POST /verifications/:id/confirm`. Expected 403 `OWNER_APPROVAL_REQUIRED`. Cashier requesting `POST /approvals/:id/decision` gets 403 `FORBIDDEN`. Activity shows `access.denied` (written by `denied.ts` for confirm, decision and release routes).
2. Owner approval. Cashier files `POST /verifications/:id/approval-requests` (Activity: `approval.requested`). Owner approves with a reason: `approval.decided`, then `payment.confirmed`; fulfillment stays `ON_HOLD` until a separate `POST /orders/:id/release` (`fulfillment.released`).
3. Owner reject. Owner decides REJECT with a reason. Approval becomes REJECTED, the verification is deactivated, the order stays UNPAID. Verify again to create a new check and a new approval request.
4. Stale approval. After a pending approval exists, change the evidence (a correction, a newer receipt, or an order version change) and approve. Expected 409 `STALE_APPROVAL`; on correction the pending approval is marked `SUPERSEDED` (`approval.superseded`). Changing rule version or bank status needs SQL: local only.
5. Cross-shop isolation. Sign in as Demo B Owner and request `GET /orders/<Kedai A order id>/receipts` or `GET /verifications/<id>`. Expected 404 `NOT_FOUND`, with no hint that the object exists.

## OCR or model failure, manual correction

No ready fixture produces an OCR failure; the local walkthrough simulates one by setting the receipt to `ERROR` in its disposable schema, which is not possible on a live deployment. On a live deployment: upload a synthetic image through the order receipt upload, and if extraction is `PENDING`, `RUNNING` or `ERROR`, verification returns 409 `EXTRACTION_NOT_READY`. Then submit `POST /receipts/:id/corrections` with `expected_revision`, `expected_version`, corrected fields and a reason (3+ characters). Activity shows `receipt.corrected` with before and after fields. Verify again: the check carries `MANUAL_FIELDS`, so an Owner is required. Extraction events appear as `receipt.extracted` with `provider` and `fallback_reason`.

## GPU and CPU disagreement

Requires `EXTRACTOR_MODE=runpod` and a live endpoint, which this script does not cover. If the CPU reading does not reproduce a GPU field, the check adds `MODEL_UNCONFIRMED`, which forces Owner review but does not block. No ready fixture forces a disagreement; the test uses a stubbed CPU reader.

## Automated coverage

| Case | Test file |
| --- | --- |
| Normal confirm, release, idempotent retry | `src/tests/integration/verification.test.ts` (T01) |
| RM500 boundary, Cashier denied, Owner approval | `verification.test.ts` (T02, T03) |
| Partial, wrong account, scheduled, money request, no bank blocked | `verification.test.ts` (T04/T05/T11); rules in `rules.test.ts` |
| Cross-shop 404, corrections, stale approval, reject | `verification.test.ts` (T14, T17, T26, T28) |
| Duplicate image | `src/tests/integration/receipt-images.test.ts` (T06) |
| `MODEL_UNCONFIRMED` | `src/tests/integration/runpod-vision.test.ts` |
| `access.denied` audit | `src/tests/integration/finalist.test.ts` |
| Every table case, Owner reject, stale approval, failed read then correction, cross-shop | `src/scripts/demo-exceptions.ts`, run by `finalist.test.ts` |
| `AWAITING_BANK` | `verification.test.ts` (helper) and `demo-exceptions.ts` |

Tests need `TEST_DATABASE_URL`. A live-service run of this script has not been done.
