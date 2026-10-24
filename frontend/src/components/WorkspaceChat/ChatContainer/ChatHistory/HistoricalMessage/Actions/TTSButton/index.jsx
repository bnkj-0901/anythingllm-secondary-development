import { useTTSProvider } from "@/components/contexts/TTSProvider";
import NativeTTSMessage from "./native";
import AsyncTTSMessage from "./asyncTts";
import PiperTTSMessage from "./piperTTS";

function WrapTTS({ children }) {
  return <div className="mx-2">{children}</div>;
}

export default function TTSMessage({ slug, chatId, message, fetchAudio }) {
  const { settings, provider, loading } = useTTSProvider();
  if (!chatId || loading) return null;

  switch (provider) {
    case "openai":
    case "generic-openai":
    case "elevenlabs":
    case "kokoro":
      return (
        <WrapTTS>
          <AsyncTTSMessage
            chatId={chatId}
            slug={slug}
            fetchAudio={fetchAudio}
          />
        </WrapTTS>
      );
    case "piper_local":
      return (
        <WrapTTS>
          <PiperTTSMessage
            chatId={chatId}
            voiceId={settings?.TTSPiperTTSVoiceModel}
            message={message}
          />
        </WrapTTS>
      );
    default:
      return (
        <WrapTTS>
          <NativeTTSMessage chatId={chatId} message={message} />
        </WrapTTS>
      );
  }
}
