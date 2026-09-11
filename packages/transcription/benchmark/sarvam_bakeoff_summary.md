# P3A Benchmark Bake-Off: Whisper Large-v3-Turbo vs Sarvam Saaras:v3 & Saaras:v4

## Executive Summary
This bake-off evaluates real-human native Telugu speech from the OpenSLR SLR66 corpus across the actual production-configured audio pipeline (16kHz mono Opus/Ogg) on four distinct candidate runs:
1. **OpenRouter Whisper Large-v3-Turbo** (Current Signal Production Default)
2. **Sarvam AI Saaras:v3 (Auto-Detect `language_code="unknown"`)**
3. **Sarvam AI Saaras:v3 (Forced `language_code="te-IN"`)**
4. **Sarvam AI Saaras:v4 (Auto-Detect `language_code="unknown"`)**

All tests use Unicode Category CER (`\p{L}\p{M}\p{N}`) to ensure cross-script substitutions are accurately penalized rather than stripped.

---

## Quantitative Comparison (6 Human Ground-Truth Cases, Production 16kHz Opus/Ogg Input)

| Candidate / Configuration | Telugu Script Preserved | Auto-Detection Accuracy | Avg Latency | Median CER | Avg WER | Primary Failure / Characteristic |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **Whisper Large-v3-Turbo** (Prod Default) | **0 / 6 (0.0%)** | **0 / 6 (0.0%)** | 1,698 ms | **1.0443** | **1.0151** | Emits Tamil, Devanagari, and Kannada scripts instead of Telugu. Dropped clip 04 entirely. |
| **Sarvam saaras:v3 (Auto-Detect)** | **6 / 6 (100.0%)** | **6 / 6 (100.0%)** | **538 ms** | **0.0196** | 0.3172 | Flawless auto-detection (`te-IN`). Proper nouns accurate. 1749 normalized to digits. |
| **Sarvam saaras:v3 (Forced te-IN)** | **6 / 6 (100.0%)** | N/A (Forced) | **466 ms** | **0.0196** | 0.3172 | Identical output to auto-detect; proves auto-detect has zero degradation. |
| **Sarvam saaras:v4 (Auto-Detect)** | **6 / 6 (100.0%)** | **6 / 6 (100.0%)** | **568 ms** | **0.0063** | **0.2960** | **Highest Accuracy.** 0.000 CER on clips 02 & 03. Near-perfect proper noun capture. |

---

## Detailed Case Breakdown (Production Opus/Ogg Input)

### Clip `openslr-te-02` (Director Names)
- **HUMAN REFERENCE:**
  ```text
  ఈ సమయంలో దాసరి నారాయణరావు కె.రాఘవేంద్రరావు కోడిరామి రెడ్డి అగ్రస్థానంలో ఉన్న దర్శకులు
  ```
- **WHISPER LARGE-V3-TURBO (`lang=ta`, latency=1693ms):**
  ```text
  ஈ சமியம்லோ ஦ாசர் நாரைனராவு கேர் ராகவேந்திரராவு கோடி ராமிரெட்டி அக்ருஸ்தானம்லோ உன்ன தர்சக்குலும்
  ```
  *(100% Failure — Tamil script substitution, CER = 1.1200)*
- **SARVAM SAARAS:V3 AUTO-DETECT (`lang=te-IN`, latency=872ms):**
  ```text
  ఈ సమయంలో దాసరి నారాయణరావు, కే రాఘవేంద్రరావు, కోడిరామిరెడ్డి అగ్రస్థానంలో ఉన్న దర్శకులు.
  ```
  *(CER = 0.0133 / 98.7% accuracy)*
- **SARVAM SAARAS:V4 AUTO-DETECT (`lang=te-IN`, latency=480ms):**
  ```text
  ఈ సమయంలో దాసరి నారాయణరావు, కె. రాఘవేంద్రరావు, కోడిరామిరెడ్డి అగ్రస్థానంలో ఉన్న దర్శకులు.
  ```
  *(**CER = 0.0000 / 100% Accuracy!** Even preserved the abbreviated "కె." exactly as in human reference)*

### Clip `openslr-te-03` (Former CM NTR & Lakshmi Parvathi)
- **HUMAN REFERENCE:**
  ```text
  ఆంధ్రప్రదేశ్ రాష్ట్ర మాజీ ముఖ్యమంత్రి నందమూరి తారక రామారావు రెండవ భార్య నందమూరి లక్ష్మీపార్వతి
  ```
- **WHISPER LARGE-V3-TURBO (`lang=hi`, latency=1094ms):**
  ```text
  आंदर प्रदेश रास्ट माजी मुख्य मंत्री नंदमुरितारकरामाराव। रिंड़ भार्या? नंदमूरी लक्ष्मी पार्वत्ती
  ```
  *(100% Failure — Devanagari script substitution, CER = 1.0000)*
- **SARVAM SAARAS:V4 AUTO-DETECT (`lang=te-IN`, latency=359ms):**
  ```text
  ఆంధ్రప్రదేశ్ రాష్ట్ర మాజీ ముఖ్యమంత్రి నందమూరి తారక రామారావు రెండవ భార్య నందమూరి లక్ష్మీ పార్వతి.
  ```
  *(**CER = 0.0000 / 100% Accuracy!**)*
