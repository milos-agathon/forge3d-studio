import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const FIELD_REVISION = "64b7cf093cf38d73cd88b8b099193f44a36bf764";
export const CANDIDATE_REVISION = "c3acc19ce65996c52474d3fbbabc6d1145e42f76";
export const WEB_REVISION = "d6459a26f04c637909360a0351c7ed98d6e0b84a";
export const CUBE_ID = "efcc1898-70bc-49d6-a20a-e534cabd1498";
export const TERRAIN_ID = "eaa87546-a5bb-41d7-8e41-f9c69af58371";
const WEB_TREE = "1d8209975d7da1c9bedaaef6de52bf12b0e68c7c";
const WEB_UPSTREAM_SHA256 = "abafa69a5eeeb219cb8d7f8ff67b3c49c1263512ddbca2abd0ec1ca64b0d5850";
const WEB_STUDIO_SHA256 = "523493d8e22434def1091d68a7b427e55aac18588861b0932ea99fcf41b83eaa";
// SHA-256 of the sorted [URL path, file SHA-256] pairs from the pinned archive's
// prepared browser files, using the same exclusions as prepare-viewport-runtime.
const WEB_RUNTIME_INVENTORY_SHA256 = "b587317f867baacc02f9f21215c6b7496b5fdc1201f376ba3c06c52f38b6d2e0";
const root = fileURLToPath(new URL("../../", import.meta.url));
const samples = join(root, "samples");
const fixtureName = "vp01-bryce.studio3d";
const recipe = "vp01-bryce-v1";

const sha256 = data => createHash("sha256").update(data).digest("hex");
const readJson = async path => JSON.parse(await readFile(path, "utf8"));

export async function runtimeArchivePath() {
  const manifest = await readJson(join(root, "package.json"));
  const dependency = manifest.dependencies?.["@forge3d/web"];
  if (!dependency?.startsWith("file:")) throw new Error("Expected a vendored @forge3d/web tarball");
  return resolve(root, dependency.slice("file:".length));
}

export async function verifyProvenance() {
  const provenance = await readJson(join(root, "vendor", "forge3d-web", "provenance.json"));
  const archive = await runtimeArchivePath();
  if (!isPinnedProvenance(provenance) || provenance.sha256 !== WEB_STUDIO_SHA256 ||
      sha256(await readFile(archive)) !== WEB_STUDIO_SHA256) {
    throw new Error("PROVENANCE_MISMATCH: PR #2 vendored forge3d-web commit, tree or archive checksum differs");
  }
  return provenance;
}

export function isPinnedProvenance(provenance) {
  // Earlier captures record the original archive. The smaller Studio archive
  // has the same pinned browser inventory and records its upstream checksum.
  return provenance?.commit === WEB_REVISION && provenance.tree === WEB_TREE &&
    (provenance.sha256 === WEB_UPSTREAM_SHA256 ||
      (provenance.sha256 === WEB_STUDIO_SHA256 && provenance.upstreamArchiveSha256 === WEB_UPSTREAM_SHA256));
}

export function isPinnedRuntimeInventory(runtime) {
  if (!runtime || typeof runtime !== "object") return false;
  const paths = Object.keys(runtime).sort();
  return paths.length === 247 &&
    sha256(JSON.stringify(paths.map(path => [path, runtime[path]]))) === WEB_RUNTIME_INVENTORY_SHA256;
}

async function fixtureRecipe() {
  const [project, animation] = await Promise.all([
    readJson(join(samples, "bryce-terrain.studio3d")),
    readJson(join(samples, "cube-animation.studio3d")),
  ]);
  const cube = animation.scene.objects.find(object => object.id === CUBE_ID);
  const terrain = project.scene.objects.find(object => object.id === TERRAIN_ID);
  if (cube?.kind.source?.primitive?.type !== "cube" || cube.kind.source.primitive.size !== 2 ||
      !isDeepStrictEqual(terrain?.kind.worldSpanXz, [4000, 3800])) {
    throw new Error("FIXTURE_RECIPE_MISMATCH: supplied Bryce or cube sample differs");
  }

  cube.name = "VP-01 cube";
  cube.transform.translation = { x: 0, y: 0.85, z: 0 };
  cube.kind.material.baseColor = [1, 0, 1];
  cube.kind.material.metallic = 0;
  project.name = "VP-01 Bryce";
  project.scene.objects.push(cube);
  project.viewport = { ...project.viewport, mode: "material", gridVisible: false, hillshade: false };
  project.render = { ...project.render, environment: null, sky: true, shadows: false, sunVisibility: false };
  // Store only the referenced DEM and imagery, and keep the project relocatable.
  const used = new Set([terrain.kind.asset, terrain.kind.overlay.asset]);
  project.assets = project.assets.filter(asset => used.has(asset.id));
  if (project.assets.length !== used.size) throw new Error("FIXTURE_RECIPE_MISMATCH: missing sampled asset");
  const sources = new Map(project.assets.map(asset => [asset.id, resolve(samples, asset.path)]));
  for (const asset of project.assets) asset.path = `assets/${basename(asset.path)}`;
  return { project, sources };
}

export async function createFixture(outDir) {
  const path = resolve(outDir, fixtureName);
  const { project, sources } = await fixtureRecipe();
  await mkdir(join(dirname(path), "assets"), { recursive: true });
  for (const asset of project.assets) {
    await copyFile(sources.get(asset.id), join(dirname(path), asset.path), constants.COPYFILE_EXCL);
  }
  await writeFile(path, `${JSON.stringify(project, null, 2)}\n`, { flag: "wx" });
  return verifyFixture(path);
}

export async function verifyFixture(projectPath) {
  const path = resolve(projectPath);
  const { project, sources } = await fixtureRecipe();
  if (!isDeepStrictEqual(await readJson(path), project)) {
    throw new Error("FIXTURE_RECIPE_MISMATCH: project differs from the VP-01 recipe");
  }
  const assets = await Promise.all(project.assets.map(async asset => {
    const [source, copy] = await Promise.all([
      readFile(sources.get(asset.id)),
      readFile(join(dirname(path), asset.path)),
    ]);
    if (copy.length !== asset.byteSize || !source.equals(copy)) {
      throw new Error(`FIXTURE_ASSET_MISMATCH: ${asset.name}`);
    }
    return { id: asset.id, name: asset.name, bytes: copy.length, sha256: sha256(copy) };
  }));
  return { path, identity: { recipe, projectId: project.id, projectSha256: sha256(JSON.stringify(project)), assets } };
}
