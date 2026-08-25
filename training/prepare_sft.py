from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


FAILURE_TAXONOMY = (
    "AUTH_EXPIRED, CONFIRMATION_REQUIRED, DISABLED_ACTION, ELEMENT_MOVED, ELEMENT_RENAMED, "
    "FORM_VALIDATION_ERROR, HIDDEN_ELEMENT, ICON_ONLY_TARGET, LOADING_STUCK, NAVIGATION_ERROR, "
    "OCCLUDED_TARGET, OFFSCREEN_TARGET, PERMISSION_DENIED, RESPONSIVE_LAYOUT_CHANGE, STALE_STATE, "
    "UNEXPECTED_MODAL, UNKNOWN_STATE"
)

RECOVERY_ACTIONS = (
    "CLOSE_MODAL, REFRESH, SCROLL, REAUTHENTICATE, USE_ALTERNATIVE_TARGET, RETURN_PREVIOUS_STEP, "
    "FILL_REQUIRED_FIELD, CONFIRM, CHANGE_VIEWPORT, ESCALATE_TO_HUMAN, ABORT, WAIT, RETRY"
)


def build_prompt(sample: dict[str, Any]) -> str:
    policy = sample.get("customer_policy")
    interactive = sample.get("dom_snapshot")
    history = sample.get("action_history")
    return "\n\n".join(
        [
            "You are WorkflowLens, a browser workflow reliability layer.",
            "Diagnose the automation failure and choose a safe recovery. Do not plan a general browser task.",
            f"FAILURE TAXONOMY\n{FAILURE_TAXONOMY}",
            f"RECOVERY ACTIONS\n{RECOVERY_ACTIONS}",
            f"GOAL\n{sample.get('goal')}",
            f"PREVIOUS STATE\n{sample.get('previous_state')}",
            f"PREVIOUS ACTION\n{sample.get('previous_action')}",
            f"EXPECTED NEXT STATE\n{sample.get('expected_next_state')}",
            f"CURRENT STATE\n{sample.get('current_state')}",
            f"INTERACTIVE DOM\n{json.dumps(interactive, ensure_ascii=False)}",
            f"ACCESSIBILITY\n{sample.get('accessibility_tree')}",
            f"ACTION HISTORY\n{json.dumps(history, ensure_ascii=False)}",
            f"CUSTOMER POLICY\n{json.dumps(policy, ensure_ascii=False)}",
            "Return compact JSON with failure_type, target, blocker, recovery, recovery_ranking, reason. recovery_ranking must contain the three best distinct recovery actions in order.",
        ]
    )


def build_answer(sample: dict[str, Any]) -> str:
    failure = sample.get("failure") or {}
    diagnosis = sample.get("diagnosis") or {}
    ranked = sample.get("recovery_ranking") or []
    ranked_actions = [str(item.get("action")) for item in ranked if isinstance(item, dict) and item.get("action")]
    expected_recovery = failure.get("expectedRecovery")
    recovery_ranking = list(dict.fromkeys([expected_recovery, *ranked_actions]))[:3]
    return json.dumps(
        {
            "failure_type": failure.get("failureType"),
            "target": failure.get("target"),
            "blocker": failure.get("blocker"),
            "recovery": expected_recovery,
            "recovery_ranking": recovery_ranking,
            "reason": diagnosis.get("reason") or "Synthetic mutation ground truth.",
        },
        ensure_ascii=False,
    )


def mutation_name(sample: dict[str, Any]) -> str:
    failure = sample.get("failure") or {}
    return str(failure.get("mutation") or "unknown")


def sample_signature(sample: dict[str, Any]) -> tuple[str, ...]:
    failure = sample.get("failure") or {}
    return (
        mutation_name(sample),
        str(sample.get("workflow")),
        str(sample.get("customer")),
        str(sample.get("order_id")),
        str(sample.get("previous_state")),
        str(sample.get("previous_action")),
        str(sample.get("expected_next_state")),
        str(sample.get("current_state")),
        str(failure.get("failureType")),
        str(failure.get("expectedRecovery")),
    )


def to_sft_row(sample: dict[str, Any]) -> dict[str, Any]:
    prompt = build_prompt(sample)
    answer = build_answer(sample)
    failure = sample.get("failure") or {}
    return {
        "sample_id": sample.get("sample_id"),
        "mutation": mutation_name(sample),
        "prompt": prompt,
        "expected": {
            "failure_type": failure.get("failureType"),
            "recovery": failure.get("expectedRecovery"),
        },
        "text": (
            "<|im_start|>user\n"
            + prompt
            + "<|im_end|>\n<|im_start|>assistant\n"
            + answer
            + "<|im_end|>"
        ),
    }


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + ("\n" if rows else ""),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="artifacts/datasets/workflowlens_failures.jsonl")
    parser.add_argument("--train-output", default="training/data/train.jsonl")
    parser.add_argument("--eval-output", default="training/data/eval.jsonl")
    parser.add_argument(
        "--eval-mutations",
        default="auth_expired,responsive_layout,unexpected_navigation",
        help="Comma-separated mutation classes reserved entirely for evaluation.",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    train_output = Path(args.train_output)
    eval_output = Path(args.eval_output)
    eval_mutations = {value.strip() for value in args.eval_mutations.split(",") if value.strip()}

    samples: list[dict[str, Any]] = []
    for line in input_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        samples.append(json.loads(line))

    deduplicated: list[dict[str, Any]] = []
    seen: set[tuple[str, ...]] = set()
    for sample in samples:
        signature = sample_signature(sample)
        if signature in seen:
            continue
        seen.add(signature)
        deduplicated.append(sample)

    train_samples = [sample for sample in deduplicated if mutation_name(sample) not in eval_mutations]
    eval_samples = [sample for sample in deduplicated if mutation_name(sample) in eval_mutations]

    if not train_samples:
        raise ValueError("No training samples remain after applying the mutation holdout split.")
    if not eval_samples:
        raise ValueError("No evaluation samples match --eval-mutations. Generate those mutation traces first.")

    train_rows = [to_sft_row(sample) for sample in train_samples]
    eval_rows = [to_sft_row(sample) for sample in eval_samples]
    write_jsonl(train_output, train_rows)
    write_jsonl(eval_output, eval_rows)

    summary = {
        "raw_samples": len(samples),
        "deduplicated_samples": len(deduplicated),
        "train_samples": len(train_rows),
        "eval_samples": len(eval_rows),
        "eval_mutations": sorted(eval_mutations),
        "train_mutation_counts": dict(sorted(Counter(mutation_name(sample) for sample in train_samples).items())),
        "eval_mutation_counts": dict(sorted(Counter(mutation_name(sample) for sample in eval_samples).items())),
        "train_output": str(train_output),
        "eval_output": str(eval_output),
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

