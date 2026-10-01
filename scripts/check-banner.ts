import assert from 'node:assert/strict';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

await mkdir('.data', { recursive: true, mode: 0o700 });
const asset = await readFile('docs/media/banner.svg', 'utf8');
assert.ok(!/<(?:script|foreignObject|image)\b/i.test(asset));
assert.ok(!/https?:\/\//.test(asset.replace('http://www.w3.org/2000/svg', '')));
const context = await chromium.launchPersistentContext(resolve('.data/banner-validation-browser'), {
    executablePath: process.env.DOTBOT_CHROME ?? '/usr/bin/google-chrome-stable',
    headless: true,
    args: ['--disable-dev-shm-usage'],
    env: { ...process.env, TMPDIR: resolve('.data'), XDG_CACHE_HOME: resolve('.data/banner-validation-cache') },
});
try {
    const page = await context.newPage();
    await page.setContent(asset);
    const packet = page.locator('.packet').first();
    const first = await packet.evaluate((element) => getComputedStyle(element).transform);
    await page.waitForTimeout(1100);
    assert.notEqual(await packet.evaluate((element) => getComputedStyle(element).transform), first);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    await page.setContent(`<img src="data:image/svg+xml;base64,${Buffer.from(asset).toString('base64')}">`);
    await page.locator('img').evaluate(async (element: HTMLImageElement) => {
        await element.decode();
        if (element.naturalWidth !== 1200 || element.naturalHeight !== 360) throw new Error('SVG image failed to render');
    });
    console.log(
        'Banner validation passed: standalone image decode, animation advancement, reduced motion, no scripts/external resources. No screenshot output.',
    );
} finally {
    await context.close();
    await rm('.data/banner-validation-browser', { recursive: true, force: true });
    await rm('.data/banner-validation-cache', { recursive: true, force: true });
}
