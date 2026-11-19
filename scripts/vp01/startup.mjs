import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { failure } from "./cdp.mjs";
import { CANDIDATE_REVISION, FIELD_REVISION, runtimeArchivePath } from "./fixture.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const viewportSource = "/src/viewport/Viewport3D.tsx";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
// These published commits contain the viewport sources used in the original captures.
const publishedRevisions = new Map([
  [FIELD_REVISION, "9bad11c0cffca185e92f3f1120a65e1c47187216"],
  [CANDIDATE_REVISION, "55b6d785ee6ec41f2c3e343639c99eba8ae4420c"],
]);

async function download(url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw Error(`HTTP ${response.status} from ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function verifyStudioSource(origin, revision, role) {
  let sourceRevision = revision;
  if (publishedRevisions.has(revision)) {
    try {
      await exec("git", ["cat-file", "-e", `${revision}^{commit}`], { cwd: root });
    } catch {
      sourceRevision = publishedRevisions.get(revision);
    }
  }
  const paths = [viewportSource, "/src/App.tsx", "/src/styles.css"];
  if (role !== "field") paths.push("/src/viewport/forge3dWebViewport.ts", "/src/viewport/forge3dWebMapping.ts");
  const entries = await Promise.all(paths.map(async path => {
    const { stdout } = await exec("git", ["show", `${sourceRevision}:${path.slice(1)}`], { cwd: root });
    const expected = stdout.replaceAll("\r\n", "\n");
    const css = path.endsWith(".css");
    const served = (await download(new URL(css ? `${path}?direct` : path, origin))).toString();
    const map = served.match(/sourceMappingURL=data:application\/json[^,]*;base64,([A-Za-z0-9+/=]+)/);
    const sources = css ? [served] : map && JSON.parse(Buffer.from(map[1], "base64").toString()).sourcesContent;
    if (!sources?.some(source => source?.replaceAll("\r\n", "\n") === expected)) {
      throw failure("STUDIO_SOURCE_MISMATCH", `${path} at ${origin} differs from Studio ${sourceRevision}`);
    }
    return [path, hash(expected)];
  }));
  const runtime = role === "field" ? {} : await verifyRuntimeAssets(origin);
  return { sourceRevision, modules: Object.fromEntries(entries), runtime };
}

export async function verifyRuntimeAssets(origin, fetchAsset = download) {
  const archive = await runtimeArchivePath();
  const scratch = await mkdtemp(join(tmpdir(), "vp01-runtime-"));
  try {
    await exec("tar", ["-xf", archive, "-C", scratch, "package/dist"]);
    const dist = join(scratch, "package", "dist");
    // Match prepare-viewport-runtime.mjs, including nested workers and assets.
    const files = (await readdir(dist, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile() && !entry.name.endsWith(".map") && !entry.name.endsWith(".d.ts"))
      .map(entry => relative(dist, join(entry.parentPath, entry.name)).replaceAll("\\", "/")).sort();
    if (!files.includes("index.js") || !files.includes("wasm-realm.js")) throw Error("Incomplete runtime archive");
    const evidence = [];
    for (let i = 0; i < files.length; i += 16) {
      const batch = await Promise.allSettled(files.slice(i, i + 16).map(async file => {
        const path = "/forge3d-web/" + file;
        const [expected, served] = await Promise.all([readFile(join(dist, file)), fetchAsset(new URL(path, origin))]);
        if (!served.equals(expected)) throw failure("SERVED_RUNTIME_MISMATCH", path + " differs from the vendored tarball");
        return [path, hash(served)];
      }));
      for (const result of batch) {
        if (result.status === "rejected") throw result.reason;
        evidence.push(result.value);
      }
    }
    return Object.fromEntries(evidence);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function observeFieldRuntime(cdp, origin) {
  const observation = { interceptions: 0, error: null };
  cdp.on("Fetch.requestPaused", async ({ requestId, responseStatusCode }) => {
    try {
      if (responseStatusCode !== 200) throw Error(`Viewport module returned HTTP ${responseStatusCode}`);
      const { body, base64Encoded } = await cdp.send("Fetch.getResponseBody", { requestId });
      const source = base64Encoded ? Buffer.from(body, "base64").toString() : body;
      const anchor = "runtimeRef.current = runtime;";
      if (source.split(anchor).length !== 2) throw Error("Field Instrument runtime observation anchor changed");
      const tagged = source.replace(anchor,
        `${anchor} Object.assign(window, { __vp01FieldDiagnostics: () => ({ runtime, three: THREE }) });`);
      await cdp.send("Fetch.fulfillRequest", {
        requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }],
        body: Buffer.from(tagged).toString("base64"),
      });
      observation.interceptions++;
    } catch (error) {
      observation.error = error.message;
      await cdp.send("Fetch.failRequest", { requestId, errorReason: "Failed" }).catch(() => {});
    }
  });
  await cdp.send("Fetch.enable", {
    patterns: [{ urlPattern: `${origin}${viewportSource}*`, requestStage: "Response" }],
  });
  return observation;
}

// Serialized into each JavaScript realm before its application scripts.
export function observeContexts(blocked, realm) {
  if (globalThis.__vp01Contexts) return globalThis.__vp01Contexts;
  const contexts = [];
  const webgl = new Set(["webgl", "webgl2", "experimental-webgl"]);
  for (const prototype of [globalThis.HTMLCanvasElement?.prototype, globalThis.OffscreenCanvas?.prototype]) {
    if (!prototype) continue;
    const getContext = prototype.getContext;
    prototype.getContext = function (name, ...options) {
      const requested = String(name);
      const denied = blocked && webgl.has(requested);
      const context = denied ? null : Reflect.apply(getContext, this, [name, ...options]);
      const request = {
        realm,
        api: this.constructor.name,
        timeMs: performance.now(),
        canvas: this.className ?? null,
        requested,
        result: context?.constructor.name ?? null,
        denied,
        ...(denied && { stack: new Error().stack }),
      };
      contexts.push(request);
      globalThis.__vp01RecordContext?.(JSON.stringify(request));
      return context;
    };
  }
  globalThis.__vp01Contexts = contexts;
  return contexts;
}

// Give fallback initialization the same budget as a normal viewport launch.
export const VIEWPORT_READY_TIMEOUT_MS = 25_000;

export function completedBlockedObservation(observation, contexts) {
  const denial = contexts.find(request => request.denied && request.canvas === "viewport-canvas");
  return Number.isFinite(denial?.timeMs) && observation?.denialAtMs === denial.timeMs &&
    observation.budgetMs === VIEWPORT_READY_TIMEOUT_MS &&
    Number.isFinite(observation.screenAtMs) && observation.screenAtMs - denial.timeMs >= VIEWPORT_READY_TIMEOUT_MS;
}

export function observeStartup({ role, runId }, observe) {
  const blocked = role === "webgl-blocked";
  if (window.top !== window) {
    if (blocked) observe(true, "iframe");
    return;
  }
  const contexts = observe(blocked, "document");
  const backendTransitions = [];
  if (role !== "field") {
    localStorage.setItem("studio.viewport.renderer", role === "forced-three" ? "three" : "auto");
  }
  new MutationObserver(() => {
    const backend = document.querySelector("[data-viewport-backend]")?.textContent?.trim();
    if (backend && backendTransitions.at(-1)?.backend !== backend) {
      backendTransitions.push({ timeMs: performance.now(), backend });
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
  globalThis.__vp01Startup = { runId, contexts, backendTransitions, blocked };
}

const attachOptions = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
  filter: ["iframe", "worker", "shared_worker", "service_worker"].map(type => ({ type })) };

export async function observeBlockedRealms(cdp) {
  const requests = [];
  const targets = [];
  const errors = [];
  const pending = new Set();
  const binding = "__vp01RecordContext";
  cdp.on("Runtime.bindingCalled", ({ name, payload }) => {
    if (name === binding) requests.push(JSON.parse(payload));
  });
  const instrument = async ({ sessionId, targetInfo, waitingForDebugger }) => {
    const { type } = targetInfo;
    targets.push({ type, waitingForDebugger });
    if (!waitingForDebugger) errors.push({ type, error: "Attached after script execution could begin" });
    try {
      await cdp.send("Runtime.addBinding", { name: binding }, sessionId);
      const source = "(" + observeContexts.toString() + ")(true," + JSON.stringify(type) + ");true";
      if (type === "iframe") {
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source, runImmediately: true }, sessionId);
      } else {
        await cdp.evaluate(source, sessionId);
      }
      await cdp.send("Target.setAutoAttach", attachOptions, sessionId);
    } catch (error) {
      errors.push({ type, error: error.message });
    } finally {
      await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(error => {
        errors.push({ type, error: error.message });
      });
    }
  };
  cdp.on("Target.attachedToTarget", event => {
    const task = instrument(event);
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  await cdp.send("Runtime.addBinding", { name: binding });
  await cdp.send("Target.setAutoAttach", attachOptions);
  return { requests, targets, errors, settle: () => Promise.all([...pending]) };
}
