from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig


def extract_json(content: str) -> dict[str, Any]:
    cleaned = content.strip()
    if cleaned.startswith("```json"):
        cleaned = cleaned[len("```json") :]
    elif cleaned.startswith("```"):
        cleaned = cleaned[len("```") :]
    if cleaned.endswith("```"):
        cleaned = cleaned[: -len("```")]
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        return {
            "failure_type": "UNKNOWN_STATE",
            "recovery": "ESCALATE_TO_HUMAN",
            "recovery_ranking": ["ESCALATE_TO_HUMAN"],
            "reason": "Model output did not contain valid JSON.",
        }
    try:
        parsed = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError:
        return {
            "failure_type": "UNKNOWN_STATE",
            "recovery": "ESCALATE_TO_HUMAN",
            "recovery_ranking": ["ESCALATE_TO_HUMAN"],
            "reason": "Model output JSON could not be parsed.",
        }
    recovery = str(parsed.get("recovery") or "ESCALATE_TO_HUMAN").upper()
    raw_ranking = parsed.get("recovery_ranking") if isinstance(parsed.get("recovery_ranking"), list) else []
    ranking = list(dict.fromkeys([recovery, *[str(value).upper() for value in raw_ranking]]))[:3]
    return {
        "failure_type": str(parsed.get("failure_type") or "UNKNOWN_STATE").upper(),
        "recovery": recovery,
        "recovery_ranking": ranking,
        "reason": str(parsed.get("reason") or ""),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
    parser.add_argument("--adapter", default=None)
    parser.add_argument("--data", default="training/data/eval.jsonl")
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-new-tokens", type=int, default=256)
    parser.add_argument("--load-in-4bit", action="store_true")
    args = parser.parse_args()

    use_cuda = torch.cuda.is_available()
    quantization_config = None
    if use_cuda and args.load_in_4bit:
        quantization_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )

    tokenizer = AutoTokenizer.from_pretrained(args.model, use_fast=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        device_map="auto" if use_cuda else None,
        torch_dtype=torch.bfloat16 if use_cuda else torch.float32,
        quantization_config=quantization_config,
    )
    if args.adapter:
        model = PeftModel.from_pretrained(model, args.adapter)
    model.eval()

    rows = [json.loads(line) for line in Path(args.data).read_text(encoding="utf-8").splitlines() if line.strip()]
    predictions: list[dict[str, Any]] = []
    for index, row in enumerate(rows, start=1):
        prompt = row.get("prompt")
        expected = row.get("expected") or {}
        if not prompt:
            raise ValueError("Evaluation row is missing prompt. Re-run training/prepare_sft.py to avoid answer leakage.")
        input_text = f"<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n"
        encoded = tokenizer(input_text, return_tensors="pt").to(model.device)
        started = time.perf_counter()
        with torch.inference_mode():
            generated = model.generate(
                **encoded,
                max_new_tokens=args.max_new_tokens,
                do_sample=False,
                pad_token_id=tokenizer.pad_token_id,
                eos_token_id=tokenizer.eos_token_id,
            )
        latency_ms = round((time.perf_counter() - started) * 1000)
        continuation = generated[0, encoded["input_ids"].shape[1] :]
        raw = tokenizer.decode(continuation, skip_special_tokens=False)
        parsed = extract_json(raw)
        predictions.append(
            {
                "sample_id": row.get("sample_id"),
                "mutation": row.get("mutation"),
                "expected_failure": expected.get("failure_type"),
                "predicted_failure": parsed["failure_type"],
                "expected_recovery": expected.get("recovery"),
                "predicted_recovery": parsed["recovery"],
                "predicted_recovery_ranking": parsed["recovery_ranking"],
                "latency_ms": latency_ms,
                "raw_output": raw,
            }
        )
        print(f"[{index}/{len(rows)}] {row.get('mutation')} -> {parsed['failure_type']} / {parsed['recovery']} ({latency_ms} ms)")

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in predictions) + ("\n" if predictions else ""),
        encoding="utf-8",
    )
    print(output)


if __name__ == "__main__":
    main()
