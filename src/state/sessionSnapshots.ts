import type { SessionState } from "../bridge/types";

type ClosedSession = Pick<SessionState, "sessionId">;
type SnapshotReply = SessionState | { state: SessionState };

export type SelectionInput = string[] | { pick: Promise<string[] | undefined>; isCurrent: () => boolean };

interface SelectionGesture {
  toggle: boolean;
  ids?: string[];
  write?: number;
  request?: Promise<unknown>;
}

function applySelection(selected: Set<string>, gesture: SelectionGesture) {
  if (!gesture.ids) return;
  if (!gesture.toggle) selected.clear();
  for (const id of gesture.ids) {
    if (gesture.toggle && selected.has(id)) selected.delete(id);
    else selected.add(id);
  }
}

/** Orders native snapshots before publishing them to React. */
export class SessionSnapshots {
  private sessionId = 0;
  private sequence = 0;
  private snapshot?: SessionState;
  private historyTail?: Promise<unknown>;
  private selectionOrder = 0;
  private lastSelectionWrite = 0;
  private selectionBase = new Set<string>();
  private pendingSelections: SelectionGesture[] = [];
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
    this.snapshot = snapshot ?? undefined;
    this.historyTail = undefined;
    this.selectionOrder = snapshot?.selectionOrder ?? 0;
    this.lastSelectionWrite = this.selectionOrder;
    this.pendingSelections = [];
    this.terrainGeneration = undefined;
    this.terrainReservation = Promise.resolve();
    this.relinkChoices.clear();
    this.publish(snapshot);
    return true;
  }

  // Preserve input order even when a WebView IPC request is delayed before
  // dispatch. A replacement project gets its own queue.
  orderHistory<T>(sessionId: number | undefined, send: (state: SessionState) => Promise<T>) {
    if (!this.owns(sessionId) || !this.snapshot) return Promise.resolve(undefined);
    const previous = this.historyTail;
    const request = previous
      ? previous.then(() => this.owns(sessionId) && this.snapshot ? send(this.snapshot) : undefined)
      : send(this.snapshot);
    const tail = request.then(() => {}, () => {});
    this.historyTail = tail;
    void tail.then(() => { if (this.historyTail === tail) this.historyTail = undefined; });
    return request;
  }

  async projectAfterHistory(sessionId: number) {
    await this.historyTail;
    return this.owns(sessionId) ? this.snapshot : undefined;
  }

  async select(sessionId: number | undefined, input: SelectionInput, toggle: boolean,
    send: (ids: string[], sessionId: number, order: number, revision: number) => Promise<SessionState>) {
    if (this.historyTail) await this.historyTail;
    if (!this.owns(sessionId) || !this.snapshot) return;
    const { project, revision } = this.snapshot;
    // Reserve the gesture's place before a viewport hit waits for the GPU.
    if (!this.pendingSelections.length) this.selectionBase = new Set(project.selection);
    const order = ++this.selectionOrder;
    const gesture: SelectionGesture = { toggle };
    this.pendingSelections.push(gesture);
    try {
      gesture.ids = Array.isArray(input) ? input : await input.pick;
      if (!gesture.ids) return;
      // A newer replacement can supersede this pick. If its native write
      // fails, the older gesture still belongs in the selection.
      for (;;) {
        const index = this.pendingSelections.indexOf(gesture);
        if (index < 0) return;
        const replacing = this.pendingSelections.slice(index + 1).find(g => !g.toggle && g.request);
        if (!replacing?.request) break;
        await replacing.request.catch(() => {});
      }
      if (!Array.isArray(input) && !input.isCurrent()) return;
      const next = new Set(this.selectionBase);
      for (const intent of this.pendingSelections) applySelection(next, intent);

      // A later toggle may already be visible in the tree. Publish the merged
      // selection with a fresh native write number while retaining input order.
      const write = order > this.lastSelectionWrite ? order : ++this.selectionOrder;
      gesture.write = write;
      this.lastSelectionWrite = write;
      gesture.request = this.forSession(sessionId)(id => send([...next], id, write, revision));
      await gesture.request;
    } catch (error) {
      gesture.write = undefined;
      throw error;
    } finally {
      gesture.request = undefined;
      const index = this.pendingSelections.indexOf(gesture);
      if (index >= 0 && gesture.write === undefined) this.pendingSelections.splice(index, 1);
      this.compactSelections();
    }
  }

  private compactSelections() {
    // An acknowledged toggle behind an unresolved pick still participates in
    // replay. Only fold the contiguous acknowledged prefix into the base.
    const acknowledged = this.snapshot?.selectionOrder ?? 0;
    // A confirmed replacement supplies a complete base even across a gap.
    for (let i = this.pendingSelections.length - 1; i > 0; i--) {
      const { toggle, write } = this.pendingSelections[i];
      if (!toggle && write !== undefined && write <= acknowledged) {
        this.pendingSelections.splice(0, i);
        break;
      }
    }
    let count = 0;
    for (const gesture of this.pendingSelections) {
      if (gesture.write === undefined || gesture.write > acknowledged) break;
      applySelection(this.selectionBase, gesture);
      count++;
    }
    this.pendingSelections.splice(0, count);
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
        let snapshot: SessionState = "state" in reply ? reply.state : reply;
        if (sessionId !== this.sessionId || snapshot.sessionId !== sessionId) return;
        // A committed relink still invalidates its bytes if a newer snapshot arrived first.
        onCommitted?.();
        if (snapshot.snapshotSequence > this.sequence) {
          const previous = this.snapshot;
          // Native view-state replies contain full project copies. Selection
          // and save leave the scene intact. A playhead seek can change object
          // transforms without an edit, including across a gap in the sequence.
          const selectionOnly = previous && snapshot.selectionOrder > previous.selectionOrder &&
            snapshot.snapshotSequence === this.sequence + 1;
          if (previous && snapshot.project.scene !== previous.project.scene &&
              snapshot.revision === previous.revision && (selectionOnly ||
              (snapshot.project.timeline?.currentFrame === previous.project.timeline?.currentFrame &&
               JSON.stringify(snapshot.project.scene) === JSON.stringify(previous.project.scene)))) {
            const { scene, assets, viewport, render, cartography } = previous.project;
            snapshot = { ...snapshot, project: { ...snapshot.project, scene, assets, viewport, render, cartography } };
          }
          this.sequence = snapshot.snapshotSequence;
          if (snapshot.revision !== this.snapshot?.revision || snapshot.selectionOrder > this.lastSelectionWrite) {
            this.pendingSelections = [];
          }
          this.snapshot = snapshot;
          this.selectionOrder = Math.max(this.selectionOrder, snapshot.selectionOrder);
          this.lastSelectionWrite = Math.max(this.lastSelectionWrite, snapshot.selectionOrder);
          this.compactSelections();
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
