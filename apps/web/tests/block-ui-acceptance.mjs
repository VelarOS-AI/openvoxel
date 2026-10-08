import assert from "node:assert/strict";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {chromium} from "playwright";
import {builtHtmlPath, projectRoot} from "./support/ui-acceptance-paths.mjs";
import {availablePort, processes, start, stop, waitForUrl} from "./support/ui-acceptance-runtime.mjs";
import {createWorld, aimAtCreativeGround} from "./support/ui-acceptance-world.mjs";

const evidence = join(projectRoot, "apps/web/generated/block-ui");
await mkdir(evidence, {recursive: true});
let browser, page;
const errors = [];
try {
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}/`;
  const preview = start("Block UI preview", ["preview", "apps/web", "--port", `${port}`]);
  await waitForUrl(url, preview, await readFile(builtHtmlPath, "utf8"));
  browser = await chromium.launch({headless: true, args: ["--enable-gpu"]});
  page = await browser.newPage({viewport: {width: 1440, height: 1000}, deviceScaleFactor: 1, reducedMotion: "reduce"});
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  // Match ui-acceptance: headless Chromium does not grant native Pointer Lock.
  // Emulate the browser-owned lock state; all game input, rendering and edits run normally.
  await page.addInitScript(() => {
    globalThis.__selectionLineDraws = 0;
    const draw = WebGL2RenderingContext.prototype.drawElements;
    WebGL2RenderingContext.prototype.drawElements = function (mode, ...args) {
      if (mode === this.LINES) globalThis.__selectionLineDraws++;
      return draw.call(this, mode, ...args);
    };
    let lockedElement = null;
    Object.defineProperty(document, "pointerLockElement", {configurable: true, get: () => lockedElement});
    Object.defineProperty(HTMLCanvasElement.prototype, "requestPointerLock", {
      configurable: true,
      value() {
        lockedElement = this;
        document.dispatchEvent(new Event("pointerlockchange"));
        return Promise.resolve();
      },
    });
    Object.defineProperty(document, "exitPointerLock", {
      configurable: true,
      value() {
        if (lockedElement === null) return;
        lockedElement = null;
        document.dispatchEvent(new Event("pointerlockchange"));
      },
    });
    window.addEventListener("keydown", event => {
      if (event.code === "Escape" && lockedElement !== null) document.exitPointerLock();
    }, true);
  });
  await page.goto(url);
  await page.locator("[data-create-first-world]").click();
  await createWorld(page, {id: `block-ui-${Date.now()}`, name: "方块界面验证", seed: "block-ui", mode: "Creative", preset: "meadow"});
  assert.equal(await page.locator('[data-creative-slot]').count(), 9);
  assert.equal(await page.locator('[data-open-inventory]').count(), 0);
  const mapBounds = await page.locator('[data-minimap]').boundingBox();
  const settingsBounds = await page.locator('[data-open-settings]').boundingBox();
  assert.ok(mapBounds.x < 30 && mapBounds.y < 30);
  assert.ok(settingsBounds.x > 1300 && settingsBounds.y < 30);
  assert.match(await page.locator('[data-open-settings]').evaluate(element => getComputedStyle(element).backgroundColor), /(?:, | \/ )0\)$/u);
  await page.waitForFunction(() => Number(document.querySelector('[data-app][data-screen="world"]').dataset.fps) > 0);
  assert.match(await page.locator('[data-frame-rate]').innerText(), /[0-9]+ FPS · [0-9.]+ ms/u);

  const hotbarLayout = await page.locator('[data-creative-toolbar]').evaluate(toolbar => {
    const style = getComputedStyle(toolbar);
    const slots = [...toolbar.querySelectorAll('[data-creative-slot]')];
    return {gap: style.gap, radius: style.borderRadius, squares: slots.every(slot => {const box = slot.getBoundingClientRect(); return box.width === box.height && getComputedStyle(slot).borderRadius === "0px";})};
  });
  assert.deepEqual(hotbarLayout, {gap: "0px", radius: "0px", squares: true});
  await page.locator('[data-creative-slot="3"]').click();
  await page.locator('[data-creative-slot="3"][data-selected="true"]').waitFor();
  assert.equal(await page.locator("[data-inventory-block]").count(), 0);
  await page.keyboard.press("e");
  await page.locator("[data-inventory-dialog][open]").waitFor();
  await page.keyboard.press("e");
  assert.equal(await page.locator("[data-inventory-dialog][open]").count(), 0);
  await page.keyboard.press("e");
  await page.locator("[data-inventory-dialog][open]").waitFor();
  const count = await page.locator("[data-inventory-block]").count();
  assert.ok(count >= 100);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-inventory-grid] img')].every(img => img.complete && img.naturalWidth === 96));
  await page.screenshot({path: join(evidence, "inventory.png")});
  await page.locator("[data-inventory-search]").fill("berri");
  await page.keyboard.type("e");
  assert.equal(await page.locator("[data-inventory-search]").inputValue(), "berrie");
  assert.equal(await page.locator("[data-inventory-dialog][open]").count(), 1);
  await page.locator("[data-inventory-search]").fill("西瓜");
  assert.equal(await page.locator("[data-inventory-block]").count(), 2);
  await page.locator('[data-inventory-block="gourds:watermelon"]').click();
  assert.equal(await page.locator("[data-inventory-dialog][open]").count(), 0);
  assert.equal(await page.locator('[data-creative-slot="3"]').getAttribute("data-block-key"), "gourds:watermelon");
  await page.locator('[data-open-settings]').click();
  await page.keyboard.press('e');
  assert.equal(await page.locator('[data-inventory-dialog][open]').count(), 0);
  await page.keyboard.press('Escape');
  await page.bringToFront();
  await page.locator("[data-inventory-dialog]").waitFor({state: "hidden"});
  const target = await aimAtCreativeGround(page);
  await page.keyboard.press('9');
  await page.locator('[data-creative-slot="9"][data-selected="true"]').waitFor();
  await page.keyboard.press('3');
  await page.locator('[data-creative-slot="3"][data-selected="true"]').waitFor();
  assert.equal(await page.locator('[data-creative-slot="3"]').evaluate(slot => getComputedStyle(slot).outlineColor), "rgb(255, 255, 255)");
  await page.locator('[data-target-block]').waitFor();
  const initialInfo = await page.locator('[data-target-block]').innerText();
  assert.ok(initialInfo.includes(`ID #${target.runtimeId}`));
  await page.waitForFunction(() => globalThis.__selectionLineDraws >= 5);
  await page.screenshot({path: join(evidence, "selection.png")});
  await page.mouse.click(320, 690, {button: 'right'});
  await page.locator('[data-target-block="gourds:watermelon"]').waitFor({timeout: 15_000});
  assert.equal(await page.locator('[data-creative-edit-error]').count(), 0);
  const drawsBefore = await page.evaluate(() => globalThis.__selectionLineDraws);
  await page.waitForFunction(before => globalThis.__selectionLineDraws > before + 5, drawsBefore);
  await page.screenshot({path: join(evidence, "placed-block.png")});
  const outlineDraws = await page.evaluate(() => globalThis.__selectionLineDraws);
  assert.ok(outlineDraws >= 10);
  const placedInfo = await page.locator('[data-target-block]').innerText();
  await page.mouse.move(320, 0);
  await page.waitForFunction(() => document.querySelector('[data-target-block]') === null, null, {timeout: 10_000});
  await page.keyboard.press("e");
  assert.equal(await page.evaluate(() => document.pointerLockElement), null);
  await page.locator('[data-inventory-search]').fill('no-such-block');
  assert.equal(await page.locator('[data-inventory-block]').count(), 0);
  assert.ok(await page.locator('[data-inventory-grid]').innerText().then(text => text.includes('没有找到')));
  await page.locator('[data-inventory-search]').fill('berries:blueberry');
  assert.equal(await page.locator('[data-inventory-block]').count(), 1);
  await page.locator('[data-close-inventory]').click();
  await page.setViewportSize({width: 844, height: 390});
  await page.keyboard.press("e");
  await page.screenshot({path: join(evidence, "inventory-mobile.png")});
  const dialog = await page.locator('[data-inventory-dialog]').boundingBox();
  assert.ok(dialog.x >= 0 && dialog.y >= 0 && dialog.x + dialog.width <= 844 && dialog.y + dialog.height <= 390);
  await page.locator('[data-close-inventory]').click();
  await page.setViewportSize({width: 1440, height: 1000});
  await page.keyboard.press('e');
  await page.locator('[data-inventory-search]').fill('合欢原木');
  await page.locator('[data-inventory-block="openvoxel:mimosa_log"]').click();
  await aimAtCreativeGround(page);
  await page.mouse.click(320, 690, {button: 'right'});
  await page.locator('[data-target-block="openvoxel:mimosa_log"]').waitFor({timeout: 15_000});
  await page.waitForTimeout(800);
  await page.screenshot({path: join(evidence, 'mimosa-log.png')});
  assert.deepEqual(errors, []);
  await writeFile(join(evidence, "report.json"), JSON.stringify({count, target, initialInfo, placedInfo, mobileDialog: dialog, pointerLock: "headless browser emulation", outlineDraws, errors}, null, 2));
  console.log(`Block UI passed: ${count} previews, search, slot assignment, extension block placement, target identity, clear target, mobile dialog`);
} catch (error) {
  if (page) {
    await page.screenshot({path: join(evidence, "failure.png")});
    console.error("Browser errors", errors);
    console.error("Page state", await page.evaluate(() => ({active: document.activeElement?.outerHTML?.slice(0, 240), lock: document.pointerLockElement?.tagName, failure: document.querySelector('[data-error]')?.textContent, dialogs: [...document.querySelectorAll('dialog[open]')].map(dialog => dialog.outerHTML.slice(0, 200))})));
  }
  throw error;
} finally {
  await browser?.close();
  for (const process of [...processes].reverse()) await stop(process);
}
