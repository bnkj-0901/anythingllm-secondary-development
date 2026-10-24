import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

// Matches the upstream TTS button's request signature. SaaS messages belong to
// an authenticated user's conversation and do not have a Workspace slug.
export async function ttsMessage(_slug, messageId) {
  const response = await fetch(
    `${API_BASE}/enterprise/messages/${encodeURIComponent(messageId)}/tts`,
    { headers: baseHeaders(), cache: "no-store" }
  );
  if (response.status === 204) return null;
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || "语音播放暂时不可用");
  }
  return URL.createObjectURL(await response.blob());
}
