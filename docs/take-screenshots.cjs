'use strict';
/* 一次性截图脚本：用本机 Edge 截取 首页/大厅/对局 三张图到 docs/ */
const { chromium } = require('playwright-core');

const BASE = 'http://localhost:8420';
const OUT = __dirname;

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // 跳过首次访问自动弹出的"玩法说明"弹窗
  await ctx.addInitScript(() => { try { localStorage.setItem('mj_help_seen', '1'); } catch {} });
  const page = await ctx.newPage();

  // 1. 首页
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: OUT + '/screenshot-home.png' });
  console.log('[ok] 首页截图');

  // 2. 创建房间 + 3 机器人 → 大厅
  await page.fill('#inp-name', '截图演示');
  await page.click('#btn-create');
  await page.waitForSelector('#view-lobby:not(.hidden)', { timeout: 8000 });
  await page.waitForTimeout(400);
  for (let i = 0; i < 3; i++) {
    await page.click('#btn-addbot');
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: OUT + '/screenshot-lobby.png' });
  console.log('[ok] 大厅截图');

  // 3. 开始对局：自动打牌约 35 秒，让牌河积累后再截图
  await page.click('#btn-start');
  await page.waitForSelector('#view-game:not(.hidden)', { timeout: 8000 });
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    const myTurn = await page.evaluate(() => {
      const hud = document.getElementById('hud-turn');
      const hand = document.querySelectorAll('#my-hand .tile');
      return hud && hud.textContent.includes('轮到你了') && hand.length > 0;
    }).catch(() => false);
    if (myTurn) {
      // 点击最右侧（刚摸的）牌两次：选中 → 打出
      const tiles = page.locator('#my-hand .tile');
      const n = await tiles.count();
      if (n > 0) {
        await tiles.nth(n - 1).click().catch(() => {});
        await page.waitForTimeout(350);
        // 打出按钮或再次点击该牌
        const btn = page.locator('#action-bar .btn, #action-bar button').first();
        if (await btn.count()) await btn.click().catch(() => {});
        else await tiles.nth(n - 1).click().catch(() => {});
      }
    }
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT + '/screenshot-game.png' });
  console.log('[ok] 对局截图');

  await browser.close();
})().catch((e) => { console.error('[fail]', e.message); process.exit(1); });
