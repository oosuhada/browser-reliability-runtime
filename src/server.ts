import express from "express";
import type { Request, Response } from "express";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  ORDERS,
  getOrder,
  getPolicy,
  type WorkflowState
} from "./domain.js";
import { MUTATIONS, getMutation, mutationApplies, type MutationDefinition } from "./mutations.js";

const app = express();
const port = Number(process.env.PORT ?? 4317);
let demoRunActive = false;
let demoRunTimestamps: number[] = [];

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/artifacts", express.static(path.resolve("artifacts")));

function esc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function querySuffix(req: Request): string {
  const mutation = getMutation(typeof req.query.mutation === "string" ? req.query.mutation : undefined);
  const policy = getPolicy(typeof req.query.customer === "string" ? req.query.customer : undefined);
  const params = new URLSearchParams({ customer: policy.id, mutation: mutation.id });
  return `?${params.toString()}`;
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

function pageMeta(state: WorkflowState, req: Request, targetIds: string[]): string {
  const mutation = getMutation(typeof req.query.mutation === "string" ? req.query.mutation : undefined);
  const policy = getPolicy(typeof req.query.customer === "string" ? req.query.customer : undefined);
  const applied = mutationApplies(mutation, state);
  return `<script>
    window.__WORKFLOWLENS__ = ${JSON.stringify({
      state,
      mutation,
      mutationApplied: applied,
      policy,
      targetIds
    }).replaceAll("<", "\\u003c")};
  </script>`;
}

function styles(): string {
  return `<style>
    :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f5f7fb; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; }
    a { color: inherit; }
    .shell { width: min(1100px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 64px; }
    .topbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 24px; }
    .brand { font-weight: 800; letter-spacing: -0.03em; }
    .pill { border: 1px solid #d7deea; background: white; border-radius: 999px; padding: 8px 12px; font-size: 12px; }
    .card { background: white; border: 1px solid #e2e7f0; border-radius: 16px; box-shadow: 0 8px 30px rgba(30, 42, 70, .06); padding: 24px; margin-bottom: 18px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
    .btn { appearance: none; border: 0; border-radius: 10px; background: #293a67; color: white; padding: 11px 15px; text-decoration: none; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; min-height: 42px; }
    .btn.secondary { color: #293a67; background: #edf1f8; }
    .btn.danger { background: #a32f3f; }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    input, select, textarea { width: 100%; border: 1px solid #cfd7e5; border-radius: 10px; padding: 11px 12px; font: inherit; background: white; }
    label { display: block; font-size: 13px; font-weight: 700; margin-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid #e7ebf2; padding: 13px 10px; }
    th { color: #667085; font-size: 12px; text-transform: uppercase; }
    .mut-banner { border: 1px dashed #d6a500; background: #fff8d9; padding: 10px 12px; border-radius: 10px; font-size: 12px; margin-bottom: 16px; }
    .overlay { position: fixed; inset: 0; background: rgba(20, 26, 43, .52); display: grid; place-items: center; z-index: 100; }
    .modal { width: min(460px, calc(100% - 32px)); background: white; border-radius: 16px; padding: 24px; box-shadow: 0 30px 80px rgba(0,0,0,.28); }
    .loading { position: fixed; inset: 0; background: rgba(245,247,251,.88); z-index: 90; display: grid; place-items: center; font-weight: 800; }
    .moved { margin-left: auto; order: 99; transform: translateY(90px); }
    .offscreen-spacer { height: 900px; border-radius: 12px; background: repeating-linear-gradient(135deg,#f8fafc,#f8fafc 12px,#f2f4f7 12px,#f2f4f7 24px); margin: 12px 0; display: grid; place-items: center; color: #98a2b3; }
    .hidden { display: none !important; }
    .compact-actions { position: fixed; right: 12px; bottom: 12px; flex-direction: column; padding: 10px; background: white; border: 1px solid #dce3ee; border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.14); z-index: 20; }
    .notice { padding: 12px 14px; border-radius: 10px; background: #fff2f0; border: 1px solid #ffccc7; margin: 12px 0; }
    .success { background: #ecfdf3; border-color: #abefc6; }
    .mut-picker { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 720px) { .grid, .mut-picker { grid-template-columns: 1fr; } .shell { width: min(100% - 20px, 1100px); } table { font-size: 13px; } }
  </style>`;
}

function shell(title: string, state: WorkflowState, req: Request, body: string, targetIds: string[] = []): string {
  const mutation = getMutation(typeof req.query.mutation === "string" ? req.query.mutation : undefined);
  const policy = getPolicy(typeof req.query.customer === "string" ? req.query.customer : undefined);
  const applied = mutationApplies(mutation, state);
  return `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)} · WorkflowLens Synthetic Commerce</title>
    ${styles()}
    ${pageMeta(state, req, targetIds)}
  </head>
  <body data-workflow-state="${state}" data-mutation="${mutation.id}" data-customer="${policy.id}">
    <main class="shell">
      <header class="topbar">
        <div><div class="brand">WorkflowLens Synthetic Commerce</div><small>Controlled browser reliability testbed</small></div>
        <div class="pill">Synthetic tenant: ${esc(policy.id)}</div>
      </header>
      ${applied ? `<div class="mut-banner" data-testid="mutation-banner"><strong>Injected mutation:</strong> ${esc(mutation.label)} — ${esc(mutation.description)}</div>` : ""}
      ${body}
    </main>
  </body>
  </html>`;
}

function overlay(id: string, heading: string, text: string, actionLabel = "Close"): string {
  return `<div class="overlay" data-testid="${esc(id)}" data-blocker-id="${esc(id)}">
    <section class="modal" role="dialog" aria-modal="true" aria-label="${esc(heading)}">
      <h2>${esc(heading)}</h2>
      <p>${esc(text)}</p>
      <button class="btn" data-recovery-action="CLOSE_MODAL" onclick="this.closest('.overlay').remove()">${esc(actionLabel)}</button>
    </section>
  </div>`;
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "workflowlens-synthetic-commerce" });
});

