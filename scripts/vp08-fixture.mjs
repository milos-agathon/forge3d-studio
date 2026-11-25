import { until } from "./viewport-desktop.mjs";

export async function openFixture(cdp, path) {
  const ev = expr => cdp.evaluate(expr);
  await until(cdp, '!!document.querySelector(".menu__button")');
  await ev('localStorage.setItem("studio.viewport.mapGrid","0")');
  await ev('__TAURI_INTERNALS__.invoke("open_project", {path:'+JSON.stringify(path)+'})');
  await reload(cdp);
}

export async function reload(cdp) {
  const ev = expr => cdp.evaluate(expr);
  await ev("window.oldDocument=true");
  await cdp.send("Page.reload", {ignoreCache:true});
  await until(cdp, "!window.oldDocument && !!document.querySelector('.viewport')");
  await ev(`document.querySelector('.recovery button[aria-label="Dismiss"]')?.click();
    Object.assign(document.querySelector(".viewport").style,{boxSizing:"content-box",flex:"none",width:"794px",height:"727px"})`);
}
