/**
 * 冒烟测试：真浏览器里走一遍主流程。
 *
 * 用系统 Edge（channel: msedge），不下载 Playwright 自带浏览器 —— 国内环境更省事。
 * 全程跑 mock provider，不消耗任何积分、不依赖外网。
 *
 * 用法：
 *   npm run build
 *   npx vite preview --port 4173 &
 *   node tests/e2e/smoke.mjs
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE_URL = process.env.P3D_BASE_URL ?? 'http://127.0.0.1:4173';
const OUT_DIR = 'tests/e2e/artifacts';

function log(step, extra = '') {
  console.log(`  ${step}${extra ? ` · ${extra}` : ''}`);
}

/**
 * 拖 gizmo。
 *
 * 不能盲点坐标：点偏了会变成旋转相机，而相机一动 gizmo 的位置也变了，
 * 搜索会自我失效。所以先用 ?debug=1 暴露的 axis 状态确定命中点，
 * 再按下拖动 —— 先沿竖线找手柄所在的纵向位置，再沿横线找 X 轴。
 */
async function dragGizmo(page) {
  const box = await page.locator('canvas').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // hover 一次真实的 pointermove，再读 gizmo 当前命中的轴
  const probe = async (dx, dy) => {
    await page.mouse.move(cx + dx, cy + dy);
    return page.evaluate(() => window.__p3d?.getAxis?.() ?? null);
  };

  // 第一步：竖着扫，找到任意手柄（通常是 Y 轴）
  let bandY = null;
  for (let dy = -220; dy <= 320; dy += 10) {
    if (await probe(0, dy)) {
      bandY = dy;
      break;
    }
  }
  if (bandY === null) return { ok: false, detail: '没找到 gizmo 手柄' };

  // 第二步：在同一高度横向扫，找 X 轴（横向拖动最直观）
  let hit = null;
  for (let dx = 10; dx <= 160; dx += 8) {
    const axis = await probe(dx, bandY);
    if (axis === 'X') {
      hit = { dx, dy: bandY };
      break;
    }
  }
  if (!hit) return { ok: false, detail: '没找到 X 轴手柄' };

  const readX = async () => {
    const raw = await page.evaluate(() => localStorage.getItem('p3d:scene:v1'));
    const objects = JSON.parse(raw ?? '{"objects":[]}').objects;
    return objects[0]?.position?.[0] ?? 0;
  };

  const before = await readX();
  await page.mouse.move(cx + hit.dx, cy + hit.dy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(cx + hit.dx + i * 8, cy + hit.dy + i * 2);
  }
  const dragging = await page.evaluate(() => window.__p3d?.isDragging?.() ?? false);
  await page.mouse.up();
  await page.waitForTimeout(350);
  const after = await readX();

  return {
    ok: dragging === true && Math.abs(after - before) > 0.05,
    detail: `x ${before.toFixed(2)} → ${after.toFixed(2)}（dragging=${dragging}）`,
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    log(`${ok ? 'PASS' : 'FAIL'} ${name}`, detail);
  };

  try {
    // ?debug=1 只在测试里用：它暴露 gizmo 的 axis 状态，让拖拽能被确定性验证
    await page.goto(`${BASE_URL}/?debug=1`, { waitUntil: 'domcontentloaded' });

    // 1. 首屏外壳 + 上传控件
    await page.waitForSelector('text=p3d', { timeout: 10_000 });
    check('首屏渲染', true);

    const generateButton = page.getByRole('button', { name: /开始生成/ });
    check('未选图时生成按钮禁用', await generateButton.isDisabled());

    // 2. 用内置示例图走完预处理（去背景 + 裁切 + 哈希）
    await page.getByRole('button', { name: /没有图？用示例图/ }).click();
    // 等预览区出现"点击可换一张"，才说明预处理真的产出了结果
    await page.waitForSelector('text=点击可换一张', { timeout: 30_000 });
    check('图片预处理完成', await generateButton.isEnabled());

    // 3. 提交生成任务，等 mock 走完假进度
    await generateButton.click();
    await page.waitForSelector('text=生成完成', { timeout: 30_000 });
    check('生成流程走到完成', true);

    // 4. 模型入场景、canvas 出现
    await page.waitForSelector('canvas', { timeout: 10_000 });
    const stats = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      return {
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
      };
    });
    check(
      'WebGL 画布已渲染',
      stats.width > 0 && stats.height > 0,
      `${stats.width}×${stats.height}`,
    );

    // 先留一张"干净"的桌面截图：未切线框、等轴视角
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT_DIR}/smoke-desktop.png` });

    // 4.5 简单模式：进阶面板默认收起，且场景里始终只有一个模型
    check(
      '简单模式隐藏场景对象列表',
      !(await page
        .getByText('4 · 场景对象')
        .isVisible()
        .catch(() => false)),
    );
    check(
      '简单模式隐藏网格/线框',
      !(await page
        .getByRole('button', { name: '线框', exact: true })
        .isVisible()
        .catch(() => false)),
    );

    // 同图同参数再生成：简单模式下应该"原地替换"，不会堆出第二个
    await generateButton.click();
    await page.waitForSelector('text=命中缓存', { timeout: 10_000 });
    check('同图同参数命中去重缓存', true);
    const simpleCount = await page.evaluate(() => {
      const raw = localStorage.getItem('p3d:scene:v1');
      return JSON.parse(raw ?? '{"objects":[]}').objects.length;
    });
    check('简单模式下场景始终只有一个模型', simpleCount === 1, `${simpleCount} 个`);

    // 切到完整模式，继续验证 M4 的摆放能力
    await page.getByRole('button', { name: '完整', exact: true }).click();
    await page.waitForSelector('text=4 · 场景对象', { timeout: 5_000 });
    check('一键切到完整模式', true);

    // 5. M4：场景对象列表 + 手动追加一个（同款可放多个）
    check('场景对象列表出现模型 01', await page.getByText('模型 01').first().isVisible());
    await page.getByRole('button', { name: '再加一个' }).click();
    await page.waitForSelector('text=模型 02', { timeout: 10_000 });
    check('同款模型可再放一个', true);

    // 6. M4：选中对象 → 出现变换工具条 → 切到旋转
    await page.getByText('模型 01', { exact: true }).first().click();
    await page.waitForSelector('text=变换', { timeout: 5_000 });
    check('选中后出现变换工具条', true);

    await page.getByRole('button', { name: '旋转', exact: true }).click();
    await page.waitForTimeout(400);
    const rotatePressed = await page
      .getByRole('button', { name: '旋转', exact: true })
      .getAttribute('aria-pressed');
    check('变换模式可切换', rotatePressed === 'true');

    // 6.5 真正拖动 gizmo：先回到移动模式，用 debug 钩子找手柄再拖
    await page.getByRole('button', { name: '移动', exact: true }).click();
    await page.waitForTimeout(300);
    const dragged = await dragGizmo(page);
    check('拖动 gizmo 可移动模型', dragged.ok, dragged.detail);

    // 7. M4：快捷键 Delete 移除选中对象
    await page.keyboard.press('Escape');
    await page.getByText('模型 01', { exact: true }).first().click();
    await page.keyboard.press('Delete');
    await page.waitForTimeout(400);
    // 删的是 01，02 应该还在
    check('Delete 键可移除选中对象', !(await page.getByText('模型 01').first().isVisible()));

    // 8. M4：场景状态写进 localStorage
    const sceneStored = await page.evaluate(() => localStorage.getItem('p3d:scene:v1'));
    const sceneObjects = JSON.parse(sceneStored ?? '{"objects":[]}').objects;
    check('场景状态已持久化', Array.isArray(sceneObjects) && sceneObjects.length === 1);

    // 9. 交互：切到"后"视角，确认不报错
    await page.getByRole('button', { name: '后', exact: true }).click();
    await page.waitForTimeout(500);
    check('视角预设可切换', true);

    // 10. 线框开关（调试图层）
    await page.getByRole('button', { name: '线框' }).click();
    await page.waitForTimeout(300);
    check('线框开关可用', true);

    // 11. 历史记录写入本地
    const stored = await page.evaluate(() => localStorage.getItem('p3d:jobs:v1'));
    check('历史记录已持久化', Boolean(stored?.includes('succeeded')));

    await page.screenshot({ path: `${OUT_DIR}/smoke-after-interactions.png` });

    // 13. 刷新后场景还在（持久化真的能从 localStorage 读回来）
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas', { timeout: 15_000 });
    check('刷新后场景仍在', await page.getByText('模型 02').first().isVisible());

    // 14. 移动端布局：允许降级，但要能看、能转
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await mobile.waitForSelector('text=p3d', { timeout: 10_000 });
    const mobileCanvas = await mobile.waitForSelector('canvas', { timeout: 15_000 });
    check('移动端渲染出画布', Boolean(mobileCanvas));
    await mobile.screenshot({ path: `${OUT_DIR}/smoke-mobile.png` });
    await mobile.close();

    check('无 JS 运行时报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  } catch (error) {
    check('流程异常', false, error instanceof Error ? error.message : String(error));
    await page.screenshot({ path: `${OUT_DIR}/smoke-failure.png` }).catch(() => {});
  } finally {
    await browser.close();
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length > 0) {
    console.log('失败项：', failed.map((item) => item.name).join(', '));
    process.exit(1);
  }
}

main();
