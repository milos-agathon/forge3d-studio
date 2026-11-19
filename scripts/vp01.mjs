import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { connectStudio, failure } from "./vp01/cdp.mjs";
import { PRESENTATION_PROBE_SCOPE, completedPresentationProbe, confirmedBlockedScreen, createPresentationProbe,
  displayThresholds, inspectBlockedScreen, measureCanvasContribution, measureErrorPaint, readFrame } from "./vp01/composition.mjs";
import { checkBlockedCapture, compareCaptures, runOfflineControls } from "./vp01/compare.mjs";
import { CANDIDATE_REVISION, CUBE_ID, createFixture, FIELD_REVISION, verifyFixture, verifyProvenance } from "./vp01/fixture.mjs";
import { installProbe } from "./vp01/page.mjs";
import { observeBlockedRealms, observeContexts, observeFieldRuntime, observeStartup, verifyStudioSource,
  VIEWPORT_READY_TIMEOUT_MS } from "./vp01/startup.mjs";

const usage = `VP-01
  node scripts/vp01.mjs fixture --out DIR
  node scripts/vp01.mjs capture --endpoint http://127.0.0.1:PORT --role ROLE --fixture PROJECT --out DIR
  node scripts/vp01.mjs compare --field DIR --candidate DIR --out REPORT.json
  node scripts/vp01.mjs controls --field DIR --candidate DIR --blocked DIR --out DIR
Roles: field, candidate, forced-three, webgl-blocked`;

const pretty = value => `${JSON.stringify(value, null, 2)}\n`;
const saveJson = (path, value) => writeFile(path, pretty(value), { flag: "wx" });

async function saveFrame(cdp, dir, name, clip) {
  const png = await cdp.screenshot(clip);
  await writeFile(join(dir, name), png, { flag: "wx" });
  return { png: name, dimensions: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } };
}

async function waitFor(cdp, expression, code, seconds = VIEWPORT_READY_TIMEOUT_MS / 1000) {
  const end = performance.now() + seconds * 1000;
  do {
    const result = await cdp.evaluate(expression);
    if (result) return result;
    await delay(100);
  } while (performance.now() < end);
  throw failure(code, `Timed out after ${seconds} s`);
}

async function saveMasks(dir, value, path = []) {
  for (const [key, child] of Object.entries(value)) {
    if (key === "mask") {
      const file = `${path.join("-")}.mask`;
      await writeFile(join(dir, file), Buffer.from(child, "base64"), { flag: "wx" });
      value[key] = file;
    } else if (child && typeof child === "object" && !Array.isArray(child)) {
      await saveMasks(dir, child, [...path, key]);
    }
  }
}

const projectState = 'window.__TAURI_INTERNALS__.invoke("project_state")';
const probe = method => `window.__vp01Probe.${method}()`;

async function captureTerrain(cdp, dir, clip) {
  await cdp.evaluate('window.__vp01TerrainSteps = window.__vp01Probe.captureTerrain(); true');
  const frames = {};
  try {
    for (;;) {
      const { done, value } = await cdp.evaluate("window.__vp01TerrainSteps.next()");
      if (done) {
        for (const [name, pose] of Object.entries(value.poses)) pose.display = frames[name];
        return value;
      }
      const { name, frame, displayChrome } = value;
      frames[name] ??= {};
      frames[name][frame] = await saveFrame(cdp, dir, `terrain-${name}-${frame}.png`, clip);
      if (displayChrome) frames[name].displayChrome = displayChrome;
    }
  } finally {
    await cdp.evaluate("window.__vp01TerrainSteps.return().finally(() => { delete window.__vp01TerrainSteps; })");
  }
}

