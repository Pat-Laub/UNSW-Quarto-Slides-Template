const { test, expect } = require('@playwright/test');

// This repo is the payload for `quarto use template`, so what matters is that
// the starting deck it hands someone actually works: it draws on the shared
// stage, the drawing tools are there, and nothing 404s.

const DECK = '/template.html';

async function openDeck(page) {
  const failures = [];
  page.on('response', r => { if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`); });
  page.on('pageerror', e => failures.push(`pageerror: ${e.message}`));
  await page.goto(DECK);
  await page.waitForFunction(() => window.Reveal && Reveal.isReady());
  return failures;
}

test('the template deck loads cleanly', async ({ page }) => {
  const failures = await openDeck(page);
  await page.waitForLoadState('networkidle');
  expect(failures, failures.join('\n')).toEqual([]);
});

test('it is drawn on the shared stage, in authored units', async ({ page }) => {
  await openDeck(page);
  const layout = await page.evaluate(() => {
    const stage = document.querySelector('[data-deck-stage]');
    const reveal = document.querySelector('.reveal');
    return stage && {
      stage: [stage.offsetWidth, stage.offsetHeight],
      content: [reveal.offsetWidth, reveal.offsetHeight],
      zoom: getComputedStyle(stage).zoom
    };
  });
  expect(layout, 'there is no deck stage').not.toBeNull();
  expect(layout.stage).toEqual([3744, 2106]);
  expect(layout.content).toEqual([3072, 1845]);
  // The stage must never scale itself with CSS zoom -- see slide-stage.
  expect(layout.zoom).toBe('1');
});

test('the UNSW look comes through the stage hooks', async ({ page }) => {
  await openDeck(page);
  const paint = await page.evaluate(() => {
    const stage = document.querySelector('[data-deck-stage]');
    return {
      rail: getComputedStyle(stage, '::after').backgroundColor,
      artwork: getComputedStyle(stage, '::before').backgroundImage
    };
  });
  expect(paint.rail).toBe('rgb(254, 220, 0)');
  expect(paint.artwork).toContain('svg');
});

test('the drawing tools are installed and draw', async ({ page }) => {
  await openDeck(page);
  await expect(page.locator('.ink-surface')).toBeAttached();

  if (await page.locator('.ink-surface.drawing').count() === 0) await page.keyboard.press('d');
  const box = await page.locator('.ink-surface').boundingBox();
  const at = (x, y) => ({ x: box.x + box.width * x, y: box.y + box.height * y });
  const start = at(0.3, 0.45);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const [x, y] of [[0.45, 0.5], [0.6, 0.45]]) {
    const p = at(x, y);
    await page.mouse.move(p.x, p.y, { steps: 8 });
  }
  await page.mouse.up();
  await expect(page.locator('svg.ink-pen path')).toHaveCount(1);
});

// Growing a page by navigating past the last slide belongs to the blank pad,
// not to a lecture deck. This template must not have opted in.
test('the deck does not grow pages', async ({ page }) => {
  await openDeck(page);
  const count = () => page.evaluate(() =>
    document.querySelectorAll('.reveal .slides section').length);
  const before = await count();
  await page.evaluate(() => Reveal.slide(Reveal.getTotalSlides() - 1, 0));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(400);
  expect(await count(), 'the deck grew a page it was not asked for').toBe(before);
});
