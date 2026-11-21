import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";

const roots: Root[] = [];
export function render(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>));
  return container;
}

export async function settle() {
  for (let index = 0; index < 5; index++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

export function button(root: ParentNode, name: string) {
  const result = Array.from(root.querySelectorAll("button")).find(
    (item) => item.textContent?.replace(/\s+/gu, "") === name.replace(/\s+/gu, ""),
  );
  if (!result) throw new Error(`未找到按钮：${name}`);
  return result;
}

export function field<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
  root: ParentNode,
  name: string,
) {
  const result = Array.from(root.querySelectorAll("label"))
    .find((item) => item.textContent?.startsWith(name))
    ?.querySelector<T>("input, textarea, select");
  if (!result) throw new Error(`未找到字段：${name}`);
  return result;
}

export function enter(input: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function select(input: HTMLSelectElement, value: string) {
  act(() => {
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => computedStyle(element));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addListener() {}, removeListener() {} })),
  );
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
