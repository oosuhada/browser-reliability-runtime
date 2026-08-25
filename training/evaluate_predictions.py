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
    parser.add_argument("--output", default=None, help="Optional path for a WorkflowLens model benchmark JSON report")
    parser.add_argument("--model", default="unknown")
    parser.add_argument("--modalities", default="structured-text")
    args = parser.parse_args()

    rows: list[dict[str, Any]] = []
    for line in Path(args.predictions).read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))

    failure_correct = sum(row.get("expected_failure") == row.get("predicted_failure") for row in rows)
    recovery_correct = sum(row.get("expected_recovery") == row.get("predicted_recovery") for row in rows)
    recovery_top3_correct = sum(
        row.get("expected_recovery") in (row.get("predicted_recovery_ranking") or [row.get("predicted_recovery")])[:3]
        for row in rows
    )
    by_class: dict[str, dict[str, int]] = defaultdict(lambda: {"correct": 0, "count": 0})
    for row in rows:
        label = str(row.get("expected_failure"))
        by_class[label]["count"] += 1
        if row.get("expected_failure") == row.get("predicted_failure"):
            by_class[label]["correct"] += 1

    labels = sorted({str(row.get("expected_failure")) for row in rows} | {str(row.get("predicted_failure")) for row in rows})
    f1_values: list[float] = []
    for label in labels:
        tp = sum(row.get("expected_failure") == label and row.get("predicted_failure") == label for row in rows)
        fp = sum(row.get("expected_failure") != label and row.get("predicted_failure") == label for row in rows)
        fn = sum(row.get("expected_failure") == label and row.get("predicted_failure") != label for row in rows)
        precision = safe_div(tp, tp + fp)
        recall = safe_div(tp, tp + fn)
        f1_values.append(2 * precision * recall / (precision + recall) if precision + recall else 0.0)

    latencies = [int(row.get("latency_ms", 0)) for row in rows if row.get("latency_ms") is not None]
    report = {
        "schema": "workflowlens.model-benchmark.v1",
        "benchmarkType": "transformers_inference",
        "batchId": Path(args.predictions).stem,
        "samples": len(rows),
        "failureAccuracy": safe_div(failure_correct, len(rows)),
        "failureMacroF1": sum(f1_values) / len(f1_values) if f1_values else 0.0,
        "recoveryTop1Accuracy": safe_div(recovery_correct, len(rows)),
        "recoveryTop3Accuracy": safe_div(recovery_top3_correct, len(rows)),
        "averageLatencyMs": round(sum(latencies) / len(latencies)) if latencies else 0,
        "models": [args.model],
        "modalities": [args.modalities],
        "byClassAccuracy": {
            label: safe_div(values["correct"], values["count"])
            for label, values in sorted(by_class.items())
        },
    }
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

