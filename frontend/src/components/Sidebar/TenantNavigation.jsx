import { useTranslation } from "react-i18next";
import { Icon } from "@/components/lib/PlatformUI";
import MenuOption from "@/components/SettingsSidebar/MenuOption";
import ThreadItem from "./ActiveWorkspaces/ThreadContainer/ThreadItem";
import Footer from "@/components/Footer";
import { useContext } from "react";
import { PfpContext } from "@/PfpContext";

export function TenantNavigation({
  session,
  hostname,
  pages,
  allowed,
  navigate,
  close,
  chat,
}) {
  const { t } = useTranslation();
  const management = allowed.filter(
    (key) => !["chat", "knowledge"].includes(key)
  );
  const option = (key) => ({
    href: `/${key}`,
    btnText: pages[key].label,
    icon: <Icon name={pages[key].icon} size={20} />,
    flex: true,
  });
  return (
    <>
      <div className="px-3 text-theme-text-secondary">
        <p className="truncate text-sm font-medium text-theme-text-primary">
          {session.identity === "platform"
            ? t("enterprise:navigation.platform")
            : session.tenant?.name}
        </p>
        <p className="mt-1 break-all text-xs">
          {hostname || window.location.hostname}
        </p>
      </div>
      {allowed
        .filter((key) => ["chat", "knowledge"].includes(key))
        .map((key) => (
          <MenuOption key={key} {...option(key)} onNavigate={navigate} />
        ))}
      {chat && (
        <div>
          <button
            type="button"
            onClick={chat.onNew}
            disabled={chat.streaming}
            className="flex items-center gap-x-2 px-3 h-[32px] text-sm text-theme-text-primary hover:bg-theme-sidebar-subitem-hover rounded-[6px]"
          >
            <Icon name="plus" size={18} />
            发起新对话
          </button>
          <div role="list" aria-label={t("enterprise:chat.history")}>
            {chat.conversations?.map((item, index) => (
              <ThreadItem
                key={item.id}
                idx={index}
                activeIdx={chat.conversations.findIndex(
                  (entry) => entry.id === chat.activeId
                )}
                hasNext={index < chat.conversations.length - 1}
                thread={{
                  ...item,
                  slug: String(item.id),
                  name: item.title || "新对话",
                }}
                isActive={String(chat.activeId) === String(item.id)}
                disabled={chat.streaming || chat.loading}
                href="/chat"
                onSelect={() => {
                  chat.onSelect(item);
                  close?.();
                }}
                onDelete={() => chat.onRemove(item)}
                onRename={
                  chat.onRename
                    ? (_thread, name) => chat.onRename(item, name)
                    : undefined
                }
              />
            ))}
          </div>
        </div>
      )}
      {!!management.length && (
        <MenuOption
          btnText={t("enterprise:navigation.management")}
          icon={<Icon name="settings" />}
          href="#management"
          flex
          childOptions={management.map(option)}
          onNavigate={navigate}
        />
      )}
    </>
  );
}

export function TenantFooter({ session, onLogout, navigate, onAccount }) {
  const { t } = useTranslation();
  const { pfp } = useContext(PfpContext) || {};
  return (
    <>
      <Footer onNavigate={navigate} showSettings />
      <div className="flex items-center gap-2 px-2">
        <button
          type="button"
          onClick={onAccount}
          disabled={session.identity === "platform"}
          aria-label={t("profile_settings.edit_account")}
          className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-theme-sidebar-item-default text-sm"
        >
          {pfp ? (
            <img
              src={pfp}
              alt={t("profile_settings.profile_picture")}
              className="h-full w-full object-cover"
            />
          ) : (
            (session.user?.name || session.user?.username || "U").slice(0, 1)
          )}
        </button>
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-xs font-medium">
            {session.user?.name || session.user?.username}
          </strong>
          <span className="text-xs text-theme-text-secondary">
            {t(
              `enterprise:navigation.${session.identity === "platform" ? "platformAdmin" : session.role === "admin" ? "admin" : "member"}`
            )}
          </span>
        </div>
        <button
          type="button"
          className="rounded-lg p-2 text-theme-text-secondary hover:bg-theme-sidebar-item-hover"
          onClick={onLogout}
          aria-label={t("enterprise:navigation.logout")}
        >
          <Icon name="logout" size={18} />
        </button>
      </div>
    </>
  );
}
