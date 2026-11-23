import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "vite";
import { FIELD_REVISION, isPinnedRuntimeInventory } from "./vp01/fixture.mjs";
import { observeFieldRuntime, verifyRuntimeAssets } from "./vp01/startup.mjs";
import { gateStudio, launchStudio } from "./vp03/desktop.mjs";
import { nativeSourceHash, sha256 } from "./vp03/identity.mjs";

export function fieldCheckout(root, override) {
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const tree = git(root, "worktree", "list", "--porcelain").split(/\r?\n\r?\n/).find(entry => entry.includes("HEAD " + FIELD_REVISION));
  const field = resolve(override ?? tree?.split(/\r?\n/)[0].slice("worktree ".length) ?? join(root, "../studio-field-instrument"));
  assert.equal(git(field, "rev-parse", "HEAD"), FIELD_REVISION);
  assert.equal(git(field, "status", "--porcelain", "--untracked-files=no"), "", "Field Instrument source must be clean");
  return field;
}

export async function until(cdp, expr) {
  const deadline = Date.now() + 75_000;
  do {
    if (await cdp.evaluate(expr)) return;
    await delay(80);
  } while (Date.now() < deadline);
  throw Error("Timed out waiting for " + expr + "\n" + await cdp.evaluate("document.body.innerText.slice(-2500)"));
}

export function buildShell(source, role, origin) {
  const target = join(tmpdir(), "studio-vp04-target", role);
  execFileSync("cargo", ["build", "--locked", "--manifest-path", "src-tauri/Cargo.toml"], {
    cwd: source, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_PROFILE_DEV_DEBUG: "0",
      TAURI_CONFIG: JSON.stringify({ identifier: "dev.forge3d.studio.vp04." + role, build: { devUrl: origin.origin } }) } });
  return join(target, "debug/forge3d-studio-shell.exe");
}

export async function desktop({ root, field, out, values, report, role, metrics = { width: 1440, height: 900 },
  observeCandidate, candidatePlugins, beforeStudio }, run) {
  const blocked = role === "candidate";
  const candidate = role !== "field";
  const source = candidate ? root : field;
  const origin = new URL("http://localhost:" + (candidate ? 1426 : 1422));
  const shell = values[candidate ? "shell" : "field-shell"] ?? buildShell(source, candidate ? "candidate" : "field", origin);
  const vite = await createServer({ root: source, plugins: candidate ? candidatePlugins : undefined,
    server: { host: "localhost", port: 0, strictPort: false, hmr: false }, logLevel: "error" });
  let gate, app;
  try {
    await vite.listen();
    const upstream = new URL(vite.resolvedUrls.local[0]);
    gate = await gateStudio(origin, upstream);
    app = await launchStudio({ root: source, origin, endpoint: new URL("http://127.0.0.1:0"), shell, dir: join(out, role), blocked });
    const { cdp } = app;
    await cdp.send("Page.enable");
    await cdp.send("Page.bringToFront");
    await cdp.send("Emulation.setDeviceMetricsOverride", { ...metrics, deviceScaleFactor: 1, mobile: false });
    await until(cdp, "!!window.__TAURI_INTERNALS__?.invoke");
    report[role + "Shell"] = { sha256: sha256(await readFile(shell)), flags: app.flags, pid: app.pid };
    if (candidate) {
      const info = await cdp.evaluate('__TAURI_INTERNALS__.invoke("shell_info")');
      assert.equal(info.nativeSourceSha256, await nativeSourceHash(root), "Rebuild the candidate shell for this checkout");
      assert.ok(isPinnedRuntimeInventory(await verifyRuntimeAssets(upstream)));
      if (blocked) assert.equal(await cdp.evaluate('document.createElement("canvas").getContext("webgl2") === null'), true);
      await observeCandidate?.(cdp);
      if (beforeStudio) {
        gate.startRuntime();
        await beforeStudio(cdp);
      }
    } else {
      await observeFieldRuntime(cdp, origin.origin);
    }
    gate.start();
    await run(cdp);
  } finally { await app?.close(); await gate?.close(); await vite.close(); }
}
