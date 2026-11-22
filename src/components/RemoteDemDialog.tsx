import { useLayoutEffect, useRef, useState } from "react";

import { bridge } from "../bridge/env";
import type { RemoteCogInfo, RemoteCogPreview } from "../bridge/types";
import { useSession } from "../state/session-context";
import { thumbPixels } from "../viewport/datasetThumb";
import { CloseIcon } from "./icons";

const COMPRESSION_NAMES: Record<number, string> = {
  1: "none",
  5: "LZW",
  6: "JPEG",
  7: "old-style JPEG",
  8: "Deflate",
  50000: "Zstd",
};

/**
 * Open a remote DEM (a Cloud Optimized GeoTIFF) as a project.
 *
 * The probe reads the COG's metadata and a coarse overview by byte range.
 * The project keeps the URL for subsequent reads.
 */
export function RemoteDemDialog() {
  const { actions, busy } = useSession();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [probing, setProbing] = useState(false);
  const [result, setResult] = useState<{ url: string; info: RemoteCogInfo; preview: RemoteCogPreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const verified = result?.url === url.trim() ? result : null;

  useLayoutEffect(() => () => { generation.current += 1; }, []);

  const resetProbe = () => {
    generation.current += 1;
    setError(null);
    setResult(null);
    setProbing(false);
  };
  const close = () => {
    resetProbe();
    setOpen(false);
  };

  const probe = async () => {
    const target = url.trim();
    if (!target || probing) return;
    const request = ++generation.current;
    setProbing(true);
    setError(null);
    setResult(null);
    try {
      const info = await bridge.remoteCogInfo(target);
      if (generation.current !== request) return;
      const preview = await bridge.remoteCogPreview(target, 96);
      if (generation.current === request) setResult({ url: target, info, preview });
    } catch (cause) {
      if (generation.current === request) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation.current === request) setProbing(false);
    }
  };

  const pick = () => {
    if (!verified || busy) return;
    // The fetch happens inside createProject; close first so the busy
    // state is not double-rendered.
    close();
    void actions.createProject(`url:${verified.url}`);
  };

  if (!open) {
    return (
      <button
        type="button"
        className="preset preset--empty"
        disabled={busy}
        onClick={() => setOpen(true)}
        title="Open a remote DEM — a Cloud Optimized GeoTIFF served over HTTP(S)"
      >
        <span className="preset__name">Remote DEM (COG)…</span>
        <span className="preset__desc">
          Preview a Cloud Optimized GeoTIFF by URL
        </span>
        <span className="preset__meta mono">http / https / file</span>
      </button>
    );
  }

  const info = verified?.info;
  const preview = verified?.preview;
  const compression = info ? COMPRESSION_NAMES[info.levels[0]?.compression] ?? `#${info.levels[0]?.compression}` : "";

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Open a remote DEM"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="modal remote-dem">
        <header className="modal__header">
          <h2>Open a remote DEM</h2>
          <button type="button" className="icon-button" aria-label="Cancel" onClick={close}>
            <CloseIcon size={14} />
          </button>
        </header>

        <p className="hint">
          Enter the URL of a Cloud Optimized GeoTIFF. Studio reads its
          metadata and a small preview using byte ranges.
        </p>

        <label className="field">
          <span className="field-label">URL</span>
          <input
            className="input input--mono"
            type="text"
            autoFocus
            spellCheck={false}
            placeholder="https://example.com/dem.tif"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              resetProbe();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void probe();
            }}
          />
        </label>

        {info && (
          <div className="probe-summary mono">
            <div className="probe-row">
              <span>Shape</span>
              <span>
                {info.levels[0]?.width} × {info.levels[0]?.height} px · {info.levels[0]?.bitsPerSample}-bit · {compression}
              </span>
            </div>
            <div className="probe-row">
              <span>Streamable</span>
              <span>{info.streamable ? "yes (byte-range reads)" : "no"}</span>
            </div>
            <div className="probe-row">
              <span>Overview levels</span>
              <span>
                {info.overviewCount} · {info.totalTiles} tiles total · {info.levels[0]?.tileWidth}×{info.levels[0]?.tileHeight} px tiles
              </span>
            </div>
            {info.bounds && (
              <div className="probe-row">
                <span>Bounds</span>
                <span>
                  {info.bounds.map((value) => value.toFixed(4)).join(", ")}
                </span>
              </div>
            )}
          </div>
        )}

        {preview && (
          <figure className="cog-preview">
            <canvas
              width={preview.resolution}
              height={preview.resolution}
              ref={(node) => {
                if (!node) return;
                const ctx = node.getContext("2d");
                if (!ctx) return;
                const pixels = thumbPixels(preview);
                ctx.putImageData(
                  new ImageData(pixels, preview.resolution, preview.resolution),
                  0,
                  0,
                );
              }}
            />
            <figcaption className="hint">
              Preview from overview level {preview.level} (
              {preview.levelWidth} × {preview.levelHeight} px).
            </figcaption>
          </figure>
        )}

        {error && <p className="hint hint--error">Probe failed. {error}</p>}

        <footer className="modal__footer">
          <span className="hint">
            Studio saves the URL and reads the DEM by byte range as needed.
          </span>
          <div className="modal__footer-actions">
            <button type="button" className="button" onClick={close}>
              Cancel
            </button>
            {!verified ? (
              <button
                type="button"
                className="button"
                disabled={probing || !url.trim()}
                onClick={() => void probe()}
              >
                {probing ? "Probing…" : "Probe"}
              </button>
            ) : (
              <button
                type="button"
                className="button button--primary"
                disabled={probing || busy}
                onClick={pick}
              >
                Open DEM
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
