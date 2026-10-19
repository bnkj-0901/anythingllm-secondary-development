export async function api(path, { method = "GET", body, token } = {}) {
  const response = await fetch(`/api/access${path}`, { method, credentials: "same-origin", headers: { ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error?.message || "请求未完成，请稍后重试。"), { status: response.status });
  return data;
}
export function message(id, text, error = false) {
  const node = document.getElementById(id);
  node.textContent = text;
  node.classList.toggle("error", error);
}
export async function currentUser() {
  const existing = localStorage.getItem("anythingllm_authToken");
  if (existing) {
    try { return (await api("/session", { method: "POST", token: existing })).user; }
    catch (error) { if (error.status !== 401) throw error; }
  }
  return (await api("/me")).user;
}
export async function logout() {
  await api("/logout", { method: "POST" });
  for (const key of ["anythingllm_authToken", "anythingllm_user", "anythingllm_authTimestamp"]) localStorage.removeItem(key);
  location.assign("/h5");
}
export function element(tag, text, className) {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;
}
export function button(text, handler, className) {
  const node = element("button", text, className); node.type = "button";
  node.addEventListener("click", () => Promise.resolve(handler()).catch(error => message("page-message", error.message, true)));
  return node;
}
