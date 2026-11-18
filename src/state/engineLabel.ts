import type { EngineStatus } from "../bridge/types";

/**
 * Shared version text for the status bar, start screen and About dialog.
 */
export function engineVersionLabel(engine: EngineStatus | null | undefined): string {
  if (!engine) return "probing…";
  if (!engine.available) return "unavailable";

  const version = engine.packageVersion?.trim() ?? "";
  const known = version.length > 0 && version.toLowerCase() !== "unknown";
  return known ? `forge3d ${version}` : "forge3d";
}

/** The engine version and graphics backend shown on the start screen. */
export function engineSummaryLabel(engine: EngineStatus | null | undefined): string {
  const label = engineVersionLabel(engine);
  return engine?.available && engine.backend ? `${label} · ${engine.backend}` : label;
}

/** Full status-bar diagnostics, including the adapter and software mode. */
export function engineLabel(engine: EngineStatus | null | undefined): string {
  if (!engine) return "probing engine…";
  if (!engine.available) return "engine unavailable";

  const parts = [engineSummaryLabel(engine)];
  if (engine.adapter) {
    parts.push(engine.adapter.replace(/^NVIDIA GeForce\s*/, "").slice(0, 44));
  }
  if (engine.software) parts.push("software");
  return parts.join(" · ");
}
