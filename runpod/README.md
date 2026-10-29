# RunPod GPU workload

PaySah reads receipt images with a vision-language model on a **RunPod Serverless endpoint**. The endpoint uses RunPod's official **vLLM worker** (v2.29.0 series, 24 GB GPU class) serving `Qwen/Qwen2.5-VL-7B-Instruct`. There is no custom `handler.py`: the official worker exposes an OpenAI-compatible API, so this folder documents configuration rather than shipping handler code.

| Item | Value |
| --- | --- |
| Endpoint type | RunPod Serverless, official vLLM worker |
| Model | `Qwen/Qwen2.5-VL-7B-Instruct` |
| Scaling | Active workers 0 by default; short idle timeout to avoid idle billing |
| Application adapter | [`src/apps/api/src/modules/receipts/runpod.ts`](../src/apps/api/src/modules/receipts/runpod.ts) |
| Server-side settings | `EXTRACTOR_MODE=runpod`, `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID`, `RUNPOD_MODEL`, `RUNPOD_TIMEOUT_MS` (see [`src/.env.example`](../src/.env.example)) |

## How the application calls it

The receipt worker (not the browser) sends the stored image to the endpoint's OpenAI-compatible route and asks for structured receipt fields:

```bash
curl -X POST "https://api.runpod.ai/v2/$RUNPOD_ENDPOINT_ID/openai/v1/chat/completions" \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen2.5-VL-7B-Instruct","messages":[{"role":"user","content":[{"type":"text","text":"Return the receipt fields as JSON."},{"type":"image_url","image_url":{"url":"data:image/png;base64,<image>"}}]}]}'
```

The model only reads fields. Deterministic server rules decide whether evidence is eligible, and a human still confirms payment and releases the order. A CPU Tesseract reading of the same image cross-checks the GPU fields; disagreements are routed to the Owner (`MODEL_UNCONFIRMED`). If the endpoint times out or fails (for example during a cold start), the worker falls back to CPU OCR and records the actual provider and fallback reason.

## Checks

From `src/`:

```bash
npm run runpod:check      # one synthetic image end to end (warms the endpoint)
npm run eval:runpod-vlm   # paired GPU/CPU evaluation on the synthetic set
```

Never commit `RUNPOD_API_KEY`; keep it in Replit Secrets or a local `.env`. Historical evaluation and proof of use: [RunPod POU](../submission/SDC2026_UTeMkuCemerlang_Runpod_POU.pdf).
