from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def build_prompt(sample: dict[str, Any]) -> str:
    policy = sample.get("customer_policy")
    interactive = sample.get("dom_snapshot")
    history = sample.get("action_history")
    return "\n\n".join(
        [
            "You are WorkflowLens, a browser workflow reliability layer.",
            "Diagnose the automation failure and choose a safe recovery. Do not plan a general browser task.",
            f"GOAL\n{sample.get('goal')}",
            f"PREVIOUS STATE\n{sample.get('previous_state')}",
            f"PREVIOUS ACTION\n{sample.get('previous_action')}",
            f"CURRENT STATE\n{sample.get('current_state')}",
            f"INTERACTIVE DOM\n{json.dumps(interactive, ensure_ascii=False)}",
            f"ACCESSIBILITY\n{sample.get('accessibility_tree')}",
            f"ACTION HISTORY\n{json.dumps(history, ensure_ascii=False)}",
            f"CUSTOMER POLICY\n{json.dumps(policy, ensure_ascii=False)}",
            "Return compact JSON with failure_type, target, blocker, recovery, reason.",
        ]
    )


def build_answer(sample: dict[str, Any]) -> str:
    failure = sample.get("failure") or {}
    diagnosis = sample.get("diagnosis") or {}
    return json.dumps(
        {
            "failure_type": failure.get("failureType"),
            "target": failure.get("target"),
            "blocker": failure.get("blocker"),
            "recovery": failure.get("expectedRecovery"),
            "reason": diagnosis.get("reason") or "Synthetic mutation ground truth.",
        },
        ensure_ascii=False,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="artifacts/datasets/workflowlens_failures.jsonl")
    parser.add_argument("--output", default="training/data/sft.jsonl")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    rows: list[dict[str, Any]] = []
    for line in input_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        sample = json.loads(line)
        rows.append(
            {
                "sample_id": sample.get("sample_id"),
                "text": (
                    "<|im_start|>user\n"
                    + build_prompt(sample)
                    + "<|im_end|>\n<|im_start|>assistant\n"
                    + build_answer(sample)
                    + "<|im_end|>"
                ),
            }
        )

    output_path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + ("\n" if rows else ""),
        encoding="utf-8",
    )
    print(json.dumps({"samples": len(rows), "output": str(output_path)}, indent=2))


if __name__ == "__main__":
    main()

