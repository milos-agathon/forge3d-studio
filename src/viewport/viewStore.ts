import type { RenderView, Transform } from "../bridge/types";

/**
 * The viewport's live camera state, published every frame.
 *
 * `resolve` captures the live camera for a native render and measures the
 * terrain if the viewport has yet to receive its footprint.
 *
 * `cameraTransform` is the viewport camera as a scene transform. The timeline's
 * path recorder samples it while a take is running, so a recorded key is the
 * pose on screen rather than a reconstruction.
 */
export const viewStore: {
  resolve: (() => Promise<RenderView | undefined>) | null;
  cameraTransform: Transform | null;
  /** End a local gesture before an editor action can change its starting pose. */
  cancelTransformPreview: (() => void) | null;
} = { resolve: null, cameraTransform: null, cancelTransformPreview: null };
