import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import renderMarkdown from "@/utils/chat/markdown";
import DOMPurify from "@/utils/chat/purify";
import { openImageLightbox } from "@/components/ImageLightbox";
import useAppearance from "@/hooks/useAppearance";

/** Shared upstream renderer for answers and authorized document previews. */
export default function Markdown({ children }) {
  const { t } = useTranslation();
  useAppearance();
  const [error, setError] = useState("");
  const root = useRef(null);
  const timers = useRef(new Set());
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  async function copyBlock(event) {
    const image = event.target.closest("img");
    if (image && root.current?.contains(image)) {
      event.preventDefault();
      const nodes = [...root.current.querySelectorAll("img")];
      openImageLightbox(
        nodes.map((node) => ({ contentString: node.src, name: node.alt })),
        nodes.indexOf(image)
      );
      return;
    }
    const button = event.target.closest("button[data-code-snippet]");
    if (!button || !root.current?.contains(button)) return;
    const code = button.closest(".hljs")?.querySelector("pre");
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent);
      setError("");
      const label = button.querySelector("p");
      if (!label) return;
      label.textContent = t("enterprise:markdown.copied");
      const timer = setTimeout(() => {
        if (button.isConnected)
          label.textContent = t("enterprise:markdown.copyBlock");
        timers.current.delete(timer);
      }, 2500);
      timers.current.add(timer);
    } catch {
      setError(t("enterprise:markdown.copyFailed"));
    }
  }

  return (
    <>
      <div
        ref={root}
        onClick={copyBlock}
        className="markdown min-w-0 whitespace-normal break-words text-theme-text-primary [&_pre]:overflow-x-auto [&_strong]:!text-theme-text-primary"
        dangerouslySetInnerHTML={{
          __html: DOMPurify.sanitize(renderMarkdown(children || "")),
        }}
      />
      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
    </>
  );
}
