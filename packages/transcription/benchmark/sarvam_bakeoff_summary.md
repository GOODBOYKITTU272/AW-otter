# P3A Benchmark Bake-Off: Whisper Large-v3 vs Sarvam AI Saaras:v3

## Executive Summary
This bake-off evaluates real-human native Telugu speech from the OpenSLR SLR66 corpus across two distinct speech recognition backends:
1. **OpenRouter Whisper Large-v3** (Standard Western Multilingual Baseline)
2. **Sarvam AI Saaras:v3** (Indian Sovereign Foundational Speech Model)

## Quantitative Comparison (6 Human Ground-Truth Cases)

| Metric | OpenRouter Whisper Large-v3 | Sarvam AI Saaras:v3 | Delta / Improvement |
| :--- | :---: | :---: | :---: |
| **Telugu Script Preservation** | **0 / 6 (0.0%)** | **6 / 6 (100.0%)** | **+100.0%** |
| **Language Detection Accuracy** | **0 / 6 (0.0%)** | **6 / 6 (100.0%)** | **+100.0%** |
| **Average Character Error Rate (CER)** | **> 1.0000** | **0.1108 (11.1%)** | **~89% Reduction** |
| **Median CER (Excluding Numerals)** | **1.0000** | **0.0130 (1.3%)** | **98.7% Accuracy** |
| **Average Latency per Clip** | **4,113 ms** | **818 ms** | **5x Faster** |

## Qualitative Findings
1. **Whisper Failure Mode:** Whisper misclassifies Telugu audio as English, Tamil, or Kannada. It emits cross-script transliteration or hallucinatory English translations.
2. **Sarvam Strength:** Sarvam natively outputs clean Telugu orthography, captures complex South Indian proper nouns accurately (e.g. *నందమూరి తారకరామారావు, దాసరి నారాయణరావు*), and intelligently normalizes spoken Telugu numbers into Arabic digits (*1749*).