async function settleStudioLayout(cdp) {
  // Recovery banners consume viewport height. Dismiss the banner through its
  // UI action, leaving the saved recovery snapshot available to the owner.
  const dismissed = await cdp.evaluate(`(() => {
    const button = document.querySelector('.workspace__center .recovery button[aria-label="Dismiss"]');
    if (button) button.click();
    return Boolean(button);
  })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
  await cdp.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  return dismissed;
}

async function blockedRun(cdp, manifest, dir, realms) {
  const denial = await waitFor(cdp, `__vp01Startup.contexts.find(request => request.denied && request.canvas === "viewport-canvas")`,
    "NO_VIEWPORT_WEBGL_DENIAL");
  const deadline = denial.timeMs + VIEWPORT_READY_TIMEOUT_MS;
  // Keep the application and its canvases in place while a fallback can load.
  await cdp.evaluate(`new Promise(resolve => setTimeout(resolve, Math.max(0, ${deadline} - performance.now())))`);
  await waitFor(cdp, `performance.now() >= ${deadline}`, "BLOCKED_OBSERVATION_INCOMPLETE", 2);
  await cdp.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  const state = await cdp.evaluate(`(() => {
    const viewport = document.querySelector(".viewport");
    return {
      viewport: { css: viewport.getBoundingClientRect().toJSON(), dpr: devicePixelRatio },
      screenAtMs: performance.now(),
      problem: viewport.querySelector(".viewport-problem")?.textContent?.trim() ?? null,
      failureScreen: (${inspectBlockedScreen.toString()})(document, viewport),
      webgpuAvailable: Boolean(navigator.gpu),
    };
  })()`);
  const { viewport, screenAtMs, ...status } = state;
  Object.assign(manifest.startup, status);
  manifest.startup.observation = { denialAtMs: denial.timeMs, screenAtMs, budgetMs: VIEWPORT_READY_TIMEOUT_MS };
  manifest.viewport = viewport;
  try {
    manifest.startup.presentationSurfaces = await cdp.evaluate(
      `(window.__vp01PresentationProbe = (${createPresentationProbe.toString()})(document)).inventory`);
    manifest.stock = await saveFrame(cdp, dir, "blocked-viewport.png", viewport.css);
    const blanked = await cdp.evaluate(`(async () => {
      if (!await window.__vp01PresentationProbe.blank()) return false;
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
    })()`);
    if (!blanked) throw failure("BLOCKED_PRESENTATION_PROBE_INCOMPLETE", "Presentation surfaces changed or could not be isolated");
    manifest.composition = { withoutPresentation: await saveFrame(cdp, dir, "blocked-without-presentation.png", viewport.css) };
    const evidence = await cdp.evaluate("window.__vp01PresentationProbe.evidence()");
    manifest.startup.presentationProbe = { scope: PRESENTATION_PROBE_SCOPE, ...evidence };
  } finally {
    await cdp.evaluate("window.__vp01PresentationProbe?.restore(); delete window.__vp01PresentationProbe;");
  }
  if (!completedPresentationProbe(manifest.startup)) {
    throw failure("BLOCKED_PRESENTATION_PROBE_INCOMPLETE", "Presentation surfaces changed during the screen comparison");
  }
  try {
    const stableError = await cdp.evaluate(`new Promise(resolve => {
      const problem = document.querySelector(".viewport .viewport-problem");
      if (!problem) return resolve(false);
      const text = ${JSON.stringify(status.problem)};
      const bounds = ${JSON.stringify(status.failureScreen.problemBounds)};
      const unchanged = () => problem.isConnected && problem.textContent.trim() === text &&
        JSON.stringify(problem.getBoundingClientRect().toJSON()) === JSON.stringify(bounds);
      if (!unchanged()) return resolve(false);
      const { style } = problem;
      const properties = { "-webkit-text-fill-color": "transparent", "text-shadow": "none" };
      const previous = Object.keys(properties).map(name => [name, style.getPropertyValue(name), style.getPropertyPriority(name)]);
      window.__vp01RestoreErrorText = () => previous.forEach(entry => style.setProperty(...entry));
      for (const [name, value] of Object.entries(properties)) style.setProperty(name, value, "important");
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(unchanged() &&
        getComputedStyle(problem).webkitTextFillColor === "rgba(0, 0, 0, 0)")));
    })`);
    if (stableError) {
      manifest.composition.withoutErrorText = await saveFrame(cdp, dir, "blocked-without-error-text.png", viewport.css);
    }
  } finally {
    await cdp.evaluate("window.__vp01RestoreErrorText?.(); delete window.__vp01RestoreErrorText;");
  }
  const [stock, withoutPresentation, withoutErrorText] = await Promise.all([
    manifest.stock, manifest.composition.withoutPresentation, manifest.composition.withoutErrorText]
    .map(frame => frame && readFrame(dir, frame, viewport)));
  manifest.startup.presentationContribution = measureCanvasContribution(stock, withoutPresentation);
  if (withoutErrorText) {
    manifest.startup.errorPaint = measureErrorPaint(stock, withoutErrorText, viewport, status.failureScreen.problemBounds);
  }
  manifest.startup.liveViewport = manifest.startup.presentationContribution.fraction >= displayThresholds.liveViewport;
  manifest.startup.canaries = await cdp.evaluate("(" + blockedCanaries.toString() + ")()");
  await realms.settle();
  const { canaries } = manifest.startup;
  if (realms.errors.length || !canaries.iframe.denied || !canaries.worker.denied || canaries.worker.error) {
    throw failure("WEBGL_REALM_GUARD_FAILED", "WebGL denial could not be verified in the frame and worker contexts");
  }
  if (manifest.startup.liveViewport) throw failure("UNEXPECTED_LIVE_VIEWPORT", "Studio displayed a live viewport with WebGL denied");
  if (!confirmedBlockedScreen(manifest.startup, manifest.startup.errorPaint)) {
    throw failure("BLOCKED_FAILURE_SCREEN_UNVERIFIED", "Studio's expected WebGL failure screen could not be verified");
  }
  throw failure("WEBGL_BLOCKED_NO_VIEWPORT", "Studio displayed no viewport frame at the end of the 25-second startup observation");
}

async function blockedCanaries() {
  function contexts(makeCanvas) {
    const denied = ["webgl", "webgl2", "experimental-webgl"].every(name => makeCanvas().getContext(name) === null);
    return { denied, webgpu: makeCanvas().getContext("webgpu")?.constructor.name,
      twoD: makeCanvas().getContext("2d")?.constructor.name };
  }
  const frame = document.createElement("iframe");
  frame.hidden = true;
  document.body.append(frame);
  const iframe = contexts(() => frame.contentDocument.createElement("canvas"));
  frame.remove();
  const url = URL.createObjectURL(new Blob([
    "postMessage((" + contexts.toString() + ")(() => new OffscreenCanvas(2, 2)));",
  ], { type: "text/javascript" }));
  const worker = new Worker(url);
  try {
    const result = await new Promise(resolve => {
      const timer = setTimeout(() => resolve({ error: "Worker canary timed out" }), 8000);
      const finish = value => { clearTimeout(timer); resolve(value); };
      worker.onmessage = event => finish(event.data);
      worker.onerror = event => finish({ error: event.message });
    });
    return { ...contexts(() => document.createElement("canvas")), iframe, worker: result };
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}

async function capture({ endpoint, role, fixture: fixturePath, out }) {
  if (!["field", "candidate", "forced-three", "webgl-blocked"].includes(role)) {
    throw failure("INVALID_ROLE", `Unknown capture role ${role}`);
  }
  const dir = resolve(out);
  await mkdir(dirname(dir), { recursive: true });
  await mkdir(dir);
  const runId = randomUUID();
  const revision = role === "field" ? FIELD_REVISION : CANDIDATE_REVISION;
  const manifest = { version: 2, role, runId, revision, startedAt: new Date().toISOString(), status: "failed", startup: { errors: [] } };
  let cdp;
  let bootstrapped = false;
  let script;
  let fieldObservation;
  let blockedRealms;
  try {
    const [fixture, provenance] = await Promise.all([verifyFixture(fixturePath), verifyProvenance()]);
    manifest.fixture = fixture.identity;
    manifest.provenance = role === "field" ? null : provenance;
    cdp = await connectStudio(endpoint);
    const { id, url } = cdp.page;
    manifest.target = { id, url, endpoint: cdp.endpoint };
    const origin = new URL(url).origin;
    manifest.sourceEvidence = await verifyStudioSource(origin, revision, role);
    cdp.on("Runtime.exceptionThrown", ({ exceptionDetails: error }) => {
      manifest.startup.errors.push({ url: error.url, message: error.exception?.description ?? error.text });
    });
    await Promise.all([cdp.send("Runtime.enable"), cdp.send("Page.enable"), cdp.send("Network.enable")]);
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Page.bringToFront");
    await waitFor(cdp, "Boolean(window.__TAURI_INTERNALS__?.invoke)", "TAURI_BRIDGE_UNAVAILABLE");
    manifest.startup.tauri = true;
    if (role === "field") fieldObservation = await observeFieldRuntime(cdp, origin);
    if (role === "webgl-blocked") blockedRealms = await observeBlockedRealms(cdp);
    script = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(${observeStartup.toString()})(${JSON.stringify({ role, runId })}, ${observeContexts.toString()});`,
    });
    const opened = await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke("open_project", { path: ${JSON.stringify(fixture.path)} })`);
    if (opened?.project?.id !== fixture.identity.projectId) {
      throw failure("LOADED_FIXTURE_MISMATCH", "Studio did not open the supplied fixture");
    }
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(cdp, `window.__vp01Startup?.runId === ${JSON.stringify(runId)} && Boolean(window.__TAURI_INTERNALS__?.invoke)`,
      "STARTUP_OBSERVATION_UNAVAILABLE");
    bootstrapped = true;
    const native = await cdp.evaluate(projectState);
    manifest.startup.loadedProjectId = native?.project?.id;
    if (manifest.startup.loadedProjectId !== fixture.identity.projectId || native.project.selection?.length !== 0) {
      throw failure("LOADED_FIXTURE_MISMATCH", "Expected the requested fixture with an empty initial selection");
    }
    if (role === "webgl-blocked") await blockedRun(cdp, manifest, dir, blockedRealms);

    await cdp.evaluate(`(${installProbe.toString()})(${JSON.stringify({ role, cubeId: CUBE_ID })});`);
    await waitFor(cdp, probe("ready"), "LIVE_VIEWPORT_UNAVAILABLE");
    manifest.startup.recoveryBannerDismissed = await settleStudioLayout(cdp);
    await waitFor(cdp, probe("ready"), "LIVE_VIEWPORT_UNAVAILABLE");
    // Stock compositing is captured before inspecting render state or touching visibility.
    const viewport = await cdp.evaluate(probe("viewport"));
    manifest.viewport = viewport;
    manifest.stock = await saveFrame(cdp, dir, "viewport.png", viewport.css);
    manifest.stock.displayChrome = await cdp.evaluate(probe("displayChrome"));
    const { project, stock, ...inspection } = await cdp.evaluate(probe("inspect"));
    if (project.id !== fixture.identity.projectId) throw failure("LOADED_FIXTURE_MISMATCH", "Rendered project differs from fixture");
    if (!isDeepStrictEqual(inspection.viewport, viewport)) throw failure("CAPTURE_VIEWPORT_CHANGED", "Viewport changed after the stock capture");
    Object.assign(manifest, inspection);
    Object.assign(manifest.stock, stock);
    manifest.startup.liveViewport = true;
    manifest.composition = {};
    try {
      await cdp.evaluate('window.__vp01Probe.composition("noCube")');
      manifest.composition.noCube = await saveFrame(cdp, dir, "viewport-no-cube.png", viewport.css);
      await cdp.evaluate('window.__vp01Probe.composition("noTerrain")');
      manifest.composition.noTerrain = await saveFrame(cdp, dir, "viewport-no-terrain.png", viewport.css);
    } finally {
      await cdp.evaluate('window.__vp01Probe.composition("stock")');
    }
    manifest.object = await cdp.evaluate(probe("captureObject"));
    await saveMasks(dir, manifest.object, ["object"]);
    if (manifest.object.click) await cdp.click(manifest.object.click.css);
    manifest.object.selection = await cdp.evaluate(probe("captureSelection"));
    manifest.terrain = await captureTerrain(cdp, dir, viewport.css);
    if (!isDeepStrictEqual(await cdp.evaluate(probe("viewport")), viewport)) {
      throw failure("CAPTURE_VIEWPORT_CHANGED", "Viewport changed during the diagnostics");
    }
    await saveMasks(dir, manifest.terrain.poses, ["terrain"]);
    manifest.status = "captured";
  } catch (error) {
    manifest.reason = error.code ?? "CAPTURE_ERROR";
    manifest.error = error.message;
  } finally {
    if (bootstrapped) {
      const evidence = await cdp.evaluate("window.__vp01Startup").catch(() => null);
      if (evidence) Object.assign(manifest.startup, evidence);
    }
    if (blockedRealms) {
      const { requests, targets, errors } = blockedRealms;
      manifest.startup.realmObservation = { requests, targets, errors };
    }
    if (script) await cdp.send("Page.removeScriptToEvaluateOnNewDocument", script).catch(() => {});
    if (fieldObservation) {
      manifest.startup.fieldObservation = fieldObservation;
      await cdp.send("Fetch.disable").catch(() => {});
    }
    cdp?.close();
  }
  manifest.finishedAt = new Date().toISOString();
  await saveJson(join(dir, "manifest.json"), manifest);
  return { role, directory: dir, status: manifest.status, reason: manifest.reason, error: manifest.error };
}

async function main([command, ...args]) {
  const options = {
    fixture: ["out"],
    capture: ["endpoint", "role", "fixture", "out"],
    compare: ["field", "candidate", "out"],
    controls: ["field", "candidate", "blocked", "out"],
  }[command];
  if (!command || command === "--help") return console.log(usage);
  if (!options) throw failure("INVALID_COMMAND", usage);
  const { values } = parseArgs({ args, options: Object.fromEntries(options.map(key => [key, { type: "string" }])) });
  if (options.some(key => !values[key])) throw failure("MISSING_ARGUMENT", usage);
  if (command === "fixture") return console.log(pretty(await createFixture(values.out)));
  if (command === "capture") {
    const result = await capture(values);
    console.log(pretty(result));
    if (result.status !== "captured") process.exitCode = 1;
    return;
  }
  if (command === "compare") {
    const report = await compareCaptures(values.field, values.candidate);
    await saveJson(values.out, report);
    console.log(pretty({ pass: report.pass, report: resolve(values.out) }));
    if (!report.pass) process.exitCode = 1;
    return;
  }
  const blocked = await checkBlockedCapture(values.blocked);
  const offline = await runOfflineControls(values.field, values.candidate, values.out);
  const report = { pass: blocked.pass && offline.pass, checks: [...offline.checks, blocked] };
  await saveJson(join(values.out, "controls.json"), report);
  console.log(pretty({ pass: report.pass, report: resolve(values.out, "controls.json") }));
  if (!report.pass) process.exitCode = 1;
}

main(process.argv.slice(2)).catch(error => {
  console.error(pretty({ status: "unexpected-failure", reason: error.code ?? "VP01_ERROR", error: error.message }));
  process.exitCode = 1;
});
