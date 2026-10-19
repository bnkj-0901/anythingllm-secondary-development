// Clear stale upstream auth before React's AuthProvider mounts on the SSO page.
for (const key of ["anythingllm_authToken", "anythingllm_user", "anythingllm_authTimestamp"]) localStorage.removeItem(key);
