import assert from "node:assert/strict";
import test from "node:test";

import { AsciiCloudsRenderer } from "../../../web/src/appearance/clouds-renderer.ts";

class RecordingContext {
  fillStyle = "";
  font = "";
  textBaseline = "";
  texts = [];

  setTransform() {}
  clearRect() {}
  fillText(text, x, y) {
    this.texts.push({ text, x, y, style: this.fillStyle });
  }
}

function renderer(theme = "dark") {
  const canvas = { width: 0, height: 0 };
  const context = new RecordingContext();
  const clouds = new AsciiCloudsRenderer(canvas, context, theme);
  clouds.resize(320, 220, 1);
  return { canvas, context, clouds };
}

test("the shared clouds renderer is deterministic with precomputed geometry", () => {
  const first = renderer();
  const second = renderer();
  first.clouds.draw(3.25);
  second.clouds.draw(3.25);
  assert.ok(first.context.texts.length > 0);
  assert.deepEqual(first.context.texts, second.context.texts);
  assert.equal(first.canvas.width, 320);
  assert.equal(first.canvas.height, 220);
});

test("theme and panel updates preserve the existing visual boundary", () => {
  const { context, clouds } = renderer();
  clouds.draw(1);
  const fullCount = context.texts.length;
  assert.ok(context.texts.some(({ style }) => style.startsWith("rgba(")));
  context.texts.length = 0;
  clouds.setPanel({ left: 0, top: 0, right: 400, bottom: 300 });
  clouds.draw(1);
  assert.equal(context.texts.length, 0);
  context.texts.length = 0;
  clouds.setPanel({ left: 120, top: 60, right: 220, bottom: 160 });
  clouds.draw(1);
  assert.ok(context.texts.length > 0);
  assert.ok(context.texts.length < fullCount);
});

test("pointer influence is applied without changing the static algorithm", () => {
  const { context, clouds } = renderer();
  clouds.draw(2);
  const before = context.texts.map(({ text }) => text);
  context.texts.length = 0;
  clouds.setPointer(160, 110);
  clouds.draw(2);
  const after = context.texts.map(({ text }) => text);
  assert.equal(after.length, before.length);
  assert.notDeepEqual(after, before);
  assert.ok(after.some((text, index) => text !== before[index]));
});
