import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { CUBE_ID, TERRAIN_ID } from "../vp01/fixture.mjs";
import { until } from "../viewport-desktop.mjs";

export async function terrainHierarchy(cdp, fixture, file, openProject) {
  const project = structuredClone(fixture);
  project.scene.objects.find(object => object.id === TERRAIN_ID).parent = CUBE_ID;
  await writeFile(file, JSON.stringify(project));
  await cdp.evaluate('localStorage.setItem("studio.viewport.renderer","three")');
  await openProject(cdp, file);

  const visible = `forge3dViewportDiagnostics().runtime?.objects.get("${TERRAIN_ID}")?.visible`;
  const toggle = id => cdp.evaluate(`document.querySelector('[data-object-id="${id}"] button.tree-action').click()`);
  const render = () => cdp.evaluate(`__TAURI_INTERNALS__.invoke("render_frame", {width:128,height:96,quality:"preview"})
    .then(frame => ({terrainId:frame.source.terrainId,width:frame.width,height:frame.height}), error => ({error:String(error)}))`);

  await until(cdp, `${visible} === true`);
  const shown = await render();
  assert.deepEqual(shown, {terrainId:TERRAIN_ID, width:128, height:96});
  await cdp.evaluate(`document.querySelector('button[title^="Rendered mode"]').click()`);
  await until(cdp, '!!document.querySelector(".viewport-rendered img")');
  await toggle(CUBE_ID);
  await until(cdp, `forge3dViewportDiagnostics().frame.objects.find(object => object.id === "${TERRAIN_ID}").visible === false`);
  assert.equal(await cdp.evaluate('!!document.querySelector(".viewport-rendered img")'), false);
  const hiddenParent = await render();
  assert.match(hiddenParent.error ?? "", /no visible terrain to render/);
  await cdp.evaluate(`document.querySelector('button[title^="Solid mode"]').click()`);
  await until(cdp, `${visible} === false`);
  await toggle(CUBE_ID);
  await until(cdp, `${visible} === true`);
  await toggle(TERRAIN_ID);
  await until(cdp, `${visible} === false`);
  const hiddenDirectly = await render();
  assert.deepEqual(hiddenParent, hiddenDirectly);
  return {shown, hiddenParent, hiddenDirectly};
}
