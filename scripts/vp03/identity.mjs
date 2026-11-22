import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { glob, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isPinnedRuntimeInventory, verifyProvenance } from "../vp01/fixture.mjs";
import { verifyRuntimeAssets } from "../vp01/startup.mjs";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const normalize = source => source.replaceAll("\r\n", "\n");
const normalizePath = path => path.replaceAll("\\", "/");
export async function nativeSourceHash(root) {
  const patterns = (await readFile(join(root, "src-tauri/native-source.inputs"), "utf8")).trim().split(/\r?\n/);
  const paths = new Set();
  for await (const file of glob(patterns, { cwd: root })) paths.add(normalizePath(file));
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    const bytes = await readFile(join(root, path));
    const content = /\.(?:png|ico)$/.test(path) ? bytes : normalize(bytes.toString("utf8"));
    hash.update(path).update("\0").update(createHash("sha256").update(content).digest());
  }
  return hash.digest("hex");
}

const servedDependencies = "/node_modules/.vite/deps/";
const isStudioModule = url => url.pathname.startsWith("/src/");
const isRuntimeModule = url => url.pathname.startsWith("/forge3d-web/") && /\.(js|wasm)$/.test(url.pathname);

function comparableExecutable(source, dependencies) {
  // The compiler's isolated dependency cache has a different URL and Vite
  // assigns its own eight-digit cache key. Keep the actual imported filename.
  const escaped = dependencies.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.replace(new RegExp(`(?<=["'])${escaped}([^"'?\\s]+)\\?v=[0-9a-f]{8}(?=["'])`, "g"),
    servedDependencies + "$1?v=00000000");
}

async function serveReference(cacheDir) {
  const { createServer } = await import("vite");
  const { createServer: createHttpServer } = await import("node:http");
  const server = createHttpServer();
  const compiler = await createServer({ cacheDir, server: { middlewareMode: true, hmr: { server }, watch: null, preTransformRequests: false } });
  server.on("request", compiler.middlewares);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  process.send({ port: server.address().port, root: compiler.config.root, cacheDir: compiler.config.cacheDir });
}

