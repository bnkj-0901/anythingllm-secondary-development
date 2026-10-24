import { savedSession, TOKEN_KEY } from "@/models/platform";

// Sets up the base headers for all authenticated requests so that we are able to prevent
// basic spoofing since a valid token is required and that cannot be spoofed
export function userFromStorage() {
  const session = savedSession();
  return session?.user
    ? { ...session.user, role: session.role, identity: session.identity }
    : null;
}

export function baseHeaders(providedToken = null) {
  const token =
    providedToken ||
    (savedSession() ? window.localStorage.getItem(TOKEN_KEY) : null);
  return {
    Authorization: token ? `Bearer ${token}` : null,
    "X-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
    "X-Language": navigator.language || "en",
  };
}

export function safeJsonParse(jsonString, fallback = null) {
  try {
    if (jsonString === null || jsonString === undefined) return fallback;
    return JSON.parse(jsonString);
  } catch {}
  return fallback;
}
