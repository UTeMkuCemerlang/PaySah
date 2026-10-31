# Live demo rehearsal

A script for rehearsing the main route, the rejection route and the second shop. All data is synthetic. `npm run smoke:rehearsal` (from `src/`, after `npm run build`, with a dedicated local `TEST_DATABASE_URL`) walks the same steps in a browser on a disposable local schema. It cannot target a deployment, and a local pass does not show the live site works.

## Before you start

- Check `/api/v1/health` and note the `commit`. The status guidance below needs a release that includes it.
- Do not touch DEMO-A-128 or DEMO-A-780.
- The RM780 receipt and its bank credit are shared with DEMO-A-780 and can be used once. As the Owner, open **Activity** and use **Reset demo data** first, then again after the rehearsal. Reset deletes that shop's history, so save any proof first.
- Keep the Cashier and Owner in two windows if you want to show the Activity update live.

## Route 1: rejection, then approval

| # | Who | Do this | You should see |
| --- | --- | --- | --- |
| 1 | Demo A Cashier | **+ New order**, reference `REHEARSAL-780`, amount `780.00` | "No receipt yet" |
| 2 | Cashier | Choose **High value · RM 780**, **Attach synthetic receipt** | "Ready to check" |
| 3 | Cashier | **Run checks** | "Needs the Owner"; Next step: Request Owner review |
| 4 | Cashier | **Request Owner review** | "Waiting for the Owner" |
| 5 | Demo A Owner | Open the order | "Owner decision" and a summary of amounts, bank credit, why the Owner, manual changes and whether the evidence is current |
| 6 | Owner | Enter a reason, **Reject receipt review** | "Rejected"; order stays Unpaid |
| 7 | Cashier | Open the order | The rejection reason and **Correct fields now** |
| 8 | Cashier | **Run checks**, **Request Owner review** | "Waiting for the Owner" again |
| 9 | Owner | Enter a reason, tick the bank credit box, **Approve & confirm payment** | "Waiting for release"; Paid, still On hold |
| 10 | Owner | **Release order** | "Complete" |
| 11 | Anyone | **View order record** | Requested, rejected, requested, approved, confirmed, released, with `Payment status: Unpaid → Paid` |

Point to make at step 5: "Approving confirms payment. Release is still a separate step."

## Route 2: same RM300, two shops

| # | Who | Do this | You should see |
| --- | --- | --- | --- |
| 1 | Demo A Cashier | Open `FINAL-BAKERY-300`, attach **bakery_300**, **Run checks** | "Ready to confirm" |
| 2 | Laundry Cashier | Open `FINAL-LAUNDRY-300`, attach **laundry_300**, **Run checks** | "Needs the Owner" |

Each shop has its own order, receipt and bank credit. To show the control, sign in as the Owner, open **Shop settings**, lower the limit, then run the same check again: the order now needs the Owner and Activity records the change. **Reset demo data** restores the shop's limit. Each order can be confirmed once, so stop at the checks unless you plan to reset. Whether these two orders exist on a deployment depends on its data, so confirm them first.

## Route 3: one blocked receipt

Follow any case in [EXCEPTION_DEMO.md](EXCEPTION_DEMO.md). A good choice is **No bank credit**: the page says "No bank match" and the Owner cannot approve it through.

## If something fails

| What happens | Say or do |
| --- | --- |
| "Reading" stays for a long time | GPU cold start. Wait for the backup method, or use a fixture-backed receipt |
| "Read using the backup method" | Open it to show the recorded reason |
| "Reading failed" | **Try reading again**, or correct the fields; the Owner must then review |
| Receipt says "already been used" | A credit or image was used earlier. Reset demo data as the Owner, after saving proof |
| Live site is unavailable | Play the backup video |
