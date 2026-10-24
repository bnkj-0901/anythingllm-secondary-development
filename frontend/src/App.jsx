import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorBoundary } from "react-error-boundary";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { AuthContext } from "@/AuthContext";
import { LogoProvider } from "@/LogoContext";
import { PfpContext, PfpProvider } from "@/PfpContext";
import { PWAModeProvider } from "@/PWAContext";
import ErrorBoundaryFallback from "@/components/ErrorBoundaryFallback";
import {
  api,
  clearSession,
  saveSession,
  savedSession,
  sessionMatchesSite,
  TOKEN_KEY,
} from "@/models/platform";
import { FullScreenLoader } from "@/components/Preloader";
import Sidebar from "@/components/Sidebar";
import Login from "@/pages/Login";
import { Icon } from "@/components/lib/PlatformUI";
import ActiveGenerationGuard from "@/components/WorkspaceChat/ChatContainer/ActiveGenerationGuard";
import ImageLightbox from "@/components/ImageLightbox";
import KeyboardShortcutsHelp from "@/components/KeyboardShortcutsHelp";
import AccountModal from "@/components/UserMenu/AccountModal";

const Chat = lazy(() => import("@/pages/Chat"));
const Knowledge = lazy(() => import("@/pages/Knowledge"));
const Tenants = lazy(() =>
  import("@/pages/Management").then((module) => ({ default: module.Tenants }))
);
const Users = lazy(() =>
  import("@/pages/Management").then((module) => ({ default: module.Users }))
);

const pages = {
  chat: { label: "问答检索", icon: "chat" },
  knowledge: {
    label: "知识管理",
    icon: "books",
    description: "管理获授权知识库中的资料，文件与文字使用相同的权限规则。",
  },
  users: {
    label: "用户与角色",
    icon: "users",
    description: "管理当前租户的用户、角色和使用状态。",
  },
  connections: {
    label: "AI 连接配置",
    icon: "settings",
    description: "配置对话模型、Embedding 模型及平台和租户默认连接。",
  },
  tenants: {
    label: "租户管理",
    icon: "building",
    description: "管理独立组织及其使用状态。",
  },
};

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <ErrorBoundary FallbackComponent={ErrorBoundaryFallback}>
      <PWAModeProvider>
        <LogoProvider>
          <ImageLightbox />
          <KeyboardShortcutsHelp />
          <Application location={location} routeNavigate={navigate} />
          <ToastContainer />
        </LogoProvider>
      </PWAModeProvider>
    </ErrorBoundary>
  );
}

function SessionProviders({ session, children }) {
  return (
    <AuthContext.Provider
      value={{
        session,
        store: {
          user: {
            ...session.user,
            role: session.role,
            identity: session.identity,
          },
          authToken: session.token,
        },
      }}
    >
      {session.identity === "tenant" ? (
        <PfpProvider>{children}</PfpProvider>
      ) : (
        <PfpContext.Provider value={{ pfp: null }}>
          {children}
        </PfpContext.Provider>
      )}
    </AuthContext.Provider>
  );
}

