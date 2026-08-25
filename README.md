# WorkflowLens

WorkflowLens is a **multimodal workflow reliability layer** for browser automation. It is not a general-purpose browser agent. The system assumes an existing Playwright/RPA workflow and focuses on one question:

Live synthetic demo: **https://workflowlens.oosu.dev**

> When the workflow fails, can we understand why it failed, choose a policy-safe recovery, execute it, and verify that the workflow returned to a valid state?

The repository is fully synthetic and reproducible. It does not contain production browser sessions, private company screenshots, credentials, or proprietary workflow data.

## What is implemented

- Synthetic commerce operations application with login, order search, order detail, shipment lookup, refund, approval, and completion states.
- Deterministic failure mutation engine with automatic ground truth.
- Playwright workflow runner with screenshot, DOM, accessibility, action history, URL, workflow state, bounding boxes, mutation labels, and verification traces.
- Visual grounding dataset generation using `getBoundingClientRect()` ground truth.
- Multimodal heuristic failure diagnosis baseline.
- Recovery ranking, policy gate, browser recovery execution, and verification loop.
- Customer-specific refund policy injection that changes the decision on the same refund screen.
- Modality ablation benchmark.
- Vision-on-demand runtime comparison.
- OpenAI-compatible live VLM fallback adapter.
- JSONL failure dataset exporter.
- Colab-oriented LoRA/SFT pipeline for failure diagnosis + recovery selection.
- Human-readable trace viewer.

## Architecture

```text
Existing Browser Workflow
        ↓
Playwright Action
        ↓
Fast-path DOM / Accessibility checks
        ↓
Action failed or confidence low?
        ↓ yes
Screenshot + DOM + A11y + History + Policy
        ↓
Failure Diagnosis
        ↓
Recovery Ranking
        ↓
Customer Policy Gate
        ↓
Recovery Execution
        ↓
Verification
        ↓
Trace / Explainability
```

## Synthetic workflows

### Refund order

```text
Login → Orders → Order Detail → Refund → Execute / Human Approval → Terminal State
```

### Shipment lookup

```text
Login → Orders → Order Detail → Shipment Lookup → Shipment State
```

The normal browser automation deliberately uses brittle human-facing selectors first. WorkflowLens only enters the recovery path when the action fails, the transition is wrong, or a low-confidence geometry condition is detected.

## Failure mutation taxonomy

Current deterministic mutations:

| Mutation | Failure ground truth | Expected recovery |
|---|---|---|
| `cookie_overlay` | `OCCLUDED_TARGET` | `CLOSE_MODAL` |
| `unexpected_modal` | `UNEXPECTED_MODAL` | `CLOSE_MODAL` |
| `element_moved` | `ELEMENT_MOVED` | `USE_ALTERNATIVE_TARGET` |
| `element_renamed` | `ELEMENT_RENAMED` | `USE_ALTERNATIVE_TARGET` |
| `disabled_action` | `DISABLED_ACTION` | `ESCALATE_TO_HUMAN` |
| `auth_expired` | `AUTH_EXPIRED` | `REAUTHENTICATE` |
| `validation_error` | `FORM_VALIDATION_ERROR` | `FILL_REQUIRED_FIELD` |
| `loading_stuck` | `LOADING_STUCK` | `REFRESH` |
| `offscreen_target` | `OFFSCREEN_TARGET` | `SCROLL` |
| `responsive_layout` | `RESPONSIVE_LAYOUT_CHANGE` | `CHANGE_VIEWPORT` |
| `icon_only` | `ICON_ONLY_TARGET` | `USE_ALTERNATIVE_TARGET` |
| `hidden_element` | `HIDDEN_ELEMENT` | `USE_ALTERNATIVE_TARGET` |
| `permission_denied` | `PERMISSION_DENIED` | `ESCALATE_TO_HUMAN` |
| `confirmation_required` | `CONFIRMATION_REQUIRED` | `CONFIRM` |
| `stale_state` | `STALE_STATE` | `REFRESH` |
| `unexpected_navigation` | `NAVIGATION_ERROR` | `RETURN_PREVIOUS_STEP` |

The application owns the mutation ground truth, so no manual failure labeling is required.

## Quick start

Requires Node.js 20+ and a Playwright-compatible Chromium installation.

```bash
npm install
npm start
```

The synthetic application listens on `http://127.0.0.1:4317` by default.

To enable the strictly allowlisted one-click Playwright demo runner on the launcher:

```bash
DEMO_BROWSER_RUNS_ENABLED=true npm start
```

The public demo only accepts the repository's fixed synthetic workflows, customers, mutations, and local order. It does not accept arbitrary URLs or browser instructions, allows only one active run at a time, and applies a small in-memory run limit.

The Mac mini deployment uses the versioned launchd template at `deploy/dev.oosu.workflowlens.plist`. The public service enables the same allowlisted synthetic runner and points browser execution back to the local `4317` service only.

In another shell:

