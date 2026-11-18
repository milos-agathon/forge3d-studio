import { engineSummaryLabel } from "../state/engineLabel";
import { useSession } from "../state/session-context";
import { FileIcon, FolderIcon, ForgeMark } from "./icons";

export function EmptyState() {
  const { actions, info, engine } = useSession();

  return (
    <div className="empty">
      <div className="empty__card">
        <span className="empty__mark" aria-hidden="true">
          <ForgeMark size={44} />
        </span>
        <h1>Forge3D Studio</h1>
        <p className="empty__lede">
          Load a DEM, set the light and render a map plate with the Forge3D
          engine. Scene and Cartography work on the same project.
        </p>

        <div className="empty__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={() => actions.requestNewProject()}
          >
            <FileIcon size={14} /> New project
          </button>
          <button
            type="button"
            className="button"
            onClick={() => void actions.openProject()}
          >
            <FolderIcon size={14} /> Open project…
          </button>
        </div>

        <dl className="empty__facts">
          <div>
            <dt>Studio</dt>
            <dd>{info?.version ?? "—"}</dd>
          </div>
          <div>
            <dt>Engine</dt>
            <dd>{engineSummaryLabel(engine)}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
