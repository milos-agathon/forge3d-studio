import assert from "node:assert/strict";
import { test } from "node:test";
import { PRESENTATION_PROBE_SCOPE, completedPresentationProbe, confirmedBlockedScreen, createPresentationProbe,
  displayThresholds, inspectBlockedScreen, measureCanvasContribution, measureDisplay, measureErrorPaint,
  measureImageryAlignment } from "./composition.mjs";

const background = [22, 22, 22, 255];
const ground = [190, 170, 150, 255];
const pink = [255, 0, 255, 255];
const size = { width: 8, height: 8 };
const cubeAt = (x, y) => x >= 2 && x < 6 && y >= 2 && y < 6;
const cube = Uint8Array.from({ length: 64 }, (_, p) => +cubeAt(p % 8, Math.floor(p / 8)));
const terrain = new Uint8Array(64).fill(1);

function frame(pixel, width = 11, height = 10) {
  const data = new Uint8Array(4 * width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    data.set(pixel(Math.floor(x * size.width / width), Math.floor(y * size.height / height)), 4 * (y * width + x));
  }
  return { data, width, height };
}

test("compositor coverage catches invisible layers with unchanged framebuffer masks", () => {
  const blank = frame(() => background);
  const terrainOnly = frame(() => ground);
  const stock = frame((x, y) => cubeAt(x, y) ? pink : ground);
  const cubeOnly = frame((x, y) => cubeAt(x, y) ? pink : background);
  const metrics = (visible, noCube) => measureDisplay({ stock: visible, noCube, noTerrain: blank }, cube, terrain, size, [3, 3]);
  const visible = metrics(stock, terrainOnly);
  assert.ok(visible.cubeFraction >= displayThresholds.cube);
  assert.ok(visible.terrainFraction >= displayThresholds.terrain);
  assert.equal(visible.clickVisible, true);
  assert.equal(metrics(terrainOnly, terrainOnly).clickVisible, false);
  assert.equal(metrics(terrainOnly, terrainOnly).cubeFraction, 0);
  assert.equal(metrics(cubeOnly, blank).terrainFraction, 0);
});

test("startup checks visible canvas contribution", () => {
  const blankStyledCanvas = frame(() => background);
  const undrawnStyledCanvas = frame(() => background);
  assert.equal(measureCanvasContribution(undrawnStyledCanvas, blankStyledCanvas).fraction, 0);
  assert.equal(measureCanvasContribution(frame(() => ground), blankStyledCanvas).fraction, 1);
});

