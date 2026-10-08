import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import {build} from "esbuild";
import {chromium} from "playwright";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const game = join(root, "packages/client/game");
const label = process.argv[2] ?? "after";
assert.match(label, /^[a-z0-9-]+$/u);
const sitesOption = process.argv.find(value => value.startsWith("--sites="))?.slice(8);
const selectedNames = sitesOption?.split(",") ?? ((process.argv.includes("--spawns") || process.argv.includes("--regions")) ? null : ["spawn", "forest", "coast"]);
const yearOption = process.argv.find(value => value.startsWith("--year="))?.slice(7);
const year = yearOption === undefined ? null : Number(yearOption);
assert.ok(year === null || (Number.isFinite(year) && year >= 0 && year < 1), "Tour year must be from zero up to one");
const radius = Number(process.argv.find(value => value.startsWith("--radius="))?.slice(9) ?? 4);
assert.ok(Number.isInteger(radius) && radius >= 2 && radius <= 5, "Tour radius must be from 2 through 5");
const evidence = join(game, "generated/terrain-tour");
await mkdir(join(evidence, label), {recursive: true});
const bundle = await build({
  entryPoints: [join(game, "tests/support/terrain-tour.browser.mjs")],
  bundle: true, write: false, format: "esm", platform: "browser", target: "chrome140",
  alias: {"#openvoxel/renderer/mesh-scan": join(root, "packages/client/rendering/src/native/mesh-scan.mjs"),
    "#openvoxel/client/chunk-palette": join(root, "packages/client/access/src/native/chunk-palette.mjs"),
    "#openvoxel/renderer/chunk-snapshot": join(root, "packages/client/rendering/src/native/chunk-snapshot.mjs"),
    "#openvoxel/renderer/lighting-native": join(root, "packages/client/rendering/src/native/voxel-lighting.mjs"),
    "@openvoxel/content": join(game, "dist/__velar_packages__/@openvoxel/content/src/index.js"),
    "@openvoxel/game": join(game, "dist/graphics/world-graphics.js"),
    "@openvoxel/world-generation": join(game, "dist/__velar_packages__/@openvoxel/world-generation/src/generator-registry.js"),
    "@openvoxel/blocks": join(game, "dist/__velar_packages__/@openvoxel/blocks/src/index.js"),
    "@openvoxel/renderer": join(game, "dist/__velar_packages__/@openvoxel/renderer/src/index.js"),
    "@openvoxel/world": join(game, "dist/__velar_packages__/@openvoxel/world/src/index.js")},
});
const server = createServer((request, response) => {
  response.setHeader("cache-control", "no-store");
  if (request.url === "/tour.js") {response.setHeader("content-type", "text/javascript"); response.end(bundle.outputFiles[0].text);}
  else {response.setHeader("content-type", "text/html"); response.end('<style>body{margin:0}canvas{display:block;width:100vw;height:100vh}</style><canvas></canvas><script type="module" src="/tour.js"></script>');}
});
let browser;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({headless: true, args: ["--use-angle=metal", "--enable-unsafe-webgpu"]});
  const page = await browser.newPage({viewport: {width: 960, height: 600}, deviceScaleFactor: 1});
  await page.addInitScript(() => localStorage.setItem("openvoxel.settings.v1", JSON.stringify({renderBackend: "webgl"})));
  const failures = [];
  let failPage;
  const pageFailure = new Promise((_, reject) => { failPage = reject; });
  pageFailure.catch(() => {});
  page.on("pageerror", error => { failures.push(error.message); failPage(error); });
  page.on("console", message => { if (message.type() === "error") failures.push(message.text().slice(0, 1800)); });
  await page.goto(`http://127.0.0.1:${server.address().port}${process.argv.includes("--packs") ? "?packs=1" : ""}`);
  await Promise.race([page.waitForFunction(() => globalThis.terrainTourReady, null, {timeout: 60000}), pageFailure]);
  let sites;
  if (process.argv.includes("--regions")) {
    if (process.argv.includes("--reuse-sites")) sites = JSON.parse(await readFile(join(evidence, (process.argv.includes("--packs") ? "ecosystem-sites.json" : "region-sites.json")), "utf8"));
    else sites = await page.evaluate(() => globalThis.discoverRegionSites());
  }
  else if (process.argv.includes("--spawns")) sites = await page.evaluate(() => globalThis.discoverSpawnSites());
  else if (process.argv.includes("--discover")) sites = await page.evaluate(() => globalThis.discoverTerrainSites());
  else try {sites = JSON.parse(await readFile(join(evidence, "sites.json"), "utf8"));}
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    sites = await page.evaluate(() => globalThis.discoverTerrainSites());
  }
  if (!process.argv.includes("--spawns")) await writeFile(join(evidence, process.argv.includes("--regions") ? (process.argv.includes("--packs") ? "ecosystem-sites.json" : "region-sites.json") : "sites.json"), JSON.stringify(sites, null, 2));
  if (selectedNames !== null && !process.argv.includes("--all")) {
    for (const name of selectedNames) assert.ok(sites.some(site => site.name === name), `Unknown terrain site ${name}`);
    sites = sites.filter(site => selectedNames.includes(site.name));
  }
  const results = [];
  let screenshotCount = 0;
  for (const site of sites) {
    process.stdout.write(`[terrain-tour] ${label} ${site.name} seed=${site.seed} x=${site.x} z=${site.z}\n`);
    results.push(await page.evaluate(options => globalThis.loadTerrainSite(options.site, options.radius, options.year), {site, radius, year}));
    const views = site.waterLevel !== undefined ? ["top", "eye", "water", "water-motion"] : year === null ? ["top", "eye"] : ["top", "eye", "foliage"];
    if (process.argv.includes("--sunflowers")) views.push("sunflower-front", "sunflower-back", "sunflower-motion");
    if (site.waterLevel !== undefined || site.name === "coast") views.push("water-low", "water-low-motion", "water-low-side");
    for (const view of views) {
      await page.evaluate(view => globalThis.terrainTourView(view), view);
      await page.waitForTimeout(view === "foliage" ? 2500 : 1000);
      if (view.startsWith("water-low")) {
        const {camera} = await page.evaluate(() => globalThis.terrainTourRenderStats());
        assert.ok(Math.abs(camera.y - (site.waterLevel ?? 64) - 2.6) < 0.01, "Water inspection camera lost its 1.6 block eye height");
        assert.ok(camera.directionY < 0 && camera.directionY > -0.08, "Water inspection needs a grazing view");
      }
      await page.screenshot({path: join(evidence, label, `${site.name}-${view}.png`)});
      screenshotCount += 1;
    }
    results[results.length - 1].render = await page.evaluate(() => globalThis.terrainTourRenderStats());
    results[results.length - 1].foliage = await page.evaluate(() => globalThis.terrainTourFoliageStats());
  }
  if (process.argv.includes("--packs")) {
    for (const result of results) {
      const counts = result.ecologyCounts;
      for (const [stem, top] of [["botanical:sunflower", "botanical:sunflower_head"], ["wetlands:cattail", "wetlands:cattail_top"]]) {
        assert.equal(counts[stem] ?? 0, counts[top] ?? 0, `${result.site.name}: tall plant segments must remain paired`);
      }
      const expected = {cherry_grove: ["orchard:cherry_log", "orchard:cherry_leaves"], orchard: ["orchard:apple_fruit", "orchard:pear_fruit", "orchard:peach_fruit"], bamboo_forest: ["botanical:bamboo", "botanical:bamboo_crown"], flower_fields: ["botanical:lavender", "botanical:sunflower"], willow_marsh: ["wetlands:willow_leaves", "wetlands:reed", "wetlands:cattail"]};
      for (const key of expected[result.site.name] ?? []) assert.ok(counts[key] > 0, `${result.site.name}: missing defining species ${key}`);
    }
  }
  await writeFile(join(evidence, label, "report.json"), JSON.stringify(results, null, 2));
  assert.deepEqual(failures, []);
  await page.evaluate(() => globalThis.terrainTourClose());
  process.stdout.write(`Terrain tour passed: ${sites.length} sites, ${screenshotCount} screenshots\n`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