```bash
npm run run:workflow -- \
  --workflow=refund_order \
  --customer=customer_a \
  --mutation=cookie_overlay \
  --order=ORD-18401
```

Open the trace viewer:

```text
http://127.0.0.1:4317/viewer
```

## Trace schema

Every run stores a directory under `artifacts/traces/<run-id>/` containing screenshots and `trace.json`.

A failure trace includes:

```json
{
  "goal": "Refund ORD-18401 according to customer policy",
  "observation": {
    "workflowState": "ORDER_DETAIL",
    "targetBBox": { "x": 286, "y": 452, "width": 132, "height": 42 },
    "blockerId": "cookie_consent_modal",
    "occlusionRatio": 1
  },
  "groundTruth": {
    "failureType": "OCCLUDED_TARGET",
    "expectedRecovery": "CLOSE_MODAL"
  },
  "diagnosis": {
    "failureType": "OCCLUDED_TARGET",
    "confidence": 0.96
  },
  "executedRecovery": "CLOSE_MODAL",
  "recoverySucceeded": true
}
```

## Dataset generation

### Failure diagnosis / recovery dataset

Generate a balanced synthetic trace batch across all 16 failure classes and multiple orders, then export failure steps:

```bash
npm run dataset:generate
npm run dataset:export
```

The generator currently produces 43 controlled workflow runs: three order variants for failures that occur before the refund policy gate, and two low-value order variants for failures that occur on the refund execution screen. This keeps the failure mutation reachable while adding amount/order variation without manual labels.

Latest local generation result:

| Dataset stage | Samples |
|---|---:|
| Generated failure runs | 43 |
| Failure classes | 16 |
| Missing injected failures | 0 |
| Diagnosis mismatches | 0 |
| Recovery mismatches | 0 |
| Deduplicated SFT train | 34 |
| Held-out mutation eval | 9 |

Output:

```text
artifacts/datasets/workflowlens_failures.jsonl
```

Each row contains the workflow goal, previous state/action, current state, interactive DOM representation, accessibility text, action history, customer policy, screenshot path, target/blocker bounding boxes, mutation ground truth, diagnosis, recovery ranking, and recovery result.

### Visual grounding dataset

```bash
npm run dataset:grounding
```

Each sample contains:

```json
{
  "instruction": "Click the shipment lookup button",
  "screenshot": "...png",
  "target_id": "shipment_lookup_button",
  "bbox": { "x": 115, "y": 453, "width": 161, "height": 42 },
  "center": { "x": 195.5, "y": 474 }
}
```

Evaluate model-produced predictions with:

```bash
npm run evaluate:grounding -- \
  --truth=artifacts/grounding/<run>/grounding.jsonl \
  --predictions=<predictions.jsonl>
```

Metrics: mean bbox IoU, point-inside-target accuracy, and localization coverage.

## Current deterministic benchmark

Command:

```bash
npm run benchmark -- --full
```

Latest local run over all 16 mutation categories:

| Metric | Result |
|---|---:|
| Workflow resolution | 100% |
| Task completion | 87.5% |
| Safe escalation | 12.5% |
| Diagnosis coverage | 100% |
| Failure accuracy | 100% |
| Failure Macro-F1 | 100% |
| Recovery Top-1 | 100% |
| Expected recovery success | 100% |
| Avg. browser runtime | 1328 ms |
| Avg. vision fallback opportunities | 1.0 |
| Actual live VLM calls | 0 |

**Important:** this is a deterministic heuristic baseline evaluated on the synthetic mutation taxonomy implemented in this repository. It is a pipeline/instrumentation benchmark, **not evidence that a learned model generalizes to arbitrary websites**.

## Modality ablation

Command:

```bash
npm run benchmark -- --all-modalities
```

Representative five-case ablation (`cookie_overlay`, `element_renamed`, `validation_error`, `permission_denied`, `unexpected_navigation`):

| Input | Task completion | Safe resolution | Failure accuracy | Macro-F1 | Recovery Top-1 |
|---|---:|---:|---:|---:|---:|
| Screenshot only | 20% | 100% | 20% | 16.7% | 40% |
| Screenshot + DOM | 60% | 100% | 80% | 66.7% | 80% |
| Screenshot + DOM + History | 80% | 100% | 100% | 100% | 100% |
| Screenshot + DOM + History + Policy | 80% | 100% | 100% | 100% | 100% |

The most illustrative temporal case is `unexpected_navigation`: the current page alone is an unknown maintenance state. Action history is what establishes that a successful shipment click produced the wrong state transition.

`Safe resolution` includes deliberate human escalation. `Task completion` is stricter and counts only workflows that reached the requested autonomous terminal state. This distinction prevents an unnecessary escalation from being reported as successful task execution.

## Customer-specific policy experiment

The refund page intentionally does **not** render the customer SOP. The visible `$120` refund screen is the same business action for both tenants; policy is external context supplied to WorkflowLens.

Policy definitions:

- Customer A: refunds `<= $500` may execute automatically.
- Customer B: every refund requires human approval.

Observed local behavior for `ORD-18401` (`$120`):

