import { useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import { CircleNotch } from "@phosphor-icons/react";
import Telegram from "@/models/telegram";
import ConnectedView from "./ConnectedView";
import SetupView from "./SetupView";
import { useTranslation } from "react-i18next";
import { savedSession } from "@/models/platform";
import { TenantSelection } from "@/components/lib/ExecutionIdentity";
import { ModalInput } from "@/components/lib/Modal";
import CTAButton from "@/components/lib/CTAButton";
import paths from "@/utils/paths";

export default function TelegramBotSettings() {
  const session = savedSession();
  const platform = session?.identity === "platform";
  const manager = platform || session?.role === "admin";
  const [tenantId, setTenantId] = useState(session?.tenant?.id || "");
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(null);

  useEffect(() => {
    async function fetchData() {
      Telegram.selectTenant(platform ? tenantId : "");
      if (platform && !tenantId) {
        setLoading(false);
        setConfig(null);
        return;
      }
      setLoading(true);
      const configRes = await Telegram.getConfig();
      setConfig(configRes?.config || null);
      setLoading(false);
    }
    fetchData();
  }, [tenantId, platform]);

  const handleConnected = (newConfig) => setConfig(newConfig);
  const handleDisconnected = () => setConfig(null);

  if (loading) {
    return (
      <ConnectionsLayout>
        <div className="flex items-center justify-center h-full">
          <CircleNotch className="h-8 w-8 text-zinc-400 light:text-slate-400 animate-spin" />
        </div>
      </ConnectionsLayout>
    );
  }

  const hasConfig = config?.active && config?.bot_username;
  if (platform && !tenantId)
    return (
      <ConnectionsLayout fullPage>
        <TenantSelection value={tenantId} onChange={setTenantId} />
      </ConnectionsLayout>
    );
  if (!manager)
    return (
      <ConnectionsLayout fullPage>
        <SelfPair config={config} />
      </ConnectionsLayout>
    );
  if (!hasConfig) {
    return (
      <ConnectionsLayout fullPage={true}>
        <TenantSelection value={tenantId} onChange={setTenantId} />
        <SetupView onConnected={handleConnected} />
      </ConnectionsLayout>
    );
  }

  return (
    <ConnectionsLayout fullPage={true}>
      <TenantSelection value={tenantId} onChange={setTenantId} />
      {!platform && <SelfPair config={config} />}
      <ConnectedView
        key={tenantId}
        config={config}
        onDisconnected={handleDisconnected}
        onReconnected={handleConnected}
      />
    </ConnectionsLayout>
  );
}

function SelfPair({ config }) {
  const [chatId, setChatId] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState(null);
  const [bindings, setBindings] = useState([]);
  const refresh = () =>
    Telegram.getApprovedUsers().then((result) =>
      setBindings(result.users || [])
    );
  useEffect(() => {
    refresh();
  }, []);
  async function pair(event) {
    event.preventDefault();
    const result = await Telegram.approveUser(chatId, code);
    setMessage(
      result.success ? "已绑定到当前企业用户。" : result.error || "配对失败"
    );
    if (result.success) {
      setCode("");
      refresh();
    }
  }
  if (!config?.active)
    return (
      <p className="text-sm text-theme-text-secondary mt-6">
        请企业管理员先配置 Telegram Bot。
      </p>
    );
  return (
    <div className="flex flex-col gap-y-4 mt-8 max-w-[700px]">
      <p className="text-sm text-theme-text-primary">
        向{" "}
        <a
          href={`https://t.me/${config.bot_username}`}
          target="_blank"
          rel="noreferrer"
          className="text-blue-400"
        >
          @{config.bot_username}
        </a>{" "}
        发送 /start，再填写私聊中收到的聊天 ID 和配对码。
      </p>
      <form onSubmit={pair} className="flex flex-col gap-y-4 max-w-[320px]">
        <ModalInput
          label="Telegram 聊天 ID"
          value={chatId}
          onChange={(event) => setChatId(event.target.value)}
          required
        />
        <ModalInput
          label="6 位配对码"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          pattern="[0-9]{6}"
          required
        />
        <CTAButton type="submit">绑定本人账号</CTAButton>
      </form>
      {message && (
        <p className="text-sm text-theme-text-secondary" role="status">
          {message}
        </p>
      )}
      {bindings
        .filter((binding) => binding.userId === savedSession()?.user?.id)
        .map((binding) => (
          <div
            key={binding.chatId}
            className="flex gap-x-4 text-sm text-theme-text-primary"
          >
            <span>{binding.username || binding.chatId}</span>
            <button
              onClick={async () => {
                await Telegram.revokeUser(binding.chatId);
                refresh();
              }}
              className="text-blue-400"
            >
              解除绑定
            </button>
          </div>
        ))}
    </div>
  );
}

function ConnectionsLayout({ children, fullPage = false }) {
  const { t } = useTranslation();
  return (
    <div className="w-screen h-screen overflow-hidden bg-zinc-950 light:bg-slate-50 flex md:mt-0 mt-6">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-2xl bg-zinc-900 light:bg-white light:border light:border-slate-300 w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        {fullPage ? (
          <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16">
            <div className="w-full flex flex-col gap-y-2 pb-6 border-b border-white/20 light:border-slate-300">
              <p className="text-lg font-semibold leading-7 text-white light:text-slate-900">
                {t("telegram.title")}
              </p>
              <p className="text-xs leading-4 text-zinc-400 light:text-slate-600 max-w-[700px]">
                {t("telegram.description")}
              </p>
              <a
                href={paths.docs("/channels/telegram")}
                target="_blank"
                rel="noreferrer"
                className="text-xs leading-4 text-white light:text-slate-900 underline w-fit"
              >
                View Documentation
              </a>
            </div>
            {children}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
