import { Plus } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "react-tooltip";
import { useMemoriesContext, LIMITS } from "../MemoriesContext";

export default function MemoryTabs() {
  const { memories, openCreateModal } = useMemoriesContext();
  const { t } = useTranslation();
  const atLimit = memories.length >= LIMITS.personal;
  return (
    <div className="flex items-center justify-between shrink-0 gap-2">
      <div className="text-xs text-theme-text-secondary">
        {t("chat_window.memories.title")} ({memories.length}/{LIMITS.personal})
      </div>
      <button
        type="button"
        onClick={openCreateModal}
        disabled={atLimit}
        className="-mr-1 flex items-center justify-center size-6 rounded-lg border-none bg-transparent cursor-pointer text-zinc-50 light:text-slate-900 hover:bg-zinc-800 light:hover:bg-slate-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        <Plus size={16} weight="bold" />
      </button>
      <Tooltip
        id="memories-workspace-pill"
        place="bottom"
        delayShow={800}
        className="tooltip !text-xs z-99"
      />
    </div>
  );
}
