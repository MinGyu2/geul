import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("lang");
  window.localStorage.clear(); // 테스트 사이에 저장된 설정이 새지 않게 한다
});
