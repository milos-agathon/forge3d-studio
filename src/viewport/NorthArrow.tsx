import * as THREE from "three";

type Quaternion = [number, number, number, number];

/** Camera heading (compass bearing, 0 = north, clockwise) and tilt below the
 *  horizon, in degrees. The viewport's terrain has north on -Z (row 0 of the
 *  DEM is the far edge) and east on +X. */
export function headingAndTilt(quaternion: Quaternion): { bearing: number; tilt: number } {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
    new THREE.Quaternion(quaternion[0], quaternion[1], quaternion[2], quaternion[3]),
  );
  const bearing = (THREE.MathUtils.radToDeg(Math.atan2(forward.x, -forward.z)) + 360) % 360;
  const tilt = THREE.MathUtils.radToDeg(Math.asin(Math.max(-1, Math.min(1, -forward.y))));
  return { bearing, tilt };
}

/**
 * Field Instrument compass: replaces the modelling XYZ gizmo on terrain
 * scenes. The needle points at map north on screen; the readout is the view's
 * bearing and tilt. Clicking turns the view to face north, keeping tilt and
 * distance.
 */
export function NorthArrow({
  quaternion,
  onNorth,
  disabled = false,
}: {
  quaternion: Quaternion;
  onNorth(): void;
  /** Fly mode and camera view own the camera: the turn cannot apply there. */
  disabled?: boolean;
}) {
  const { bearing, tilt } = headingAndTilt(quaternion);
  // One rounded, wrapped value for both the readout and the spoken label:
  // 359.8° is 000°, never "360 degrees".
  const shownBearing = Math.round(bearing) % 360;
  const action = disabled
    ? "Turning to north is unavailable in fly mode and camera view"
    : "Turn the view to face north";
  return (
    <button
      type="button"
      className="north-arrow"
      onClick={onNorth}
      disabled={disabled}
      title={action}
      aria-label={`Bearing ${shownBearing} degrees. ${action}`}
    >
      <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
        <circle className="north-arrow__ring" cx="24" cy="24" r="17" />
        <g className="north-arrow__ticks">
          <path d="M24 3v5M24 40v5M3 24h5M40 24h5" />
        </g>
        <g transform={`rotate(${-bearing} 24 24)`}>
          <path className="north-arrow__north" d="M24 9 29 24H19Z" />
          <path className="north-arrow__south" d="M24 39 29 24H19Z" />
          <text className="north-arrow__n" x="24" y="7.5" textAnchor="middle">
            N
          </text>
        </g>
      </svg>
      <span className="north-arrow__readout">
        <span>BRG {String(shownBearing).padStart(3, "0")}°</span>
        <span>TILT {Math.round(tilt)}°</span>
      </span>
    </button>
  );
}
