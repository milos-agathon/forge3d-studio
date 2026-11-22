import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connectStudio } from "../vp01/cdp.mjs";
import { observeContexts } from "../vp01/startup.mjs";

export function loopbackUrl(value) {
  const url = new URL(value);
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    url.port && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password,
  "Expected an HTTP loopback origin with an explicit port");
  return url;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

async function reserveDebugPort(port, host) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const reservation = createServer();
    try {
      await listen(reservation, port, host);
      const selected = reservation.address().port;
      await new Promise(resolve => reservation.close(resolve));
      return selected;
    } catch (error) {
      // WebView2 can release the socket after its Tauri parent exits.
      if (error.code !== "EADDRINUSE" || Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
}

function contextCanary(canvas) {
  const names = ["webgl", "webgl2", "experimental-webgl", "webgpu", "2d"];
  return Object.fromEntries(names.map(name => [name, canvas().getContext(name)?.constructor.name ?? null]));
}

function realmCanary(kind, body) {
  return `
    const sample = ${contextCanary.toString()};
    const inspect = () => ({
      ...(globalThis.document && { html: sample(() => document.createElement("canvas")) }),
      offscreen: sample(() => new OffscreenCanvas(2, 2)),
    });
    (${observeContexts.toString()})(true, ${JSON.stringify(kind)});
    const result = () => ({ guarded: inspect(), requests: globalThis.__vp01Contexts });
    ${body}
  `;
}

const iframe = `<!doctype html><script>${realmCanary("iframe", 'parent.postMessage({type: "vp03-contexts", result: result()}, "*");')}</script>`;
const canaries = new Map([
  ["/vp03-canary/frame", [iframe, "text/html"]],
  ["/vp03-canary/worker.js", [realmCanary("worker", "postMessage(result());"), "text/javascript"]],
  ["/vp03-canary/shared.js", [realmCanary("shared_worker", "onconnect = event => { event.ports[0].postMessage(result()); event.ports[0].close(); };"), "text/javascript"]],
  ["/vp03-canary/service.js", [realmCanary("service_worker", `
    addEventListener("install", event => event.waitUntil(skipWaiting()));
    addEventListener("activate", event => event.waitUntil(clients.claim()));
    addEventListener("message", event => event.ports[0].postMessage(result()));
  `), "text/javascript"]],
]);

function sendCanary(res, [body, contentType]) {
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(body);
}

export async function gateStudio(origin, upstream) {
  const runtime = Promise.withResolvers();
  const studio = Promise.withResolvers();
  let runtimeOpen = false, studioOpen = false;
  let tamper;
  const held = [];
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) { res.writeHead(400); res.end(); return; }
    if (canaries.has(req.url)) { sendCanary(res, canaries.get(req.url)); return; }
    const runtimeFile = new URL(req.url, origin).pathname.startsWith("/forge3d-web/");
    if (req.url !== "/" && !(runtimeFile ? runtimeOpen : studioOpen)) {
      held.push(req.url);
      await (runtimeFile ? runtime.promise : studio.promise);
    }
    if (res.destroyed) return;
    const proxy = request(new URL(req.url, upstream), {
      method: req.method, headers: { ...req.headers, host: upstream.host, "accept-encoding": "identity" },
    }, reply => {
      const headers = reply.headers;
      if (tamper?.path === new URL(req.url, origin).pathname) {
        const chunks = [];
        reply.on("data", chunk => chunks.push(chunk));
        reply.on("end", () => {
          // Keep the original source map and change executable statements only.
          const source = Buffer.concat(chunks).toString("utf8");
          const altered = source.replace(tamper.before, tamper.after);
          if (altered === source) { res.writeHead(502); res.end("The executable control did not match the compiler output"); return; }
          const changed = "globalThis.__vp03TamperedModule = true;\n" + altered;
          delete headers["transfer-encoding"];
          res.writeHead(reply.statusCode, { ...headers, "content-length": Buffer.byteLength(changed) });
          res.end(changed);
        });
        return;
      }
      res.writeHead(reply.statusCode, headers);
      reply.pipe(res);
    });
    proxy.on("error", error => { res.writeHead(502); res.end(error.message); });
    req.pipe(proxy);
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // Forward the dev client connection without changing module responses.
  server.on("upgrade", (req, socket, head) => {
    const peer = connect(Number(upstream.port), upstream.hostname.replace(/^\[|\]$/g, ""), () => {
      const headers = Object.entries({ ...req.headers, host: upstream.host }).map(([name, value]) => `${name}: ${value}`);
      peer.write([`${req.method} ${req.url} HTTP/1.1`, ...headers, "", ""].join("\r\n"));
      peer.write(head);
      socket.pipe(peer).pipe(socket);
    });
    peer.on("error", () => socket.destroy());
    socket.on("error", () => peer.destroy());
    peer.on("close", () => socket.destroy());
    socket.on("close", () => peer.destroy());
  });
  await listen(server, Number(origin.port), origin.hostname.replace(/^\[|\]$/g, ""));
  const cross = createServer((_, res) => sendCanary(res, canaries.get("/vp03-canary/frame")));
  try {
    await listen(cross, 0, "127.0.0.1");
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    origin: new URL(`http://${origin.hostname}:${server.address().port}`),
    held, crossFrame: `http://127.0.0.1:${cross.address().port}/frame`,
    startRuntime() { runtimeOpen = true; runtime.resolve(); },
    start({ altered } = {}) {
      tamper = altered;
      runtimeOpen = studioOpen = true;
      runtime.resolve();
      studio.resolve();
    },
    async close() {
      runtime.resolve();
      studio.resolve();
      for (const socket of sockets) socket.destroy();
      cross.closeAllConnections();
      await Promise.all([cross, server].map(item => new Promise(resolve => item.close(resolve))));
    },
  };
}

