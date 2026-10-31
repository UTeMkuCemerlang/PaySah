
const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4007);

// Public HTTPS address after deployment.
// Local development defaults to localhost.
const BASE_URL = (
  process.env.BASE_URL || `http://localhost:${PORT}`
).replace(/\/$/, "");

// Must match the configuration in PaySah Backend.
const API_KEY = process.env.MOCK_API_KEY || "local-demo-key";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "local-demo-secret";

// PaySah must expose an actual callback endpoint.
// Do not guess its URL.
const PAYSAH_WEBHOOK_URL =
  process.env.PAYSAH_WEBHOOK_URL || "";

// Development-only memory storage.
const sessions = new Map();
const transactions = [];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[ch]);
}

function render(content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PaySah Mock Payment</title>
<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #f4f6fa;
  font-family: Arial, sans-serif;
  color: #17263e;
  padding: 30px 14px;
}
.card {
  max-width: 550px;
  margin: 35px auto;
  background: white;
  border-radius: 20px;
  padding: 32px;
  box-shadow: 0 8px 30px #14213d12;
}
h1 { font-size: 27px; margin: 16px 0; }
h2 { font-size: 22px; }
p { line-height: 1.65; }
.tag {
  display: inline-block;
  background: #fff0bd;
  color: #795800;
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 12px;
  font-weight: bold;
}
label {
  display: block;
  font-weight: bold;
  margin: 25px 0 8px;
}
input {
  width: 100%;
  padding: 15px;
  font-size: 20px;
  border: 1px solid #bac7d9;
  border-radius: 10px;
}
button {
  display: block;
  width: 100%;
  padding: 16px;
  margin-top: 24px;
  background: #2563d9;
  border: none;
  border-radius: 10px;
  color: white;
  font-size: 17px;
  font-weight: bold;
  cursor: pointer;
}
button:hover { background: #1c4fb4; }
.receipt {
  margin-top: 22px;
  padding: 20px;
  border-radius: 12px;
  background: #f1f5fa;
  line-height: 2;
  overflow-wrap: anywhere;
}
.muted { color: #68788f; font-size: 14px; }
.value { font-weight: bold; }
</style>
</head>
<body>
<div class="card">${content}</div>
</body>
</html>`;
}

function respond(res, status, content, type = "text/html") {
  res.writeHead(status, {
    "Content-Type": type + "; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(content);
}

function json(res, status, object) {
  respond(
    res,
    status,
    JSON.stringify(object),
    "application/json"
  );
}

async function readBody(req) {
  let body = "";

  for await (const chunk of req) {
    body += chunk;

    if (body.length > 30000) {
      throw new Error("Request too large");
    }
  }

  return body;
}

function readRequiredString(data, field) {
  const value = data[field];

  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 250
  ) {
    throw new Error("Missing or invalid: " + field);
  }

  return value.trim();
}

// Payment link is created ONLY from PaySah-supplied data.
function createPaymentSession(data) {
  const order = {
    orderId: readRequiredString(data, "orderId"),
    merchantId: readRequiredString(data, "merchantId"),
    bank: readRequiredString(data, "bank"),
    bankTransactionRef: readRequiredString(
      data, "bankTransactionRef"
    ),
    customerReference: readRequiredString(
      data, "customerReference"
    ),
    recipientAccount: readRequiredString(
      data, "recipientAccount"
    ),
    documentType: readRequiredString(
      data, "documentType"
    )
  };

  // Internal payment-link ID only.
  // This is NOT a bank transaction reference.
  const paymentLinkId = crypto.randomUUID();

  const session = {
    paymentLinkId,
    order,
    completed: false,
    transaction: null
  };

  sessions.set(paymentLinkId, session);

  return {
    paymentLinkId,
    paymentUrl: BASE_URL + "/pay/" + paymentLinkId,
    provider: "PAYSAH_MOCK",
    synthetic: true
  };
}

async function postToPaySah(transaction) {
  if (!PAYSAH_WEBHOOK_URL) {
    return {
      delivered: false,
      reason: "PAYSAH_WEBHOOK_URL not configured"
    };
  }

  const payload = JSON.stringify(transaction);

  const signature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(payload)
    .digest("hex");

  try {
    const response = await fetch(PAYSAH_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mock-Signature": signature,
        "X-Mock-Provider": "PAYSAH_MOCK"
      },
      body: payload,
      signal: AbortSignal.timeout(10000)
    });

    return {
      delivered: response.ok,
      httpStatus: response.status
    };
  } catch (error) {
    return {
      delivered: false,
      reason: error.message
    };
  }
}

function showCheckout(session) {
  const order = session.order;

  if (session.completed) {
    return render(`
      <div class="tag">SYNTHETIC PAYMENT</div>
      <h1>Already submitted</h1>
      <p>This payment link has already been used.</p>
    `);
  }

  return render(`
    <div class="tag">MOCK PAYMENT — NO REAL MONEY</div>

    <h1>PaySah Payment</h1>

    <p class="muted">
      Order: ${escapeHtml(order.orderId)}
    </p>

    <p>Enter the amount you want to pay.</p>

    <form
      method="POST"
      action="/pay/${session.paymentLinkId}/complete"
    >
      <label for="amount">Amount (RM)</label>

      <input
        id="amount"
        name="amount"
        type="number"
        step="0.01"
        min="0.01"
        placeholder="0.00"
        required
        autofocus
      >

      <button type="submit">
        Pay Now (Demo)
      </button>
    </form>

    <p class="muted">
      This is a synthetic transaction.
      PaySah will verify the amount after submission.
    </p>
  `);
}

function buildTransaction(session, amount) {
  const order = session.order;

  // These values come directly from PaySah's order.
  // The customer supplies ONLY amount.
  return {
    synthetic: true,
    provider: "PAYSAH_MOCK",

    orderId: order.orderId,
    merchantId: order.merchantId,

    bank: order.bank,
    amount: amount,
    currency: "MYR",

    bankTransactionRef: order.bankTransactionRef,
    customerReference: order.customerReference,
    recipientAccount: order.recipientAccount,

    occurredAt: new Date().toISOString(),
    status: "SUCCESS",
    documentType: order.documentType
  };
}

function showReceipt(transaction, delivery) {
  const t = transaction;

  return render(`
    <div class="tag">SYNTHETIC EXAMPLE ONLY</div>

    <h1>Payment Submitted</h1>

    <div class="receipt">
      <strong>PAYSAH SYNTHETIC RECEIPT</strong><br>

      Bank:
      ${escapeHtml(t.bank)}<br>

      Amount:
      RM ${Number(t.amount).toFixed(2)}<br>

      Bank transaction ref:
      ${escapeHtml(t.bankTransactionRef)}<br>

      Customer reference:
      ${escapeHtml(t.customerReference)}<br>

      Recipient account:
      ${escapeHtml(t.recipientAccount)}<br>

      Occurred at:
      ${escapeHtml(t.occurredAt)}<br>

      Status:
      ${escapeHtml(t.status)}<br>

      Document type:
      ${escapeHtml(t.documentType)}
    </div>

    <p class="muted">
      ${
        delivery.delivered
          ? "The synthetic event was accepted by the configured PaySah callback endpoint."
          : "The transaction was generated locally, but delivery to PaySah is not confirmed."
      }
    </p>

    <p class="muted">
      Matching, confirmation, approval, and fulfillment
      must be handled by PaySah.
    </p>
  `);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);

  // Home page: informational only.
  // Customers get links generated by PaySah Backend.
  if (req.method === "GET" && url.pathname === "/") {
    return respond(res, 200, render(`
      <div class="tag">PAYSAH MOCK PROVIDER</div>
      <h1>Payment Simulator</h1>

      <p>
        Payment links are created by PaySah Backend
        using an existing order.
      </p>

      <p>
        Customers can only enter their payment amount.
      </p>

      <p class="muted">
        This simulator is not a real bank or Billplz.
      </p>
    `));
  }

  // Secure server-to-server link creation.
  if (
    req.method === "POST" &&
    url.pathname === "/api/mock/links"
  ) {
    if (req.headers["x-api-key"] !== API_KEY) {
      return json(res, 401, {
        error: "Unauthorized"
      });
    }

    try {
      const data = JSON.parse(await readBody(req));

      const result = createPaymentSession(data);

      return json(res, 201, result);

    } catch (error) {
      return json(res, 400, {
        error: error.message
      });
    }
  }

  // Match /pay/<id> or /pay/<id>/complete
  const match = url.pathname.match(
    /^\/pay\/([0-9a-f-]+)(?:\/complete)?$/
  );

  if (match) {
    const session = sessions.get(match[1]);

    if (!session) {
      return respond(res, 404, render(`
        <h2>Payment link not found</h2>
      `));
    }

    // Customer opens payment link.
    if (
      req.method === "GET" &&
      url.pathname === "/pay/" + session.paymentLinkId
    ) {
      return respond(res, 200, showCheckout(session));
    }

    // Customer submits the amount.
    if (
      req.method === "POST" &&
      url.pathname ===
        "/pay/" + session.paymentLinkId + "/complete"
    ) {
      if (session.completed) {
        return respond(res, 409, render(`
          <h2>Payment already submitted</h2>
        `));
      }

      let form;

      try {
        form = new URLSearchParams(await readBody(req));
      } catch {
        return respond(res, 400, render(`
          <h2>Invalid form submission</h2>
        `));
      }

      const amountText = (form.get("amount") || "").trim();

      // Validate format only.
      // DO NOT compare against the order amount.
      if (!/^\d+(\.\d{1,2})?$/.test(amountText)) {
        return respond(res, 400, render(`
          <h2>Invalid amount format</h2>
        `));
      }

      const amount = Number(amountText);

      if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        amount > 1000000
      ) {
        return respond(res, 400, render(`
          <h2>Enter a valid positive amount</h2>
        `));
      }

      const paidAmount = Math.round(amount * 100) / 100;

      const transaction = buildTransaction(
        session,
        paidAmount
      );

      // Do not accept another submission for this link.
      session.completed = true;
      session.transaction = transaction;

      transactions.push(transaction);

      console.log("\n=== SYNTHETIC TRANSACTION ===");
      console.log(JSON.stringify(transaction, null, 2));

      const delivery = await postToPaySah(transaction);

      console.log("PaySah delivery result:", delivery);

      return respond(
        res,
        200,
        showReceipt(transaction, delivery)
      );
    }
  }

  return respond(res, 404, render(`
    <h2>Page not found</h2>
  `));
});

server.listen(PORT, () => {
  console.log("\nPaySah Mock Provider running");
  console.log("URL:", BASE_URL);
  console.log(
    "PaySah Webhook configured:",
    Boolean(PAYSAH_WEBHOOK_URL)
  );
  console.log(
    "Create links via POST /api/mock/links"
  );
});
