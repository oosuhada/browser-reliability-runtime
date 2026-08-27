import { readFile } from "node:fs/promises";

export interface VlmDiagnosisRequest {
  screenshotPath: string;
  goal: string;
  previousAction: string | null;
  currentUrl: string;
  dom: string;
  accessibility: string;
  customerPolicy: string;
}

export interface VlmStructuredResult {
  workflow_state: string;
  expected_next_state: string;
  failure_type: string;
  confidence: number;
  target: string | null;
  blocker: string | null;
  evidence: string[];
  candidate_recovery: string[];
  reason: string;
}

function parseStructuredResult(content: string): VlmStructuredResult {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`VLM response did not contain a JSON object: ${content.slice(0, 500)}`);
  }
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Partial<VlmStructuredResult>;
  return {
    workflow_state: String(parsed.workflow_state ?? "UNKNOWN"),
    expected_next_state: String(parsed.expected_next_state ?? "UNKNOWN"),
    failure_type: String(parsed.failure_type ?? "UNKNOWN_STATE").trim().toUpperCase(),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    target: parsed.target === null || parsed.target === undefined ? null : String(parsed.target),
    blocker: parsed.blocker === null || parsed.blocker === undefined ? null : String(parsed.blocker),
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : [],
    candidate_recovery: Array.isArray(parsed.candidate_recovery)
      ? parsed.candidate_recovery.map((value) => String(value).trim().toUpperCase()).filter(Boolean)
      : [],
    reason: String(parsed.reason ?? "Live VLM diagnosis")
  };
}

function endpoint(): string {
  return (process.env.VLM_ENDPOINT ?? "http://127.0.0.1:11434/v1").replace(/\/$/, "");
}

export async function diagnoseWithVlm(request: VlmDiagnosisRequest): Promise<VlmStructuredResult> {
  const model = process.env.VLM_MODEL;
  if (!model) throw new Error("VLM_MODEL is required for the live VLM fallback.");
  const bytes = await readFile(request.screenshotPath);
  const imageUrl = `data:image/png;base64,${bytes.toString("base64")}`;
  const prompt = [
    "You are Browser Reliability Runtime, a browser automation reliability layer. Do not plan a general web task.",
    "Diagnose why the existing workflow automation failed and rank safe recovery actions.",
    `GOAL: ${request.goal}`,
    `PREVIOUS ACTION: ${request.previousAction ?? "none"}`,
    `CURRENT URL: ${request.currentUrl}`,
    `DOM / INTERACTIVE ELEMENTS:\n${request.dom}`,
    `ACCESSIBILITY / PAGE TEXT:\n${request.accessibility}`,
    `CUSTOMER POLICY:\n${request.customerPolicy}`,
    "Return JSON only with keys workflow_state, expected_next_state, failure_type, confidence, target, blocker, evidence, candidate_recovery, reason."
  ].join("\n\n");
  const response = await fetch(`${endpoint()}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.VLM_API_KEY ? { authorization: `Bearer ${process.env.VLM_API_KEY}` } : {})
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageUrl } }
          ]
        }
      ]
    })
  });
  if (!response.ok) throw new Error(`VLM request failed: ${response.status} ${await response.text()}`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("VLM response did not include message content.");
  return parseStructuredResult(content);
}

