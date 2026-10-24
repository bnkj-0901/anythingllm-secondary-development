import { useEffect, useState } from "react";
import Appearance from "@/models/appearance";

export default function useAppearance() {
  const [settings, setSettings] = useState(Appearance.getSettings);
  useEffect(() => {
    const refresh = () => setSettings(Appearance.getSettings());
    window.addEventListener("appearanceChange", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("appearanceChange", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return settings;
}
