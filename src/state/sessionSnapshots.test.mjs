import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionSnapshots } from "./sessionSnapshots.ts";

// The two files deliberately share all persisted IDs, and a reopen resets revision.
const a = { sessionId: 1, selectionOrder: 0, project: { id: "shared", selection: [], scene: {objects: [{id:"cube"},{id:"terrain"}]} }, path: "a.studio3d", revision: 0, snapshotSequence: 0 };
const b = { ...a, sessionId: 2, path: "b.studio3d" };

function start() {
  const published = [];
  const snapshots = new SessionSnapshots(state => published.push(state));
  snapshots.replace(a);
  return { snapshots, published, request: snapshots.forSession(a.sessionId) };
}

test("rapid selection toggles include pending clicks and reconcile out-of-order replies", async () => {
  const {snapshots,published} = start();
  const calls = [];
  function send(ids, sessionId, selectionOrder) {
    const pending = Promise.withResolvers();
    const snapshot = {...a, sessionId, selectionOrder, snapshotSequence: calls.length + 1, project: {...a.project, selection: ids}};
    calls.push({ ids, resolve: () => pending.resolve(snapshot) });
    return pending.promise;
  }
  const first = snapshots.select(a.sessionId, ["cube"], true, send);
  const second = snapshots.select(a.sessionId, ["terrain"], true, send);
  assert.deepEqual(calls.map(c=>c.ids), [["cube"],["cube","terrain"]]);
  calls[1].resolve();
  await second;
  calls[0].resolve();
  await first;
  assert.deepEqual(published.at(-1).project.selection, ["cube","terrain"]);
  const third = snapshots.select(a.sessionId, ["cube"], true, send);
  assert.deepEqual(calls[2].ids, ["terrain"]);
  snapshots.replace(b);
  const fourth = snapshots.select(b.sessionId, ["cube"], true, send);
  assert.deepEqual(calls[3].ids, ["cube"]);
  calls[2].resolve();
  calls[3].resolve();
  await Promise.all([third,fourth]);
  assert.equal(published.at(-1).sessionId,b.sessionId);
});

test("a slow viewport pick and a later tree gesture compose in input order", async () => {
  for (const toggle of [false, true]) {
    const { snapshots, published } = start();
    const pick = Promise.withResolvers(), calls = [];
    const send = async (ids, sessionId, selectionOrder) => {
      calls.push(ids);
      return {...a, sessionId, selectionOrder, snapshotSequence:calls.length, project:{...a.project,selection:ids}};
    };
    const viewport = snapshots.select(a.sessionId, { pick:pick.promise, isCurrent:() => true }, false, send);
    await snapshots.select(a.sessionId, ["terrain"], toggle, send);
    assert.deepEqual(published.at(-1).project.selection, ["terrain"]);
    pick.resolve(["cube"]);
    await viewport;
    assert.deepEqual(calls, toggle ? [["terrain"], ["cube","terrain"]] : [["terrain"]]);
    assert.deepEqual(published.at(-1).project.selection, toggle ? ["cube","terrain"] : ["terrain"]);
  }
});

test("a rejected tree replacement leaves a pending viewport gesture eligible", async () => {
  const { snapshots, published } = start();
  const pick = Promise.withResolvers(), write = Promise.withResolvers();
  const viewport = snapshots.select(a.sessionId, { pick:pick.promise, isCurrent:() => true }, false, async (ids, sessionId, selectionOrder) =>
    ({...a, sessionId, selectionOrder, snapshotSequence:1, project:{...a.project, selection:ids}}));
  const tree = snapshots.select(a.sessionId, ["missing"], false, () => write.promise);
  pick.resolve(["cube"]);
  await Promise.resolve();
  write.reject(new Error("object removed"));
  await assert.rejects(tree, /object removed/);
  await viewport;
  assert.deepEqual(published.at(-1).project.selection, ["cube"]);
});

test("a scene change retires a hit waiting for a later replacement to settle", async () => {
  const { snapshots } = start();
  const pick = Promise.withResolvers(), replacement = Promise.withResolvers();
  let current = true, sends = 0;
  const older = snapshots.select(a.sessionId, {pick:pick.promise,isCurrent:() => current}, false, () => sends++);
  const newer = snapshots.select(a.sessionId, ["missing"], false, () => replacement.promise);
  pick.resolve(["cube"]);
  await Promise.resolve();
  current = false;
  replacement.reject(new Error("object removed"));
  await assert.rejects(newer, /object removed/);
  await older;
  assert.equal(sends, 0);
});

test("selection shares scene inputs but a skipped playhead evaluation keeps its geometry", async () => {
  const { published, request } = start();
  const selected = structuredClone(a);
  selected.selectionOrder = selected.snapshotSequence = 1;
  selected.project.selection = ["cube"];
  await request(async () => selected);
  assert.equal(published.at(-1).project.scene, a.project.scene);
  assert.deepEqual(published.at(-1).project.selection, ["cube"]);

  const afterSeek = structuredClone(selected);
  afterSeek.selectionOrder++;
  afterSeek.snapshotSequence += 2;
  afterSeek.project.scene.objects[0].transform = { translation: { x: 2, y: 0, z: 0 } };
  await request(async () => afterSeek);
  assert.equal(published.at(-1).project.scene, afterSeek.project.scene);
});

test("undo acknowledges a held selection and removes its deleted object from the next toggle", async () => {
  const { snapshots, published } = start();
  const held = Promise.withResolvers();
  const first = snapshots.select(a.sessionId, ["cube"], false, () => held.promise);
  const accepted = { ...a, selectionOrder: 1, snapshotSequence: 1, project: { ...a.project, selection: ["cube"] } };
  const undone = { ...accepted, revision: 1, snapshotSequence: 2, project: { ...a.project, scene: { objects: [{ id: "terrain" }] } } };
  await snapshots.forSession(a.sessionId)(async () => undone);
  await snapshots.select(a.sessionId, ["terrain"], true, async (ids, sessionId, selectionOrder) => {
    assert.deepEqual(ids, ["terrain"]);
    return { ...undone, sessionId, selectionOrder, snapshotSequence: 3, project: { ...undone.project, selection: ids } };
  });
  held.resolve(accepted);
  await first;
  assert.deepEqual(published.at(-1).project.selection, ["terrain"]);
});

test("a failed selection leaves the next toggle based on the accepted selection", async () => {
  const { snapshots, published } = start();
  const commit = (ids, sessionId, selectionOrder) => Promise.resolve({
    ...a, sessionId, selectionOrder, snapshotSequence: published.length, project: { ...a.project, selection: ids },
  });
  await snapshots.select(a.sessionId, ["terrain"], false, commit);
  await assert.rejects(snapshots.select(a.sessionId, ["missing"], true,
    () => Promise.reject(new Error("object removed"))), /object removed/);
  await snapshots.select(a.sessionId, ["cube"], true, commit);
  assert.deepEqual(published.at(-1).project.selection, ["terrain", "cube"]);
});

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
