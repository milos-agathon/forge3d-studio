import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { observeContexts, observeStartup, verifyRuntimeAssets } from "./startup.mjs";

for (const role of ["candidate", "webgl-blocked"]) {
  test("startup context requests for " + role, () => {
    class GPUCanvasContext {}
    class CanvasRenderingContext2D {}
    class WebGL2RenderingContext {}
    const getContext = name => {
      if (name === "webgpu") return new GPUCanvasContext();
      if (name === "2d") return new CanvasRenderingContext2D();
      return new WebGL2RenderingContext();
    };
    const scope = {
      HTMLCanvasElement: class HTMLCanvasElement { getContext = null; },
      OffscreenCanvas: class OffscreenCanvas {},
      document: {},
      localStorage: { setItem() {} },
      MutationObserver: class { observe() {} },
      performance,
    };
    scope.window = scope;
    scope.top = scope;
    const blocked = role === "webgl-blocked";
    for (const Canvas of [scope.HTMLCanvasElement, scope.OffscreenCanvas]) Canvas.prototype.getContext = getContext;
    runInNewContext("(" + observeStartup.toString() + ")({ role: " + JSON.stringify(role) +
      ', runId: "test" }, ' + observeContexts.toString() + ");", scope);
    for (const Canvas of [scope.HTMLCanvasElement, scope.OffscreenCanvas]) {
      const canvas = new Canvas();
      // Use the prototype methods that would be native on actual browser canvases.
      for (const name of ["webgl", "webgl2", "experimental-webgl"]) {
        assert.equal(Canvas.prototype.getContext.call(canvas, name)?.constructor.name,
          blocked ? undefined : "WebGL2RenderingContext");
      }
      assert.ok(Canvas.prototype.getContext.call(canvas, "webgpu") instanceof GPUCanvasContext);
      assert.ok(Canvas.prototype.getContext.call(canvas, "2d") instanceof CanvasRenderingContext2D);
    }
    const { contexts } = scope.__vp01Startup;
    assert.equal(contexts.length, 10);
    assert.equal(contexts.filter(request => request.denied && request.stack).length, blocked ? 6 : 0);
  });
}

test("runtime verification rejects a modified transitive WASM loader", async () => {
  const dist = new URL("../../node_modules/@forge3d/web/dist/", import.meta.url);
  await assert.rejects(verifyRuntimeAssets("http://localhost:1423", url => {
    const file = url.pathname.slice("/forge3d-web/".length);
    if (file === "wasm-realm.js") return Buffer.from("altered loader");
    return readFile(new URL(file, dist));
  }), { code: "SERVED_RUNTIME_MISMATCH", message: /wasm-realm\.js/ });
});
