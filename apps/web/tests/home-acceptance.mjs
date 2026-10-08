import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {builtHtmlPath, projectRoot} from './support/ui-acceptance-paths.mjs';
import {availablePort, processes, requireSuccess, start, stop, waitForUrl} from './support/ui-acceptance-runtime.mjs';
import {createWorld, leaveWorldToHome, waitForWorkerCount, cancelWorldEntryWhileLoading} from './support/ui-acceptance-world.mjs';

import {dispatchCarouselWheel} from './support/ui-acceptance-visual.mjs';

const output = join(projectRoot, 'apps/web/generated/home-acceptance');
let browser, page;
const failures = [];
const report = {};
const id = 'ui-delete';
const neighbor = {id: id + ':1', name: '山间小屋', mode: 'survival', preset: 'highlands', seed: 'neighbor', lastPlayed: '刚刚创建'};
async function shot(name) {
  await page.waitForTimeout(450);
  await page.screenshot({path: join(output, name + '.png')});
}
async function storedKeys(seed = false) {
  return page.evaluate(async ({id, seed}) => {
    const databases = await indexedDB.databases();
    const info = databases.find(item => item.name.includes('openvoxel-local'));
    if (!info) throw new Error('Local world database missing');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(info.name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const storeName = db.objectStoreNames[0];
      if (seed) await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        for (const key of [`delta:${id}:-1:0:2`, `delta:${id}:8:4:-7`, `manifest:${id}:1`, `delta:${id}:1:0:0:0`]) {
          store.put(new Uint8Array([1, 2, 3]), key);
        }
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return await new Promise((resolve, reject) => {
        const request = db.transaction(storeName).objectStore(storeName).getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }, {id, seed});
}
try {
  await mkdir(output, {recursive: true});
  if (!process.argv.includes('--reuse-build')) await requireSuccess(start('Home check', ['check', 'apps/web']), 120_000);
  if (!process.argv.includes('--reuse-build')) await requireSuccess(start('Home build', ['build', 'apps/web']), 120_000);
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}/`;
  const preview = start('Home preview', ['preview', 'apps/web', '--port', String(port)]);
  await waitForUrl(url, preview, await readFile(builtHtmlPath, 'utf8'));
  browser = await chromium.launch({headless: true, args: ['--enable-gpu']});
  const context = await browser.newContext({viewport: {width: 1440, height: 900}});
  page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => {if (message.type() === 'error') failures.push(message.text());});
  await page.goto(url);
  await page.locator('[data-open-menu-settings]').click();
  await page.locator('[data-settings-dialog]').waitFor({state: 'visible'});
  assert.equal(await page.locator('[data-preset-quality]').count(), 4);
  assert.equal(await page.locator('[data-leave-world]').count(), 0);
  await page.locator('[data-preset-quality="low"]').click();
  assert.equal(await page.locator('[data-setting="viewDistance"]').inputValue(), '3');
  await page.locator('[data-setting="viewDistance"]').fill('4');
  assert.equal(await page.locator('[data-preset-quality][aria-pressed="true"]').count(), 0);
  await page.locator('[data-preset-quality="balanced"]').click();
  await shot('00-menu-settings');
  await page.locator('[data-close-settings]').click();
  await page.locator('[data-settings-dialog]').waitFor({state: 'hidden'});
  await page.locator('[data-create-first-world]').click();
  await page.locator('[data-create-world-form]').waitFor();
  await shot('01-create');
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  await page.locator('[data-preset="coast"]').click();
  await page.locator('[data-preset="coast"][aria-pressed="true"]').waitFor();
  await page.waitForTimeout(450);
  const panelStyle = await page.locator('[data-create-world-form]').evaluate(el => ({color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor}));
  assert.match(panelStyle.background, /^rgba\(32, 32, 32, 0.76\)$/);
  report.panel = panelStyle;
  await createWorld(page, {id, name: '林间溪谷', mode: 'Creative', preset: 'meadow', seed: 'ui-theme'}, {waitForRendering: false});
  await page.locator('[data-world-loading]').waitFor({state: 'hidden'});
  await page.locator('[data-open-settings]').click();
  await page.locator('[data-settings-dialog]').waitFor({state: 'visible'});
  await page.locator('[data-settings-tab="audio"]').click();
  await page.locator('[data-setting="masterVolume"]').waitFor();
  await shot('02-settings');
  await page.locator('[data-close-settings]').click();
  await page.locator('[data-settings-dialog]').waitFor({state: 'hidden'});
  await leaveWorldToHome(page);
  await waitForWorkerCount(page, 0, 'Theme world exit');
  await cancelWorldEntryWhileLoading(page, {id, name: '林间溪谷'}, failures);
  const before = await storedKeys(true);
  assert.ok(before.includes(`manifest:${id}`));
  await page.evaluate(neighbor => {
    const worlds = JSON.parse(localStorage.getItem('openvoxel.worlds.v1'));
    localStorage.setItem('openvoxel.worlds.v1', JSON.stringify([neighbor, ...worlds]));
  }, neighbor);
  await page.reload();
  await page.locator('[data-selected-world-name]').filter({hasText: '林间溪谷'}).waitFor();
  await shot('03-home');
  const geometry = await page.evaluate(() => {
    const left = document.querySelector('[data-carousel-previous]');
    const right = document.querySelector('[data-carousel-next]');
    const a = left.getBoundingClientRect(), b = right.getBoundingClientRect();
    const footer = document.querySelector('[data-world-carousel]').getBoundingClientRect();
    return {left: a.x, right: innerWidth - b.right, leftY: a.y + a.height / 2, rightY: b.y + b.height / 2, height: innerHeight, footerWidth: footer.width, width: innerWidth,
      arrowBackground: getComputedStyle(left).backgroundColor, arrowBorder: getComputedStyle(left).borderWidth};
  });
  assert.ok(Math.abs(geometry.left - geometry.right) < 1);
  assert.equal(geometry.leftY, geometry.height / 2);
  assert.equal(geometry.rightY, geometry.height / 2);
  assert.ok(geometry.footerWidth / geometry.width > .88);
  assert.equal(geometry.arrowBackground, 'rgba(0, 0, 0, 0)');
  assert.equal(geometry.arrowBorder, '0px');
  report.geometry = geometry;
  assert.equal(await page.locator('[data-carousel-dot]').count(), 0);
  assert.equal(await dispatchCarouselWheel(page, {deltaY: 160}), false);
  await page.locator('[data-carousel-previous]').click();
  await page.locator('[data-selected-world-name]').filter({hasText: neighbor.name}).waitFor();
  assert.equal(await page.locator('[data-carousel-previous]').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
  await page.locator('[data-carousel-next]').click();
  await page.locator('[data-selected-world-name]').filter({hasText: '林间溪谷'}).waitFor();
  report.switchLatencyMs = await page.evaluate(async () => {
    const samples = [];
    for (let i = 0; i < 6; i++) {
      const start = performance.now();
      document.querySelector('[data-carousel-next]').click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      samples.push(Math.round(performance.now() - start));
    }
    return samples;
  });
  assert.ok(Math.max(...report.switchLatencyMs) < 250, 'Menu actions must paint promptly');
  // Repeated changes must preserve order and never leave stale transition snapshots.
  await page.evaluate(() => {
    for (let i = 0; i < 4; i++) document.querySelector('[data-carousel-next]').click();
  });
  await page.waitForTimeout(700);
  assert.equal(await page.locator('[data-selected-world-name]').innerText(), '林间溪谷');
  await page.locator('[data-delete-world]').click();
  const deletion = page.locator('[data-delete-world-dialog]');
  await deletion.waitFor({state: 'visible'});
  assert.match(await deletion.innerText(), /林间溪谷/u);
  await shot('04-delete');
  await page.locator('[data-cancel-delete-world]').click();
  await deletion.waitFor({state: 'hidden'});
  assert.deepEqual(await storedKeys(), before);
  await page.setViewportSize({width: 390, height: 844});
  await shot('05-home-mobile');
  await page.locator('[data-world-settings]').click();
  const info = await page.locator('[data-world-settings-panel]').boundingBox();
  assert.ok(info.x >= 0 && info.x + info.width <= 390);
  await page.locator('[data-world-settings-panel] button').click();
  await page.locator('[data-world-settings-panel]').waitFor({state: 'hidden'});
  await page.locator('[data-delete-world]').click();
  await page.locator('[data-confirm-delete-world]').click();
  await deletion.waitFor({state: 'hidden'});
  await waitForWorkerCount(page, 0, 'Deleted world');
  const after = await storedKeys();
  assert.deepEqual(after, [`delta:${id}:1:0:0:0`, `manifest:${id}:1`]);
  await page.reload();
  assert.equal(await page.locator('[data-selected-world-name]').innerText(), neighbor.name);
  await page.locator('[data-delete-world]').click();
  await page.locator('[data-confirm-delete-world]').click();
  await page.locator('[data-empty-worlds]').waitFor();
  assert.deepEqual(await storedKeys(), []);
  await page.goto(url + 'world/missing-ui-test-world');
  await page.locator('[data-error]').waitFor({timeout: 30000});
  await page.locator('[data-error] button').click();
  await page.locator('[data-screen="world-home"]').waitFor();
  assert.equal(await page.locator('[data-world-exit-dialog][open]').count(), 0);
  await waitForWorkerCount(page, 0, 'Failed world exit');
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.locator('[data-create-first-world]').click();
  await page.locator('[data-create-world-form]').waitFor();
  await page.locator('[data-advanced-settings]').click();
  assert.equal(await page.locator('[data-advanced-wrap]').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  await shot('06-create-mobile');
  const form = await page.locator('[data-create-world-form]').boundingBox();
  assert.ok(form.x >= 0 && form.x + form.width <= 390);
  assert.deepEqual(failures, []);
  report.passed = true;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  if (page) await shot('failure').catch(() => {});
  console.error('Browser failures:', failures);
  throw error;
} finally {
  if (browser) await browser.close();
  for (const process of processes.toReversed()) await stop(process);
}
