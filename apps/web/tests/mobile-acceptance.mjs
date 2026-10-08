import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {builtHtmlPath, projectRoot} from './support/ui-acceptance-paths.mjs';
import {availablePort, processes, requireSuccess, start, stop, waitForUrl} from './support/ui-acceptance-runtime.mjs';
import {createWorld, leaveWorldToHome, waitForWorkerCount} from './support/ui-acceptance-world.mjs';

const output = join(projectRoot, 'apps/web/generated/mobile-acceptance');
const failures = [];
let browser, page;
const report = {};
const shot = async name => {
  await page.waitForTimeout(300);
  await page.screenshot({path: join(output, name + '.png')});
};
try {
  await mkdir(output, {recursive: true});
  if (!process.argv.includes('--reuse-build')) {
    await import('../tools/generate-assets.mjs');
    await requireSuccess(start('Mobile check', ['check', 'apps/web']), 120_000);
    await requireSuccess(start('Mobile build', ['build', 'apps/web']), 120_000);
  }
  const port = await availablePort(), url = `http://127.0.0.1:${port}/`;
  const preview = start('Mobile preview', ['preview', 'apps/web', '--port', String(port)]);
  await waitForUrl(url, preview, await readFile(builtHtmlPath, 'utf8'));
  browser = await chromium.launch({headless: true, args: ['--enable-gpu']});
  const context = await browser.newContext({viewport: {width: 844, height: 390}, hasTouch: true, isMobile: true, deviceScaleFactor: 1});
  page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
  await page.goto(url);
  await page.locator('[data-open-menu-settings]').tap();
  await page.locator('[data-preset-quality="low"]').tap();
  await page.locator('[data-close-settings]').tap();
  await page.locator('[data-settings-dialog]').waitFor({state: 'hidden'});
  await page.locator('[data-create-first-world]').tap();
  await createWorld(page, {id: 'mobile-controls', name: '触控测试', mode: 'Creative', preset: 'meadow', seed: 'mobile-controls'}, {waitForRendering: false});
  await page.locator('[data-world-loading]').waitFor({state: 'hidden'});
  await page.locator('[data-touch-controls]').waitFor({state: 'visible'});
  await page.waitForFunction(() => [...document.querySelectorAll('[data-touch-controls] img')].every(image => image.complete && image.naturalWidth > 0));
  const move = await page.locator('[data-touch-move]').boundingBox();
  const look = {x: 680, y: 200, width: 120, height: 120};
  const point = (id, box, x, y) => ({id, x: box.x + box.width * x, y: box.y + box.height * y});
  const session = await context.newCDPSession(page);
  await page.evaluate(() => {
    window.touchLog = [];
    for (const name of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(name, event => window.touchLog.push({name, id: event.pointerId, x: event.clientX, y: event.clientY, target: event.target.outerHTML?.slice(0, 150)}));
  });
  const send = (type, touchPoints) => session.send('Input.dispatchTouchEvent', {type, touchPoints});
  const forward = point(1, move, .5, .18), view = point(2, look, .5, .5), jump = point(3, move, .5, .5);
  await send('touchStart', [forward, view]);
  await page.locator('[data-touch-direction="KeyW"][data-pressed="true"]').waitFor();
  await send('touchMove', [forward, {...view, x: view.x + 24, y: view.y + 12}]);
  await send('touchStart', [forward, view, jump]);
  await page.locator('[data-touch-direction="Space"][data-pressed="true"]').waitFor();
  await shot('01-original-controls-pressed');
  // Chromium emits pointerup for the changed points supplied to touchEnd.
  await send('touchEnd', [jump]);
  await page.locator('[data-touch-direction="Space"][data-pressed="true"]').waitFor({state: 'detached'});
  assert.equal(await page.locator('[data-touch-direction="KeyW"][data-pressed="true"]').count(), 1);
  await send('touchCancel', []);
  assert.equal(await page.locator('[data-touch-controls] [data-pressed="true"]').count(), 0);
  assert.equal(await page.locator('[data-voxel-canvas]').getAttribute('data-pointer-locked'), 'false');
  await page.locator('[data-creative-slot="3"]').tap();
  await page.locator('[data-creative-slot="3"][data-selected="true"]').waitFor();
  const mapBounds = await page.locator('[data-minimap]').boundingBox();
  const settingsBounds = await page.locator('[data-open-settings]').boundingBox();
  assert.ok(mapBounds.x < 30 && settingsBounds.x > 750);
  await page.locator('[data-touch-inventory]').tap();
  await page.locator('[data-inventory-dialog][open]').waitFor();
  await page.locator('[data-close-inventory]').tap();
  await page.locator('[data-inventory-dialog]').waitFor({state: 'hidden'});
  await shot('02-landscape');
  await send('touchStart', [forward]);
  await page.locator('[data-open-settings]').tap();
  await page.locator('[data-settings-dialog]').waitFor({state: 'visible'});
  assert.equal(await page.locator('[data-touch-controls] [data-pressed="true"]').count(), 0);
  const panel = await page.locator('[data-settings-dialog]').boundingBox();
  assert.ok(panel.y >= 0 && panel.y + panel.height <= 391);
  await shot('03-landscape-settings');
  await send('touchCancel', []);
  await page.locator('[data-close-settings]').tap();
  await page.locator('[data-settings-dialog]').waitFor({state: 'hidden'});
  // The desktop emulation window must leave native fullscreen before it can resize.
  await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('[data-landscape-notice]').waitFor({state: 'visible'});
  assert.equal(await page.locator('[data-touch-controls]').isVisible(), false);
  await shot('04-portrait-guidance');
  await page.setViewportSize({width: 844, height: 390});
  await page.locator('[data-landscape-notice]').waitFor({state: 'hidden'});
  await page.locator('[data-touch-controls]').waitFor({state: 'visible'});
  report.controls = {move, look, panel};
  await leaveWorldToHome(page);
  await waitForWorkerCount(page, 0, 'Mobile exit');
  assert.deepEqual(failures, []);
  report.passed = true;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  if (page) console.error('Touch event trace:', await page.evaluate(() => window.touchLog).catch(() => null));
  if (page) await shot('failure').catch(() => {});
  console.error('Mobile browser failures:', failures);
  throw error;
} finally {
  if (browser) await browser.close();
  for (const process of processes.toReversed()) await stop(process);
}
