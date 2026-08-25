import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { LocalLlmEvidence, LocalLlmPrediction } from "./types.js";

interface RemoteModel {
  id: string;
  type: "llm" | "vlm" | "embeddings" | string;
  state: "loaded" | "not-loaded" | string;
}

interface RemoteModelsResponse {
  data?: RemoteModel[];
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

function sshHost(): string {
  return process.env.WORKFLOWLENS_LLM_SSH_HOST ?? "macbook-pro";
}

function endpoint(): string {
  return (process.env.WORKFLOWLENS_LLM_ENDPOINT ?? "http://127.0.0.1:1234").replace(/\/$/, "");
}

function requestTimeoutMs(): number {
  return Number(process.env.WORKFLOWLENS_LLM_REQUEST_TIMEOUT_MS ?? 15 * 60_000);
}

function respectRemoteBusy(): boolean {
  return process.env.WORKFLOWLENS_LLM_RESPECT_REMOTE_BUSY !== "false";
}

function endpointPort(): number {
  try {
    const parsed = new URL(endpoint());
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return 1234;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function sshCurl(url: string, body?: unknown): Promise<string> {
  const timeoutMs = requestTimeoutMs();
  const timeoutSeconds = Math.max(5, Math.ceil(timeoutMs / 1000));
  const command = body === undefined
    ? `curl --fail-with-body --silent --show-error --max-time ${timeoutSeconds} ${shellQuote(url)}`
    : `curl --fail-with-body --silent --show-error --max-time ${timeoutSeconds} -H 'Content-Type: application/json' --data-binary @- ${shellQuote(url)}`;

  return await new Promise<string>((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", sshHost(), command], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Remote LM Studio request timed out after ${timeoutMs} ms.`));
    }, timeoutMs + 10_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Remote LM Studio request failed (${code ?? "unknown"}): ${[stderr, stdout].filter(Boolean).join("\n")}`));
    });
    if (body === undefined) child.stdin.end();
    else child.stdin.end(JSON.stringify(body));
  });
}

export async function isRemoteInferenceBusy(): Promise<boolean> {
  if (!respectRemoteBusy()) return false;
  const port = endpointPort();
  const command = `lsof -nP -iTCP:${port} -sTCP:ESTABLISHED -t 2>/dev/null | head -1 || true`;
  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", sshHost(), command], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Remote busy probe timed out."));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim().length > 0);
      else reject(new Error(`Remote busy probe failed (${code ?? "unknown"}): ${stderr}`));
    });
  });
}

export async function listRemoteModels(): Promise<RemoteModel[]> {
  const response = JSON.parse(await sshCurl(`${endpoint()}/api/v0/models`)) as RemoteModelsResponse;
  return response.data ?? [];
}

export async function resolveLoadedModel(requiresVision: boolean, requestedModel: string | null): Promise<RemoteModel | null> {
  const loaded = (await listRemoteModels()).filter((model) => model.state === "loaded");
  if (requestedModel) {
    const requested = loaded.find((model) => model.id === requestedModel) ?? null;
    if (!requested) return null;
    if (requiresVision && requested.type !== "vlm") return null;
    return requested;
  }
  return loaded.find((model) => requiresVision ? model.type === "vlm" : model.type === "llm" || model.type === "vlm") ?? null;
}

function prompt(evidence: LocalLlmEvidence): string {
  return [
    "You are WorkflowLens, a browser workflow reliability layer.",
    "Diagnose why an existing browser automation step failed. Do not plan a general browsing task.",
    "Use only the evidence below. Return JSON only.",
    "Required keys: failure_type, recovery, recovery_ranking, confidence, reason.",
    "failure_type must be exactly one of: AUTH_EXPIRED, CONFIRMATION_REQUIRED, DISABLED_ACTION, ELEMENT_MOVED, ELEMENT_RENAMED, FORM_VALIDATION_ERROR, HIDDEN_ELEMENT, ICON_ONLY_TARGET, LOADING_STUCK, NAVIGATION_ERROR, OCCLUDED_TARGET, OFFSCREEN_TARGET, PERMISSION_DENIED, RESPONSIVE_LAYOUT_CHANGE, STALE_STATE, UNEXPECTED_MODAL, UNKNOWN_STATE.",
    "Taxonomy semantics: AUTH_EXPIRED=session/login expired; CONFIRMATION_REQUIRED=extra confirmation step; DISABLED_ACTION=target present but disabled; ELEMENT_MOVED=target relocated; ELEMENT_RENAMED=label changed; FORM_VALIDATION_ERROR=required form input missing or invalid; HIDDEN_ELEMENT=primary target hidden; ICON_ONLY_TARGET=text target became icon-only; LOADING_STUCK=loading blocker does not resolve; NAVIGATION_ERROR=action led to the wrong workflow state or page; OCCLUDED_TARGET=overlay visually blocks target; OFFSCREEN_TARGET=target exists outside viewport; PERMISSION_DENIED=operator lacks permission; RESPONSIVE_LAYOUT_CHANGE=responsive or fixed layout changed target geometry; STALE_STATE=page data is stale and needs refresh; UNEXPECTED_MODAL=unrelated modal interrupts workflow; UNKNOWN_STATE=evidence is insufficient for another class.",
    "Recovery must be the highest-ranked concrete recovery action.",
    "recovery_ranking must contain exactly the three best distinct recovery actions, ordered best to worst, chosen from: CLOSE_MODAL, REFRESH, SCROLL, REAUTHENTICATE, USE_ALTERNATIVE_TARGET, RETURN_PREVIOUS_STEP, FILL_REQUIRED_FIELD, CONFIRM, CHANGE_VIEWPORT, ESCALATE_TO_HUMAN, ABORT, WAIT, RETRY.",
    `GOAL\n${evidence.goal}`,
    `PREVIOUS STATE\n${evidence.previousState ?? "unknown"}`,
    `PREVIOUS ACTION\n${evidence.previousAction ?? "unknown"}`,
    `EXPECTED NEXT STATE\n${evidence.expectedNextState ?? "unknown"}`,
    `CURRENT STATE\n${evidence.currentState}`,
    `INTERACTIVE DOM\n${JSON.stringify(evidence.domSnapshot)}`,
    `ACCESSIBILITY\n${evidence.accessibilityTree}`,
    `ACTION HISTORY\n${JSON.stringify(evidence.actionHistory)}`,
    `CUSTOMER POLICY\n${JSON.stringify(evidence.customerPolicy)}`
  ].join("\n\n");
}

function extractJson(content: string): LocalLlmPrediction {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`Model response did not contain a JSON object: ${content.slice(0, 500)}`);
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Partial<LocalLlmPrediction>;
  const ranking = Array.isArray(parsed.recovery_ranking)
    ? parsed.recovery_ranking.map((value) => String(value).trim().toUpperCase()).filter(Boolean)
    : [];
  const recovery = String(parsed.recovery ?? ranking[0] ?? "ESCALATE_TO_HUMAN").trim().toUpperCase();
  const deduplicatedRanking = [...new Set([recovery, ...ranking])].slice(0, 3);
  return {
    failure_type: String(parsed.failure_type ?? "UNKNOWN_STATE").trim().toUpperCase(),
    recovery,
    recovery_ranking: deduplicatedRanking,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    reason: String(parsed.reason ?? "")
  };
}

export async function runRemoteDiagnosis(
  model: RemoteModel,
  evidence: LocalLlmEvidence,
  requiresVision: boolean,
  screenshotBase64: string | null
): Promise<{ prediction: LocalLlmPrediction; rawContent: string; latencyMs: number }> {
  const text = prompt(evidence);
  const content = requiresVision
    ? [
        { type: "text", text },
        { type: "image_url", image_url: { url: `data:image/png;base64,${screenshotBase64 ?? ""}` } }
      ]
    : text;
  const started = performance.now();
  const response = JSON.parse(await sshCurl(`${endpoint()}/v1/chat/completions`, {
    model: model.id,
    temperature: 0,
    max_tokens: 512,
    messages: [
      {
        role: "system",
        content: "You diagnose browser workflow failures and emit strict JSON. Never reveal hidden benchmark labels because none are provided."
      },
      { role: "user", content }
    ]
  })) as ChatCompletionResponse;
  const rawContent = response.choices?.[0]?.message?.content;
  if (!rawContent) throw new Error("Remote LM Studio response did not include message content.");
  return {
    prediction: extractJson(rawContent),
    rawContent,
    latencyMs: Math.round(performance.now() - started)
  };
}