test("the presentation probe suppresses and restores canvas, media, and CSS image paint", async () => {
  const nodes = [];
  const document = {
    defaultView: { getComputedStyle: element => ({
      opacity: element.style.getPropertyValue("opacity") || "1",
      backgroundImage: element.style.getPropertyValue("background-image") || element.decorativeBackground || "none",
    }) },
    querySelectorAll(selector) {
      assert.equal(selector, "*");
      return nodes;
    },
    createElement(tag) {
      const styles = new Map();
      return {
        ownerDocument: document, localName: tag, width: 300, height: 150, hidden: false, attributes: [],
        matches(selector) { return selector.split(",").includes(tag); },
        getAttribute(name) { return this.attributes.find(attribute => attribute.name === name)?.value ?? null; },
        setAttribute(name, value) { this.attributes.push({ name, value }); },
        style: {
          getPropertyValue(name) { return styles.get(name)?.value ?? ""; },
          getPropertyPriority(name) { return styles.get(name)?.priority ?? ""; },
          setProperty(name, value, priority) { styles.set(name, { value, priority }); },
        },
        replaceWith(canvas) { nodes[nodes.indexOf(this)] = canvas; },
      };
    },
  };
  const studio = document.createElement("canvas");
  studio.setAttribute("class", "viewport-canvas");
  const fallback = document.createElement("canvas");
  fallback.setAttribute("data-fallback-view", "true");
  fallback.setAttribute("style", "background-color: gray");
  fallback.bitmap = "rendered terrain";
  const preview = document.createElement("img");
  preview.setAttribute("src", "data:image/png;base64,opaque-pixels");
  preview.style.setProperty("opacity", "0.8", "");
  const viewport = document.createElement("div");
  viewport.setAttribute("class", "viewport");
  const gradient = "linear-gradient(rgb(0, 0, 0), rgb(22, 22, 22))";
  const images = `url("data:image/png;base64,opaque-pixels"), ${gradient}, image-set(url("a,b.png") 1x, url("b.png") 2x)`;
  viewport.style.setProperty("background-image", images, "important");
  const chrome = document.createElement("div");
  chrome.decorativeBackground = "repeating-radial-gradient(black, transparent 5px)";
  nodes.push(studio, fallback, preview, viewport, chrome);

  const probe = createPresentationProbe(document);
  assert.deepEqual(probe.inventory.map(surface => [surface.tag, surface.className, surface.backgroundImages]),
    [["canvas", "viewport-canvas", 0], ["canvas", null, 0], ["img", null, 0], ["div", "viewport", 2]]);
  assert.ok(!JSON.stringify(probe.inventory).includes("opaque-pixels"));
  await probe.blank();
  assert.notEqual(nodes[1], fallback);
  assert.deepEqual(nodes[1].attributes, fallback.attributes);
  assert.equal(nodes[1].bitmap, undefined);
  assert.equal(nodes[2], preview);
  assert.equal(preview.style.getPropertyValue("opacity"), "0");
  assert.equal(viewport.style.getPropertyValue("background-image"), `none, ${gradient}, none`);
  assert.equal(chrome.style.getPropertyValue("background-image"), "");
  const hasEvidence = () => completedPresentationProbe({
    presentationSurfaces: probe.inventory, presentationProbe: { scope: PRESENTATION_PROBE_SCOPE, ...probe.evidence() },
  });
  assert.equal(hasEvidence(), true);
  preview.style.setProperty("opacity", "1", "important");
  assert.equal(hasEvidence(), false);
  preview.style.setProperty("opacity", "0", "important");
  viewport.style.setProperty("background-image", "url(reintroduced.png)", "important");
  assert.equal(hasEvidence(), false);
  viewport.style.setProperty("background-image", `none, ${gradient}, none`, "important");
  nodes.push(document.createElement("canvas"));
  assert.equal(hasEvidence(), false);
  probe.restore();
  assert.deepEqual(nodes.slice(0, 3), [studio, fallback, preview]);
  assert.equal(preview.style.getPropertyValue("opacity"), "0.8");
  assert.equal(preview.style.getPropertyPriority("opacity"), "");
  assert.equal(viewport.style.getPropertyValue("background-image"), images);
  assert.equal(viewport.style.getPropertyPriority("background-image"), "important");
  assert.equal(completedPresentationProbe({ canvases: probe.inventory }), false);
});

test("matching screenshots alone cannot certify a blocked startup", () => {
  const problem = "WebGL is unavailable in this webview: THREE.WebGLRenderer: Error creating WebGL context.";
  const failureScreen = { problemVisible: true, unexpectedLayers: [] };
  assert.equal(confirmedBlockedScreen({ problem, failureScreen }, { changed: 1 }), true);
  assert.equal(confirmedBlockedScreen({ problem, failureScreen }, { changed: 0 }), false);
  assert.equal(confirmedBlockedScreen({ problem, failureScreen: { ...failureScreen, problemVisible: false } }, { changed: 1 }), false);
  assert.equal(confirmedBlockedScreen({ problem, failureScreen: { ...failureScreen, unexpectedLayers: [{ tag: "div" }] } },
    { changed: 1 }), false);
});

test("the presentation probe leaves decorative generated paint in the blocked viewport", async () => {
  const pseudos = {
    "::before": { content: '""', backgroundImage: "none", backgroundColor: "rgb(84, 84, 84)" },
    "::after": { content: '"url(decoration.png)"', backgroundImage: "linear-gradient(red, transparent)" },
  };
  const surface = { matches: () => false, localName: "div", getAttribute: () => "viewport" };
  const document = {
    querySelectorAll: () => [surface],
    defaultView: { getComputedStyle: (_element, pseudo) => pseudos[pseudo] ?? { backgroundImage: "none" } },
  };
  surface.ownerDocument = document;

  const probe = createPresentationProbe(document);
  assert.deepEqual(probe.inventory, []);
  await probe.blank();
  assert.deepEqual(probe.evidence(), { suppressed: 0, stable: true });
  probe.restore();
});

