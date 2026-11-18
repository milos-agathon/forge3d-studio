import { useSession } from "../state/session-context";
import { engineLabel } from "../state/engineLabel";

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function time(unixMs: number | null | undefined): string {
  if (!unixMs) return "—";
  return new Date(unixMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function StatusBar({ viewport }: { viewport: string }) {
  const { state, autosave, recovery, busy, engine } = useSession();

  const objects = state?.project.scene.objects.length ?? 0;
  const selected = state?.project.selection.length ?? 0;

  return (
    <footer className="statusbar">
      <span
        className={`status-chip ${engine?.available ? "status-chip--ready" : "status-chip--waiting"}`}
      >
        {engine ? (engine.available ? "Engine ready" : "No engine") : "Engine…"}
      </span>
      <span
        className={`status-engine ${engine?.available ? "is-ready" : ""}`}
        title={[
          engine?.detail,
          engine?.backend && engine.adapter
            ? `${engine.backend} · ${engine.adapter}`
            : null,
          engine?.software
            ? "software fallback: the engine did not get a GPU adapter"
            : null,
        ]
          .filter(Boolean)
          .join("\n") ?? "Probing for the Forge3D engine…"}
      >
        {engineLabel(engine)}
      </span>
      {viewport && <span className="status-engine" data-viewport-backend>{viewport}</span>}
      {state ? (
        <>
          <span>{count(objects, "object")}</span>
          <span>{selected} selected</span>
          <span className="mono">rev {state.revision}</span>
          <span>{count(state.historyLen, "undo step")}</span>
          <span className={state.dirty ? "status-dirty" : "status-clean"}>
            {state.dirty ? "unsaved" : "saved"}
          </span>
        </>
      ) : (
        <span>No project</span>
      )}

      <span className="statusbar__spacer" />

      {busy && <span className="status-busy">working…</span>}
      {recovery.length > 0 && (
        <span className="status-warn">{count(recovery.length, "recovery snapshot")}</span>
      )}
      {autosave?.lastError ? (
        <span className="status-error" title={autosave.lastError}>
          autosave failed
        </span>
      ) : (
        <span className="status-muted">
          autosave {autosave ? `every ${autosave.intervalSeconds}s` : "off"}
          {autosave?.lastWriteUnixMs
            ? ` · last ${time(autosave.lastWriteUnixMs)}`
            : " · not written yet"}
        </span>
      )}
    </footer>
  );
}