function Application({ location, routeNavigate }) {
  const { pathname } = location;
  const { t } = useTranslation();
  const [session, setSession] = useState(null);
  const [initialized, setInitialized] = useState(null);
  const [site, setSite] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatNavigation, setChatNavigation] = useState(null);
  const [accountOpen, setAccountOpen] = useState(false);
  async function boot() {
    setLoading(true);
    setError("");
    try {
      const status = await api("/status");
      setInitialized(status.initialized);
      setSite(status.site);
      setSession(null);
      if (
        status.initialized &&
        pathname !== "/login" &&
        localStorage.getItem(TOKEN_KEY)
      ) {
        const cached = savedSession();
        if (!sessionMatchesSite(cached, status.site)) {
          clearSession();
          return;
        }
        const identity = status.site.kind;
        const restored = {
          ...(await api(identity === "platform" ? "/platform/me" : "/me")),
          token: localStorage.getItem(TOKEN_KEY),
        };
        if (!sessionMatchesSite(restored, status.site)) {
          clearSession();
          setError("登录身份与当前访问域名不匹配，请重新登录。");
          return;
        }
        saveSession(restored);
        setSession(restored);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    boot();
    const unauthorized = () => {
      setSession(null);
      setError("登录已失效，请重新登录。");
    };
    window.addEventListener("enterprise:unauthorized", unauthorized);
    return () => {
      window.removeEventListener("enterprise:unauthorized", unauthorized);
    };
  }, []);
  useEffect(() => {
    const legacy = location.hash.slice(1);
    if (pathname === "/" && Object.hasOwn(pages, legacy))
      routeNavigate(
        { pathname: `/${legacy}`, search: location.search },
        { replace: true }
      );
  }, [pathname, location.hash, location.search, routeNavigate]);
  useEffect(() => {
    if (pathname === "/login") {
      clearSession();
      setSession(null);
    }
  }, [pathname]);
  if (loading) return <FullScreenLoader />;
  if (pathname === "/sso/simple") return <Outlet />;
  if (!session)
    return (
      <Login
        initialized={initialized}
        site={site}
        initialError={error}
        onRetry={boot}
        onSession={(value) => {
          setInitialized(true);
          setError("");
          setSession(value);
          routeNavigate("/", { replace: true });
        }}
      />
    );
  const platform = session.identity === "platform";
  const allowed = platform
    ? ["tenants", "knowledge", "connections"]
    : ["chat", "knowledge", ...(session.role === "admin" ? ["users"] : [])];
  const page = pathname.slice(1);
  const active = allowed.includes(page) ? page : allowed[0];
  const navigation = Object.fromEntries(
    Object.entries(pages).map(([key, value]) => [
      key,
      {
        ...value,
        label: t(`enterprise:pages.${key}`),
        description: value.description
          ? t(`enterprise:pages.${key}Description`, {
              defaultValue: value.description,
            })
          : undefined,
      },
    ])
  );
  navigation.connections = {
    ...navigation.connections,
    label: t(
      `enterprise:pages.${platform ? "platformConnections" : "connections"}`
    ),
    description: t(
      `enterprise:pages.${platform ? "platformConnections" : "connections"}Description`
    ),
  };
  const current = navigation[active];
  const navigate = (key) => {
    routeNavigate(key.startsWith("/") ? key : `/${key}`);
    setMenuOpen(false);
  };
  const logout = () => routeNavigate("/login");
  const updateAccount = async (data) => {
    try {
      const result = await api("/me", {
        method: "PATCH",
        body: Object.fromEntries(
          ["username", "bio", "password"]
            .filter((key) => data[key] !== undefined)
            .map((key) => [key, data[key]])
        ),
      });
      saveSession(result);
      setSession(result);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  };
  if (pathname === "/settings" || pathname.startsWith("/settings/"))
    return (
      <SessionProviders session={session}>
        <Outlet context={session} />
      </SessionProviders>
    );
  if (pathname !== "/" && pathname !== "/login" && !Object.hasOwn(pages, page))
    return (
      <SessionProviders session={session}>
        <Outlet context={session} />
      </SessionProviders>
    );
  if (active === "connections")
    return (
      <SessionProviders session={session}>
        <Navigate to="/settings/llm-preference" replace />
      </SessionProviders>
    );
  return (
    <SessionProviders session={session}>
      <div className="flex h-screen supports-[height:100dvh]:h-[100dvh] w-screen overflow-hidden bg-theme-bg-container text-theme-text-primary">
        <ActiveGenerationGuard isGenerating={chatNavigation?.streaming} />
        <Sidebar
          session={session}
          hostname={site?.hostname}
          pages={navigation}
          allowed={allowed}
          active={active}
          navigate={navigate}
          open={menuOpen}
          close={() => setMenuOpen(false)}
          onLogout={logout}
          onAccount={() => setAccountOpen(true)}
          chat={active === "chat" ? chatNavigation : null}
        />
        {accountOpen && !platform && (
          <AccountModal
            user={session.user}
            onUpdate={updateAccount}
            hideModal={() => setAccountOpen(false)}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-theme-sidebar-border bg-theme-bg-primary px-4 md:hidden">
            <button
              className="rounded-md p-2 text-theme-text-secondary"
              onClick={() => setMenuOpen(true)}
              aria-label="展开菜单"
            >
              <Icon name="menu" />
            </button>
            <strong className="text-sm font-medium">{current.label}</strong>
            <span className="w-9" />
          </header>
          <main
            className={`min-h-0 min-w-0 flex-1 ${active === "chat" ? "flex overflow-hidden" : "overflow-y-auto px-4 py-6 md:px-8 md:py-8"}`}
          >
            {active !== "chat" && (
              <div className="mb-8 border-b border-theme-sidebar-border pb-6">
                <h1 className="text-xl font-semibold text-theme-text-primary">
                  {current.label}
                </h1>
                <p className="mt-2 text-sm text-theme-text-secondary">
                  {current.description}
                </p>
              </div>
            )}
            <Suspense fallback={<FullScreenLoader />}>
              {active === "chat" && (
                <Chat session={session} onNavigation={setChatNavigation} />
              )}
              {active === "knowledge" && <Knowledge session={session} />}
              {active === "users" && <Users session={session} />}
              {active === "tenants" && <Tenants session={session} />}
            </Suspense>
          </main>
        </div>
      </div>
    </SessionProviders>
  );
}
