import { chromium, type Browser, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { getPolicy, getOrder, requiresHumanApproval, type CustomerId, type RecoveryAction, type WorkflowId, type WorkflowState } from "../domain.js";
import { getMutation, type MutationId } from "../mutations.js";
import { diagnoseFailure } from "../ai/diagnosis.js";
import { applyPolicyGate, rankRecoveries } from "../ai/recovery.js";
import { diagnoseWithVlm } from "../ai/vlm.js";
import { captureObservation, getWorkflowState, sanitizeControlMetadataText, sanitizeWorkflowUrl } from "./capture.js";
import type {
  ActionRecord,
  BrowserObservation,
  GroundTruth,
  ModalityConfig,
  TraceStep,
  VisionStrategy,
  WorkflowTrace
} from "./types.js";

const BASE_URL = process.env.WORKFLOWLENS_BASE_URL ?? "http://127.0.0.1:4317";

export interface RunnerOptions {
  workflow: WorkflowId;
  customer: CustomerId;
  mutation: MutationId;
  orderId: string;
  modalities: ModalityConfig;
  headless: boolean;
  visionStrategy?: VisionStrategy;
  reasoner?: "heuristic" | "vlm";
}

interface TargetAction {
  name: string;
  targetId: string;
  brittleSelector: string;
  expectedLabel: string;
  expectedState: WorkflowState | "TERMINAL";
}

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function parseModalities(raw: string): ModalityConfig {
  const values = new Set(raw.split(",").map((value) => value.trim().toLowerCase()));
  return {
    screenshot: values.has("screenshot"),
    dom: values.has("dom"),
    history: values.has("history"),
    policy: values.has("policy")
  };
}

function runId(options: RunnerOptions): string {
  return `${Date.now()}_${options.workflow}_${options.customer}_${options.mutation}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function withParams(pathname: string, options: RunnerOptions, mutation = options.mutation): string {
  const params = new URLSearchParams({ customer: options.customer, mutation });
  return `${BASE_URL}${pathname}?${params.toString()}`;
}

async function screenshot(page: Page, directory: string, index: number, label: string): Promise<string> {
  const filename = `${String(index).padStart(2, "0")}_${label}.png`;
  await page.screenshot({ path: path.join(directory, filename), fullPage: true });
  return filename;
}

function groundTruth(options: RunnerOptions): GroundTruth | null {
  const mutation = getMutation(options.mutation);
  if (mutation.id === "none") return null;
  return {
    mutation: mutation.id,
    failureType: mutation.failureType,
    target: mutation.targetId,
    blocker: mutation.blocker,
    expectedRecovery: mutation.expectedRecovery
  };
}

async function recordStep(
  steps: TraceStep[],
  page: Page,
  directory: string,
  phase: TraceStep["phase"],
  targetId: string | null,
  history: ActionRecord[],
  extra: Partial<Omit<TraceStep, "index" | "phase" | "timestamp" | "screenshot" | "observation" | "actionHistory">> = {}
): Promise<BrowserObservation> {
  const observation = await captureObservation(page, targetId);
  const index = steps.length;
  const image = await screenshot(page, directory, index, phase.toLowerCase());
  steps.push({
    index,
    phase,
    timestamp: new Date().toISOString(),
    screenshot: image,
    observation,
    action: null,
    actionHistory: [...history],
    groundTruth: null,
    diagnosis: null,
    rankedRecoveries: [],
    policyDecision: null,
    executedRecovery: null,
    recoverySucceeded: null,
    ...extra
  });
  return observation;
}

async function performAction(page: Page, action: TargetAction, history: ActionRecord[], relaxedLayout = false): Promise<ActionRecord> {
  const stateBefore = await getWorkflowState(page);
  const urlBefore = sanitizeWorkflowUrl(page.url());
  let success = true;
  let error: string | null = null;
  try {
    const observation = await captureObservation(page, action.targetId);
    if (observation.overlayPresent && (observation.occlusionRatio > 0.05 || observation.blockerId === "loading_overlay" || observation.blockerId === "session_expired_modal")) {
      throw new Error(`preflight blocker detected: ${observation.blockerId}`);
    }
    if (observation.targetDisabled) throw new Error("preflight target is disabled");
    if (observation.targetVisible && !observation.targetInViewport) throw new Error("preflight target is offscreen");
    const targetSnapshot = observation.interactiveElements.find((element) => element.targetId === action.targetId);
    if (!relaxedLayout && stateBefore === "ORDER_DETAIL" && targetSnapshot?.fixedAncestor) throw new Error("preflight responsive layout confidence is low");
    if (!relaxedLayout && stateBefore === "ORDER_DETAIL" && observation.targetVisible && observation.targetBBox && observation.targetBBox.y > 500) throw new Error("preflight target geometry moved from expected action region");
    await page.locator(action.brittleSelector).click({ timeout: 900 });
    await page.waitForTimeout(120);
  } catch (caught) {
    success = false;
    error = sanitizeControlMetadataText(caught instanceof Error ? caught.message.slice(0, 1200) : String(caught));
  }
  const stateAfter = await getWorkflowState(page);
  const record: ActionRecord = {
    name: action.name,
    targetId: action.targetId,
    selector: action.brittleSelector,
    expectedState: action.expectedState,
    success,
    error,
    stateBefore,
    stateAfter,
    urlBefore,
    urlAfter: sanitizeWorkflowUrl(page.url())
  };
  history.push(record);
  return record;
}

async function executeRecovery(page: Page, action: RecoveryAction, target: TargetAction, options: RunnerOptions): Promise<boolean> {
  try {
    if (action === "CLOSE_MODAL") {
      await page.locator('[data-recovery-action="CLOSE_MODAL"]').first().click({ timeout: 900 });
      return true;
    }
    if (action === "SCROLL") {
      await page.locator(`[data-target-id="${target.targetId}"]`).scrollIntoViewIfNeeded();
      return true;
    }
    if (action === "USE_ALTERNATIVE_TARGET") {
      const primary = page.locator(`[data-target-id="${target.targetId}"]:visible`);
      if (await primary.count()) await primary.first().click({ timeout: 900 });
      else await page.locator(`[data-target-id="${target.targetId}_alternative"]`).click({ timeout: 900 });
      return true;
    }
    if (action === "CHANGE_VIEWPORT") {
      await page.setViewportSize({ width: 1440, height: 1000 });
      return true;
    }
    if (action === "REAUTHENTICATE") {
      const current = new URL(page.url());
      const currentPath = current.pathname.includes("/refund") ? current.pathname : `/orders/${options.orderId}`;
      await page.goto(withParams("/login", options, "none"));
      await page.locator("#login-form").evaluate((form: HTMLFormElement) => form.requestSubmit());
      await page.waitForURL(/\/orders/);
      await page.goto(withParams(currentPath, options, "none"));
      return true;
    }
    if (action === "FILL_REQUIRED_FIELD") {
      await page.locator("#reason").fill("Customer requested return");
      return true;
    }
    if (action === "CONFIRM") {
      await page.locator('[data-recovery-action="CONFIRM"]').click({ timeout: 900 });
      return true;
    }
    if (action === "REFRESH") {
      const current = new URL(page.url());
      await page.goto(withParams(current.pathname, options, "none"));
      return true;
    }
    if (action === "RETURN_PREVIOUS_STEP") {
      await page.goBack({ waitUntil: "domcontentloaded" });
      const returned = new URL(page.url());
      await page.goto(withParams(returned.pathname, options, "none"));
      return true;
    }
    if (action === "ESCALATE_TO_HUMAN" || action === "ABORT") return true;
    if (action === "WAIT") {
      await page.waitForTimeout(250);
      return true;
    }
    if (action === "RETRY") return true;
    return false;
  } catch {
    return false;
  }
}

async function diagnoseAndRecover(
  page: Page,
  target: TargetAction,
  options: RunnerOptions,
  history: ActionRecord[],
  steps: TraceStep[],
  directory: string,
  goal: string,
  refundAmount: number | null
): Promise<{ recovered: boolean; escalated: boolean }> {
  const policy = getPolicy(options.customer);
  const observation = await captureObservation(page, target.targetId);
  const heuristicDiagnosis = diagnoseFailure({
    observation,
    history,
    goal,
    expectedState: target.expectedState,
    expectedTargetLabel: target.expectedLabel,
    policy,
    modalities: options.modalities
  });
  let diagnosis = heuristicDiagnosis;
  if (options.reasoner === "vlm" && options.modalities.screenshot) {
    try {
      const vlmInput = path.join(directory, `vlm_${steps.length}.png`);
      await page.screenshot({ path: vlmInput, fullPage: true });
      const vlm = await diagnoseWithVlm({
        screenshotPath: vlmInput,
        goal,
        previousAction: history.at(-1)?.name ?? null,
        currentUrl: observation.url,
        dom: JSON.stringify(observation.interactiveElements),
        accessibility: observation.accessibility,
        customerPolicy: JSON.stringify(policy)
      });
      diagnosis = {
        failureType: vlm.failure_type as typeof heuristicDiagnosis.failureType,
        confidence: Math.max(0, Math.min(1, Number(vlm.confidence) || 0)),
        target: vlm.target,
        blocker: vlm.blocker,
        evidence: Array.isArray(vlm.evidence) ? vlm.evidence : [],
        reason: vlm.reason || "Live VLM diagnosis"
      };
    } catch (error) {
      diagnosis = {
        ...heuristicDiagnosis,
        evidence: [
          ...heuristicDiagnosis.evidence,
          `VLM fallback failed; heuristic used: ${error instanceof Error ? error.message : String(error)}`
        ]
      };
    }
  }
  const ranked = rankRecoveries(diagnosis);
  let selected = ranked[0].action;
  const gate = options.modalities.policy ? applyPolicyGate(selected, policy, refundAmount) : { decision: "ALLOW" as const, reason: "Policy modality disabled for this run." };
  if (gate.decision === "ESCALATE") selected = "ESCALATE_TO_HUMAN";
  await recordStep(steps, page, directory, "FAILURE", target.targetId, history, {
    groundTruth: groundTruth(options),
    diagnosis,
    rankedRecoveries: ranked,
    policyDecision: gate,
    executedRecovery: selected
  });
  const failureStep = steps.at(-1)!;
  const recoverySucceeded = await executeRecovery(page, selected, target, options);
  failureStep.recoverySucceeded = recoverySucceeded;
  await recordStep(steps, page, directory, "RECOVERY", target.targetId, history, {
    groundTruth: groundTruth(options),
    diagnosis,
    rankedRecoveries: ranked,
    policyDecision: gate,
    executedRecovery: selected,
    recoverySucceeded
  });
  return { recovered: recoverySucceeded, escalated: selected === "ESCALATE_TO_HUMAN" };
}

async function runTargetAction(
  page: Page,
  target: TargetAction,
  options: RunnerOptions,
  history: ActionRecord[],
  steps: TraceStep[],
  directory: string,
  goal: string,
  refundAmount: number | null
): Promise<{ ok: boolean; escalated: boolean }> {
  await recordStep(steps, page, directory, "NORMAL_ACTION", target.targetId, history);
  const actionRecord = await performAction(page, target, history);
  steps.at(-1)!.action = actionRecord;
  const state = await getWorkflowState(page);
  if (actionRecord.success && (state === target.expectedState || (target.expectedState === "TERMINAL" && ["COMPLETE", "APPROVAL_REQUIRED"].includes(state)))) {
    await recordStep(steps, page, directory, "VERIFY", null, history);
    return { ok: true, escalated: false };
  }

  const recovery = await diagnoseAndRecover(page, target, options, history, steps, directory, goal, refundAmount);
  if (!recovery.recovered) return { ok: false, escalated: recovery.escalated };
  if (recovery.escalated) return { ok: true, escalated: true };

  const currentState = await getWorkflowState(page);
  if (currentState === target.expectedState || (target.expectedState === "TERMINAL" && ["COMPLETE", "APPROVAL_REQUIRED"].includes(currentState))) {
    await recordStep(steps, page, directory, "VERIFY", null, history);
    return { ok: true, escalated: false };
  }

  const retry = await performAction(page, { ...target, brittleSelector: `[data-target-id="${target.targetId}"]` }, history, true);
  const retryState = await getWorkflowState(page);
  const ok = retry.success && (retryState === target.expectedState || (target.expectedState === "TERMINAL" && ["COMPLETE", "APPROVAL_REQUIRED"].includes(retryState)));
  await recordStep(steps, page, directory, "VERIFY", target.targetId, history, { action: retry, recoverySucceeded: ok });
  return { ok, escalated: false };
}

export async function runWorkflow(options: RunnerOptions): Promise<WorkflowTrace> {
  const started = performance.now();
  const id = runId(options);
  const directory = path.resolve("artifacts", "traces", id);
  await mkdir(directory, { recursive: true });
  const history: ActionRecord[] = [];
  const steps: TraceStep[] = [];
  const goal = options.workflow === "refund_order" ? `Refund ${options.orderId} according to customer policy` : `Look up shipment for ${options.orderId}`;
  let browser: Browser | null = null;
  let success = false;
  let safeEscalation = false;

  try {
    browser = await chromium.launch({ headless: options.headless });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(withParams("/login", options));
    await page.locator("#login-form").evaluate((form: HTMLFormElement) => form.requestSubmit());
    await page.waitForURL(/\/orders/);
    await page.locator(`[data-target-id="order_${options.orderId}"]`).click();

    if (options.workflow === "lookup_shipment") {
      const shipment = await runTargetAction(page, {
        name: "click_shipment_lookup",
        targetId: "shipment_lookup_button",
        brittleSelector: 'a:has-text("Shipment lookup")',
        expectedLabel: "shipment lookup",
        expectedState: "SHIPMENT"
      }, options, history, steps, directory, goal, null);
      success = shipment.ok;
      safeEscalation = shipment.escalated;
    } else {
      const openRefund = await runTargetAction(page, {
        name: "click_refund",
        targetId: "refund_button",
        brittleSelector: 'a:has-text("Refund order")',
        expectedLabel: "refund order",
        expectedState: "REFUND"
      }, options, history, steps, directory, goal, getOrder(options.orderId).total);
      if (!openRefund.ok || openRefund.escalated) {
        success = openRefund.ok;
        safeEscalation = openRefund.escalated;
      } else {
        const refundAmount = getOrder(options.orderId).total;
        const policy = getPolicy(options.customer);
        if (options.modalities.policy && requiresHumanApproval(policy, refundAmount)) {
          await recordStep(steps, page, directory, "NORMAL_ACTION", "execute_refund_button", history, {
            policyDecision: {
              decision: "ESCALATE",
              reason: policy.requireApprovalForAllRefunds
                ? `${policy.name} requires human approval for every refund.`
                : `Refund $${refundAmount.toFixed(2)} exceeds ${policy.name}'s $${policy.refundAutoExecuteLimit.toFixed(2)} autonomous limit.`
            },
            executedRecovery: "ESCALATE_TO_HUMAN",
            recoverySucceeded: true
          });
          await page.goto(withParams(`/orders/${options.orderId}/approval`, options, "none"));
          await recordStep(steps, page, directory, "VERIFY", null, history, {
            policyDecision: {
              decision: "ESCALATE",
              reason: "Policy-aware business action gate prevented autonomous financial execution."
            },
            executedRecovery: "ESCALATE_TO_HUMAN",
            recoverySucceeded: true
          });
          success = true;
          safeEscalation = true;
        } else {
        const executeRefund = await runTargetAction(page, {
          name: "execute_refund",
          targetId: "execute_refund_button",
          brittleSelector: '[data-target-id="execute_refund_button"]',
          expectedLabel: "execute refund",
          expectedState: "TERMINAL"
        }, options, history, steps, directory, goal, refundAmount);
        success = executeRefund.ok;
        safeEscalation = executeRefund.escalated || (await getWorkflowState(page)) === "APPROVAL_REQUIRED";
        }
      }
    }
  } finally {
    await browser?.close();
  }

  const completedAt = new Date().toISOString();
  const visionStrategy = options.visionStrategy ?? "on_failure";
  const reasoner = options.reasoner ?? "heuristic";
  const visionEligibleActions = steps.filter((step) => step.phase === "NORMAL_ACTION").length;
  const fallbackCalls = steps.filter((step) => step.phase === "FAILURE").length;
  const visionFallbackCalls = options.modalities.screenshot
    ? visionStrategy === "always"
      ? visionEligibleActions
      : fallbackCalls
    : 0;
  const trace: WorkflowTrace = {
    schemaVersion: "1.0",
    runId: id,
    startedAt: new Date(Date.now() - (performance.now() - started)).toISOString(),
    completedAt,
    baseUrl: BASE_URL,
    workflow: options.workflow,
    goal,
    customer: options.customer,
    orderId: options.orderId,
    mutation: options.mutation,
    modalities: options.modalities,
    visionStrategy,
    reasoner,
    success,
    taskCompleted: success && !safeEscalation,
    safeEscalation,
    visionFallbackCalls,
    vlmCalls: reasoner === "vlm" ? fallbackCalls : 0,
    durationMs: Math.round(performance.now() - started),
    steps
  };
  await writeFile(path.join(directory, "trace.json"), JSON.stringify(trace, null, 2));
  return trace;
}

async function main(): Promise<void> {
  const options: RunnerOptions = {
    workflow: arg("workflow", "refund_order") as WorkflowId,
    customer: arg("customer", "customer_a") as CustomerId,
    mutation: arg("mutation", "cookie_overlay") as MutationId,
    orderId: arg("order", "ORD-18401"),
    modalities: parseModalities(arg("modalities", "screenshot,dom,history,policy")),
    headless: arg("headless", "true") !== "false",
    visionStrategy: arg("vision", "on_failure") as VisionStrategy,
    reasoner: arg("reasoner", "heuristic") as "heuristic" | "vlm"
  };
  const trace = await runWorkflow(options);
  console.log(JSON.stringify({
    runId: trace.runId,
    success: trace.success,
    safeEscalation: trace.safeEscalation,
    mutation: trace.mutation,
    durationMs: trace.durationMs,
    visionFallbackCalls: trace.visionFallbackCalls,
    vlmCalls: trace.vlmCalls,
    trace: `artifacts/traces/${trace.runId}/trace.json`
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

