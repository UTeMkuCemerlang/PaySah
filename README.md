# PaySah

Receipt verification for Malaysian small businesses: compare receipt details with independent bank evidence before confirming payment or releasing goods.

## Team Information

| Field | Details |
| --- | --- |
| Team name | UTeMkuCemerlang |
| Team domain | Domain 2 — Orbyte Smart SME Challenge |
| SDG alignment | SDG 8.3 — support micro and small enterprises |
| Team Leader | Chong Kai Li |
| University | Universiti Teknikal Malaysia Melaka (UTeM) |
| Number of Members | 4 |

## Links

- [Live demo](https://paysah.replit.app/#orders)
- [GitHub repository](https://github.com/UTeMkuCemerlang/PaySah)
- [Public pitch video](https://youtu.be/4aPbn72CRjA)
- [Slide deck](submission/PaySah-Town.pdf)
- [Submission files and remaining items](submission/README.md)

## Overview

### Problem and solution

Small merchants receive transfer screenshots but still need to establish whether money arrived. PaySah extracts receipt fields, checks explainable rules against independent bank records, and keeps human payment and release decisions separate. Cashier and Owner permissions, duplicate evidence detection and activity records support review.

The public prototype uses synthetic customers, receipts and bank credits. It does not connect to a real bank or move money. Screenshots alone never establish payment. Partial or invalid evidence stays blocked; clean payments above RM500 require Owner approval.

### Key features

- Receive receipts through dashboard upload, Telegram or an order-linked Google Form.
- Extract receipt fields and compare amounts, recipient, status, references and duplicate evidence with independent bank records.
- Keep payment confirmation and release as separate, permission-controlled decisions.
- Record evidence provenance, exceptions and human actions in the activity history.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | React, TypeScript, Vite; Three.js for the product story |
| Backend | Node.js, Express, persistent receipt worker |
| Database | PostgreSQL |
| Receipt extraction | RunPod vLLM / Qwen2.5-VL-7B-Instruct; Tesseract CPU fallback |
| Hosting and storage | Replit deployment and private App Storage |
| Intake integrations | Telegram and Google Forms / Apps Script |

## Project structure

```text
src/                         Complete runnable application
  apps/web/                  React/Vite interface and interactive product story
  apps/api/                  Express API, verification rules and receipt worker
  packages/contracts/        Shared validation contracts
  db/                        PostgreSQL migrations and synthetic seeds
  integrations/google-form/  Google Apps Script connector
  fixtures/                  Synthetic demo images and expected fields
  scripts/                   Database, evaluation and verification commands
  tests/                     Automated tests
  docs/                      Public implementation notes
  submission/                Technical disclosures and prior validation notes
  .env.example               Configuration template; no live credentials
  package.json               Commands and dependencies
submission/
  replit/                    Reviewed Replit screenshots
  runpod/                    Reviewed RunPod screenshots
  README.md                  Required PDF filenames and completion status
README.md
LICENSE                      Apache License 2.0
.replit                      Starts the application from src/
.gitignore                   Excludes credentials, build output and local records
```

Submission documents: [preliminary proposal](submission/SDC2026_UTeMkuCemerlang_Preliminary.pdf), [technical tools declaration](submission/SDC2026_UTeMkuCemerlang_TechDeclaration_final.pdf), [Replit proof](submission/SDC2026_UTeMkuCemerlang_Replit_POU.pdf) and [RunPod proof](submission/SDC2026_UTeMkuCemerlang_Runpod_POU.pdf).

## Architecture

Receipt upload or channel intake → Express API and private image storage → persistent extraction worker → RunPod vision model or CPU fallback → server-side verification against orders and bank evidence → Cashier / Owner review → separate confirmation and release → activity log.

PostgreSQL stores orders, receipt fields, jobs and audit records. Server-side identity, tenant and permission checks protect business operations. The demonstration bank feed is synthetic.

## How to run

Requirements: Node.js 24, npm and PostgreSQL 17 for the local helper. Run application commands from **src/**.

```powershell
git clone https://github.com/UTeMkuCemerlang/PaySah.git
cd PaySah/src
npm ci
Copy-Item .env.example .env
npm run db:local:start
npm run db:migrate
npm run db:seed
npm run dev
```

Open http://127.0.0.1:5173 and select a synthetic shop and role. Copy the environment template only on a fresh checkout. For a managed database, set DATABASE_URL and skip the portable database command. The example password is development-only.

The default fixture mode needs no GPU. For actual CPU image reading, set EXTRACTOR_MODE=cpu_ocr and run npm run worker in another terminal, also from src/.

```sh
# From src/
npm run build
npm run start:deployment
```

Set TEST_DATABASE_URL to a dedicated test database, then run npm test. Database tests may skip if it is absent. Browser checks use installed Chrome: npm run smoke:m3 and npm run smoke:intake. See [detailed source instructions](src/README.md) and [release validation](submission/VALIDATION.md).

## How we use Replit

Replit hosts the web application, Express API and receipt worker at the live demo URL. The deployment uses PostgreSQL and private App Storage; server credentials are configured through Secrets. Reviewed screenshots are in [submission/replit](submission/replit/).

For a fresh import, the root .replit configuration installs and builds within src/. Set DATABASE_URL, HOST=0.0.0.0 and the relevant variables from src/.env.example. Configure STORAGE_DRIVER=replit with a private bucket for persistent images. Apply migrations deliberately using cd src and npm run db:migrate. Seed only a dedicated synthetic demo database. Do not overwrite an existing production database with development data.

## How we use RunPod

The receipt worker sends an image to a RunPod Serverless vLLM endpoint running Qwen/Qwen2.5-VL-7B-Instruct and parses structured receipt fields. Deterministic server rules perform payment verification. RunPod does not approve payments. Failed GPU reading can fall back to Tesseract CPU OCR, with the actual provider and fallback reason recorded.

Set EXTRACTOR_MODE=runpod and configure RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID and RUNPOD_MODEL server-side. Never place credentials in the browser or repository. The application adapter is in src/apps/api/src/modules/receipts/runpod.ts. The separate experimental eval:runpod handler is not the deployed application adapter.

Reviewed screenshots are in [submission/runpod](submission/runpod/). Their dates and limitations are listed in the submission index. Historical balances are not current quotations.

The deployed endpoint/model identification is shown in the [RunPod proof PDF](submission/SDC2026_UTeMkuCemerlang_Runpod_POU.pdf). The authenticated endpoint is called by the server; the public demo requires no RunPod API key from reviewers.

## Current source

The source includes the V4 interface, Owner-only demo reset, 180-second receipt-worker lease, English Telegram acknowledgements and their regression tests. See [demo operations](src/docs/DEMO_OPERATIONS.md). Reset deletes the selected demo shop's history; save proof first.

Telegram and Google Form intake each completed a real end-to-end test on 24 October 2026. These two runs used CPU fallback after GPU extraction timed out; they do not establish GPU success or replay reliability. Telegram accepts allowlisted team accounts only. Other accounts are ignored by design; reviewers can use the Google Form link generated on an order page instead.

## Challenges and Learnings

Independent bank evidence is the main integration constraint, so the prototype uses synthetic credits. GPU cold starts can delay extraction; a persistent worker and CPU fallback preserve the review flow and record which provider actually returned the fields. Receipt extraction alone cannot establish that money arrived.

## Future Improvements

- Add authorized bank-statement ingestion and evaluate reconciliation with merchant data.
- Improve GPU cold-start latency and measure extraction quality across more receipt formats.
- Expand channel replay testing and validate the workflow with small merchants.

## Submission Status and License

The PaySah pitching video has been completed and is available through the link provided above. The repository includes the project proposal, technical tools declaration, pitch deck and platform proof documents.

The prototype demonstrates AI-assisted receipt extraction, rule-based payment verification, role-based approval, and receipt intake through Telegram and Google Forms. The demonstration uses synthetic receipts and bank records; it does not connect to a live bank or payment gateway.

Licensed under [Apache-2.0](LICENSE). Third-party packages retain their respective licenses. See the [technical tools declaration](submission/SDC2026_UTeMkuCemerlang_TechDeclaration_final.pdf) and supporting [source disclosure](src/submission/TOOLS_DECLARATION.md).