app.post("/api/demo/run", async (req: Request, res: Response) => {
  if (process.env.DEMO_BROWSER_RUNS_ENABLED !== "true") {
    return res.status(503).json({
      ok: false,
      error: "Controlled browser demo runs are disabled on this deployment."
    });
  }

  const workflow = String(req.body?.workflow ?? "");
  const customer = String(req.body?.customer ?? "");
  const mutation = String(req.body?.mutation ?? "");
  const allowedWorkflows = new Set(["refund_order", "lookup_shipment"]);
  const allowedCustomers = new Set(["customer_a", "customer_b"]);
  const allowedMutations = new Set(Object.keys(MUTATIONS));

  if (!allowedWorkflows.has(workflow) || !allowedCustomers.has(customer) || !allowedMutations.has(mutation)) {
    return res.status(400).json({ ok: false, error: "Unsupported controlled demo configuration." });
  }

  const now = Date.now();
  demoRunTimestamps = demoRunTimestamps.filter((timestamp) => now - timestamp < 60_000);
  if (demoRunActive || demoRunTimestamps.length >= 6) {
    return res.status(429).json({ ok: false, error: "The controlled demo runner is currently busy. Try again shortly." });
  }

  demoRunActive = true;
  demoRunTimestamps.push(now);
  try {
    const { runWorkflow } = await import("./browser/runner.js");
    const trace = await runWorkflow({
      workflow: workflow as "refund_order" | "lookup_shipment",
      customer: customer as "customer_a" | "customer_b",
      mutation: mutation as keyof typeof MUTATIONS,
      orderId: "ORD-18401",
      modalities: {
        screenshot: true,
        dom: true,
        history: true,
        policy: true
      },
      headless: true,
      visionStrategy: "on_failure",
      reasoner: "heuristic"
    });
    return res.json({
      ok: true,
      runId: trace.runId,
      success: trace.success,
      safeEscalation: trace.safeEscalation,
      viewerUrl: `/viewer/${trace.runId}`
    });
  } catch (error) {
    console.error("Controlled demo run failed", error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Controlled demo run failed."
    });
  } finally {
    demoRunActive = false;
  }
});

