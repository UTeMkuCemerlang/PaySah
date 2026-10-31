# Live demo rehearsal

A script for rehearsing the main route, the rejection route and the second shop. All data is synthetic. `npm run smoke:rehearsal` (from `src/`, after `npm run build`, with a dedicated local `TEST_DATABASE_URL`) walks the same steps in a browser on a disposable local schema. It cannot target a deployment, and a local pass does not show the live site works.

## Before you start

- Check `/api/v1/health` and note the `commit`. The status guidance below needs a release that includes it.
- Do not touch DEMO-A-128 or DEMO-A-780.
- The RM780 receipt and its bank credit are shared with DEMO-A-780 and can be used once. As the Owner, open **Activity** and use **Reset demo data** first, then again after the rehearsal. Reset deletes that shop's history, so save any proof first.
- Keep the Cashier and Owner in two windows if you want to show the Activity update live.

## Main demo: one owner working alone

Use only the Demo A Owner account. `npx tsx scripts/smoke-owner-only.ts` (from `src/`, after a build, with a dedicated local `TEST_DATABASE_URL`) walks these steps on a disposable local schema.

| # | Do this | You should see |
| --- | --- | --- |
| 1 | New order, RM128. Attach **Normal · RM 128**, **Run checks** | "Ready to confirm" |
| 2 | Tick the bank credit box, **Confirm payment**, then **Release order** | "Waiting for release", then "Complete" |
| 3 | New order, RM780. Attach **High value · RM 780**, **Run checks** | "Ready to confirm", with a note to check it carefully |
| 4 | Tick the bank credit box, **Confirm payment**, accept the think-twice prompt, **Release order** | "Complete" |
| 5 | **View order record** on the RM780 order | The plain record |
| 6 | New order, RM128. Attach **No matching bank credit**, **Run checks** | "No bank match"; **Confirm payment** is not offered |
| 7 | Under **Approve anyway**, enter a reason and accept the think-twice prompt, then **Release order** | "Complete". The order shows Manually confirmed, not Paid, and the record keeps the reason and the amount not covered by bank evidence |

Steps 1 and 6 use receipts and credits that are shared with other demo orders, so a repeat run needs **Reset demo data**. On a shared or live deployment, expect "already been used" otherwise.

One owner still confirms every payment by hand. PaySah does not confirm any payment by itself. PaySah warns and holds by default. The Owner has the final word, on their own responsibility, and every override is recorded and never shown as Paid.

## Route 2: one blocked receipt

Follow any case in [EXCEPTION_DEMO.md](EXCEPTION_DEMO.md). A good choice is **No bank credit**: the page says "No bank match", and only **Approve anyway** can move it forward.

## If something fails

| What happens | Say or do |
| --- | --- |
| "Reading" stays for a long time | GPU cold start. Wait for the backup method, or use a fixture-backed receipt |
| "Read using the backup method" | Open it to show the recorded reason |
| "Reading failed" | **Try reading again**, or correct the fields; the Owner must then review |
| Receipt says "already been used" | A credit or image was used earlier. Reset demo data as the Owner, after saving proof |
| Live site is unavailable | Play the backup video |
