import { useSession } from "../state/session-context";
import { CloseIcon, RestoreIcon } from "./icons";

/**
 * Offers unsaved work found in the recovery directory at startup.
 *
 * `dismissed` lives with the caller, not here: the banner is mounted on the
 * start screen and again over the viewport, and Restore swaps one for the
 * other. Local state would reset on that remount and offer the snapshot that
 * was just restored (restoring keeps it on disk, so `recovery` is unchanged).
 */
export function RecoveryBanner({
  dismissed,
  onDismiss,
}: {
  dismissed: boolean;
  onDismiss: () => void;
}) {
  const { recovery, actions } = useSession();

  if (recovery.length === 0 || dismissed) return null;

  const newest = recovery[0];
  const when = new Date(newest.writtenUnixMs).toLocaleString();
  const origin = newest.sourcePath?.split(/[\\/]/).pop() ?? "an unsaved project";

  return (
    <div className="recovery" role="status">
      <RestoreIcon size={16} />
      <div className="recovery__text">
        <strong>Unsaved work found</strong>
        <span>
          {origin} · {newest.projectName} · {newest.objectCount} objects · {when}
        </span>
      </div>
      <div className="recovery__actions">
        <button
          type="button"
          className="button button--primary button--small"
          onClick={() => {
            onDismiss();
            void actions.restoreRecovery(newest.id);
          }}
        >
          Restore
        </button>
        <button
          type="button"
          className="button button--small"
          onClick={() => void actions.discardRecovery(newest.id)}
        >
          Discard
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <CloseIcon size={14} />
        </button>
      </div>
    </div>
  );
}
