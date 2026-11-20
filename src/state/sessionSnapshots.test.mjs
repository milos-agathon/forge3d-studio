import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionSnapshots } from "./sessionSnapshots.ts";

// The two files deliberately share all persisted IDs, and a reopen resets revision.
const a = { sessionId: 1, project: { id: "shared" }, path: "a.studio3d", revision: 0, snapshotSequence: 0 };
const b = { ...a, sessionId: 2, path: "b.studio3d" };

function start() {
  const published = [];
  const snapshots = new SessionSnapshots(state => published.push(state));
  snapshots.replace(a);
  return { snapshots, published, request: snapshots.forSession(a.sessionId) };
}

test("a late Open or Close cannot replace the most recent native session", async () => {
  const { snapshots, published } = start();
  const earlierOpen = Promise.withResolvers();
  const opening = earlierOpen.promise.then(reply => snapshots.replace(reply));
  const reopened = { ...a, sessionId: 4 };
  assert.equal(snapshots.replace(reopened), true);
  earlierOpen.resolve(b);
  assert.equal(await opening, false);
  assert.equal(snapshots.replace({ sessionId: 3 }), false);
  assert.deepEqual(published, [a, reopened]);
  assert.equal(snapshots.replace({ sessionId: 5 }), true);
  assert.equal(snapshots.replace(reopened), false);
  assert.equal(published.at(-1), null);
});

test("a relink waiting for file size cannot send an edit after replacing its session", async () => {
  const { snapshots, request, published } = start();
  const size = Promise.withResolvers();
  let issued = false;
  const relink = size.promise.then(() => request(async () => {
    issued = true;
    return { state: { ...b, revision: 1 } };
  }));
  snapshots.replace(b);
  size.resolve(37088);
  assert.equal(await relink, undefined);
  assert.equal(issued, false);
  assert.deepEqual(published, [a, b]);
});

test("an inactive DEM can be relinked after a newer import becomes active", async () => {
  const { snapshots } = start();
  const reserve = async (_sessionId, assetId) => {
    assert.equal(assetId, "former-dem");
    return null;
  };
  const choice = await snapshots.prepareSourceChange(a.sessionId, reserve, () => 37088, "former-dem");
  assert.equal(choice.value, 37088);
  assert.equal(choice.generation, undefined);
  assert.equal(choice.isCurrent(), true);
});

test("relinks supersede choices for the same asset while other assets finish independently", async () => {
  const { snapshots } = start();
  const reserve = async () => null;
  const stat = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const earlier = snapshots.prepareSourceChange(a.sessionId, reserve, () => {
    entered.resolve();
    return stat.promise;
  }, "drape");
  await entered.promise;
  const other = await snapshots.prepareSourceChange(a.sessionId, reserve, () => "texture", "texture");
  const latest = await snapshots.prepareSourceChange(a.sessionId, reserve, () => "new.tif", "drape");
  stat.resolve("old.tif");
  assert.equal(await earlier, undefined);
  assert.equal(latest.value, "new.tif");
  assert.equal(latest.isCurrent(), true);
  assert.equal(other.isCurrent(), true);
  snapshots.replace(b);
  assert.equal(latest.isCurrent(), false);
  assert.equal(other.isCurrent(), false);
});

test("only a relink of the active DEM supersedes a pending terrain import", async () => {
  const { snapshots } = start();
  let generation = 0;
  const reserve = async (_sessionId, assetId) =>
    assetId === undefined || assetId === "active-dem" ? ++generation : null;
  const lookup = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const importing = snapshots.prepareSourceChange(a.sessionId, reserve, () => {
    entered.resolve();
    return lookup.promise;
  });
  await entered.promise;
  const imagery = await snapshots.prepareSourceChange(a.sessionId, reserve, () => 27830, "drape");
  assert.equal(generation, 1);
  const demStat = Promise.withResolvers();
  const demStatEntered = Promise.withResolvers();
  const relink = snapshots.prepareSourceChange(a.sessionId, reserve, () => {
    demStatEntered.resolve();
    return demStat.promise;
  }, "active-dem");
  await demStatEntered.promise;
  lookup.resolve("dataset.tif");
  assert.equal(await importing, undefined);
  assert.equal(imagery.isCurrent(), true);
  demStat.resolve(37088);
  assert.equal((await relink).generation, 2);
});

test("a superseded DEM import leaves the current snapshot in place", async () => {
  const { request, published } = start();
  assert.equal(await request(async () => null), undefined);
  assert.deepEqual(published, [a]);
});

test("an older playhead reply cannot replace a newer snapshot at the same edit revision", async () => {
  const { request, published } = start();
  const held = Promise.withResolvers();
  const first = request(() => held.promise);
  const early = { state: { ...a, snapshotSequence: 1 }, frame: 12 };
  const latest = { state: { ...a, snapshotSequence: 2 }, frame: 48 };
  await request(async () => latest);
  held.resolve(early);
  await first;
  assert.deepEqual(published, [a, latest.state]);
});

test("older same-session edits return their results without publishing their snapshots", async () => {
  const { snapshots, request, published } = start();
  const selection = Promise.withResolvers();
  const edit = Promise.withResolvers();
  const selecting = request(() => selection.promise);
  let invalidations = 0;
  const editing = request(() => edit.promise, () => invalidations++);
  const latest = { ...a, revision: 2, snapshotSequence: 3 };
  await request(async () => ({ state: latest }));
  selection.resolve(a);
  const committed = {
    state: { ...a, revision: 1, snapshotSequence: 2 },
    applied: { affected: ["sphere"], revision: 1 },
  };
  edit.resolve(committed);
  assert.equal(await selecting, a);
  assert.equal(await editing, committed, "the caller keeps the affected IDs");
  assert.equal(invalidations, 1, "the earlier committed relink still invalidates cached bytes");
  assert.deepEqual(published, [a, latest]);

  const selected = {
    ...latest,
    snapshotSequence: 4,
    project: { ...latest.project, selection: ["terrain"] },
  };
  await request(async () => selected);
  assert.equal(published.at(-1), selected, "view-only updates can share a revision");
  snapshots.initialize(a);
  assert.equal(published.at(-1), selected, "a late startup reply cannot roll back an edit");

  const held = Promise.withResolvers();
  const pending = request(() => held.promise, () => invalidations++);
  snapshots.replace(b);
  held.resolve({ state: { ...a, revision: 3, snapshotSequence: 5 } });
  assert.equal(await pending, undefined);
  assert.equal(invalidations, 1);
  assert.equal(published.at(-1), b);
});
