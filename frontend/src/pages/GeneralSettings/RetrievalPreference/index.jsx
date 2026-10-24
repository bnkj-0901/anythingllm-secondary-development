import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { isMobile } from "react-device-detect";
import { useTranslation } from "react-i18next";
import Sidebar from "@/components/SettingsSidebar";
import AutosaveForm from "@/components/AutosaveForm";
import Toggle from "@/components/lib/Toggle";
import { api } from "@/models/platform";
import paths from "@/utils/paths";
import ChatSettings from "@/pages/WorkspaceSettings/ChatSettings";
import MaxContextSnippets from "@/pages/WorkspaceSettings/VectorDatabase/MaxContextSnippets";
import DocumentSimilarityThreshold from "@/pages/WorkspaceSettings/VectorDatabase/DocumentSimilarityThreshold";
import VectorSearchMode from "@/pages/WorkspaceSettings/VectorDatabase/VectorSearchMode";
import SuggestedChatMessages from "@/pages/WorkspaceSettings/GeneralAppearance/SuggestedChatMessages";
import System from "@/models/system";
import AgentConfiguration from "@/pages/WorkspaceSettings/AgentConfig";

export default function RetrievalPreference() {
  const { t } = useTranslation();
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [tenants, setTenants] = useState([]);
  const [vectorDB, setVectorDB] = useState(null);
  const [params, setParams] = useSearchParams();
  const tenantId = params.get("tenantId") || "";
  const endpoint = `/platform/tenants/${encodeURIComponent(tenantId)}/rag-settings`;
  useEffect(() => {
    System.keys().then((settings) => setVectorDB(settings?.VectorDB));
    api("/platform/tenants")
      .then((result) => setTenants(result.tenants || []))
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setForm(null);
    if (!tenantId) return;
    api(endpoint, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setForm(result.settings);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [tenantId]);

  const suggestedApi = {
    getSuggestedMessages: async () => {
      const result = await api(
        `/platform/tenants/${encodeURIComponent(tenantId)}/suggested-messages`
      );
      return result.messages || [];
    },
    setSuggestedMessages: async (_id, messages) => {
      try {
        await api(
          `/platform/tenants/${encodeURIComponent(tenantId)}/suggested-messages`,
          { method: "POST", body: { messages } }
        );
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
  };
  async function saveConfiguration(settings) {
    setError("");
    try {
      const result = await api(endpoint, {
        method: "PATCH",
        body: { settings },
      });
      setForm(result.settings);
      setSuccess("企业配置已保存。");
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  }

  async function save(event) {
    event.preventDefault();
    setError("");
    setSuccess("");
    const values = new FormData(event.currentTarget);
    const settings = {
      topK: Number(values.get("topN")),
      similarityThreshold: Number(values.get("similarityThreshold")),
      embeddingCache: form.embeddingCache !== false,
      ...(values.has("vectorSearchMode")
        ? { rerank: values.get("vectorSearchMode") === "rerank" }
        : {}),
    };
    setBusy(true);
    try {
      const result = await api(endpoint, {
        method: "PATCH",
        body: { settings },
      });
      setForm(result.settings);
      setSuccess("知识检索设置已保存。");
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[86px] md:py-6 py-16">
          <div className="w-full flex flex-col gap-y-1 pb-6 border-white light:border-theme-sidebar-border border-b-2 border-opacity-10">
            <p className="text-lg leading-6 font-bold text-white">
              知识检索设置
            </p>
            <p className="text-xs leading-[18px] font-base text-white text-opacity-60">
              召回数量、相似度阈值和重排在下次问答时生效。分片规则在
              <Link
                to={paths.settings.embedder.chunkingPreference()}
                className="text-primary-button"
              >
                文本分片设置
              </Link>
              中维护，适用于之后上传或重新处理的资料。
            </p>
          </div>
          <label className="mt-4 text-sm text-theme-text-primary">
            企业
            <select
              aria-label="企业"
              className="ml-4 rounded-lg bg-theme-settings-input-bg p-2"
              value={tenantId}
              onChange={(e) => {
                setError("");
                setSuccess("");
                setParams({ tenantId: e.target.value });
              }}
            >
              <option value="">请选择企业</option>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <p role="alert" className="my-4 text-sm text-red-400">
              {error}
            </p>
          )}
          {success && (
            <p role="status" className="my-4 text-sm text-theme-text-primary">
              {success}
            </p>
          )}
          {!form && !error && tenantId && (
            <p className="mt-4 text-sm text-theme-text-secondary">
              正在加载检索设置…
            </p>
          )}
          {form && (
            <div key={tenantId} className="mt-6 flex flex-col gap-y-8">
              <ChatSettings
                workspace={{ ...form, tenantId }}
                onUpdate={saveConfiguration}
              />
              <AgentConfiguration
                workspace={{ ...form, tenantId }}
                onUpdate={saveConfiguration}
              />
              <SuggestedChatMessages
                slug={tenantId}
                resourceApi={suggestedApi}
              />
            </div>
          )}
          {form && (
            <AutosaveForm
              key={tenantId}
              onSave={(element) =>
                save({ preventDefault() {}, currentTarget: element })
              }
            >
              <fieldset disabled={busy}>
                <div className="w-1/2 flex flex-col gap-y-[32px] mt-6">
                  <MaxContextSnippets workspace={{ topN: form.topK }} />
                  <DocumentSimilarityThreshold workspace={form} />
                  <VectorSearchMode
                    workspace={{
                      vectorDB,
                      vectorSearchMode: form.rerank ? "rerank" : "default",
                    }}
                  />
                </div>
                <div className="my-6 flex flex-col gap-y-4">
                  <Toggle
                    size="md"
                    variant="horizontal"
                    enabled={form.embeddingCache !== false}
                    onChange={(value) =>
                      saveConfiguration({ embeddingCache: value })
                    }
                    label={t("enterprise:rag.cache")}
                    description={t("enterprise:rag.cacheHint")}
                  />
                </div>
              </fieldset>
            </AutosaveForm>
          )}
        </div>
      </div>
    </div>
  );
}
