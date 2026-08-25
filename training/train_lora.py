from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from datasets import load_dataset
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
    parser.add_argument("--data", default="training/data/train.jsonl")
    parser.add_argument("--eval-data", default="training/data/eval.jsonl")
    parser.add_argument("--output", default="training/output/workflowlens-lora")
    parser.add_argument("--epochs", type=float, default=2.0)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--grad-accum", type=int, default=8)
    parser.add_argument("--max-length", type=int, default=4096)
    args = parser.parse_args()

    use_cuda = torch.cuda.is_available()
    quantization_config = None
    if use_cuda:
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

    train_dataset = load_dataset("json", data_files=args.data, split="train")
    eval_path = Path(args.eval_data)
    if eval_path.exists():
        eval_dataset = load_dataset("json", data_files=str(eval_path), split="train")
        split_mode = "held_out_mutations"
    else:
        split = train_dataset.train_test_split(test_size=max(1, int(len(train_dataset) * 0.15)), seed=42)
        train_dataset = split["train"]
        eval_dataset = split["test"]
        split_mode = "random_fallback"

    peft_config = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )

    training_args = SFTConfig(
        output_dir=args.output,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=1,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=2e-4,
        warmup_ratio=0.05,
        logging_steps=5,
        eval_strategy="epoch",
        save_strategy="epoch",
        report_to="none",
        bf16=use_cuda,
        fp16=False,
        max_length=args.max_length,
        dataset_text_field="text",
        packing=False,
    )

    trainer = SFTTrainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        peft_config=peft_config,
        processing_class=tokenizer,
    )
    trainer.train()
    trainer.save_model(args.output)
    tokenizer.save_pretrained(args.output)

    metrics_path = Path(args.output) / "training_summary.json"
    metrics_path.write_text(
        json.dumps(
            {
                "base_model": args.model,
                "train_samples": len(train_dataset),
                "eval_samples": len(eval_dataset),
                "split_mode": split_mode,
                "epochs": args.epochs,
                "quantized": use_cuda,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(metrics_path)


if __name__ == "__main__":
    main()

