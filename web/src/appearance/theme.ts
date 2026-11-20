import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const key = "df-billboard:theme";
const listeners = new Set<() => void>();
let current: Theme = "dark";

function apply(theme: Theme) {
  current = theme;
  document.documentElement.dataset.theme = theme;
  listeners.forEach((listener) => listener());
}

export function initializeTheme() {
  current =
    document.documentElement.dataset.theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = current;
  window.addEventListener("storage", (event) => {
    if (event.key === key) apply(event.newValue === "light" ? "light" : "dark");
  });
}

export function useTheme() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => "dark" as Theme
  );
}

export function toggleTheme() {
  const next = current === "dark" ? "light" : "dark";
  apply(next);
  try {
    localStorage.setItem(key, next);
  } catch {
    // The chosen theme still works for this visit.
  }
}
