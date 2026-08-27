# Measured results

This directory contains compact, reviewable summaries of measured Browser Reliability Runtime experiments. Large generated traces, screenshots, model weights, adapters, and raw result bundles remain outside Git.

## Local text model vs screenshot-aware VLM

The same leakage-free 9-case held-out split contains three cases each for `AUTH_EXPIRED`, `RESPONSIVE_LAYOUT_CHANGE`, and `NAVIGATION_ERROR`.

| Model | Modality | N | Failure Acc | Macro-F1 | Recovery Top-1 | Recovery Top-3 | Avg latency |
|---|---|---:|---:|---:|---:|---:|---:|
| Qwen3-Coder-Next | structured text | 9 | 66.7% | 50.0% | 33.3% | 66.7% | 31.26 s |
| Gemma 4 26B-A4B | screenshot + structured context | 9 | 100.0% | 100.0% | 66.7% | 100.0% | 34.21 s |

The VLM completed all nine requests without blocked or failed jobs. Screenshot evidence materially improved failure diagnosis and recovery ranking in this controlled workflow reliability task.

## Canonical Colab Base vs QLoRA

This is the first successful canonical run. No seed, split, or epoch retuning was performed after observing the result.

| Model | N | Failure Acc | Macro-F1 | Recovery Top-1 | Recovery Top-3 | Avg latency |
|---|---:|---:|---:|---:|---:|---:|
| Qwen2.5-1.5B Base | 9 | 0.00% | 0.00% | 33.33% | 33.33% | 3,991 ms |
| 34-sample QLoRA | 9 | 0.00% | 0.00% | 0.00% | 66.67% | 6,513 ms |

Training used 34 examples with the three held-out mutation classes excluded entirely. Only assistant tokens contributed to loss. The adapter improved Recovery Top-3 by `+33.33 pp`, but did not improve failure classification and reduced Recovery Top-1 by `-33.33 pp`.

Canonical environment: NVIDIA A100-SXM4-40GB, Python 3.13.15, PyTorch 2.11.0+cu128, Transformers 4.57.6, PEFT 0.19.1, TRL 0.29.1, bitsandbytes 0.50.1. QLoRA used 4-bit NF4 double quantization, rank 16, alpha 32, dropout 0.05, two epochs, learning rate 2e-4, effective batch size 16, and seed 42.

The source result bundle is intentionally gitignored. The canonical ZIP was `72,053,020` bytes with SHA-256 `370c894f085387bdfd626a2db4e5cf05a01e8e909b89452251e350582b7d5f99`.

See `canonical_colab_summary.json` for machine-readable metrics and provenance.
