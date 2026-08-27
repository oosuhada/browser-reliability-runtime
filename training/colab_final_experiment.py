from __future__ import annotations

import argparse
import gc
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import bitsandbytes
import datasets
import peft
import torch
import transformers
import trl
from datasets import Dataset
from peft import LoraConfig, PeftModel, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    DataCollatorForSeq2Seq,
    Trainer,
    TrainingArguments,
)


BASE_MODEL = "Qwen/Qwen2.5-1.5B-Instruct"
HELD_OUT_MUTATIONS = {"auth_expired", "responsive_layout", "unexpected_navigation"}
EXPECTED_FAILURES = {
    "auth_expired": "AUTH_EXPIRED",
    "responsive_layout": "RESPONSIVE_LAYOUT_CHANGE",
    "unexpected_navigation": "NAVIGATION_ERROR",
}


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def validate_data(train_rows: list[dict[str, Any]], eval_rows: list[dict[str, Any]]) -> dict[str, Any]:
    train_mutations = {str(row["mutation"]) for row in train_rows}
    eval_mutations = {str(row["mutation"]) for row in eval_rows}
    train_ids = {str(row["sample_id"]) for row in train_rows}
    eval_ids = {str(row["sample_id"]) for row in eval_rows}
    leakage_terms = ("expected_failure", "expected_recovery", "<|im_start|>assistant")
    prompt_leaks = [
        row["sample_id"]
        for row in eval_rows
        if any(term.lower() in str(row.get("prompt", "")).lower() for term in leakage_terms)
    ]
    validation = {
        "train_count": len(train_rows),
        "eval_count": len(eval_rows),
        "train_mutation_distribution": dict(sorted(Counter(row["mutation"] for row in train_rows).items())),
        "eval_mutation_distribution": dict(sorted(Counter(row["mutation"] for row in eval_rows).items())),
        "mutation_overlap": sorted(train_mutations & eval_mutations),
        "sample_id_overlap": sorted(train_ids & eval_ids),
        "eval_prompt_leaks": prompt_leaks,
        "held_out_mutations_match": eval_mutations == HELD_OUT_MUTATIONS,
        "expected_failure_mapping_valid": all(
            (row.get("expected") or {}).get("failure_type") == EXPECTED_FAILURES.get(row["mutation"])
            for row in eval_rows
        ),
    }
    if len(train_rows) != 34 or len(eval_rows) != 9:
        raise ValueError(f"Unexpected split sizes: {len(train_rows)=}, {len(eval_rows)=}")
    if validation["mutation_overlap"] or validation["sample_id_overlap"] or prompt_leaks:
        raise ValueError(f"Leakage validation failed: {json.dumps(validation, indent=2)}")
    if not validation["held_out_mutations_match"] or not validation["expected_failure_mapping_valid"]:
        raise ValueError(f"Held-out class validation failed: {json.dumps(validation, indent=2)}")
    return validation


def run(command: list[str]) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, check=True)


def unload(model: Any | None = None) -> None:
    if model is not None:
        del model
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.synchronize()


def load_quantized_model() -> AutoModelForCausalLM:
    compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    quantization_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=compute_dtype,
        bnb_4bit_use_double_quant=True,
    )
    return AutoModelForCausalLM.from_pretrained(
        BASE_MODEL,
        device_map="auto",
        torch_dtype=compute_dtype,
        quantization_config=quantization_config,
    )


def tokenize_training_rows(rows: list[dict[str, Any]], tokenizer: AutoTokenizer, max_length: int) -> Dataset:
    tokenized: list[dict[str, list[int]]] = []
    for row in rows:
        prompt_prefix = f"<|im_start|>user\n{row['prompt']}<|im_end|>\n<|im_start|>assistant\n"
        full_text = str(row["text"])
        if not full_text.startswith(prompt_prefix):
            raise ValueError(f"Unexpected SFT chat format for {row['sample_id']}")
        full = tokenizer(full_text, add_special_tokens=False, truncation=True, max_length=max_length)
        prefix = tokenizer(prompt_prefix, add_special_tokens=False, truncation=True, max_length=max_length)
        if len(prefix["input_ids"]) >= len(full["input_ids"]):
            raise ValueError(f"Assistant completion was truncated for {row['sample_id']}")
        labels = [-100] * len(prefix["input_ids"]) + full["input_ids"][len(prefix["input_ids"]):]
        if not any(value != -100 for value in labels):
            raise ValueError(f"No assistant target tokens for {row['sample_id']}")
        tokenized.append(
            {"input_ids": full["input_ids"], "attention_mask": full["attention_mask"], "labels": labels}
        )
    return Dataset.from_list(tokenized)