test("the presentation probe suppresses generated images and preserves their box paint", async () => {
  let ruleTakesEffect = true;
  const loaded = [];
  const document = {
    adoptedStyleSheets: [],
    defaultView: {
      CSSStyleSheet: class {
        replaceSync(rules) { this.rules = rules; }
      },
      Image: class {
        naturalWidth = 60;
        naturalHeight = 45;
        async decode() {
          loaded.push(this.src);
          if (this.src === "broken.png") throw Error("Image did not decode");
        }
      },
      getComputedStyle(element, pseudo) {
        if (!pseudo) return { backgroundImage: "none" };
        const marker = element.getAttribute?.("data-vp01-presentation-index");
        const rule = root.adoptedStyleSheets.flatMap(sheet => sheet.rules?.split("\n") ?? [])
          .find(line => ruleTakesEffect && line.includes(`="${marker}"]${pseudo}`));
        const paint = element.pseudos[pseudo];
        return { ...paint, opacity: rule?.includes("opacity: 0") ? "0" : "1",
          content: rule?.match(/(?:^|\s)content: (.*?) !important/)?.[1] ?? paint?.content,
          backgroundImage: rule?.match(/background-image: (.*?) !important/)?.[1] ?? paint?.backgroundImage };
      },
    },
    querySelectorAll: () => [host],
  };
  const existingSheet = {};
  const root = { ownerDocument: document, adoptedStyleSheets: [existingSheet], querySelectorAll: () => [surface] };
  const host = {
    ownerDocument: document, shadowRoot: root, matches: () => false, getRootNode: () => document,
    pseudos: { "::before": { content: "none", backgroundImage: 'url("unused.png")' } },
  };
  const attrs = new Map([["class", "viewport"]]);
  const gradient = "linear-gradient(red, transparent)";
  const surface = {
    ownerDocument: document, localName: "div", matches: () => false, getRootNode: () => root,
    getAttribute: name => attrs.get(name) ?? null, setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: name => attrs.delete(name),
    pseudos: {
      "::before": { content: '""', backgroundImage: `url("data:image/png;base64,pixels"), ${gradient}` },
      "::after": { content: 'url("data:image/png;base64,pixels") / "Preview"', backgroundImage: "none",
        backgroundColor: "rgb(84, 84, 84)", width: "60px", height: "45px" },
    },
  };
  const probe = createPresentationProbe(document);
  assert.deepEqual(probe.inventory.map(entry => entry.generatedPseudos), [["::before", "::after"]]);
  assert.ok(!JSON.stringify(probe.inventory).includes("base64"));
  await probe.blank();
  const before = document.defaultView.getComputedStyle(surface, "::before");
  assert.equal(before.backgroundImage, `none, ${gradient}`);
  assert.equal(before.opacity, "1");
  const after = document.defaultView.getComputedStyle(surface, "::after");
  assert.equal(after.opacity, "1");
  assert.equal(after.backgroundColor, "rgb(84, 84, 84)");
  assert.deepEqual([after.width, after.height], ["60px", "45px"]);
  assert.ok(after.content.endsWith(' / "Preview"'));
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0], "data:image/png;base64,pixels");
  assert.equal(decodeURIComponent(loaded[1]), 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="60" height="45"/>');
  assert.equal(probe.evidence().stable, true);
  ruleTakesEffect = false;
  assert.equal(probe.evidence().stable, false);
  ruleTakesEffect = true;
  surface.pseudos["::after"].height = "30px";
  assert.equal(probe.evidence().stable, false);
  probe.restore();
  assert.deepEqual([...attrs], [["class", "viewport"]]);
  assert.deepEqual(root.adoptedStyleSheets, [existingSheet]);
  assert.deepEqual(document.adoptedStyleSheets, []);

  surface.pseudos["::after"].height = "45px";
  const description = ' / "Preview url(leave-this.png)"';
  surface.pseudos["::after"].content = `-webkit-cross-fade(url("render.png"), ${gradient}, 10%)${description}`;
  const blended = createPresentationProbe(document);
  assert.deepEqual(blended.inventory.map(entry => entry.generatedPseudos), [["::before", "::after"]]);
  assert.equal(await blended.blank(), true);
  assert.equal(document.defaultView.getComputedStyle(surface, "::after").content,
    `-webkit-cross-fade(url("${loaded[3]}"), ${gradient}, 10%)${description}`);
  assert.equal(loaded[2], "render.png");
  assert.equal(loaded.length, 4);
  assert.equal(blended.evidence().stable, true);
  blended.restore();

  surface.pseudos["::after"].content = 'url("broken.png")';
  const broken = createPresentationProbe(document);
  assert.equal(await broken.blank(), false);
  assert.equal(broken.evidence().stable, false);
  assert.deepEqual([...attrs], [["class", "viewport"]]);
  assert.deepEqual(root.adoptedStyleSheets, [existingSheet]);
});

