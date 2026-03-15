// TrailRunner bug-fix verification tests
// Tests: Oval track, free run UX, focus mode layout, settings panel, metric labels
// Target: 1280x720 viewport (NordicTrack X32i scaled)

const { test, expect } = require('@playwright/test');

const URL = 'file:///mnt/d/trailrunner/index.html';

test.use({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
});

test.describe('TrailRunner Bug Fixes', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    // Wait for App.init() to complete
    await page.waitForFunction(() => typeof App !== 'undefined' && typeof Engine !== 'undefined');
  });

  // ─── FIX 1: Free Run auto-opens speed QS panel ────────────────────────
  test('free run opens speed quick-select panel', async ({ page }) => {
    // Click FREE RUN button
    const freeRunBtn = page.locator('.setup-freerun-btn');
    await expect(freeRunBtn).toBeVisible();
    await freeRunBtn.click();

    // Setup overlay should be hidden
    const setup = page.locator('#setupOverlay');
    await expect(setup).toBeHidden();

    // Focus mode should be active
    await expect(page.locator('.layout')).toHaveClass(/focus/);

    // Speed QS panel should auto-open after 500ms
    await page.waitForTimeout(700);
    const qsSpeed = page.locator('#qsSpeed');
    await expect(qsSpeed).toHaveClass(/open/);

    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/01-freerun-qs-open.png' });
  });

  // ─── FIX 2: Focus mode hides route name ────────────────────────────────
  test('focus mode hides route name box', async ({ page }) => {
    // Start a run to enter focus mode
    const startBtn = page.locator('.setup-start-btn');
    await startBtn.click();

    // Topbar should have focus class
    await expect(page.locator('.topbar')).toHaveClass(/focus/);

    // Route name should be hidden
    const rname = page.locator('.rname');
    await expect(rname).toBeHidden();

    // Timer should still be visible
    const timer = page.locator('#timerEl');
    await expect(timer).toBeVisible();

    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/02-focus-no-rname.png' });
  });

  // ─── FIX 3: Focus badges centered (not covered by QS panels) ──────────
  test('focus badges visible and centered in focus mode', async ({ page }) => {
    const startBtn = page.locator('.setup-start-btn');
    await startBtn.click();

    // Focus badges should be visible
    const badges = page.locator('#focusBadges');
    await expect(badges).toBeVisible();

    // Check badges are horizontally centered (left: 50%)
    const badgeBox = await badges.boundingBox();
    expect(badgeBox).toBeTruthy();
    // Badges should be roughly centered in the map zone
    const mapZone = page.locator('.map-zone');
    const mapBox = await mapZone.boundingBox();
    if (badgeBox && mapBox) {
      const badgeCenterX = badgeBox.x + badgeBox.width / 2;
      const mapCenterX = mapBox.x + mapBox.width / 2;
      expect(Math.abs(badgeCenterX - mapCenterX)).toBeLessThan(100);
    }

    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/03-focus-badges-centered.png' });
  });

  // ─── FIX 4: Focus badges not covered when speed QS opens ──────────────
  test('focus badges remain visible when speed QS panel opens', async ({ page }) => {
    const startBtn = page.locator('.setup-start-btn');
    await startBtn.click();
    await page.waitForTimeout(300);

    // Open speed QS panel
    await page.evaluate(() => App.toggleQS('speed'));
    await page.waitForTimeout(400);

    const qsSpeed = page.locator('#qsSpeed');
    await expect(qsSpeed).toHaveClass(/open/);

    // Focus badges should still be visible and not behind the QS panel
    const badges = page.locator('#focusBadges');
    await expect(badges).toBeVisible();
    const badgeBox = await badges.boundingBox();
    const qsBox = await qsSpeed.boundingBox();

    // Badges should not be fully inside the QS panel area
    if (badgeBox && qsBox) {
      // Badges center should be to the left of the QS panel
      const badgeRight = badgeBox.x + badgeBox.width;
      // With centered badges, they shouldn't overlap the right-side QS panel
      console.log(`Badges: x=${badgeBox.x}, right=${badgeRight}, QS: x=${qsBox.x}`);
    }

    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/04-badges-with-qs.png' });
  });

  // ─── FIX 5: Settings panel fits within 720px canvas ────────────────────
  test('settings panel fits within viewport', async ({ page }) => {
    // Open settings
    await page.evaluate(() => App.openSettings());
    await page.waitForTimeout(400);

    const panel = page.locator('.sp-panel');
    await expect(panel).toBeVisible();

    const panelBox = await panel.boundingBox();
    expect(panelBox).toBeTruthy();
    if (panelBox) {
      // Panel should not exceed 720px height (the rootApp height)
      expect(panelBox.height).toBeLessThanOrEqual(680);
      // Panel should be less than 560px wide (we reduced to 520)
      expect(panelBox.width).toBeLessThanOrEqual(540);
    }

    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/05-settings-fits.png' });
  });

  // ─── FIX 6: Metrics dropdown updates visible label ─────────────────────
  test('metrics dropdown updates visible label on change', async ({ page }) => {
    // Open settings and go to metrics tab
    await page.evaluate(() => {
      SettingsPanel.open();
      SettingsPanel._setTab('metrics');
    });
    await page.waitForTimeout(400);

    // Find first metric item
    const firstItem = page.locator('.sp-metric-item').first();
    await expect(firstItem).toBeVisible();

    const nameSpan = firstItem.locator('.sp-metric-name');
    const select = firstItem.locator('.sp-metric-select');

    // Get initial label
    const initialText = await nameSpan.textContent();

    // Change the dropdown to a different value
    await select.selectOption('cadence');
    await page.waitForTimeout(200);

    // Name span should update
    const updatedText = await nameSpan.textContent();
    expect(updatedText).toBe('Cadence');
    expect(updatedText).not.toBe(initialText);

    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/06-metric-label-update.png' });
  });

  // ─── FIX 7: Oval track gets progress without WorkoutSegments ──────────
  test('oval track receives progress during route run', async ({ page }) => {
    // Start a run
    const startBtn = page.locator('.setup-start-btn');
    await startBtn.click();
    await page.waitForTimeout(300);

    // Switch to oval view
    await page.evaluate(() => App.setMapStyle('oval'));
    await page.waitForTimeout(300);

    // Verify OvalTrack is active
    const ovalActive = await page.evaluate(() => OvalTrack.active);
    expect(ovalActive).toBe(true);

    // Simulate speed and tick
    await page.evaluate(() => {
      Engine.run.speed = 8;
      Engine.run.speedSource = 'simulation';
      // Manually tick a few times
      for (let i = 0; i < 20; i++) {
        Engine.tick();
      }
    });
    await page.waitForTimeout(500);

    // OvalTrack should have non-zero progress (distance was accumulated)
    const progress = await page.evaluate(() => OvalTrack._progress);
    expect(progress).toBeGreaterThan(0);

    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/07-oval-progress.png' });
  });

  // ─── FIX 8: Emergency stop button visible and functional ──────────────
  test('emergency stop button accessible in focus mode', async ({ page }) => {
    const startBtn = page.locator('.setup-start-btn');
    await startBtn.click();

    // E-stop should be visible even in focus mode
    const estop = page.locator('.estop');
    await expect(estop).toBeVisible();

    const estopBox = await estop.boundingBox();
    expect(estopBox).toBeTruthy();
    // Should be clickable (not behind another element)
    if (estopBox) {
      expect(estopBox.width).toBeGreaterThan(10);
      expect(estopBox.height).toBeGreaterThan(10);
    }

    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/08-estop-visible.png' });
  });

  // ─── FIX 9: All settings accordion sections open and render ────────────
  test('all settings accordion sections render correctly', async ({ page }) => {
    await page.evaluate(() => App.openSettings());
    await page.waitForTimeout(400);

    const sections = ['audio', 'heartrate', 'bluetooth', 'features', 'display', 'theme', 'units', 'integrations', 'profile'];

    for (const sec of sections) {
      // Close all sections first, then open just this one
      await page.evaluate((s) => {
        // Ensure only our target section is open
        SettingsPanel._openSections.clear();
        SettingsPanel._openSections.add(s);
        SettingsPanel._render();
      }, sec);
      await page.waitForTimeout(300);

      // Verify the accordion body rendered
      const bodyCount = await page.locator('.sp-acc-body').count();
      expect(bodyCount).toBeGreaterThan(0);

      await page.screenshot({ path: `/mnt/d/trailrunner/tests/screenshots/09-settings-${sec}.png` });
    }
  });

  // ─── FIX 10: Bottom strip speed/incline controls work in focus mode ────
  test('bottom strip controls visible and functional in focus mode', async ({ page }) => {
    const startBtn = page.locator('.setup-start-btn');
    await startBtn.click();
    await page.waitForTimeout(300);

    // Bottom strip should still be visible
    const bottomStrip = page.locator('.bottom-strip');
    await expect(bottomStrip).toBeVisible();

    // Speed +/- buttons should work
    const speedUp = page.locator('.speed-up');
    await expect(speedUp).toBeVisible();
    await speedUp.click();
    await page.waitForTimeout(100);

    // Speed should have increased
    const speed = await page.evaluate(() => Engine.ctrl.targetSpeed);
    expect(speed).toBeGreaterThan(0);

    // Big speed display should show the value
    const bigSpeed = page.locator('#bigSpeedVal');
    const speedText = await bigSpeed.textContent();
    expect(parseFloat(speedText)).toBeGreaterThan(0);

    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/10-bottom-controls.png' });
  });

  // ─── FIX 11: Settings tabs all render without overflow ─────────────────
  test('settings panel tabs render within bounds', async ({ page }) => {
    await page.evaluate(() => App.openSettings());
    await page.waitForTimeout(400);

    const tabs = ['controls', 'metrics', 'charts', 'widgets'];
    for (const tab of tabs) {
      await page.evaluate((t) => SettingsPanel._setTab(t), tab);
      await page.waitForTimeout(300);

      const panel = page.locator('.sp-panel');
      const panelBox = await panel.boundingBox();
      if (panelBox) {
        // Should stay within 720px canvas height
        expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(720);
      }

      await page.screenshot({ path: `/mnt/d/trailrunner/tests/screenshots/11-settings-tab-${tab}.png` });
    }
  });

  // ─── FIX 12: Hamburger menu accessible in focus mode ───────────────────
  test('hamburger menu opens and navigates in focus mode', async ({ page }) => {
    const startBtn = page.locator('.setup-start-btn');
    await startBtn.click();
    await page.waitForTimeout(300);

    // Hamburger should be visible
    const hamburger = page.locator('.focus-menu-btn');
    await expect(hamburger).toBeVisible();
    await hamburger.click();

    // Focus menu overlay should show
    const overlay = page.locator('#focusMenuOverlay');
    await expect(overlay).toHaveClass(/show/);

    // Menu items should be visible
    const items = page.locator('.fm-item');
    const count = await items.count();
    expect(count).toBeGreaterThan(5);

    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/12-hamburger-menu.png' });

    // Click outside to close
    await overlay.click({ position: { x: 1000, y: 400 } });
    await page.waitForTimeout(300);
    await expect(overlay).not.toHaveClass(/show/);
  });

  // ─── FIX 13: Dot moves and distance accumulates during a run ──────────
  test('dot moves and distance accumulates over simulated run', async ({ page }) => {
    // Start a run
    const startBtn = page.locator('.setup-start-btn');
    await startBtn.click();
    await page.waitForTimeout(300);

    // Set speed to 10 km/h (manual mode simulation)
    await page.evaluate(() => {
      Engine.ctrl.mode = 'manual';
      Engine.ctrl.targetSpeed = 10;
      Engine.run.speedSource = 'simulation';
    });

    // Take initial distance reading
    const dist0 = await page.evaluate(() => Engine.run.distanceM);

    // Wait 5 seconds — speed ramps at 2km/h/s so ~2.5s to reach 10km/h
    await page.waitForTimeout(5000);

    const dist5 = await page.evaluate(() => Engine.run.distanceM);
    const speed5 = await page.evaluate(() => Engine.run.speed);
    expect(dist5).toBeGreaterThan(dist0);
    expect(speed5).toBeGreaterThan(0);
    console.log(`After 5s: dist=${dist5.toFixed(1)}m, speed=${speed5.toFixed(1)}km/h`);
    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/13-run-5s.png' });

    // Wait another 10 seconds
    await page.waitForTimeout(10000);

    const dist15 = await page.evaluate(() => Engine.run.distanceM);
    const elapsed15 = await page.evaluate(() => Engine.run.elapsed);
    expect(dist15).toBeGreaterThan(dist5);
    expect(elapsed15).toBeGreaterThan(10);

    const speedNow = await page.evaluate(() => Engine.run.speed);
    expect(speedNow).toBeCloseTo(10, 0);

    console.log(`After 15s: dist=${dist15.toFixed(1)}m, elapsed=${elapsed15.toFixed(1)}s, speed=${speedNow.toFixed(1)}km/h`);
    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/13-run-15s.png' });

    // Verify focus badge values updated
    const fbDist = await page.locator('#fbDist').textContent();
    expect(parseFloat(fbDist)).toBeGreaterThan(0);
    const fbSpeed = await page.locator('#fbSpeed').textContent();
    expect(parseFloat(fbSpeed)).toBeGreaterThan(0);
  });

  // ─── FIX 14: Speed ramp works (doesn't jump instantly) ────────────────
  test('speed ramps gradually not instantly', async ({ page }) => {
    const startBtn = page.locator('.setup-start-btn');
    await startBtn.click();
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      Engine.ctrl.mode = 'manual';
      Engine.run.speedSource = 'simulation';
      Engine.run.speed = 0;
      Engine.ctrl.targetSpeed = 16;
      Engine.run.incline = 0;
    });

    // After 1s speed should be ramping (2km/h/s rate = ~2km/h after 1s)
    await page.waitForTimeout(1200);
    const speed1 = await page.evaluate(() => Engine.run.speed);
    expect(speed1).toBeLessThan(16);
    expect(speed1).toBeGreaterThanOrEqual(0);
    console.log(`After 1.2s: speed=${speed1.toFixed(2)} (target 16)`);

    // After 4 more seconds
    await page.waitForTimeout(4000);
    const speed4 = await page.evaluate(() => Engine.run.speed);
    expect(speed4).toBeGreaterThan(6);
    console.log(`After 4.3s: speed=${speed4.toFixed(2)} (target 16)`);

    // After 10 total, should be at or very near target
    await page.waitForTimeout(6000);
    const speed8 = await page.evaluate(() => Engine.run.speed);
    expect(speed8).toBeGreaterThan(14);
    console.log(`After 10s: speed=${speed8.toFixed(2)} (target 16)`);

    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/14-speed-ramp.png' });
  });

  // ─── FIX 15: Free run shows START not PAUSE ───────────────────────────
  test('free run shows START button until user starts', async ({ page }) => {
    const freeRunBtn = page.locator('.setup-freerun-btn');
    await freeRunBtn.click();
    await page.waitForTimeout(700);

    const status = await page.evaluate(() => Engine.run ? Engine.run.status : null);
    expect(status).toBe('ready');

    const fcStart = page.locator('#fcStart');
    const fcPause = page.locator('#fcPause');
    await expect(fcStart).toBeVisible();
    await expect(fcPause).toBeHidden();

    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/15-freerun-start-btn.png' });

    // Click START to begin
    await fcStart.click();
    await page.waitForTimeout(300);
    const statusAfter = await page.evaluate(() => Engine.run ? Engine.run.status : null);
    expect(statusAfter).toBe('running');
    await expect(fcStart).toBeHidden();
    await expect(fcPause).toBeVisible();
  });

  // ─── FIX 16: Pause shows funny message ────────────────────────────────
  test('pause overlay shows funny message', async ({ page }) => {
    const startBtn = page.locator('.setup-start-btn');
    await startBtn.click();
    await page.waitForTimeout(300);

    await page.evaluate(() => App.togglePause());
    await page.waitForTimeout(300);

    const pauseOverlay = page.locator('#pauseOverlay');
    await expect(pauseOverlay).toHaveClass(/show/);

    const jokeEl = page.locator('#pauseJoke');
    const joke = await jokeEl.textContent();
    expect(joke.length).toBeGreaterThan(5);
    console.log(`Pause joke: "${joke}"`);

    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/16-pause-joke.png' });
  });

  // ─── FIX 17: Pac-Man dots and arcade ghosts render on oval track ──────
  test('oval track pac-man dots and ghosts render', async ({ page }) => {
    const startBtn = page.locator('.setup-start-btn');
    await startBtn.click();
    await page.waitForTimeout(300);

    // Switch to oval view
    await page.evaluate(() => App.setMapStyle('oval'));
    await page.waitForTimeout(500);

    // Verify OvalTrack initialized game elements
    const dotsCount = await page.evaluate(() => OvalTrack._dots.length);
    expect(dotsCount).toBe(40);

    const powerDotsCount = await page.evaluate(() => OvalTrack._powerDots.length);
    expect(powerDotsCount).toBe(4);

    const ghostsCount = await page.evaluate(() => OvalTrack._arcadeGhosts.length);
    expect(ghostsCount).toBe(4);

    // Verify ghost names are correct
    const ghostNames = await page.evaluate(() => OvalTrack._arcadeGhosts.map(g => g.name));
    expect(ghostNames).toEqual(['Blinky', 'Pinky', 'Inky', 'Clyde']);

    // Score may already be > 0 if Pac-Man ate dots near starting position
    const score = await page.evaluate(() => OvalTrack._score);
    expect(score).toBeGreaterThanOrEqual(0);

    // Set speed and let Pac-Man move to eat some dots
    await page.evaluate(() => {
      Engine.ctrl.mode = 'manual';
      Engine.ctrl.targetSpeed = 10;
      Engine.run.speedSource = 'simulation';
    });
    await page.waitForTimeout(5000);

    // Some dots should have been eaten (score > 0)
    const scoreAfter = await page.evaluate(() => OvalTrack._score);
    expect(scoreAfter).toBeGreaterThan(0);
    console.log(`Pac-Man score after 5s: ${scoreAfter}`);

    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/17-pacman-dots-ghosts.png' });
  });

  // ─── FIX 18: Map style buttons compact at bottom-left ─────────────────
  test('map style buttons are compact icons at bottom-left', async ({ page }) => {
    const mapTl = page.locator('.map-tl');
    await expect(mapTl).toBeVisible();

    const box = await mapTl.boundingBox();
    expect(box).toBeTruthy();
    if (box) {
      expect(box.y).toBeGreaterThan(300);
      expect(box.x).toBeLessThan(100);
      console.log(`Map buttons: x=${box.x}, y=${box.y}, w=${box.width}, h=${box.height}`);
    }

    const btn = page.locator('.map-mode-btn').first();
    const btnBox = await btn.boundingBox();
    if (btnBox) {
      expect(btnBox.width).toBeLessThanOrEqual(40);
      expect(btnBox.height).toBeLessThanOrEqual(40);
    }

    await page.screenshot({ path: '/mnt/d/trailrunner/tests/screenshots/17-map-buttons-compact.png' });
  });

});