app.get("/viewer", async (req: Request, res: Response) => {
  const root = path.resolve("artifacts", "traces");
  const entries = await readdir(root, { withFileTypes: true });
  const traces: Array<{ runId: string; workflow: string; mutation: string; success: boolean; durationMs: number; customer: string }> = [];
  for (const entry of entries.filter((value) => value.isDirectory()).slice(-50).reverse()) {
    try {
      const trace = JSON.parse(await readFile(path.join(root, entry.name, "trace.json"), "utf8")) as { runId: string; workflow: string; mutation: string; success: boolean; durationMs: number; customer: string };
      traces.push(trace);
    } catch {
      // Ignore partially written or unrelated directories.
    }
  }
  const rows = traces.map((trace) => `<tr><td><a href="/viewer/${encodeURIComponent(trace.runId)}">${esc(trace.runId)}</a></td><td>${esc(trace.workflow)}</td><td>${esc(trace.mutation)}</td><td>${esc(trace.customer)}</td><td>${trace.success ? "SUCCESS" : "FAILED"}</td><td>${trace.durationMs} ms</td></tr>`).join("");
  res.send(shell("Trace viewer", "UNKNOWN", req, `<section class="card"><h1>Workflow Trace Viewer</h1><p>Each run explains the action, evidence, diagnosis, ranked recovery, policy decision, and verification result.</p><div style="overflow:auto"><table><thead><tr><th>Run</th><th>Workflow</th><th>Mutation</th><th>Customer</th><th>Result</th><th>Latency</th></tr></thead><tbody>${rows || `<tr><td colspan="6">No traces yet. Run the Playwright runner first.</td></tr>`}</tbody></table></div></section>`));
});

