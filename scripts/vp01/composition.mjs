import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { decodePng } from "../../node_modules/@forge3d/web/dist/png-decode.js";

export const displayThresholds = {
  cube: 0.9, terrain: 0.9, terrainIou: 0.97, imageryCosine: 0.7, minimumImageryContrast: 0.5,
  maximumChromeCoverage: 0.25, channelDelta: 24, maximumColorMismatch: 0.2, liveViewport: 0.01,
};

export const PRESENTATION_PROBE_SCOPE = "document-presentation-preserving-generated-boxes";
const presentationScopes = new Set([PRESENTATION_PROBE_SCOPE,
  "document-presentation-including-generated-images", "document-presentation-including-generated-paint"]);

export function completedPresentationProbe(startup) {
  const probe = startup.presentationProbe;
  return Array.isArray(startup.presentationSurfaces) && presentationScopes.has(probe?.scope) &&
    probe.stable === true && probe.suppressed === startup.presentationSurfaces.length;
}

export function confirmedBlockedScreen(startup, errorPaint) {
  return typeof startup.problem === "string" && startup.problem.startsWith("WebGL is unavailable in this webview:") &&
    errorPaint?.changed > 0 &&
    startup.failureScreen?.problemVisible === true && Array.isArray(startup.failureScreen.unexpectedLayers) &&
    startup.failureScreen.unexpectedLayers.length === 0;
}

// Only the known chrome of the pinned Material viewport can pass as the
// blocked failure screen. Unfamiliar visible layers make it inconclusive
// even if their pixels are not produced by a canvas or media element.
export function inspectBlockedScreen(document, viewport) {
  const chrome = [
    "canvas", ".viewport-toolbar", ".viewport-instruments", ".viewport-overlay--bottom",
    ".viewport-problem", ".viewport-plate-frame", ".viewport-attribution", ".axis-gizmo",
  ].join(",");
  function visible(element) {
    if (!element) return false;
    const box = element.getBoundingClientRect();
    const crop = viewport.getBoundingClientRect();
    if (Math.min(box.right, crop.right) <= Math.max(box.left, crop.left) ||
        Math.min(box.bottom, crop.bottom) <= Math.max(box.top, crop.top)) return false;
    if (document.defaultView.getComputedStyle(element).visibility !== "visible") return false;
    for (let node = element; node; node = node.parentElement) {
      const style = document.defaultView.getComputedStyle(node);
      if (style.display === "none" || Number(style.opacity) === 0) return false;
    }
    return true;
  }
  const problem = viewport.querySelector(".viewport-problem");
  return {
    problemBounds: problem?.getBoundingClientRect().toJSON() ?? null,
    problemVisible: visible(problem),
    unexpectedLayers: [...viewport.children].filter(element => !element.matches(chrome) && visible(element))
      .map(element => ({ tag: element.localName, className: element.getAttribute("class") })),
  };
}

