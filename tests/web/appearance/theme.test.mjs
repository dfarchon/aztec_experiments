import assert from "node:assert/strict";
import test from "node:test";

import {
  initializeTheme,
  toggleTheme,
} from "../../../web/src/appearance/theme.ts";

test("theme initializes from the prepaint choice and persists changes", () => {
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
  };
  const saved = new Map();
  const handlers = new Map();
  globalThis.document = { documentElement: { dataset: { theme: "light" } } };
  globalThis.window = {
    addEventListener: (type, callback) => handlers.set(type, callback),
  };
  globalThis.localStorage = {
    setItem: (key, value) => saved.set(key, value),
  };
  try {
    initializeTheme();
    assert.equal(document.documentElement.dataset.theme, "light");
    toggleTheme();
    assert.equal(document.documentElement.dataset.theme, "dark");
    assert.equal(saved.get("df-billboard:theme"), "dark");
    handlers.get("storage")({ key: "df-billboard:theme", newValue: "light" });
    assert.equal(document.documentElement.dataset.theme, "light");
  } finally {
    Object.assign(globalThis, previous);
  }
});
