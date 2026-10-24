import { useContext, useState } from "react";
import { LogoContext } from "@/LogoContext";
import { api, saveSession, sessionMatchesSite } from "@/models/platform";
import { Button, Field, Notice } from "@/components/lib/PlatformUI";
import { useThemeContext } from "@/ThemeContext";
import LightLogo from "@/media/illustrations/login-logo-light.svg";
import DarkLogo from "@/media/illustrations/login-logo.svg";
import { Navigate } from "react-router-dom";
import useSimpleSSO from "@/hooks/useSimpleSSO";
import { FullScreenLoader } from "@/components/Preloader";
import paths from "@/utils/paths";
import BaseModal from "@/components/lib/Modal";
import RecoveryCodeModal from "@/components/Modals/DisplayRecoveryCodeModal";
import {
  RecoveryForm,
  ResetPasswordForm,
} from "@/components/Modals/Password/MultiUserAuth";
import {
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_PATTERN,
} from "@/utils/username";

export default function Login({
  initialized,
  site,
  onSession,
  onRetry,
  initialError,
}) {
  const { loading: ssoLoading, ssoConfig } = useSimpleSSO();
  const { isLight } = useThemeContext();
  const branding = useContext(LogoContext);
  const [form, setForm] = useState({
    username: "",
    password: "",
    name: "",
  });
  const [error, setError] = useState(initialError || "");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("login");
  const [pendingSession, setPendingSession] = useState(null);
  const [resetToken, setResetToken] = useState(null);
  const platform = site?.kind === "platform";
  const knownSite = platform || site?.kind === "tenant";
  const registering = mode === "register" && !platform;
  const change = (key) => (event) =>
    setForm({ ...form, [key]: event.target.value });
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const path = registering
        ? "/register"
        : platform
          ? "/platform/login"
          : "/login";
      const body = { username: form.username.trim(), password: form.password };
      if (registering) body.name = form.name.trim();
      const session = await api(path, {
        method: "POST",
        body,
      });
      if (!sessionMatchesSite(session, site))
        throw new Error("登录身份与当前访问域名不匹配。");
      if (session.recoveryCodes?.length) setPendingSession(session);
      else finishLogin(session);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  function finishLogin(value) {
    const { recoveryCodes: _codes, ...session } = value;
    saveSession(session);
    onSession(session);
  }
  async function recover(username, recoveryCodes) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api("/recover-account", {
        method: "POST",
        body: { username, recoveryCodes },
      });
      setResetToken(result.resetToken);
      setMode("reset");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function reset(newPassword, confirmPassword) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/reset-password", {
        method: "POST",
        body: { token: resetToken, newPassword, confirmPassword },
      });
      setResetToken(null);
      setForm({ ...form, password: "" });
      setMode("login");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  if (site?.kind === "tenant" && ssoLoading) return <FullScreenLoader />;
  if (site?.kind === "tenant" && ssoConfig.enabled && ssoConfig.noLogin) {
    if (
      ssoConfig.noLoginRedirect &&
      !new URLSearchParams(window.location.search).has("token")
    ) {
      window.location.replace(ssoConfig.noLoginRedirect);
      return null;
    }
    return <Navigate to={paths.sso.login() + window.location.search} replace />;
  }
  return (
    <div className="fixed inset-0 bg-zinc-950 light:bg-slate-50 flex flex-col items-center justify-center overflow-auto px-4 py-8 text-theme-text-primary">
      <div className="flex w-full max-w-[396px] flex-col items-center">
        <img
          src={branding?.loginLogo || (isLight ? LightLogo : DarkLogo)}
          alt="AnythingLLM"
          className="max-h-[80px] max-w-full object-contain"
        />
        <h1 className="max-w-[300px] pt-7 text-center text-3xl leading-[38px] font-medium">
          {!knownSite && initialized !== null
            ? "访问入口未绑定"
            : registering
              ? `${site?.tenant?.name || "企业"}注册`
              : platform
                ? "平台管理登录"
                : `${site?.tenant?.name || "企业"}登录`}
        </h1>
        <p className="max-w-[300px] pb-9 mt-[18px] text-center text-sm leading-relaxed text-zinc-400 light:text-zinc-600">
          {!knownSite && initialized !== null
            ? "当前域名未绑定到企业，请使用管理员提供的企业访问地址。"
            : registering
              ? "注册后即可使用当前企业的普通用户账号。"
              : platform
                ? "使用顶级管理员账号管理企业租户及平台配置。"
                : "使用企业账号登录，访问本企业的知识管理和问答。"}
        </p>
        {initialized === null ? (
          <>
            <Notice>{initialError || "暂时无法连接服务"}</Notice>
            <Button onClick={onRetry} icon="refresh">
              重新连接
            </Button>
          </>
        ) : !knownSite ? (
          <p className="break-all text-sm text-theme-text-secondary">
            {site?.hostname || window.location.hostname}
          </p>
        ) : initialized === false ? (
          <Notice>数据库尚未完成初始化，请联系管理员执行数据库初始化。</Notice>
        ) : !platform && ["recover", "reset"].includes(mode) ? (
          <div className="w-full">
            <Notice>{error}</Notice>
            <fieldset disabled={busy}>
              {mode === "recover" ? (
                <RecoveryForm
                  onSubmit={recover}
                  setShowRecoveryForm={() => setMode("login")}
                />
              ) : (
                <ResetPasswordForm onSubmit={reset} />
              )}
            </fieldset>
          </div>
        ) : (
          <form onSubmit={submit} className="w-full max-w-[300px]">
            <Notice onClose={() => setError("")}>{error}</Notice>
            {registering && (
              <Field label="姓名">
                <input
                  required
                  maxLength={80}
                  placeholder="请输入显示名称"
                  value={form.name}
                  onChange={change("name")}
                  autoComplete="name"
                />
              </Field>
            )}
            <Field
              label={platform ? "平台账号" : "企业账号"}
              hint={
                registering
                  ? "2—64 位，以小写字母开头，可包含数字或 _ . @ -"
                  : undefined
              }
            >
              <input
                required
                minLength={registering ? USERNAME_MIN_LENGTH : undefined}
                maxLength={USERNAME_MAX_LENGTH}
                pattern={registering ? USERNAME_PATTERN : undefined}
                placeholder="请输入账号"
                value={form.username}
                onChange={change("username")}
                autoComplete="username"
              />
            </Field>
            <Field
              label="密码"
              hint={registering ? "请设置符合企业密码规则的密码。" : undefined}
            >
              <input
                type="password"
                required
                placeholder={registering ? "设置密码" : "请输入密码"}
                value={form.password}
                onChange={change("password")}
                autoComplete={registering ? "new-password" : "current-password"}
              />
            </Field>
            <Button type="submit" busy={busy} className="mt-2 w-full">
              {registering ? "注册" : "登录"}
            </Button>
            {!platform && (
              <div className="mt-4 flex justify-between text-sm text-theme-text-secondary">
                <button
                  type="button"
                  onClick={() => {
                    setMode(registering ? "login" : "register");
                    setError("");
                  }}
                >
                  {registering ? "返回登录" : "注册账号"}
                </button>
                {!registering && (
                  <button
                    type="button"
                    onClick={() => {
                      setMode("recover");
                      setError("");
                    }}
                  >
                    找回密码
                  </button>
                )}
              </div>
            )}
          </form>
        )}
        <p className="max-w-[300px] mt-6 text-center text-xs leading-relaxed text-theme-text-secondary">
          {!knownSite
            ? "请向企业管理员确认正确的访问域名。"
            : platform
              ? "初始顶级管理员由数据库初始化创建。"
              : "账号固定属于当前企业，知识访问由知识库授权决定。"}
        </p>
        {pendingSession && (
          <BaseModal isOpen size="lg" closeOnEsc={false}>
            <RecoveryCodeModal
              recoveryCodes={pendingSession.recoveryCodes}
              onDownloadComplete={() => {}}
              onClose={() => {
                finishLogin(pendingSession);
                setPendingSession(null);
              }}
            />
          </BaseModal>
        )}
      </div>
    </div>
  );
}