// Serialized into the Studio document. The CDP screenshot crop determines
// which surface pixels contribute, including surfaces mounted via portals.
export function createPresentationProbe(document) {
  const tags = "canvas,img,video,image,object,embed";
  const pseudos = ["::before", "::after"];
  const probeAttribute = "data-vp01-presentation-index";
  const styleOf = (element, pseudo) => element.ownerDocument.defaultView.getComputedStyle(element, pseudo);
  function withoutImages(background) {
    // CSSOM serializes image functions, URLs and gradients with internal commas.
    const layers = [];
    let start = 0;
    let depth = 0;
    let quote;
    for (let i = 0; i < background.length; i++) {
      const char = background[i];
      if (char === "\\") i++;
      else if (quote) {
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "(") depth++;
      else if (char === ")") depth--;
      else if (char === "," && depth === 0) {
        layers.push(background.slice(start, i).trim());
        start = i + 1;
      }
    }
    layers.push(background.slice(start).trim());
    const stripped = layers.map(layer => /^(?:none$|(?:repeating-)?(?:linear|radial|conic)-gradient\()/i.test(layer)
      ? layer : "none");
    return { value: stripped.join(", "), count: layers.filter((layer, i) => layer !== stripped[i]).length };
  }
  function contentImages(content) {
    // CSSOM quotes URL values. Consume quoted text separately to find URL
    // tokens in image functions while leaving displayed and alternative text intact.
    const tokens = /url\("((?:\\.|[^"\\])*)"\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:url|(?:-webkit-)?image-set)\(/gi;
    const urls = [];
    let imageContent = false;
    for (const match of content.matchAll(tokens)) {
      if (match[1] !== undefined) urls.push(match);
      if (match[0][0] !== '"' && match[0][0] !== "'") imageContent = true;
    }
    return { urls, imageContent };
  }
  function generatedPaint(element, retained) {
    return pseudos.flatMap(pseudo => {
      const { content, opacity, backgroundColor, backgroundImage, width, height } = styleOf(element, pseudo);
      if (!content || content === "none" || content === "normal") return [];
      const background = backgroundImage || "none";
      const masked = withoutImages(background);
      const { urls, imageContent } = contentImages(content);
      return imageContent || masked.count || retained?.some(entry => entry.pseudo === pseudo)
        ? [{ pseudo, content, opacity, backgroundColor, background, width, height, masked, urls, imageContent }] : [];
    });
  }
  async function decodedImage(Image, url) {
    const image = new Image();
    image.src = url;
    let timer;
    try {
      await Promise.race([image.decode(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Generated content image did not decode")), 5000);
      })]);
      return image;
    } finally {
      clearTimeout(timer);
    }
  }
  async function transparentContent(element, { content, urls }) {
    const { Image } = element.ownerDocument.defaultView;
    if (!urls.length) return null;
    try {
      const transparent = await Promise.all(urls.map(async ([, source]) => {
        const url = source.replace(/\\(?:([a-f\d]{1,6})[ \t\n\f\r]?|(.)?)/gi, (_, hex, char) => {
          if (!hex) return char ?? "";
          const point = Number.parseInt(hex, 16);
          return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "\ufffd";
        });
        const { naturalWidth: width, naturalHeight: height } = await decodedImage(Image, url);
        if (!width || !height) throw Error("Generated content image has no intrinsic size");
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`;
        const blank = `data:image/svg+xml,${encodeURIComponent(svg)}`;
        await decodedImage(Image, blank);
        return `url("${blank}")`;
      }));
      let result = "";
      let start = 0;
      for (const [i, match] of urls.entries()) {
        result += content.slice(start, match.index) + transparent[i];
        start = match.index + match[0].length;
      }
      return result + content.slice(start);
    } catch {
      return null;
    }
  }
  function collect(root) {
    const elements = [];
    for (const element of root.querySelectorAll("*")) {
      elements.push(element);
      for (const nested of [element.shadowRoot, element.contentDocument]) {
        if (nested) elements.push(...collect(nested));
      }
    }
    return elements;
  }
  function inventory(retained = new Map()) {
    return collect(document).flatMap(element => {
      const media = element.matches(tags);
      const background = styleOf(element).backgroundImage || "none";
      const masked = withoutImages(background);
      const generated = generatedPaint(element, retained.get(element));
      return media || masked.count || generated.length || retained.has(element)
        ? [{ element, media, background, masked, generated }] : [];
    });
  }
  function override({ style }, name, value) {
    const previous = style.getPropertyValue(name);
    const priority = style.getPropertyPriority(name);
    style.setProperty(name, value, "important");
    return () => style.setProperty(name, previous, priority);
  }
  const originals = inventory();
  function matches(found, expected) {
    return found.length === expected.length && found.every(({ element, background, generated }, i) => {
      const previous = expected[i];
      return element === previous.element && background === previous.background && generated.length === previous.generated.length &&
        generated.every(({ pseudo, content, opacity, background, backgroundColor, width, height }, j) => {
          const old = previous.generated[j];
          return pseudo === old.pseudo && content === old.content && opacity === old.opacity && background === old.background &&
            backgroundColor === old.backgroundColor && width === old.width && height === old.height;
        });
    });
  }
  const suppressed = [];
  const stylesheets = new Map();
  return {
    inventory: originals.map(({ element: surface, masked, generated }) => ({
      tag: surface.localName, className: surface.getAttribute("class"),
      width: surface.width, height: surface.height, hidden: surface.hidden, backgroundImages: masked.count,
      generatedPseudos: generated.map(entry => entry.pseudo),
    })),
    async blank() {
      const images = originals.flatMap(({ element, generated }) => generated.filter(paint => paint.imageContent)
        .map(async paint => [paint, await transparentContent(element, paint)]));
      const replacements = new Map(await Promise.all(images));
      if ([...replacements.values()].includes(null) || !matches(inventory(), originals)) return false;
      const rulesByRoot = new Map();
      for (const { element: surface, media, masked, generated } of originals) {
        let used = false;
        const restores = [];
        const entry = {
          element: surface, background: masked.value,
          generated: generated.map(paint => ({ ...paint, background: paint.masked.value, content: replacements.get(paint) ?? paint.content })),
          isSuppressed: () => !used && (!media || surface.localName === "canvas" || Number(styleOf(surface).opacity) === 0),
          restore: () => restores.reverse().forEach(restore => restore()),
        };
        const index = suppressed.push(entry) - 1;
        if (surface.localName === "canvas") {
          // Keep canvas layout and its decorative CSS paint.
          const blank = surface.ownerDocument.createElement("canvas");
          for (const { name, value } of surface.attributes) blank.setAttribute(name, value);
          for (const method of ["getContext", "transferControlToOffscreen"]) {
            const original = blank[method];
            if (typeof original !== "function") continue;
            blank[method] = function (...args) {
              used = true;
              return original.apply(this, args);
            };
          }
          surface.replaceWith(blank);
          entry.element = blank;
          restores.push(() => blank.replaceWith(surface));
        } else if (media) {
          // Keep media mounted and preserve its layout during the screenshot.
          restores.push(override(surface, "opacity", "0"));
        }
        const { element } = entry;
        if (masked.count) restores.push(override(element, "background-image", masked.value));
        if (!generated.length) continue;

        const root = element.getRootNode();
        const rules = rulesByRoot.get(root) ?? [];
        rulesByRoot.set(root, rules);
        const previous = element.getAttribute(probeAttribute);
        element.setAttribute(probeAttribute, String(index));
        restores.push(() => previous === null ? element.removeAttribute(probeAttribute) : element.setAttribute(probeAttribute, previous));
        for (const paint of generated) {
          // Swap image pixels while retaining the pseudo-element's box and paint.
          const { pseudo, masked: images } = paint;
          const background = images.count ? `background-image: ${images.value} !important;` : "";
          const content = paint.imageContent ? `content: ${replacements.get(paint)} !important;` : "";
          rules.push(`[${probeAttribute}="${index}"]${pseudo} { ${background} ${content} transition: none !important; }`);
        }
      }
      for (const [root, rules] of rulesByRoot) {
        const { defaultView } = root.ownerDocument ?? root;
        const sheet = new defaultView.CSSStyleSheet();
        sheet.replaceSync(rules.join("\n"));
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
        stylesheets.set(root, sheet);
      }
      return true;
    },
    evidence() {
      const retained = new Map(suppressed.map(entry => [entry.element, entry.generated]));
      const found = inventory(retained);
      return { suppressed: suppressed.length, stable: suppressed.length === originals.length &&
        matches(found, suppressed) && suppressed.every(entry => entry.isSuppressed()) };
    },
    restore() {
      for (const entry of suppressed) entry.restore();
      for (const [root, sheet] of stylesheets) {
        root.adoptedStyleSheets = root.adoptedStyleSheets.filter(current => current !== sheet);
      }
    },
  };
}

export async function readFrame(dir, entry, viewport) {
  if (typeof entry?.png !== "string" || entry.png !== basename(entry.png) || !entry.png.endsWith(".png")) {
    throw Error("Expected a saved viewport PNG filename");
  }
  const frame = decodePng(await readFile(join(dir, entry.png)));
  const { width, height } = frame;
  if (entry.dimensions?.width !== width || entry.dimensions?.height !== height) throw Error("PNG dimensions differ from manifest");
  if (["width", "height"].some(key => Math.abs(frame[key] - viewport.css[key] * viewport.dpr) > 1)) {
    throw Error("PNG dimensions differ from the CSS crop at the window DPR");
  }
  return frame;
}

function sameDimensions(...frames) {
  const [first, ...rest] = frames;
  if (rest.some(frame => frame.width !== first.width || frame.height !== first.height)) {
    throw Error("Composited frames must use one screenshot crop");
  }
}

const rgbDifference = (a, b, i) => Math.max(
  Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
const magenta = (data, i) => data[i] > data[i + 1] + 24 && data[i + 2] > data[i + 1] + 24 && data[i + 3] > 200;

// Stabilize the decision at rounding and resampling edges. All masks use the
// drawing buffer's top-left coordinates and all PNGs use the same CSS crop.
export function measureDisplay({ stock, noCube, noTerrain }, cube, terrain, size, click, crop = {}) {
  sameDimensions(stock, noCube, noTerrain);
  const { width, height } = size;
  const xScale = stock.width / width;
  const yScale = stock.height / height;
  const pngOffset = (x, y) => 4 * (Math.floor((y + 0.5) * yScale) * stock.width + Math.floor((x + 0.5) * xScale));
  const showsCube = i => magenta(stock.data, i) && !magenta(noCube.data, i) &&
    rgbDifference(stock.data, noCube.data, i) > displayThresholds.channelDelta;
  // Known Studio chrome can cover terrain in a narrow CSS viewport. Keep the
  // exclusion bounded and report its coverage independently of rendered colour.
  const { css, chrome = [] } = crop;
  const underChrome = (x, y) => chrome.some(rect => {
    const cssX = (x + 0.5) * css.width / width;
    const cssY = (y + 0.5) * css.height / height;
    return cssX >= rect.x && cssX < rect.x + rect.width && cssY >= rect.y && cssY < rect.y + rect.height;
  });
  const counts = { cubeInterior: 0, displayedCube: 0, hiddenCube: 0, terrainOutsideCube: 0, displayedTerrain: 0, chromeTerrain: 0 };
  const silhouette = { expected: 0, observed: 0, intersection: 0 };
  const imagery = { eligible: new Uint8Array(width * height), rgb: new Uint8Array(width * height * 3) };
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const neighbors = [p - 1, p + 1, p - width, p + width];
      const i = pngOffset(x, y);
      if (cube[p] && neighbors.every(index => cube[index])) {
        counts.cubeInterior++;
        if (showsCube(i)) counts.displayedCube++;
        if (magenta(noCube.data, i)) counts.hiddenCube++;
      }
      if (cube[p] || neighbors.some(index => cube[index])) continue;
      const interior = terrain[p] && neighbors.every(index => terrain[index]);
      if (underChrome(x, y)) {
        if (interior) counts.chromeTerrain++;
        continue;
      }
      const observed = rgbDifference(stock.data, noTerrain.data, i) > displayThresholds.channelDelta;
      silhouette.expected += terrain[p];
      silhouette.observed += Number(observed);
      silhouette.intersection += Number(terrain[p] && observed);
      if (!interior) continue;
      counts.terrainOutsideCube++;
      counts.displayedTerrain += Number(observed);
      imagery.eligible[p] = 1;
      imagery.rgb.set(stock.data.subarray(i, i + 3), p * 3);
    }
  }
  const [x, y] = click ?? [];
  const clickVisible = Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height &&
    showsCube(pngOffset(x, y));
  const terrainSamples = counts.terrainOutsideCube + counts.chromeTerrain;
  const union = silhouette.expected + silhouette.observed - silhouette.intersection;
  return { ...counts, clickVisible, cubeFraction: counts.cubeInterior ? counts.displayedCube / counts.cubeInterior : 0,
    chromeFraction: terrainSamples ? counts.chromeTerrain / terrainSamples : 0,
    terrainFraction: counts.terrainOutsideCube ? counts.displayedTerrain / counts.terrainOutsideCube : 0,
    silhouette: { ...silhouette, union, iou: union ? silhouette.intersection / union : 0 }, imagery };
}

// Compare color and spatial RGB changes on common terrain interior pixels.
// The color outlier budget and clipped gradients allow for differences in
// lighting, filtering and tone mapping between renderers.
export function measureImageryAlignment(field, candidate, { width, height }) {
  const step = Math.max(1, Math.round(Math.min(width, height) / 100));
  const limitGradient = delta => Math.max(-40, Math.min(40, delta));
  const shared = (p, q) => field.eligible[p] && field.eligible[q] && candidate.eligible[p] && candidate.eligible[q];
  let samples = 0;
  let different = 0;
  for (let p = 0; p < width * height; p++) {
    if (!field.eligible[p] || !candidate.eligible[p]) continue;
    samples++;
    if (rgbDifference(field.rgb, candidate.rgb, 3 * p) > displayThresholds.channelDelta) different++;
  }
  const color = { samples, different, fraction: samples ? different / samples : null };
  const directions = [["horizontal", step, 0], ["vertical", 0, step]];
  return { step, color, directions: directions.map(([axis, dx, dy]) => {
    let pairs = 0;
    let dot = 0;
    let fieldEnergy = 0;
    let candidateEnergy = 0;
    for (let y = 0; y < height - dy; y++) for (let x = 0; x < width - dx; x++) {
      const p = y * width + x;
      const q = p + dy * width + dx;
      if (!shared(p, q)) continue;
      pairs++;
      for (let channel = 0; channel < 3; channel++) {
        const a = limitGradient(field.rgb[q * 3 + channel] - field.rgb[p * 3 + channel]);
        const b = limitGradient(candidate.rgb[q * 3 + channel] - candidate.rgb[p * 3 + channel]);
        dot += a * b;
        fieldEnergy += a * a;
        candidateEnergy += b * b;
      }
    }
    return { axis, pairs, cosine: fieldEnergy && candidateEnergy ? dot / Math.sqrt(fieldEnergy * candidateEnergy) : 0,
      contrastRatio: fieldEnergy ? Math.sqrt(candidateEnergy / fieldEnergy) : 0 };
  }) };
}

export function measureCanvasContribution(stock, blankCanvases) {
  sameDimensions(stock, blankCanvases);
  let changed = 0;
  for (let i = 0; i < stock.data.length; i += 4) {
    if (rgbDifference(stock.data, blankCanvases.data, i) > displayThresholds.channelDelta) changed++;
  }
  const pixels = stock.width * stock.height;
  return { changed, pixels, fraction: changed / pixels };
}

export function measureErrorPaint(stock, withoutErrorText, viewport, bounds) {
  sameDimensions(stock, withoutErrorText);
  if (!bounds) return { changed: 0, pixels: 0 };
  const { css } = viewport;
  if (!["left", "top", "right", "bottom"].every(key => Number.isFinite(bounds[key]))) {
    throw Error("Invalid WebGL error bounds");
  }
  const x = value => Math.min(stock.width, Math.max(0, (value - css.x) * stock.width / css.width));
  const y = value => Math.min(stock.height, Math.max(0, (value - css.y) * stock.height / css.height));
  if (x(bounds.right) <= x(bounds.left) || y(bounds.bottom) <= y(bounds.top)) return { changed: 0, pixels: 0 };
  const left = Math.floor(x(bounds.left));
  const top = Math.floor(y(bounds.top));
  const right = Math.ceil(x(bounds.right));
  const bottom = Math.ceil(y(bounds.bottom));
  let changed = 0;
  for (let row = top; row < bottom; row++) for (let col = left; col < right; col++) {
    if (rgbDifference(stock.data, withoutErrorText.data, 4 * (row * stock.width + col)) > displayThresholds.channelDelta) changed++;
  }
  return { changed, pixels: Math.max(0, right - left) * Math.max(0, bottom - top) };
}