export async function compileReference(root, cacheDir) {
  const compiler = spawn(process.execPath, ["--input-type=module", "--eval", `await (${serveReference})(process.argv[1])`, cacheDir],
    { cwd: root, stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true });
  const close = async () => {
    if (compiler.pid && compiler.exitCode === null && compiler.signalCode === null) {
      const exited = once(compiler, "exit");
      compiler.kill();
      await exited;
    }
  };
  try {
    const info = await Promise.race([
      once(compiler, "message", { signal: AbortSignal.timeout(30_000) }).then(([message]) => message),
      once(compiler, "exit").then(([code]) => { throw new Error(`The local Vite compiler exited with ${code}`); }),
    ]);
    const origin = `http://127.0.0.1:${info.port}`;
    const cache = relative(info.root, info.cacheDir);
    const outsideRoot = isAbsolute(cache) || cache.startsWith(".." + sep);
    const dependencies = (outsideRoot ? "/@fs/" + normalizePath(info.cacheDir) : "/" + normalizePath(cache)) + "/deps/";
    const src = join(root, "src");
    const compile = async url => {
      assert.ok(isStudioModule(url));
      const path = resolve(root, decodeURIComponent(url.pathname.slice(1)));
      const sourcePath = relative(src, path);
      assert.ok(sourcePath && !isAbsolute(sourcePath) && sourcePath !== ".." && !sourcePath.startsWith(".." + sep),
        `Unknown Studio source path ${url.pathname}`);
      const [reply, source] = await Promise.all([
        fetch(new URL(url.pathname + url.search, origin), { signal: AbortSignal.timeout(30_000) }),
        readFile(path, "utf8"),
      ]);
      assert.ok(reply.ok, `Local Vite compiler returned ${reply.status} for ${url.pathname}`);
      const body = Buffer.from(await reply.arrayBuffer());
      return { sourceSha256: sha256(normalize(source)), compilerSha256: sha256(body),
        comparable: comparableExecutable(body.toString(), dependencies) };
    };
    const modules = new Map();
    return { get(url) {
      const key = url.pathname + url.search;
      if (!modules.has(key)) modules.set(key, compile(url));
      return modules.get(key);
    }, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function observeExecution(cdp, origin) {
  const requests = new Map();
  const scripts = [];
  const pending = new Set();
  const errors = [];
  const local = address => {
    if (!address.startsWith("http")) return undefined;
    const url = new URL(address);
    return url.origin === origin.origin ? url : undefined;
  };
  const observe = work => {
    const task = work.catch(error => errors.push(error.message)).finally(() => pending.delete(task));
    pending.add(task);
  };
  cdp.on("Network.responseReceived", ({ requestId, loaderId, type, response }) => {
    const url = local(response.url);
    if (!url || (!isRuntimeModule(url) && !(isStudioModule(url) &&
      (type === "Script" || /(?:java|ecma)script/i.test(response.mimeType))))) return;
    requests.set(requestId, { url: response.url, loaderId, status: response.status });
  });
  cdp.on("Network.loadingFinished", ({ requestId }) => {
    const entry = requests.get(requestId);
    if (!entry) return;
    observe(cdp.send("Network.getResponseBody", { requestId }).then(({ body, base64Encoded }) => {
      entry.body = Buffer.from(body, base64Encoded ? "base64" : "utf8");
    }).catch(error => {
      if (error.code !== "CDP_COMMAND_ERROR" || !/evicted|no (?:resource|data)(?: with given identifier)? found/i.test(error.message)) throw error;
      entry.bodyError = error.message;
    }));
  });
  cdp.on("Debugger.scriptParsed", ({ scriptId, url, executionContextId }) => {
    const address = local(url);
    if (!address || !(isStudioModule(address) || isRuntimeModule(address)) || address.pathname.endsWith(".wasm")) return;
    observe(cdp.send("Debugger.getScriptSource", { scriptId }).then(({ scriptSource }) => {
      scripts.push({ url, executionContextId, sha256: sha256(scriptSource), source: scriptSource });
    }));
  });
  await cdp.send("Network.enable", { maxTotalBufferSize: 128_000_000, maxResourceBufferSize: 32_000_000 });
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Debugger.enable", { maxScriptsCacheSize: 128_000_000 });
  return async () => {
    await Promise.all([...pending]);
    assert.deepEqual(errors, [], "Executable capture errors");
    return { responses: [...requests.values()], scripts };
  };
}

function measuredBody(entry, scripts) {
  assert.equal(entry.status, 200, `Unexpected response for ${entry.url}`);
  const hits = scripts.filter(script => script.url === entry.url);
  const parsed = hits.map(({ source, ...script }) => script);
  if (entry.body) return { body: entry.body, parsed, capture: "network" };
  // The body cache can evict a response after execution. Its V8 source is
  // still original execution evidence and must match the independent compile.
  assert.ok(entry.bodyError && hits.length && !new URL(entry.url).pathname.endsWith(".wasm"),
    `Missing original WebView body for ${entry.url}`);
  return { body: Buffer.from(hits[0].source), parsed, capture: "debugger", bodyError: entry.bodyError };
}

function requireExecutable(condition, url, bodySha256, compilerSha256) {
  if (condition) return;
  throw Object.assign(new Error(`Measured WebView executable differs from the local compiler output for ${new URL(url).pathname}`),
    { code: "VP03_EXECUTABLE_MISMATCH", bodySha256, compilerSha256 });
}

export async function verifyExecution(cdp, measured, reference, servedOrigin) {
  const { frameTree: { frame } } = await cdp.send("Page.getFrameTree");
  const { responses, scripts } = await measured();
  const observed = responses.filter(entry => entry.loaderId === frame.loaderId);
  const studio = observed.filter(entry => isStudioModule(new URL(entry.url)));
  const loadedUrls = new Set(studio.map(entry => entry.url));
  for (const script of scripts.filter(script => isStudioModule(new URL(script.url)))) {
    assert.ok(loadedUrls.has(script.url), `No measured Studio response for executable ${script.url}`);
  }
  const captured = {};
  for (const entry of studio) {
    const url = new URL(entry.url);
    const { sourceSha256, compilerSha256, comparable } = await reference.get(url);
    const { body, ...capture } = measuredBody(entry, scripts);
    const executable = comparableExecutable(body.toString(), servedDependencies);
    const bodySha256 = sha256(body);
    requireExecutable(executable === comparable && capture.parsed.length > 0 &&
      capture.parsed.every(script => script.sha256 === bodySha256), entry.url, bodySha256, compilerSha256);
    const path = url.pathname.slice(1);
    captured[path] ??= { loaderId: frame.loaderId, sourceSha256, executed: [] };
    captured[path].executed.push({ url: entry.url, bodySha256, compilerSha256, comparableSha256: sha256(comparable), ...capture });
  }
  assert.ok(captured["src/main.tsx"] && captured["src/viewport/Viewport3D.tsx"], "Missing Studio entry or viewport executable");
  const [provenance, runtime] = await Promise.all([verifyProvenance(), verifyRuntimeAssets(servedOrigin)]);
  assert.ok(isPinnedRuntimeInventory(runtime));
  const executedRuntime = {};
  for (const entry of observed) {
    const path = new URL(entry.url).pathname.slice(1);
    if (!path.startsWith("forge3d-web/")) continue;
    const { body, ...capture } = measuredBody(entry, scripts);
    const bodySha256 = sha256(body);
    assert.equal(bodySha256, runtime["/" + path], `Measured WebView runtime differs for ${path}`);
    assert.ok(path.endsWith(".wasm") || (capture.parsed.length && capture.parsed.every(script => script.sha256 === bodySha256)),
      `V8 script source differs for ${path}`);
    executedRuntime[path] = { bodySha256, ...capture };
  }
  for (const path of ["index.js", "wasm-realm.js", "wasm/forge3d_web_bg.wasm"]) {
    assert.ok(executedRuntime["forge3d-web/" + path] ||
      Object.keys(executedRuntime).some(file => file.endsWith("/" + path.split("/").at(-1))),
    `The measured WebView must load runtime ${path}`);
  }
  return { sources: captured, provenance, runtime, executedRuntime };
}
