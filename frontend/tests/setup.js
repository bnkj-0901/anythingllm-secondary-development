import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import i18n from "../src/i18n";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  document.body.innerHTML = '<div id="root"></div>';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.scrollTo = vi.fn();