def train_adapter(train_rows: list[dict[str, Any]], adapter_dir: Path) -> dict[str, Any]:
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL, use_fast=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"
    model = load_quantized_model()
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    config = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )
    model = get_peft_model(model, config)
    model.print_trainable_parameters()
    max_length = 4096
    dataset = tokenize_training_rows(train_rows, tokenizer, max_length)
    bf16 = torch.cuda.is_bf16_supported()
    args = TrainingArguments(
        output_dir=str(adapter_dir),
        num_train_epochs=2.0,
        per_device_train_batch_size=2,
        gradient_accumulation_steps=8,
        learning_rate=2e-4,
        warmup_ratio=0.05,
        logging_steps=1,
        save_strategy="no",
        eval_strategy="no",
        report_to="none",
        bf16=bf16,
        fp16=not bf16,
        optim="paged_adamw_8bit",
        gradient_checkpointing=True,
        seed=42,
        data_seed=42,
        remove_unused_columns=False,
    )
    collator = DataCollatorForSeq2Seq(tokenizer=tokenizer, padding=True, label_pad_token_id=-100)
    trainer = Trainer(model=model, args=args, train_dataset=dataset, data_collator=collator)
    started = time.perf_counter()
    result = trainer.train()
    runtime = time.perf_counter() - started
    adapter_dir.mkdir(parents=True, exist_ok=True)
    trainer.save_model(str(adapter_dir))
    tokenizer.save_pretrained(adapter_dir)
    summary = {
        "base_model": BASE_MODEL,
        "train_samples": len(train_rows),
        "held_out_samples_used_for_training": 0,
        "assistant_only_loss": True,
        "epochs": 2.0,
        "learning_rate": 2e-4,
        "per_device_batch_size": 2,
        "gradient_accumulation_steps": 8,
        "effective_batch_size": 16,
        "max_length": max_length,
        "lora_rank": 16,
        "lora_alpha": 32,
        "lora_dropout": 0.05,
        "target_modules": sorted(config.target_modules),
        "quantization": "4-bit NF4 double-quant",
        "seed": 42,
        "train_runtime_seconds_wall": runtime,
        "trainer_metrics": result.metrics,
        "trainable_parameters": sum(p.numel() for p in model.parameters() if p.requires_grad),
    }
    write_json(adapter_dir / "training_summary.json", summary)
    unload(model)
    return summary