export async function launchStudio({ shell, origin, endpoint, dir, root, blocked }) {
  await mkdir(dir);
  const nativeTemp = join(dir, "native-temp");
  await mkdir(nativeTemp);
  const address = endpoint.hostname === "localhost" ? "127.0.0.1" : endpoint.hostname.replace(/^\[|\]$/g, "");
  const port = await reserveDebugPort(Number(endpoint.port), address);
  const debugEndpoint = new URL(endpoint);
  debugEndpoint.port = String(port);
  const flags = [`--remote-debugging-address=${address}`, `--remote-debugging-port=${port}`, "--force-device-scale-factor=1"];
  if (blocked) flags.push("--disable-webgl");
  const child = spawn(shell, [], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, TEMP: nativeTemp, TMP: nativeTemp,
    WEBVIEW2_USER_DATA_FOLDER: join(dir, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: flags.join(" "),
  } });
  child.stdout.pipe(createWriteStream(join(dir, "shell.log")));
  child.stderr.pipe(createWriteStream(join(dir, "shell.err")));
  let spawnError;
  child.on("error", error => { spawnError = error; });
  let cdp;
  async function close() {
    cdp?.close();
    if (child.exitCode === null && !child.signalCode && child.pid) {
      const closed = new Promise(resolve => child.once("exit", resolve));
      child.kill();
      await closed;
    }
  }
  try {
    // Wait for the first navigation on this lane's fresh WebView2 profile.
    const deadline = Date.now() + 120_000;
    let connectionError;
    while (!cdp && Date.now() < deadline) {
      if (spawnError || child.exitCode !== null) throw spawnError ?? Error(`Studio exited ${child.exitCode}`);
      cdp = await connectStudio(debugEndpoint.href).catch(error => { connectionError = error; return null; });
      if (!cdp) await delay(100);
    }
    if (!cdp) throw Error(`Timed out discovering Studio on ${debugEndpoint.origin}`, { cause: connectionError });
    assert.ok(new URL(cdp.page.url).origin === origin.origin, "Studio must start on the gated development origin");
    return { cdp, flags, pid: child.pid, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function checkBlockedCanaries(cdp, crossFrame) {
  const checked = await cdp.evaluate(`(async () => {
    const test = ${contextCanary.toString()};
    const bounded = async (promise) => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Context canary timed out")), 10000);
      })]); } finally { clearTimeout(timer); }
    };
    const frames = (src) => bounded(new Promise(resolve => {
      const frame = document.createElement("iframe");
      frame.hidden = true;
      addEventListener("message", function receive(event) {
        if (event.source !== frame.contentWindow || event.data?.type !== "vp03-contexts") return;
        removeEventListener("message", receive);
        frame.remove();
        resolve(event.data.result);
      });
      frame.src = src;
      document.body.append(frame);
    }));
    const worker = new Worker("/vp03-canary/worker.js");
    const shared = new SharedWorker("/vp03-canary/shared.js");
    let registration;
    try {
      const dedicated = await bounded(new Promise((resolve, reject) => {
        worker.onmessage = event => resolve(event.data);
        worker.onerror = event => reject(Error(event.message));
      }));
      const sharedWorker = await bounded(new Promise((resolve, reject) => {
        shared.port.onmessage = event => resolve(event.data);
        shared.onerror = event => reject(Error(event.message));
      }));
      registration = await navigator.serviceWorker.register("/vp03-canary/service.js", { scope: "/vp03-canary/" });
      const serviceWorker = await bounded((async () => {
        while (!registration.active) await new Promise(resolve => setTimeout(resolve, 25));
        const channel = new MessageChannel();
        const result = new Promise(resolve => channel.port1.onmessage = event => resolve(event.data));
        registration.active.postMessage("probe", [channel.port2]);
        try { return await result; } finally { channel.port1.close(); }
      })());
      return {
        document: { guarded: { html: test(() => document.createElement("canvas")), offscreen: test(() => new OffscreenCanvas(2, 2)) } },
        sameOrigin: await frames("/vp03-canary/frame"), crossOrigin: await frames(${JSON.stringify(crossFrame)}),
        dedicated, sharedWorker, serviceWorker,
      };
    } finally {
      worker.terminate();
      shared.port.close();
      await registration?.unregister();
    }
  })()`);
  for (const [realm, result] of Object.entries(checked)) {
    for (const [canvas, contexts] of Object.entries(result.guarded)) {
      const expected = { webgl: null, webgl2: null, "experimental-webgl": null, webgpu: "GPUCanvasContext",
        "2d": canvas === "html" ? "CanvasRenderingContext2D" : "OffscreenCanvasRenderingContext2D" };
      assert.deepEqual(contexts, expected, `${realm} ${canvas} guard`);
    }
  }
  return checked;
}
