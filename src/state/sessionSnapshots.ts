import type { SessionState } from "../bridge/types";

type ClosedSession = Pick<SessionState, "sessionId">;
type SnapshotReply = SessionState | { state: SessionState };

/** Orders native snapshots before publishing them to React. */
export class SessionSnapshots {
  private sessionId = 0;
  private sequence = 0;
  private terrainGeneration: number | undefined;
  private terrainReservation: Promise<unknown> = Promise.resolve();
  private readonly relinkChoices = new Map<string, symbol>();
  private readonly publish: (snapshot: SessionState | null) => void;

  constructor(publish: (snapshot: SessionState | null) => void) {
    this.publish = publish;
  }

  owns(sessionId: number | undefined): sessionId is number {
    return sessionId !== undefined && sessionId === this.sessionId;
  }

  initialize(snapshot: SessionState | null): void {
    if (this.sessionId === 0 && snapshot) this.replace(snapshot);
  }

  replace(reply: SessionState | ClosedSession): boolean {
    if (reply.sessionId <= this.sessionId) return false;
    const snapshot = "project" in reply ? reply : null;
    this.sessionId = reply.sessionId;
    this.sequence = snapshot?.snapshotSequence ?? 0;
    this.terrainGeneration = undefined;
    this.terrainReservation = Promise.resolve();
    this.relinkChoices.clear();
    this.publish(snapshot);
    return true;
  }

  async prepareSourceChange<T>(
    sessionId: number | undefined,
    reserve: (sessionId: number, assetId?: string) => Promise<number | null>,
    prepare: () => T | Promise<T>,
    assetId?: string,
  ): Promise<{ value: T; generation: number | undefined; isCurrent: () => boolean } | undefined> {
    if (!this.owns(sessionId)) return;
    const choice = Symbol();
    if (assetId !== undefined) this.relinkChoices.set(assetId, choice);
    let generation: number | null | undefined;
    const isCurrent = () =>
      this.owns(sessionId) &&
      (assetId === undefined || this.relinkChoices.get(assetId) === choice) &&
      (typeof generation !== "number" || generation === this.terrainGeneration);

    // Serialize only the native reservations. A relink reserves a terrain generation
    // only if its asset is the active DEM when Rust receives the chosen file's request.
    const reservation = this.terrainReservation.then(async () => {
      if (!isCurrent()) return;
      const reserved = await reserve(sessionId, assetId);
      if (reserved !== null && this.owns(sessionId)) this.terrainGeneration = reserved;
      return reserved;
    });
    this.terrainReservation = reservation.catch(() => undefined);

    try {
      generation = await reservation;
      if (generation === undefined || (generation === null && assetId === undefined) || !isCurrent()) return;
      const value = await prepare();
      if (typeof generation === "number" && this.owns(sessionId)) await this.terrainReservation;
      if (isCurrent()) return { value, generation: generation ?? undefined, isCurrent };
    } catch (cause) {
      if (isCurrent()) throw cause;
    }
  }

  // An action keeps this binding across a file picker, file stat or dataset lookup.
  forSession(sessionId: number | undefined) {
    return async <T extends SnapshotReply>(
      send: (sessionId: number) => Promise<T | null>,
      onCommitted?: () => void,
    ): Promise<T | undefined> => {
      if (!this.owns(sessionId)) return;
      try {
        const reply = await send(sessionId);
        if (reply === null) return;
        const snapshot: SessionState = "state" in reply ? reply.state : reply;
        if (sessionId !== this.sessionId || snapshot.sessionId !== sessionId) return;
        // A committed relink still invalidates its bytes if a newer snapshot arrived first.
        onCommitted?.();
        if (snapshot.snapshotSequence > this.sequence) {
          this.sequence = snapshot.snapshotSequence;
          this.publish(snapshot);
        }
        // Callers still need the result of a committed command, such as the IDs to select.
        return reply;
      } catch (cause) {
        if (sessionId === this.sessionId) throw cause;
      }
    };
  }
}