app.get("/viewer/:runId", async (req: Request, res: Response) => {
  const runId = routeParam(req.params.runId);
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) return res.status(400).send("Invalid run id");
  try {
    const trace = JSON.parse(await readFile(path.resolve("artifacts", "traces", runId, "trace.json"), "utf8")) as {
      goal: string;
      workflow: string;
      mutation: string;
      customer: string;
      success: boolean;
      safeEscalation: boolean;
      durationMs: number;
      vlmCalls: number;
      steps: Array<{
        index: number;
        phase: string;
        screenshot: string;
        observation: { workflowState: string; url: string; targetBBox: unknown; blockerBBox: unknown };
        action: { name: string; success: boolean; error: string | null } | null;
        diagnosis: { failureType: string; confidence: number; reason: string; evidence: string[] } | null;
        rankedRecoveries: Array<{ action: string; score: number }>;
        policyDecision: { decision: string; reason: string } | null;
        executedRecovery: string | null;
        recoverySucceeded: boolean | null;
      }>;
    };
    const timeline = trace.steps.map((step) => `<section class="card"><div class="topbar"><div><strong>#${step.index} · ${esc(step.phase)}</strong><div>${esc(step.observation.workflowState)}</div></div><span class="pill">${esc(step.observation.url)}</span></div><div class="grid"><div><img src="/artifacts/traces/${encodeURIComponent(runId)}/${encodeURIComponent(step.screenshot)}" alt="Trace screenshot ${step.index}" style="width:100%;border:1px solid #e2e7f0;border-radius:12px" /></div><div>${step.action ? `<h3>Action</h3><p>${esc(step.action.name)} · ${step.action.success ? "success" : "failed"}</p>${step.action.error ? `<pre style="white-space:pre-wrap">${esc(step.action.error)}</pre>` : ""}` : ""}${step.diagnosis ? `<h3>Diagnosis</h3><p><strong>${esc(step.diagnosis.failureType)}</strong> · ${(step.diagnosis.confidence * 100).toFixed(0)}%</p><p>${esc(step.diagnosis.reason)}</p><ul>${step.diagnosis.evidence.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : ""}${step.rankedRecoveries.length ? `<h3>Recovery ranking</h3><ol>${step.rankedRecoveries.map((item) => `<li>${esc(item.action)} · ${item.score.toFixed(2)}</li>`).join("")}</ol>` : ""}${step.policyDecision ? `<h3>Policy</h3><p>${esc(step.policyDecision.decision)} — ${esc(step.policyDecision.reason)}</p>` : ""}${step.executedRecovery ? `<h3>Executed</h3><p>${esc(step.executedRecovery)} · ${step.recoverySucceeded ? "success" : "failed"}</p>` : ""}</div></div></section>`).join("");
    return res.send(shell(`Trace ${runId}`, "UNKNOWN", req, `<section class="card"><p><a href="/viewer">← All traces</a></p><h1>${esc(trace.goal)}</h1><div class="grid"><div><strong>Workflow</strong><p>${esc(trace.workflow)}</p></div><div><strong>Mutation</strong><p>${esc(trace.mutation)}</p></div><div><strong>Customer</strong><p>${esc(trace.customer)}</p></div><div><strong>Outcome</strong><p>${trace.success ? "SUCCESS" : "FAILED"}${trace.safeEscalation ? " · SAFE ESCALATION" : ""}</p></div><div><strong>Latency</strong><p>${trace.durationMs} ms</p></div><div><strong>Vision calls</strong><p>${trace.vlmCalls}</p></div></div></section>${timeline}`));
  } catch {
    return res.status(404).send("Trace not found");
  }
});

app.get("/", (req: Request, res: Response) => {
  const options = Object.values(MUTATIONS)
    .map((mutation) => `<option value="${mutation.id}">${esc(mutation.label)} · ${mutation.failureType}</option>`)
    .join("");
  res.send(shell("Demo launcher", "UNKNOWN", req, `
    <section class="card">
      <h1>Reliability Demo Launcher</h1>
      <p>Choose a customer policy and a deterministic UI failure. The browser runner uses the same parameters to generate automatic ground truth.</p>
      <div class="mut-picker">
        <div><label for="customer">Customer policy</label><select id="customer"><option value="customer_a">Customer A — auto refund ≤ $500</option><option value="customer_b">Customer B — all refunds require approval</option></select></div>
        <div><label for="mutation">Injected failure</label><select id="mutation">${options}</select></div>
      </div>
      <div class="actions">
        <button id="run-refund" class="btn" onclick="runControlledDemo('refund_order')">Run refund reliability demo</button>
        <button id="run-shipment" class="btn secondary" onclick="runControlledDemo('lookup_shipment')">Run shipment reliability demo</button>
        <button class="btn secondary" onclick="launch('refund_order')">Open synthetic app manually</button>
        <a class="btn secondary" href="/viewer">Open trace viewer</a>
      </div>
      <div id="run-status" class="notice" style="display:none;margin-top:16px"></div>
    </section>
    <section class="card"><h2>Product boundary</h2><p>This application is intentionally synthetic. WorkflowLens sits above deterministic browser automation and focuses on failure detection, diagnosis, policy-aware recovery, verification, and explainability.</p></section>
    <script>
      function launch(workflow) {
        const customer = document.getElementById('customer').value;
        const mutation = document.getElementById('mutation').value;
        window.location.href = '/login?customer=' + encodeURIComponent(customer) + '&mutation=' + encodeURIComponent(mutation) + '&workflow=' + encodeURIComponent(workflow);
      }

      async function runControlledDemo(workflow) {
        const customer = document.getElementById('customer').value;
        const mutation = document.getElementById('mutation').value;
        const status = document.getElementById('run-status');
        const buttons = [document.getElementById('run-refund'), document.getElementById('run-shipment')];
        status.style.display = 'block';
        status.classList.remove('success');
        status.textContent = 'Running controlled local-browser workflow…';
        for (const button of buttons) button.disabled = true;
        try {
          const response = await fetch('/api/demo/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workflow, customer, mutation })
          });
          const payload = await response.json();
          if (!response.ok || !payload.ok) throw new Error(payload.error || 'Demo run failed.');
          status.classList.add('success');
          status.textContent = 'Run complete. Opening the explainable trace…';
          window.location.href = payload.viewerUrl;
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : 'Demo run failed.';
          for (const button of buttons) button.disabled = false;
        }
      }
    </script>
  `));
});

app.get("/login", (req: Request, res: Response) => {
  const suffix = querySuffix(req);
  res.send(shell("Login", "LOGIN", req, `
    <section class="card" style="max-width:520px;margin:60px auto">
      <h1>Operations Login</h1>
      <p>Use the deterministic demo account: <strong>demo / demo</strong>.</p>
      <form id="login-form">
        <div style="margin-bottom:12px"><label for="username">Username</label><input id="username" name="username" value="demo" autocomplete="username" /></div>
        <div><label for="password">Password</label><input id="password" name="password" type="password" value="demo" autocomplete="current-password" /></div>
        <div class="actions"><button class="btn" data-target-id="login_button" type="submit">Sign in</button></div>
      </form>
    </section>
    <script>
      document.getElementById('login-form').addEventListener('submit', (event) => {
        event.preventDefault();
        window.location.href = '/orders${suffix}';
      });
    </script>
  `, ["login_button"]));
});

app.get("/orders", (req: Request, res: Response) => {
  const suffix = querySuffix(req);
  const rows = ORDERS.map((order) => `<tr data-order-id="${order.id}"><td><a data-target-id="order_${order.id}" href="/orders/${order.id}${suffix}">${order.id}</a></td><td>${esc(order.customer)}</td><td>$${order.total.toFixed(2)}</td><td>${order.status}</td></tr>`).join("");
  res.send(shell("Orders", "ORDERS", req, `
    <section class="card">
      <h1>Orders</h1>
      <div class="grid"><div><label for="order-search">Order search</label><input id="order-search" value="ORD-18392" /></div><div style="align-self:end"><button class="btn" data-target-id="order_search_button" onclick="filterOrders()">Search order</button></div></div>
      <div style="overflow:auto;margin-top:18px"><table><thead><tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th></tr></thead><tbody id="order-body">${rows}</tbody></table></div>
    </section>
    <script>
      function filterOrders() {
        const query = document.getElementById('order-search').value.trim().toUpperCase();
        for (const row of document.querySelectorAll('[data-order-id]')) row.style.display = !query || row.dataset.orderId.includes(query) ? '' : 'none';
      }
    </script>
  `, ["order_search_button", ...ORDERS.map((order) => `order_${order.id}`)]));
});

app.get("/orders/:orderId", (req: Request, res: Response) => {
  const order = getOrder(routeParam(req.params.orderId));
  const mutation = getMutation(typeof req.query.mutation === "string" ? req.query.mutation : undefined);
  const applied = mutationApplies(mutation, "ORDER_DETAIL");
  const suffix = querySuffix(req);
  const isMoved = applied && mutation.id === "element_moved";
  const isOffscreen = applied && mutation.id === "offscreen_target";
  const isResponsive = applied && mutation.id === "responsive_layout";
  const isHidden = applied && mutation.id === "hidden_element";
  const renameShipment = applied && mutation.id === "element_renamed";
  const iconOnly = applied && mutation.id === "icon_only";
  const unexpectedNav = applied && mutation.id === "unexpected_navigation";
  const shipmentHref = unexpectedNav ? `/maintenance${suffix}` : `/orders/${order.id}/shipment${suffix}`;
  const shipmentText = iconOnly ? "↗" : renameShipment ? "Track parcel" : "Shipment lookup";
  const shipmentAria = iconOnly ? `Shipment lookup for ${order.id}` : undefined;
  const refundButton = `<a class="btn danger ${isMoved ? "moved" : ""} ${isHidden ? "hidden" : ""}" data-target-id="refund_button" href="/orders/${order.id}/refund${suffix}">Refund order</a>`;
  const alternativeRefund = isHidden ? `<a class="btn danger" data-target-id="refund_button_alternative" href="/orders/${order.id}/refund${suffix}">Open refund controls</a>` : "";
  const blocker = applied && mutation.id === "cookie_overlay"
    ? overlay("cookie_consent_modal", "Cookie preferences", "Please review cookie preferences before continuing.", "Accept and close")
    : applied && mutation.id === "unexpected_modal"
      ? overlay("announcement_modal", "Operations announcement", "A scheduled carrier update is available.")
      : applied && mutation.id === "auth_expired"
        ? `<div class="overlay" data-testid="session_expired_modal" data-blocker-id="session_expired_modal"><section class="modal" role="dialog" aria-modal="true"><h2>Session expired</h2><p>Your session expired. Sign in again to continue.</p><a class="btn" data-recovery-action="REAUTHENTICATE" href="/login${suffix}">Sign in again</a></section></div>`
        : applied && mutation.id === "loading_stuck"
          ? `<div class="loading" data-testid="loading_overlay" data-blocker-id="loading_overlay">Loading order state…</div>`
          : "";
  res.send(shell(`Order ${order.id}`, "ORDER_DETAIL", req, `
    <section class="card">
      <p><a href="/orders${suffix}">← Orders</a></p>
      <h1>${order.id}</h1>
      <div class="grid"><div><strong>Customer</strong><p>${esc(order.customer)}</p></div><div><strong>Total</strong><p>$${order.total.toFixed(2)}</p></div><div><strong>Status</strong><p>${order.status}</p></div><div><strong>Shipment</strong><p>${order.shipmentId}</p></div></div>
      ${isOffscreen ? `<div class="offscreen-spacer">Injected content pushes primary action below viewport</div>` : ""}
      <div class="actions ${isResponsive ? "compact-actions" : ""}">
        <a class="btn secondary" data-target-id="shipment_lookup_button" href="${shipmentHref}" ${shipmentAria ? `aria-label="${esc(shipmentAria)}" title="Shipment lookup"` : ""}>${shipmentText}</a>
        ${refundButton}
        ${alternativeRefund}
      </div>
    </section>
    ${blocker}
  `, ["shipment_lookup_button", "refund_button", ...(isHidden ? ["refund_button_alternative"] : [])]));
});

app.get("/orders/:orderId/shipment", (req: Request, res: Response) => {
  const order = getOrder(routeParam(req.params.orderId));
  const suffix = querySuffix(req);
  const mutation = getMutation(typeof req.query.mutation === "string" ? req.query.mutation : undefined);
  const stuck = mutationApplies(mutation, "SHIPMENT") && mutation.id === "loading_stuck";
  res.send(shell(`Shipment ${order.shipmentId}`, "SHIPMENT", req, `
    <section class="card"><p><a href="/orders/${order.id}${suffix}">← Order</a></p><h1>Shipment ${order.shipmentId}</h1><p><strong>Carrier:</strong> ${esc(order.carrier)}</p><p><strong>Status:</strong> In transit · next scan expected today</p></section>
    ${stuck ? `<div class="loading" data-testid="loading_overlay" data-blocker-id="loading_overlay">Loading live carrier events…</div>` : ""}
  `));
});

app.get("/orders/:orderId/refund", (req: Request, res: Response) => {
  const order = getOrder(routeParam(req.params.orderId));
  const suffix = querySuffix(req);
  const mutation = getMutation(typeof req.query.mutation === "string" ? req.query.mutation : undefined);
  const applied = mutationApplies(mutation, "REFUND");
  const disabled = applied && mutation.id === "disabled_action";
  const permissionDenied = applied && mutation.id === "permission_denied";
  const stale = applied && mutation.id === "stale_state";
  const actionUrl = `/orders/${order.id}/complete${suffix}`;
  const validationScript = applied && mutation.id === "validation_error"
    ? `if (!document.getElementById('reason').value.trim()) { document.getElementById('validation').textContent = 'Refund reason is required.'; document.getElementById('validation').style.display = 'block'; return; }`
    : "";
  const clickScript = applied && mutation.id === "confirmation_required"
    ? `document.getElementById('confirmation-modal').style.display = 'grid';`
    : `window.location.href = '${actionUrl}';`;
  const authOverlay = applied && mutation.id === "auth_expired"
    ? `<div class="overlay" data-testid="session_expired_modal" data-blocker-id="session_expired_modal"><section class="modal"><h2>Session expired</h2><p>Authentication is required before refund execution.</p><a class="btn" data-recovery-action="REAUTHENTICATE" href="/login${suffix}">Reauthenticate</a></section></div>`
    : "";
  res.send(shell(`Refund ${order.id}`, "REFUND", req, `
    <section class="card">
      <p><a href="/orders/${order.id}${suffix}">← Order</a></p>
      <h1>Refund ${order.id}</h1>
      <p>Refund amount: <strong>$${order.total.toFixed(2)}</strong></p>
      <p>Business policy is intentionally not rendered on this screen. WorkflowLens receives it as external domain context.</p>
      ${permissionDenied ? `<div class="notice" data-testid="permission_banner" data-blocker-id="permission_banner">Permission denied: your role cannot execute refunds.</div>` : ""}
      ${stale ? `<div class="notice" data-testid="stale_state_banner" data-blocker-id="stale_state_banner">Order data changed after page load. Refresh before proceeding.</div>` : ""}
      <div><label for="reason">Refund reason</label><textarea id="reason" rows="3">${applied && mutation.id === "validation_error" ? "" : "Customer requested return"}</textarea><div id="validation" class="notice" style="display:none"></div></div>
      <div class="actions"><button class="btn danger" data-target-id="execute_refund_button" ${disabled || permissionDenied || stale ? "disabled" : ""} onclick="handleRefund()">Execute refund</button></div>
    </section>
    <div id="confirmation-modal" class="overlay" data-testid="confirmation_modal" data-blocker-id="confirmation_modal" style="display:none"><section class="modal"><h2>Confirm refund</h2><p>Confirm the final refund action for ${order.id}.</p><button class="btn danger" data-recovery-action="CONFIRM" onclick="window.location.href='${actionUrl}'">Confirm</button></section></div>
    ${authOverlay}
    <script>
      function handleRefund() {
        document.getElementById('validation').style.display = 'none';
        ${validationScript}
        ${clickScript}
      }
    </script>
  `, ["execute_refund_button"]));
});

app.get("/orders/:orderId/approval", (req: Request, res: Response) => {
  const order = getOrder(routeParam(req.params.orderId));
  const suffix = querySuffix(req);
  res.send(shell(`Approval ${order.id}`, "APPROVAL_REQUIRED", req, `
    <section class="card"><h1>Human approval requested</h1><p>${order.id} refund of $${order.total.toFixed(2)} has been escalated according to customer policy.</p><div class="notice success">Safe terminal state: no autonomous financial action was executed.</div><div class="actions"><a class="btn secondary" href="/${suffix}">Back to launcher</a></div></section>
  `));
});

app.get("/orders/:orderId/complete", (req: Request, res: Response) => {
  const order = getOrder(routeParam(req.params.orderId));
  const suffix = querySuffix(req);
  res.send(shell(`Complete ${order.id}`, "COMPLETE", req, `
    <section class="card"><h1>Refund complete</h1><div class="notice success">${order.id} refund completed successfully in the synthetic environment.</div><div class="actions"><a class="btn secondary" href="/${suffix}">Back to launcher</a></div></section>
  `));
});

app.get("/maintenance", (req: Request, res: Response) => {
  const suffix = querySuffix(req);
  res.send(shell("Unexpected navigation", "UNKNOWN", req, `<section class="card"><h1>Maintenance</h1><div class="notice">This is not the expected shipment screen.</div><div class="actions"><button class="btn" data-recovery-action="RETURN_PREVIOUS_STEP" onclick="history.back()">Return to previous step</button><a class="btn secondary" href="/orders${suffix}">Orders</a></div></section>`));
});

app.listen(port, () => {
  console.log(`WorkflowLens synthetic commerce listening on http://127.0.0.1:${port}`);
});

