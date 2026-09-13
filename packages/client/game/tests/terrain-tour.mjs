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
const selectedNames = sitesOption?.split(",") ?? (process.argv.includes("--spawns") ? null : ["spawn", "forest", "coast"]);
const radius = Number(process.argv.find(value => value.startsWith("--radius="))?.slice(9) ?? 4);
assert.ok(Number.isInteger(radius) && radius >= 2 && radius <= 5, "Tour radius must be from 2 through 5");
const evidence = join(game, "generated/terrain-tour");
await mkdir(join(evidence, label), {recursive: true});
const bundle = await build({
  entryPoints: [join(game, "tests/support/terrain-tour.browser.mjs")],
  bundle: true, write: false, format: "esm", platform: "browser", target: "chrome140",
  alias: {"@openvoxel/game": join(game, "dist/graphics/world-graphics.js"),
    "@openvoxel/world-generation": join(root, "packages/world/generation/dist/generator-registry.js"),
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
  const failures = [];
  page.on("pageerror", error => failures.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => globalThis.terrainTourReady, null, {timeout: 60000});
  let sites;
  if (process.argv.includes("--spawns")) sites = await page.evaluate(() => globalThis.discoverSpawnSites());
  else if (process.argv.includes("--discover")) sites = await page.evaluate(() => globalThis.discoverTerrainSites());
  else try {sites = JSON.parse(await readFile(join(evidence, "sites.json"), "utf8"));}
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    sites = await page.evaluate(() => globalThis.discoverTerrainSites());
  }
  if (!process.argv.includes("--spawns")) await writeFile(join(evidence, "sites.json"), JSON.stringify(sites, null, 2));
  if (selectedNames !== null && !process.argv.includes("--all")) {
    for (const name of selectedNames) assert.ok(sites.some(site => site.name === name), `Unknown terrain site ${name}`);
    sites = sites.filter(site => selectedNames.includes(site.name));
  }
  const results = [];
  for (const site of sites) {
    process.stdout.write(`[terrain-tour] ${label} ${site.name} seed=${site.seed} x=${site.x} z=${site.z}\n`);
    results.push(await page.evaluate(options => globalThis.loadTerrainSite(options.site, options.radius), {site, radius}));
    for (const view of ["top", "eye"]) {
      await page.evaluate(view => globalThis.terrainTourView(view), view);
      await page.waitForTimeout(1000);
      await page.screenshot({path: join(evidence, label, `${site.name}-${view}.png`)});
    }
  }
  await writeFile(join(evidence, label, "report.json"), JSON.stringify(results, null, 2));
  assert.deepEqual(failures, []);
  await page.evaluate(() => globalThis.terrainTourClose());
  process.stdout.write(`Terrain tour passed: ${sites.length} sites, ${sites.length * 2} screenshots\n`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
