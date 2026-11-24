import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { Camera } from "@forge3d/web";
import { WEB_REVISION } from "../vp01/fixture.mjs";
import { until } from "../viewport-desktop.mjs";

const examplePath = "/examples/vector-picking.html";
export function pinnedExampleServer(root) {
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding:"utf8" }).trim();
  const common = resolve(root, git(root, "rev-parse", "--git-common-dir"));
  const web = process.env.FORGE3D_WEB_REPO ?? resolve(dirname(common), "../forge3d-web");
  const example = git(web, "show", WEB_REVISION + ":crates/forge3d-web/examples/vector-picking.html");
  // Serve the upstream page in its own document. Resolve its source entry
  // to the installed browser entry, so both controls use the verified pin.
  return {name:"vp06-vector-example", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === examplePath) {
        res.setHeader("Content-Type", "text/html");
        res.end(example);
      } else if (req.url === "/src-ts/index.ts") {
        res.setHeader("Content-Type", "text/javascript");
        res.end('export * from "/forge3d-web/index.js"');
      } else next();
    });
  }};
}

export async function vectorExample(cdp) {
  await cdp.send("Page.navigate", { url: new URL(examplePath, cdp.page.url).href });
  await until(cdp, "!!window.__picking");
  const click = async ([x, y]) => {
    const client = await cdp.evaluate(`(() => {const c=document.querySelector('canvas'), r=c.getBoundingClientRect();
      return [r.x+(${x}+.5)*r.width/c.width,r.y+(${y}+.5)*r.height/c.height]})()`);
    await cdp.click(client);
  };
  await click([2, 2]);
  await until(cdp, 'document.querySelector("pre").textContent === "No feature at this pixel"');
  const background = await cdp.evaluate("__picking.picker.point(2,2)");
  assert.equal(background, null);
  const camera = new Camera({ position:[0,6,4], target:[0,0,-.5], up:[0,1,0], fovYDegrees:45, near:.1, far:30 });
  const size = await cdp.evaluate("({width:__picking.runtime.width,height:__picking.runtime.height})");
  const expected = camera.worldToScreen([-1, .2, 0], size);
  const pixel = [Math.floor(expected.x), Math.floor(expected.y)];
  await click(pixel);
  await until(cdp, 'document.querySelector("pre").textContent.startsWith("{")');
  const hit = await cdp.evaluate('JSON.parse(document.querySelector("pre").textContent)');
  assert.deepEqual([hit.id, hit.layerId, hit.layerName, hit.kind, hit.properties, hit.pixel],
    [1, 1, "symbols", "point", { name: "Circle" }, pixel]);
  assert.ok(Math.abs(hit.depth - expected.depth) < 1e-4, JSON.stringify(hit));
  assert.ok(hit.worldPosition.length === 3 && hit.worldPosition.every((v,i) => Math.abs(v - [-1,.2,0][i]) < 1e-6), JSON.stringify(hit));
  await cdp.evaluate('document.querySelector("#lasso").click()');
  await until(cdp, 'document.querySelector("pre").textContent.startsWith("[")');
  const lasso = await cdp.evaluate('JSON.parse(document.querySelector("pre").textContent)');
  assert.deepEqual(lasso.map(h => [h.id,h.kind]), [[1,"point"],[2,"point"],[3,"polygon"]]);
  return { background, hit, lasso };
}