test("error paint must intersect the viewport and produce a local PNG difference", () => {
  const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
  const viewportBox = rect(20, 40, 28, 48);
  const viewport = { getBoundingClientRect: () => viewportBox, querySelector: () => error, children: [] };
  const document = { defaultView: { getComputedStyle: () => ({ visibility: "visible", opacity: "1" }) } };
  let bounds = rect(20, 49, 24, 51);
  const error = { parentElement: viewport, getBoundingClientRect: () => ({ ...bounds, toJSON: () => bounds }) };
  const inspect = () => inspectBlockedScreen(document, viewport);
  const size = { css: { x: 20, y: 40, width: 8, height: 8 }, dpr: 1.25 };
  const blank = frame(() => background, 10, 10);
  const stock = frame((x, y) => x < 4 && y < 4 ? ground : background, 10, 10);
  assert.equal(inspect().problemVisible, false);
  assert.deepEqual(measureErrorPaint(stock, blank, size, inspect().problemBounds), { changed: 0, pixels: 0 });
  bounds = rect(19, 39, 24, 44);
  assert.equal(inspect().problemVisible, true);
  assert.deepEqual(measureErrorPaint(stock, blank, size, inspect().problemBounds), { changed: 25, pixels: 25 });
  bounds = rect(24, 44, 28, 48);
  assert.equal(inspect().problemVisible, true);
  assert.deepEqual(measureErrorPaint(stock, blank, size, inspect().problemBounds), { changed: 0, pixels: 25 });
});

test("terrain display distinguishes misplaced geometry and a flat replacement inside the correct footprint", () => {
  const blank = frame(() => background, 8, 8);
  const texture = (x, y) => [70 + 20 * x, 80 + 10 * y, 60 + 10 * (x + y), 255];
  const footprints = Uint8Array.from(cube);
  const measure = stock => measureDisplay({ stock, noCube: stock, noTerrain: blank }, new Uint8Array(64), footprints, size);
  const reference = measure(frame((x, y) => cubeAt(x, y) ? texture(x, y) : background, 8, 8));
  const flat = measure(frame((x, y) => cubeAt(x, y) ? ground : background, 8, 8));
  const shifted = measure(frame((x, y) => cubeAt(x - 2, y) ? texture(x - 2, y) : background, 8, 8));
  assert.equal(reference.silhouette.iou, 1);
  assert.equal(flat.silhouette.iou, 1);
  assert.ok(shifted.silhouette.iou < displayThresholds.terrainIou);
  const testAlignment = result => measureImageryAlignment(reference.imagery, result.imagery, size).directions;
  assert.ok(testAlignment(reference).every(axis => axis.cosine === 1 && axis.contrastRatio === 1));
  assert.ok(testAlignment(flat).every(axis => axis.cosine === 0 && axis.contrastRatio === 0));
});

test("terrain display samples account for measured Studio chrome", () => {
  const terrainWithReadout = frame(x => x < 2 ? background : ground, 8, 8);
  const raw = measureDisplay({ stock: terrainWithReadout, noCube: terrainWithReadout, noTerrain: frame(() => background, 8, 8) },
    new Uint8Array(64), terrain, size, null, { css: size, chrome: [{ x: 0, y: 0, width: 2, height: 8 }] });
  assert.equal(raw.chromeTerrain, 6);
  assert.equal(raw.terrainFraction, 1);
  assert.equal(raw.chromeFraction, 1 / 6);
});

test("terrain color comparison catches a channel swap with identical spatial contrast", () => {
  const blank = frame(() => background, 8, 8);
  const sample = color => {
    const stock = frame((x, y) => color(4 * x + 3 * y), 8, 8);
    return measureDisplay({ stock, noCube: stock, noTerrain: blank }, new Uint8Array(64), terrain, size).imagery;
  };
  const field = sample(tone => [120 + tone, 90 + tone, 60 + tone, 255]);
  const healthy = sample(tone => [132 + tone, 102 + tone, 72 + tone, 255]);
  const swapped = sample(tone => [60 + tone, 90 + tone, 120 + tone, 255]);
  const compare = candidate => measureImageryAlignment(field, candidate, size);
  const aligned = compare(healthy);
  const altered = compare(swapped);
  assert.deepEqual(aligned.directions, altered.directions);
  assert.deepEqual(aligned.color, { samples: 36, different: 0, fraction: 0 });
  assert.deepEqual(altered.color, { samples: 36, different: 36, fraction: 1 });
});
