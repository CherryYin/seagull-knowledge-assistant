import type { PodcastAudioRenderRequest } from "./api/podcasts";

export function readAudioReceipt(key: string): PodcastAudioRenderRequest | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const body = JSON.parse(raw) as PodcastAudioRenderRequest;
  if (!body || !/^[a-f0-9]{64}$/.test(body.base_input_hash) || !/^[a-f0-9]{64}$/.test(body.execution_fingerprint) || !/^[A-Za-z0-9_-]{8,120}$/.test(body.idempotency_key) || !Number.isInteger(body.credential_id) || typeof body.budget_limit !== "string" || typeof body.price_per_10k_characters !== "string" || body.authorize_text_to_provider !== true || body.acknowledge_billing_uncertainty !== true) throw new Error("本地音频提交回执无效，请先核对服务器任务记录，不要直接重新生成。");
  return body;
}
