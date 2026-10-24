import CTAButton from "@/components/lib/CTAButton";
import CommunityHubImportItemSteps from "../..";
import { useState } from "react";
import { TenantSelection } from "@/components/lib/ExecutionIdentity";
import showToast from "@/utils/toast";
import paths from "@/utils/paths";
import CommunityHub from "@/models/communityHub";

export default function SystemPrompt({ item, setStep }) {
  const [tenantId, setTenantId] = useState("");

  async function handleSubmit() {
    showToast("Applying system prompt to tenant...", "info");
    const { error } = await CommunityHub.applyItem(item.importId, {
      tenantId,
    });
    if (error) {
      return showToast(`Failed to apply system prompt. ${error}`, "error", {
        clear: true,
      });
    }

    showToast("System prompt applied to tenant.", "success", {
      clear: true,
    });
    setStep(CommunityHubImportItemSteps.completed.key);
  }

  return (
    <div className="flex flex-col mt-4 gap-y-4">
      <div className="flex flex-col gap-y-1">
        <h2 className="text-base text-theme-text-primary font-semibold">
          Review System Prompt "{item.name}"
        </h2>
        {item.creatorUsername && (
          <p className="text-white/60 light:text-theme-text-secondary text-xs font-mono">
            Created by{" "}
            <a
              href={paths.communityHub.profile(item.creatorUsername)}
              target="_blank"
              className="hover:text-blue-500 hover:underline"
              rel="noreferrer"
            >
              @{item.creatorUsername}
            </a>
          </p>
        )}
      </div>
      <div className="flex flex-col gap-y-[25px] text-white/80 light:text-theme-text-secondary text-sm">
        <p>
          System prompts are used to guide the behavior of the AI agents and can
          be applied to the selected tenant.
        </p>

        <div className="flex flex-col gap-y-2">
          <p className="text-white/60 light:text-theme-text-secondary font-semibold">
            Provided system prompt:
          </p>
          <div className="w-full text-theme-text-primary text-md flex flex-col max-h-[calc(300px)] overflow-y-auto">
            <p className="text-white/60 light:text-theme-text-secondary font-mono bg-zinc-900 light:bg-slate-200 px-2 py-1 rounded-md text-sm whitespace-pre-line">
              {item.prompt}
            </p>
          </div>
        </div>

        <div className="flex flex-col w-60">
          <TenantSelection value={tenantId} onChange={setTenantId} />
        </div>
      </div>
      {tenantId && (
        <CTAButton
          className="text-dark-text w-full mt-[18px] h-[34px] hover:bg-accent"
          onClick={handleSubmit}
        >
          Apply system prompt to tenant
        </CTAButton>
      )}
    </div>
  );
}