| Run | Result |
|---|---|
| Customer A + policy modality | Autonomous refund execution |
| Customer B + policy modality | Safe human escalation |
| Customer B without policy modality | Incorrect autonomous execution |

This is the intended domain-context ablation: screen understanding alone is insufficient to choose the safe business action.

Run the policy benchmark across both a `$120` and `$720` refund for both customers:

```bash
npm run benchmark:policy
```

Latest local result:

| Input | Policy compliance | Unsafe autonomous executions |
|---|---:|---:|
| Screenshot + DOM + History | 25% | 3 / 4 |
| Screenshot + DOM + History + Policy | 100% | 0 / 4 |

The three unsafe no-policy cases are Customer A's `$720` refund and both Customer B refunds. This makes the domain-context effect measurable instead of demonstrating it with only one hand-picked example.

## Vision-on-demand experiment

Command:

```bash
npm run benchmark:runtime
```

Five-scenario local comparison:

| Strategy | Resolution | Task completion | Avg. vision opportunities | Measured browser runtime | Estimated E2E latency* | Estimated inference cost* |
|---|---:|---:|---:|---:|---:|---:|
| Always Vision | 100% | 100% | 1.6 | 1848 ms | 3128 ms | $0.0032 |
| Vision on Failure | 100% | 100% | 0.8 | 1163 ms | 1803 ms | $0.0016 |
| Vision on Low Confidence | 100% | 100% | 0.8 | 1128 ms | 1768 ms | $0.0016 |

`*` VLM latency/cost are configurable estimates (`800 ms` and `$0.002` per call by default). Browser runtime is measured locally. No external API was called for this table.

## Live VLM fallback

`src/ai/vlm.ts` implements an OpenAI-compatible multimodal endpoint adapter. It sends screenshot + DOM + accessibility + temporal context + customer policy and requests structured failure/recovery JSON.

Environment variables:

```bash
export VLM_ENDPOINT=http://127.0.0.1:11434/v1
export VLM_MODEL=<vision-model-name>
export VLM_API_KEY=<optional-key>
```

Run:

```bash
npm run run:workflow -- \
  --workflow=refund_order \
  --customer=customer_a \
  --mutation=cookie_overlay \
  --order=ORD-18401 \
  --reasoner=vlm
```

If the VLM request fails, the trace records the error evidence and falls back to the local heuristic diagnosis instead of terminating the workflow.

## LoRA / SFT experiment

The first fine-tuning target is intentionally narrow: **failure diagnosis + recovery selection**, not the entire browser agent.

Prepare data locally:

```bash
npm run dataset:export
python3 training/prepare_sft.py
```

`prepare_sft.py` deduplicates repeated deterministic traces and reserves whole mutation classes (`auth_expired`, `responsive_layout`, and `unexpected_navigation` by default) for evaluation. This avoids random train/eval leakage from repeated runs of the same synthetic mutation.

On Colab/GPU:

```bash
pip install -r training/requirements.txt
python training/train_lora.py \
  --model=Qwen/Qwen2.5-1.5B-Instruct \
  --data=training/data/train.jsonl \
  --eval-data=training/data/eval.jsonl
```

The training path is implemented but **no GPU fine-tuning result is claimed in the current benchmark**. A base-vs-LoRA comparison should use a held-out mutation split and the same failure/recovery metrics.

## Repository structure

```text
workflowlens/
├── src/
│   ├── ai/                 # diagnosis, recovery ranking, live VLM adapter
│   ├── browser/            # Playwright capture + recovery runner
│   ├── dataset/            # failure and visual grounding generation
│   ├── evaluation/         # failure, recovery, grounding, runtime benchmarks
│   ├── domain.ts           # orders and customer SOPs
│   ├── mutations.ts        # deterministic failure taxonomy + ground truth
│   └── server.ts           # synthetic commerce app + trace viewer
├── training/               # Colab-oriented SFT/LoRA path
├── dataset/samples/        # public synthetic schema examples
├── artifacts/              # ignored generated traces, screenshots, reports
└── README.md
```

## Known limitations / next experiments

- The 100% full benchmark is expected on a hand-designed deterministic taxonomy; unseen-site generalization remains unmeasured.
- Live VLM accuracy/latency has not yet been benchmarked against a configured external/local vision model.
- LoRA training is prepared but not yet run on GPU, so there is no base-vs-fine-tuned score yet.
- Current visual grounding generation is ready for model predictions, but the repository does not claim a vision-model grounding score yet.
- Iframe, canvas, shadow-DOM, cross-origin auth, and real enterprise browser policies are not included in the public synthetic MVP.
- `on_failure` and `on_low_confidence` currently converge to the same call count in the small runtime benchmark; more benign low-confidence cases are needed to separate them experimentally.

## Safety / privacy

- `.env`, tokens, cookies, browser login state, production credentials, and generated traces are gitignored.
- The demo account is synthetic (`demo / demo`) and has no external access.
- No private research files are copied into this repository.
- Public workflows run only against the local synthetic application.

