import test from "node:test";
import assert from "node:assert/strict";

import { clearAssetCaches, loadAssetScene, putAssetBytes } from "./assets.ts";

test("raw asset bytes are evicted by byte budget before a viewport consumes them", async () => {
  const budget = 128 * 1024 * 1024;
  // A plain byteLength stand-in avoids allocating 128 MiB in the test runner.
  putAssetBytes("too-large", { byteLength: budget + 1 });

  let readCalled = false;
  await assert.rejects(
    loadAssetScene("too-large", async () => {
      readCalled = true;
      throw new Error("cache miss");
    }),
    /cache miss/,
  );
  assert.equal(readCalled, true, "an over-budget buffer must be evicted immediately");
  clearAssetCaches();
});
