# Browser Reliability Runtime

**Multimodal failure diagnosis, policy-aware recovery, and verification for browser automation.**

[Live Demo](https://workflowlens.oosu.dev) · [Measured Results](reports/measured/README.md) · [Failure Benchmark](#current-deterministic-benchmark) · [Local Model Benchmark](#macbook-pro-local-llm-waiting-queue)

Browser Reliability Runtime is not a general-purpose browser agent. It assumes an existing Playwright/RPA workflow and focuses on one question:

> When the workflow fails, can we understand why it failed, choose a policy-safe recovery, execute it, and verify that the workflow returned to a valid state?

The repository is fully synthetic and reproducible. It does not contain production browser sessions, private company screenshots, credentials, or proprietary workflow data.

## Measured highlights

The project has three different kinds of measured evidence: deterministic end-to-end recovery coverage across the full synthetic taxonomy, a text-only vs screenshot-aware local-model comparison, and a leakage-free Base vs QLoRA held-out experiment.

| Result | Measured outcome |
|---|---:|
| Deterministic 16-class workflow resolution | **100%** |
| Deterministic task completion | **87.5%** |
| Policy compliance with customer policy context | **100%** |
| Policy compliance without policy context | **25%** |
| Text-only local LLM failure accuracy, 9 held-out cases | **66.7%** |
| Screenshot + structured-context VLM failure accuracy, same 9 cases | **100%** |
| Text-only Recovery Top-3 | **66.7%** |
| Screenshot + structured-context VLM Recovery Top-3 | **100%** |
| Qwen2.5-1.5B Base failure accuracy, 9 leakage-free held-out cases | **0.0%** |
| 34-sample QLoRA failure accuracy, same 9 cases | **0.0%** |
| Qwen2.5-1.5B Base → QLoRA Recovery Top-3 | **33.3% → 66.7%** |

The learned-model result is the central multimodal finding: on the same held-out `AUTH_EXPIRED`, `RESPONSIVE_LAYOUT_CHANGE`, and `NAVIGATION_ERROR` cases, adding the screenshot to temporal and structured workflow evidence raised failure accuracy from **66.7% to 100%**. This is a deliberately small nine-case experiment, so it demonstrates the value of visual evidence inside this controlled reliability task rather than broad web generalization.

The fine-tuning result is intentionally reported even though it is negative. A 34-sample QLoRA adapter did **not** improve held-out failure classification: Base and LoRA both scored `0/9`. Recovery Top-3 improved from **33.3% to 66.7%**, but Recovery Top-1 fell from **33.3% to 0%** and average latency increased. No seed, split, or epoch retuning was performed after observing the first successful canonical run.

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
- Canonical Colab/A100 QLoRA runner for leakage-free Base vs fine-tuned evaluation.
- Human-readable trace viewer.
- Screenshot evidence overlays for target and blocker bounding boxes on newly collected traces.

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

The normal browser automation deliberately uses brittle human-facing selectors first. Browser Reliability Runtime only enters the recovery path when the action fails, the transition is wrong, or a low-confidence geometry condition is detected.

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

Benchmark/browser traces intentionally redact synthetic control metadata from model-facing evidence. Mutation/customer IDs are removed from captured URLs and accessibility links, and the in-app mutation banner is only visible in manual `debug=1` mode. This prevents a VLM or fine-tuned model from reading the injected failure label instead of reasoning from the UI state.

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

Each action record also persists its `expectedState`, so a failure trace keeps the temporal contract explicitly: previous state + action + expected next state + observed current state.

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
npm run dataset:validate
```

For a targeted mutation regression after changing one failure condition:

```bash
npm run dataset:generate -- --mutation=element_moved
```

The generator currently produces 43 controlled workflow runs: three order variants for failures that occur before the refund policy gate, and two low-value order variants for failures that occur on the refund execution screen. This keeps the failure mutation reachable while adding amount/order variation without manual labels.

The exporter skips legacy traces that predate temporal-state metadata or contain benchmark control labels. `dataset:validate` then scans only model-facing fields and fails if the injected mutation ID, failure type, or expected recovery string appears in the input evidence.

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

The exported rows also include `expected_next_state`, which is used by the SFT prompt as explicit temporal workflow context.

### Workflow transition benchmark

```bash
npm run benchmark:transitions
```

This benchmark separates the workflow's expected transition contract from the observed browser state and reports immediate transition success rate plus how consistently injected failure steps produce an expected-state mismatch before recovery.

Latest 16-class failure run: all `16 / 16` failure steps had an explicit expected-state mismatch before recovery (`failureTransitionMismatchRecall = 100%`). The immediate transition success rate was `54.3%` because the metric intentionally includes both mutation-broken first attempts and successful post-recovery retries; it is a workflow transition metric, not a learned state-estimator accuracy claim.

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
| Avg. browser runtime | 1030 ms |
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

The refund page intentionally does **not** render the customer SOP. The visible `$120` refund screen is the same business action for both tenants; policy is external context supplied to Browser Reliability Runtime.

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

## MacBook Pro local-LLM waiting queue

Browser Reliability Runtime can use the Tailscale-reachable MacBook Pro as a serialized inference worker without exposing LM Studio outside that machine. Queue files live under `artifacts/local-llm-queue/` on the MacBook Air and move through `pending`, `running`, `blocked`, `completed`, and `failed` directories. Requests are sent to `127.0.0.1:1234` on the MacBook Pro through SSH stdin, so screenshots and prompts do not need a public API endpoint.

Enqueue held-out temporal failure cases for the model that is currently loaded in LM Studio:

```bash
npm run llm:queue:enqueue -- --vision=false
npm run llm:queue:status
npm run llm:queue:status -- --remote
npm run llm:queue:work
npm run llm:queue:pause
npm run llm:queue:resume
```

`pause` stops the worker from claiming new jobs without killing the daemon or losing queued work. A job that is already running is allowed to finish; `resume` continues FIFO processing from the persisted queue.

Run the persistent single-concurrency worker manually with:

```bash
npm run build
node dist/local-llm/worker.js --watch
```

The repository also includes `deploy/dev.oosu.workflowlens-llm-worker.plist` for a MacBook Air `launchd` worker. The worker never loads or unloads LM Studio models. A text job uses an already loaded LLM/VLM. A vision job is moved to `blocked` when no VLM is loaded and is retried automatically by the watch worker after a compatible VLM becomes available.

The worker also respects existing LM Studio traffic by default. Before claiming a queued job it checks whether the LM Studio port already has an established inference connection. If another local agent is generating, Browser Reliability Runtime leaves its job untouched and retries on a later poll instead of competing for the same model. Set `WORKFLOWLENS_LLM_RESPECT_REMOTE_BUSY=false` only when concurrent inference is intentional.

Enqueue screenshot-aware jobs after loading a VLM in LM Studio:

```bash
npm run llm:queue:enqueue -- --vision=true --batch=heldout_vision
```

Evaluate completed jobs with:

```bash
npm run llm:queue:evaluate -- --batch=heldout_vision
```

The model response includes both a Top-1 `recovery` and an ordered three-action `recovery_ranking`. Evaluation reports both Recovery Top-1 and Top-3 accuracy. The enqueue command deduplicates repeated trace runs by mutation/order/transition signature before creating jobs. Evaluation writes a JSON report under `artifacts/reports/` so a local-model baseline can be compared directly with later VLM or fine-tuned runs.

The same 9-case held-out mutation split was measured with a text-only local LLM and a screenshot-aware local VLM:

| Model | Modality | Failure accuracy | Macro-F1 | Recovery Top-1 | Recovery Top-3 | Avg latency |
|---|---|---:|---:|---:|---:|---:|
| Qwen3-Coder-Next | structured text | 66.7% | 50.0% | 33.3% | 66.7% | 31.26 s |
| **Gemma 4 26B-A4B** | **screenshot + structured context** | **100%** | **100%** | **66.7%** | **100%** | 34.21 s |

This is the key measured multimodal result: adding actual screenshot evidence to the same workflow evidence improved failure diagnosis from **66.7% to 100%**, Recovery Top-1 from **33.3% to 66.7%**, and Recovery Top-3 from **66.7% to 100%**. The Gemma run used `google/gemma-4-26b-a4b` through LM Studio with a 1536-token vision completion budget and completed all 9 held-out requests without blocked or failed jobs.

The class-level pattern is also informative. Gemma diagnosed and recovered all three `AUTH_EXPIRED` cases correctly, diagnosed all three `NAVIGATION_ERROR` cases and selected `RETURN_PREVIOUS_STEP` correctly, and diagnosed all three `RESPONSIVE_LAYOUT_CHANGE` cases correctly. Responsive-layout Recovery Top-1 still preferred `RETRY`, but the expected `CHANGE_VIEWPORT` action appeared inside the Top-3 for every case. The text-only run instead classified all three `AUTH_EXPIRED` cases as `UNEXPECTED_MODAL`; `NAVIGATION_ERROR` was its strongest class at 3/3 diagnosis and Top-1 recovery.

The latency values are real observed local queue/runtime measurements, not isolated model-throughput benchmarks. The text run shared LM Studio with another local workload, while the VLM run reflects the loaded Gemma 4 inference path.

Compare completed model benchmark reports that use the same held-out split:

```bash
npm run benchmark:models -- --inputs=artifacts/reports/text.json,artifacts/reports/vision.json,artifacts/reports/lora.json
```

The comparison command produces JSON and Markdown tables with failure accuracy, Macro-F1, Recovery Top-1/Top-3, and average latency. Missing metrics stay `n/a`; the command does not invent placeholder performance values.

### Cross-workflow generalization

The synthetic application also includes a third workflow family, `approve_refund`, with separate `APPROVAL_QUEUE` and `APPROVAL_DETAIL` states. It deliberately reuses existing failure classes such as unexpected modal, expired authentication, permission denial, confirmation, and stale state rather than creating a new taxonomy for the new page family.

```bash
npm run benchmark:generalization
```

This benchmark is kept separate from the SFT generation cases, so the report explicitly tests the reliability logic on an approval workflow that is not part of the current 43-condition training dataset.

Latest measured deterministic generalization result: `5 / 5` approval failures were diagnosed correctly, Recovery Top-1/Top-3 were both `100%`, expected recovery execution succeeded in `5 / 5`, workflow resolution was `100%`, and task completion was `80%` because the permission-denied case intentionally ended in a safe human escalation.

## LoRA / SFT experiment

The fine-tuning target is intentionally narrow: **failure diagnosis + recovery selection**, not the entire browser agent.

### Canonical Colab held-out experiment

We evaluated `Qwen/Qwen2.5-1.5B-Instruct` and a 34-sample assistant-only QLoRA adapter on the same leakage-free 9-case held-out set. The set contains three cases each for `AUTH_EXPIRED`, `RESPONSIVE_LAYOUT_CHANGE`, and `NAVIGATION_ERROR`. These mutation classes were excluded entirely from training.

| Model | N | Failure Accuracy | Failure Macro-F1 | Recovery Top-1 | Recovery Top-3 | Avg latency |
|---|---:|---:|---:|---:|---:|---:|
| Qwen2.5-1.5B Base | 9 | 0.00% | 0.00% | 33.33% | 33.33% | 3,991 ms |
| Browser Reliability Runtime LoRA | 9 | 0.00% | 0.00% | 0.00% | 66.67% | 6,513 ms |

The 34-sample LoRA adapter did not improve held-out failure classification. It improved Recovery Top-3 by **33.33 percentage points**, but Recovery Top-1 decreased by **33.33 points** and average latency increased by `2,522 ms`. At the sample level, all nine failure classifications were wrong for both Base and LoRA. The first successful run is the canonical result; no seed, split, or epoch retuning was performed after observing it.

The class behavior explains the aggregate result. Both models labeled all three `AUTH_EXPIRED` cases as `SESSION_EXPIRED` and all three `RESPONSIVE_LAYOUT_CHANGE` cases as `LOADING_STUCK`. Base labeled all three `NAVIGATION_ERROR` cases as `UNKNOWN`; LoRA changed those to `UNEXPECTED_MODAL`. LoRA did, however, place `CHANGE_VIEWPORT` in the Top-3 for all three responsive-layout cases and preserved the expected navigation recovery inside the Top-3, which is why Recovery Top-3 increased despite zero classification accuracy.

The canonical A100 run used 4-bit NF4 double quantization, LoRA rank `16`, alpha `32`, dropout `0.05`, two epochs, learning rate `2e-4`, effective batch size `16`, and seed `42`. Only assistant response tokens contributed to training loss. Training used exactly `34` examples; the `9` held-out examples contributed no training loss. The A100 trainer runtime was `18.16 s`, final train loss was `0.740283`, and the adapter contained `18,464,768` trainable parameters.

Prepare data locally:

```bash
npm run dataset:export
python3 training/prepare_sft.py
```

`prepare_sft.py` deduplicates repeated deterministic traces and reserves whole mutation classes (`auth_expired`, `responsive_layout`, and `unexpected_navigation` by default) for evaluation. This avoids random train/eval leakage from repeated runs of the same synthetic mutation.

For the canonical Colab path, copy the repository with the generated `training/data/` split into the Colab workspace, install the training requirements, and run the single experiment driver:

```bash
pip install -r training/requirements.txt
python training/colab_final_experiment.py \
  --workspace=/content/browser-reliability-runtime
```

`colab_final_experiment.py` validates the `34/9` split, checks mutation/sample-ID overlap and prompt leakage, runs Base inference first, trains the QLoRA adapter, evaluates the same nine prompts with the adapter, produces Base/LoRA reports and a paired comparison, verifies adapter creation, and packages the run artifacts. The small checked-in summary under `reports/measured/` records the canonical metrics and provenance; the 72 MB adapter/result ZIP stays outside Git. The legacy `workflowlens.model-benchmark.v1` schema identifier is intentionally retained for compatibility with pre-rename benchmark artifacts.

## Repository structure

```text
browser-reliability-runtime/
├── src/
│   ├── ai/                 # diagnosis, recovery ranking, live VLM adapter
│   ├── browser/            # Playwright capture + recovery runner
│   ├── dataset/            # failure and visual grounding generation
│   ├── evaluation/         # failure, recovery, grounding, runtime benchmarks
│   ├── domain.ts           # orders and customer SOPs
│   ├── mutations.ts        # deterministic failure taxonomy + ground truth
│   └── server.ts           # synthetic commerce app + trace viewer
├── training/               # Colab-oriented SFT/LoRA path
├── reports/measured/       # small checked-in measured-result summaries
├── dataset/samples/        # public synthetic schema examples
├── artifacts/              # ignored generated traces, screenshots, reports
└── README.md
```

## Known limitations / next experiments

- The 100% full benchmark is expected on a hand-designed deterministic taxonomy; unseen-site generalization remains unmeasured.
- The measured VLM comparison uses a deliberately small 9-case held-out split across three mutation classes; a larger learned-model benchmark is still needed.
- The canonical 34-sample QLoRA run did not improve held-out failure classification and regressed Recovery Top-1. Its Top-3 gain should be interpreted as an engineering diagnostic, not evidence of generalization.
- Current visual grounding generation is ready for model predictions, but the repository does not claim a vision-model grounding score yet.
- Iframe, canvas, shadow-DOM, cross-origin auth, and real enterprise browser policies are not included in the public synthetic MVP.
- `on_failure` and `on_low_confidence` currently converge to the same call count in the small runtime benchmark; more benign low-confidence cases are needed to separate them experimentally.

## Safety / privacy

- `.env`, tokens, cookies, browser login state, production credentials, and generated traces are gitignored.
- The demo account is synthetic (`demo / demo`) and has no external access.
- No private research files are copied into this repository.
- Public workflows run only against the local synthetic application.

