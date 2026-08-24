from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any


def safe_div(numerator: int, denominator: int) -> float:
    return numerator / denominator if denominator else 0.0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--predictions", required=True, help="JSONL with expected_failure/predicted_failure and expected_recovery/predicted_recovery")
    args = parser.parse_args()

    rows: list[dict[str, Any]] = []
    for line in Path(args.predictions).read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))

    failure_correct = sum(row.get("expected_failure") == row.get("predicted_failure") for row in rows)
    recovery_correct = sum(row.get("expected_recovery") == row.get("predicted_recovery") for row in rows)
    by_class: dict[str, dict[str, int]] = defaultdict(lambda: {"correct": 0, "count": 0})
    for row in rows:
        label = str(row.get("expected_failure"))
        by_class[label]["count"] += 1
        if row.get("expected_failure") == row.get("predicted_failure"):
            by_class[label]["correct"] += 1

    print(
        json.dumps(
            {
                "samples": len(rows),
                "failure_accuracy": safe_div(failure_correct, len(rows)),
                "recovery_top1_accuracy": safe_div(recovery_correct, len(rows)),
                "by_class_accuracy": {
                    label: safe_div(values["correct"], values["count"])
                    for label, values in sorted(by_class.items())
                },
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

