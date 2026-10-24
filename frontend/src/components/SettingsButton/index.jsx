import paths from "@/utils/paths";
import { ArrowUUpLeft, Wrench } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { useMatch } from "react-router-dom";

export default function SettingsButton({ onNavigate } = {}) {
  const isInSettings = !!useMatch("/settings/*");
  const handleNavigate = (event, href) => {
    if (
      !onNavigate ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey
    )
      return;
    event.preventDefault();
    onNavigate(href);
  };

  if (isInSettings)
    return (
      <div className="flex w-fit">
        <Link
          to={paths.home()}
          onClick={(event) => handleNavigate(event, paths.home())}
          className="transition-all duration-300 p-2 rounded-full bg-theme-sidebar-footer-icon hover:bg-theme-sidebar-footer-icon-hover"
          aria-label="Home"
          data-tooltip-id="footer-item"
          data-tooltip-content="Back to home"
        >
          <ArrowUUpLeft
            className="h-5 w-5 text-white light:text-slate-800"
            weight="fill"
          />
        </Link>
      </div>
    );

  return (
    <div className="flex w-fit">
      <Link
        to={paths.settings.interface()}
        onClick={(event) => handleNavigate(event, paths.settings.interface())}
        className="transition-all duration-300 p-2 rounded-full bg-theme-sidebar-footer-icon hover:bg-theme-sidebar-footer-icon-hover"
        aria-label="Settings"
        data-tooltip-id="footer-item"
        data-tooltip-content="Open settings"
      >
        <Wrench
          className="h-5 w-5 text-white light:text-slate-800"
          weight="fill"
        />
      </Link>
    </div>
  );
}