def load_report(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def build_comparison(base_rows: list[dict[str, Any]], lora_rows: list[dict[str, Any]], base: dict[str, Any], lora: dict[str, Any]) -> dict[str, Any]:
    base_by_id = {row["sample_id"]: row for row in base_rows}
    lora_by_id = {row["sample_id"]: row for row in lora_rows}
    transitions = Counter()
    sample_details = []
    for sample_id in sorted(base_by_id):
        b = base_by_id[sample_id]
        l = lora_by_id[sample_id]
        b_correct = b["expected_failure"] == b["predicted_failure"]
        l_correct = l["expected_failure"] == l["predicted_failure"]
        key = (
            "base_wrong_lora_correct" if not b_correct and l_correct else
            "base_correct_lora_wrong" if b_correct and not l_correct else
            "both_correct" if b_correct and l_correct else "both_wrong"
        )
        transitions[key] += 1
        sample_details.append({
            "sample_id": sample_id,
            "mutation": b["mutation"],
            "expected_failure": b["expected_failure"],
            "base_failure": b["predicted_failure"],
            "lora_failure": l["predicted_failure"],
            "expected_recovery": b["expected_recovery"],
            "base_recovery": b["predicted_recovery"],
            "lora_recovery": l["predicted_recovery"],
            "transition": key,
        })
    metric_keys = {
        "failure_accuracy": "failureAccuracy",
        "failure_macro_f1": "failureMacroF1",
        "recovery_top1": "recoveryTop1Accuracy",
        "recovery_top3": "recoveryTop3Accuracy",
    }
    class_details: dict[str, Any] = {}
    for mutation in sorted(HELD_OUT_MUTATIONS):
        b_rows = [row for row in base_rows if row["mutation"] == mutation]
        l_rows = [row for row in lora_rows if row["mutation"] == mutation]
        class_details[mutation] = {
            "expected_failure": EXPECTED_FAILURES[mutation],
            "n": len(b_rows),
            "base_failure_correct": sum(row["expected_failure"] == row["predicted_failure"] for row in b_rows),
            "lora_failure_correct": sum(row["expected_failure"] == row["predicted_failure"] for row in l_rows),
            "base_recovery_top1_correct": sum(row["expected_recovery"] == row["predicted_recovery"] for row in b_rows),
            "lora_recovery_top1_correct": sum(row["expected_recovery"] == row["predicted_recovery"] for row in l_rows),
            "base_recovery_top3_correct": sum(row["expected_recovery"] in row["predicted_recovery_ranking"][:3] for row in b_rows),
            "lora_recovery_top3_correct": sum(row["expected_recovery"] in row["predicted_recovery_ranking"][:3] for row in l_rows),
        }
    return {
        "base": base,
        "lora": lora,
        "delta_percentage_points": {
            name: (lora[key] - base[key]) * 100 for name, key in metric_keys.items()
        },
        "sample_level_counts": {name: transitions.get(name, 0) for name in (
            "base_wrong_lora_correct", "base_correct_lora_wrong", "both_correct", "both_wrong"
        )},
        "by_held_out_class": class_details,
        "samples": sample_details,
    }


def comparison_markdown(comparison: dict[str, Any]) -> str:
    b, l = comparison["base"], comparison["lora"]
    lines = [
        "# Browser Reliability Runtime — canonical Colab result",
        "",
        "| Model | N | Failure Acc | Macro-F1 | Recovery Top-1 | Recovery Top-3 | Avg latency |",
        "|---|---:|---:|---:|---:|---:|---:|",
        f"| Base | {b['samples']} | {b['failureAccuracy']:.2%} | {b['failureMacroF1']:.2%} | {b['recoveryTop1Accuracy']:.2%} | {b['recoveryTop3Accuracy']:.2%} | {b['averageLatencyMs']} ms |",
        f"| LoRA | {l['samples']} | {l['failureAccuracy']:.2%} | {l['failureMacroF1']:.2%} | {l['recoveryTop1Accuracy']:.2%} | {l['recoveryTop3Accuracy']:.2%} | {l['averageLatencyMs']} ms |",
        "",
        "## Percentage-point deltas (LoRA − Base)",
    ]
    lines.extend(f"- {key}: {value:+.2f} pp" for key, value in comparison["delta_percentage_points"].items())
    lines.extend(["", "## Sample-level transitions"])
    lines.extend(f"- {key}: {value}" for key, value in comparison["sample_level_counts"].items())
    lines.extend(["", "## Held-out classes", "", "| Mutation | N | Base failure | LoRA failure | Base recovery@1 | LoRA recovery@1 | Base recovery@3 | LoRA recovery@3 |", "|---|---:|---:|---:|---:|---:|---:|---:|"])
    for mutation, row in comparison["by_held_out_class"].items():
        lines.append(
            f"| {mutation} | {row['n']} | {row['base_failure_correct']}/{row['n']} | {row['lora_failure_correct']}/{row['n']} | "
            f"{row['base_recovery_top1_correct']}/{row['n']} | {row['lora_recovery_top1_correct']}/{row['n']} | "
            f"{row['base_recovery_top3_correct']}/{row['n']} | {row['lora_recovery_top3_correct']}/{row['n']} |"
        )
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", default="/content/browser-reliability-runtime")
    args = parser.parse_args()
    root = Path(args.workspace)
    training = root / "training"
    output = root / "colab-results"
    adapter = output / "adapter"
    output.mkdir(parents=True, exist_ok=True)

    if not torch.cuda.is_available():
        raise RuntimeError("A Colab CUDA GPU is required.")
    train_rows = read_jsonl(training / "data/train.jsonl")
    eval_rows = read_jsonl(training / "data/eval.jsonl")
    validation = validate_data(train_rows, eval_rows)
    write_json(output / "dataset_validation.json", validation)
    print(json.dumps(validation, indent=2), flush=True)

    environment = {
        "utc_timestamp": datetime.now(timezone.utc).isoformat(),
        "gpu_name": torch.cuda.get_device_name(0),
        "gpu_total_memory_bytes": torch.cuda.get_device_properties(0).total_memory,
        "python": platform.python_version(),
        "torch": torch.__version__,
        "cuda": torch.version.cuda,
        "transformers": transformers.__version__,
        "datasets": datasets.__version__,
        "peft": peft.__version__,
        "trl": trl.__version__,
        "bitsandbytes": bitsandbytes.__version__,
    }
    write_json(output / "environment.json", environment)
    print(json.dumps(environment, indent=2), flush=True)

    base_predictions = output / "base_predictions.jsonl"
    lora_predictions = output / "lora_predictions.jsonl"
    base_report = output / "base_report.json"
    lora_report = output / "lora_report.json"
    run([sys.executable, str(training / "run_inference.py"), "--model", BASE_MODEL, "--data", str(training / "data/eval.jsonl"), "--output", str(base_predictions), "--max-new-tokens", "256", "--load-in-4bit"])
    run([sys.executable, str(training / "evaluate_predictions.py"), "--predictions", str(base_predictions), "--output", str(base_report), "--model", BASE_MODEL])

    training_summary = train_adapter(train_rows, adapter)
    write_json(output / "training_summary.json", training_summary)

    run([sys.executable, str(training / "run_inference.py"), "--model", BASE_MODEL, "--adapter", str(adapter), "--data", str(training / "data/eval.jsonl"), "--output", str(lora_predictions), "--max-new-tokens", "256", "--load-in-4bit"])
    run([sys.executable, str(training / "evaluate_predictions.py"), "--predictions", str(lora_predictions), "--output", str(lora_report), "--model", BASE_MODEL + "+BRR-LoRA"])

    base_rows = read_jsonl(base_predictions)
    lora_rows = read_jsonl(lora_predictions)
    base = load_report(base_report)
    lora = load_report(lora_report)
    failed = sum(not row.get("raw_output") for row in [*base_rows, *lora_rows])
    checks = {
        "base_predictions": len(base_rows), "lora_predictions": len(lora_rows),
        "failed_inference": failed, "train_count": len(train_rows), "eval_count": len(eval_rows),
        "leakage_free": not validation["mutation_overlap"] and not validation["sample_id_overlap"] and not validation["eval_prompt_leaks"],
        "base_report_samples": base["samples"], "lora_report_samples": lora["samples"],
        "adapter_config_exists": (adapter / "adapter_config.json").exists(),
        "adapter_weights_exist": (adapter / "adapter_model.safetensors").exists(),
    }
    expected_checks = {
        "base_predictions": 9, "lora_predictions": 9, "failed_inference": 0,
        "train_count": 34, "eval_count": 9, "leakage_free": True,
        "base_report_samples": 9, "lora_report_samples": 9,
        "adapter_config_exists": True, "adapter_weights_exist": True,
    }
    if checks != expected_checks:
        raise RuntimeError(f"Final verification failed: {json.dumps(checks, indent=2)}")

    comparison = build_comparison(base_rows, lora_rows, base, lora)
    write_json(output / "comparison.json", comparison)
    (output / "comparison.md").write_text(comparison_markdown(comparison), encoding="utf-8")
    manifest = {
        **environment,
        "base_model": BASE_MODEL,
        "train_count": len(train_rows),
        "eval_count": len(eval_rows),
        "held_out_mutations": sorted(HELD_OUT_MUTATIONS),
        "training_config": {key: training_summary[key] for key in (
            "epochs", "learning_rate", "per_device_batch_size", "gradient_accumulation_steps",
            "effective_batch_size", "max_length", "lora_rank", "lora_alpha", "lora_dropout",
            "target_modules", "quantization", "seed", "assistant_only_loss"
        )},
        "validation": validation,
        "final_checks": checks,
    }
    write_json(output / "run_manifest.json", manifest)
    write_json(output / "final_checks.json", checks)
    archive = shutil.make_archive(str(root / "browser-reliability-runtime-colab-results"), "zip", root_dir=root, base_dir="colab-results")
    checks["result_zip_exists"] = Path(archive).exists()
    checks["result_zip_bytes"] = Path(archive).stat().st_size
    write_json(output / "final_checks.json", checks)
    print((output / "comparison.md").read_text(encoding="utf-8"), flush=True)
    print(json.dumps({"archive": archive, "checks": checks}, indent=2), flush=True)
    unload()


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    main()
