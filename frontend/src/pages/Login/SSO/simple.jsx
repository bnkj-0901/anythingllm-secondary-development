import React, { useEffect, useState } from "react";
import { FullScreenLoader } from "@/components/Preloader";
import paths from "@/utils/paths";
import useQuery from "@/hooks/useQuery";
import System from "@/models/system";
import { clearSession, saveSession } from "@/models/platform";

export default function SimpleSSOPassthrough() {
  const query = useQuery();
  const requestedRedirect = query.get("redirectTo");
  const redirectPath =
    requestedRedirect?.startsWith("/") && !requestedRedirect.startsWith("//")
      ? requestedRedirect
      : paths.home();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    try {
      if (!query.get("token")) throw new Error("No token provided.");

      clearSession();

      System.simpleSSOLogin(query.get("token"))
        .then((res) => {
          if (!res.valid) throw new Error(res.message);

          saveSession(res.session);
          setReady(res.valid);
        })
        .catch((e) => {
          setError(e.message);
        });
    } catch (e) {
      setError(e.message);
    }
  }, []);

  if (error)
    return (
      <div className="w-screen h-screen overflow-hidden bg-theme-bg-primary flex items-center justify-center flex-col gap-4">
        <p className="text-theme-text-primary font-mono text-lg">{error}</p>
        <p className="text-theme-text-secondary font-mono text-sm">
          Please contact the system administrator about this error.
        </p>
      </div>
    );
  if (ready) return window.location.replace(redirectPath);

  // Loading state by default
  return <FullScreenLoader />;
}
