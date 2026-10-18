// 打开X长文编辑器并填写：标题、封面、正文、图片。全程不点发布。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { chromium } from 'playwright';

export class StepError extends Error {
  constructor(step, message) {
    super(message);
    this.step = step;
  }
}

const log = {
  step: (s) => console.log(`\n▶ ${s}`),
  info: (s) => console.log(`  ${s}`),
  ok: (s) => console.log(`  ✓ ${s}`),
  warn: (s) => console.log(`  ⚠ ${s}`),
};

function toMatcher(v) {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(v);
  return m ? new RegExp(m[1], m[2]) : v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

class Filler {
  constructor(page, cfg) {
    this.page = page;
    this.cfg = cfg;
    this.t = cfg.timing;
    this.forbidden = toMatcher(cfg.forbiddenClickNames);
  }

  // 模拟人工操作节奏的随机停顿
  pause(scale = 1) {
    const { minDelayMs: a, maxDelayMs: b } = this.t;
    return sleep(Math.round((a + Math.random() * (b - a)) * scale));
  }

  locatorFor(spec) {
    const scope = spec.within ? this.page.locator(spec.within) : this.page;
    if (spec.css) return scope.locator(spec.css);
    if (spec.role) return scope.getByRole(spec.role, spec.name ? { name: toMatcher(spec.name) } : {});
    if (spec.placeholder) return scope.getByPlaceholder(toMatcher(spec.placeholder));
    if (spec.text) return scope.getByText(toMatcher(spec.text));
    throw new Error(`选择器写法不认识：${JSON.stringify(spec)}`);
  }

  // 在候选选择器里找第一个可见元素；optional=true 时找不到返回 null
  async find(candidates, what, { timeout = this.t.findTimeoutMs, optional = false } = {}) {
    const deadline = Date.now() + timeout;
    do {
      for (const spec of candidates) {
        const loc = this.locatorFor(spec);
        const n = await loc.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
          const el = loc.nth(i);
          if (await el.isVisible().catch(() => false)) return el;
        }
      }
      await sleep(300);
    } while (Date.now() < deadline);
    if (optional) return null;
    throw new Error(`页面上找不到「${what}」。已尝试：${JSON.stringify(candidates)}。如果X改版了，请修改 selectors.json 里对应的项。`);
  }

  // 所有点击都走这里：点击前检查，绝不点击发布类按钮
  async click(loc, what) {
    const label = await loc
      .evaluate((el) => [el.getAttribute('aria-label') || '', el.innerText || '', el.value || ''])
      .catch(() => []);
    for (const s of label) {
      if (s && this.forbidden.test(s.trim())) {
        throw new Error(`安全拦截：「${what}」定位到了发布类按钮（${s.trim()}），已停止。请检查 selectors.json。`);
      }
    }
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await this.pause(0.6);
    await loc.click();
  }

  async editor() {
    return this.find(this.cfg.bodyEditor, '正文编辑区');
  }

  async editorState() {
    const ed = await this.editor();
    return ed.evaluate((el, imgSel) => ({
      text: el.innerText,
      images: el.querySelectorAll(imgSel).length,
    }), this.cfg.editorImage);
  }

  async uploadingVisible() {
    const loc = this.page.getByText(toMatcher(this.cfg.uploadingText));
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return true;
    return false;
  }

  // 依次点击 clicks 里的元素，期间一旦页面要打开文件选择框，就直接把本地文件交给它（不弹系统窗口）
  async uploadVia(clicks, file, what) {
    let chooser = null;
    const chooserPromise = this.page
      .waitForEvent('filechooser', { timeout: this.t.uploadTimeoutMs })
      .then((c) => { chooser = c; })
      .catch(() => {});

    for (const { candidates, label, optional } of clicks) {
      if (chooser) break;
      const el = await this.find(candidates, label, optional ? { timeout: this.t.optionalStepTimeoutMs, optional: true } : {});
      if (!el) continue;
      await this.click(el, label);
      await sleep(800);
    }
    if (!chooser) await Promise.race([chooserPromise, sleep(1500)]);

    if (chooser) {
      await chooser.setFiles(file);
      return;
    }
    // 退路：直接写入页面上的文件上传控件
    const inputs = this.page.locator(this.cfg.imageFileInput);
    const n = await inputs.count();
    if (!n) throw new Error(`没有出现文件选择框，也找不到上传控件（${this.cfg.imageFileInput}），无法上传${what}`);
    await inputs.nth(n - 1).setInputFiles(file);
  }

  // 等上传完成；期间如果弹窗里出现「应用/完成」之类的确认按钮就点掉
  async waitUploaded(check, what, confirm = [], baseDialogs = 0) {
    const deadline = Date.now() + this.t.uploadTimeoutMs;
    const inDialog = confirm.map((s) => ({ within: "[role='dialog']", ...s }));
    await sleep(1000);
    while (Date.now() < deadline) {
      const btn = inDialog.length ? await this.find(inDialog, `${what}确认按钮`, { timeout: 0, optional: true }) : null;
      if (btn) {
        await this.click(btn, `${what}确认按钮`);
        await sleep(800);
        continue;
      }
      if (!(await this.uploadingVisible()) && (await this.dialogCount()) <= baseDialogs && (await check())) return;
      await sleep(500);
    }
    throw new Error(`${what}等待上传完成超时（${this.t.uploadTimeoutMs / 1000}秒）`);
  }

  // 当前可见的弹窗数量（用于判断上传/确认弹窗是否已关闭）
  async dialogCount() {
    const loc = this.page.locator("[role='dialog']");
    let n = 0;
    for (let i = 0; i < (await loc.count()); i++) if (await loc.nth(i).isVisible().catch(() => false)) n++;
    return n;
  }

  // ---------- 各步骤 ----------

  async openEditor(composeUrl) {
    const { page, cfg } = this;
    await page.goto(composeUrl, { waitUntil: 'domcontentloaded' });

    for (let attempt = 0; ; attempt++) {
      const loginRe = new RegExp(cfg.loginUrlPattern);
      const onLogin = loginRe.test(new URL(page.url()).pathname);
      const ready = onLogin
        ? null
        : await this.find([...cfg.createButton, ...cfg.titleInput], '新建按钮或标题栏', { optional: true });
      if (ready) break;
      if (attempt >= 1) throw new Error('登录后仍然打不开长文页面。请确认账号有长文（Articles）权限，或检查 selectors.json 中的 createButton。');
      if (!process.stdin.isTTY) {
        // 在后台运行（比如由 Claude 调用）时没法按回车，直接说明怎么登录
        throw new Error('[未登录] 还没有登录X。请先运行 x-article-fill --login，在打开的窗口里登录后按 Cmd+Q 退出，再重新运行。');
      }
      console.log('\n  看起来还没有登录X（或页面没加载出来）。');
      console.log('  · 用X账号密码登录：直接在打开的浏览器窗口里登录，然后回这里按回车。');
      console.log('  · 用Google登录：Google不允许在自动化窗口里登录。请按 Ctrl+C 结束，先运行 x-article-fill --login 登录一次。');
      await waitForEnter('  登录完成后按回车继续… ');
      await page.goto(composeUrl, { waitUntil: 'domcontentloaded' });
    }

    const title = await this.find(cfg.titleInput, '标题栏', { timeout: 1500, optional: true });
    if (!title) {
      const create = await this.find(cfg.createButton, '新建长文按钮');
      await this.click(create, '新建长文按钮');
    }
    await this.find(cfg.titleInput, '标题栏');
    await this.editor();
    await this.pause();
  }

  async setCover(file) {
    const { cfg } = this;
    const dialogs = await this.dialogCount();
    await this.uploadVia([{ candidates: cfg.coverButton, label: '添加封面按钮' }], file, '封面');
    await this.waitUploaded(async () => true, '封面', cfg.coverConfirm, dialogs);
  }

  async fillTitle(text) {
    const title = await this.find(this.cfg.titleInput, '标题栏');
    await this.click(title, '标题栏');
    await this.page.keyboard.type(text, { delay: this.t.typeDelayMs });
    await this.pause();
    const value = await title.evaluate((el) => el.value ?? el.innerText);
    if (!value.includes(text)) throw new Error(`标题写入后内容不一致：期望「${text}」，实际「${value}」`);
  }

  async pasteHtml(html, method) {
    const ed = await this.editor();
    await this.click(ed, '正文编辑区');
    await this.pause(0.5);
    const plain = html.replace(/<br>/g, '\n').replace(/<\/(p|h\d|li|blockquote)>/g, '\n').replace(/<[^>]+>/g, '');

    if (method === 'clipboard') {
      // 真实的粘贴：写入剪贴板后按 Cmd/Ctrl+V，编辑器用自己的格式规则转换
      const ok = await this.page.evaluate(async ({ html, plain }) => {
        try {
          await navigator.clipboard.write([new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([plain], { type: 'text/plain' }),
          })]);
          return true;
        } catch { return false; }
      }, { html, plain });
      if (ok) {
        await this.page.keyboard.press('ControlOrMeta+V');
        await sleep(1500);
        if ((await this.editorState()).text.trim()) return 'clipboard';
      }
      log.warn('剪贴板粘贴没有生效，改用页面内粘贴事件');
    }

    await ed.evaluate((el, { html, plain }) => {
      el.focus();
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', plain);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, { html, plain });
    await sleep(1500);
    if (!(await this.editorState()).text.trim()) throw new Error('正文粘贴后编辑器仍为空');
    return 'event';
  }

  // 选中占位行文字并删除，光标留在这一空行，图片就插在这里
  async clearMarker(marker) {
    // 上一张图还在上传/处理时编辑器是只读的，先等它结束；删除失败再重试几次
    for (let attempt = 1; ; attempt++) {
      await this.waitIdle();
      try {
        return await this.clearMarkerOnce(marker);
      } catch (e) {
        if (attempt >= 3) throw e;
        log.warn(`${e.message}，${attempt * 3}秒后重试`);
        await sleep(attempt * 3000);
      }
    }
  }

  async waitIdle() {
    const deadline = Date.now() + this.t.uploadTimeoutMs;
    while (await this.uploadingVisible()) {
      if (Date.now() > deadline) throw new Error('等待媒体上传/处理完成超时');
      await sleep(500);
    }
  }

  async clearMarkerOnce(marker) {
    const ed = await this.editor();
    const found = await ed.evaluate((root, marker) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const i = node.data.indexOf(marker);
        if (i < 0) continue;
        node.parentElement.scrollIntoView({ block: 'center' });
        const r = node.parentElement.getBoundingClientRect();
        return { x: r.left + Math.min(r.width, 40) / 2, y: r.top + r.height / 2 };
      }
      return null;
    }, marker);
    if (!found) throw new Error(`正文里找不到图片占位行 ${marker}`);

    await this.page.mouse.click(found.x, found.y);
    await sleep(300);
    await ed.evaluate((root, marker) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const i = node.data.indexOf(marker);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + marker.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
    }, marker);
    await sleep(400);
    await this.page.keyboard.press('Backspace');
    await sleep(500);
    if ((await this.editorState()).text.includes(marker)) {
      throw new Error(`没能删除图片占位行 ${marker}`);
    }
    // X 在保存/处理媒体时可能把刚做的修改撤回，稍等再确认一次
    await sleep(1500);
    if ((await this.editorState()).text.includes(marker)) {
      throw new Error(`图片占位行 ${marker} 删除后又被编辑器恢复了`);
    }
  }

  async insertImage(img) {
    const { cfg } = this;
    const before = (await this.editorState()).images;
    const dialogs = await this.dialogCount();
    await this.clearMarker(img.marker);
    await this.pause();

    const clicks = cfg.imageMenuSteps.map((candidates, i) => ({ candidates, label: `插入图片菜单第${i + 1}步` }));
    clicks.push({ candidates: cfg.imageFileButton, label: '添加照片按钮', optional: true });
    await this.uploadVia(clicks, img.file, `第${img.n}张图片`);
    await this.waitUploaded(
      async () => (await this.editorState()).images > before,
      `第${img.n}张图片`,
      cfg.imageConfirm,
      dialogs,
    );
  }
}

async function launch(profileDir, headless = false) {
  fs.mkdirSync(profileDir, { recursive: true });
  const opts = { headless, viewport: null, args: ['--start-maximized'] };
  try {
    return await chromium.launchPersistentContext(profileDir, { ...opts, channel: 'chrome' });
  } catch (e) {
    if (/ProcessSingleton|SingletonLock|already in use/i.test(e.message)) {
      throw new StepError('启动浏览器', `浏览器配置目录正被占用：${profileDir}。请先关闭上一次运行留下的浏览器窗口（Mac 上按 Cmd+Q）。`);
    }
    log.warn('没有找到本机 Chrome，改用 Playwright 自带的 Chromium');
    return chromium.launchPersistentContext(profileDir, opts);
  }
}

export async function fillArticle(article, opts) {
  const cfg = opts.config;
  const context = await launch(opts.profile, opts.headless);
  const page = context.pages()[0] || (await context.newPage());
  const origin = new URL(opts.composeUrl).origin;
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin }).catch(() => {});
  const f = new Filler(page, cfg);
  let lastError = '';

  const run = async (name, fn) => {
    log.step(name);
    try {
      return await fn();
    } catch (e) {
      throw e instanceof StepError ? e : new StepError(name, e.message.split('\n')[0]);
    }
  };

  try {
    await run('打开X长文编辑器并新建草稿', () => f.openEditor(opts.composeUrl));
    log.ok('编辑器已打开');

    if (article.cover && opts.cover) {
      await run(`设置封面 ${path.basename(article.cover)}`, () => f.setCover(article.cover));
      log.ok('封面已上传');
    }

    await run('填写标题', () => f.fillTitle(article.title));
    log.ok(article.title);

    const how = await run('写入正文（标题、加粗、列表、引用、链接等）', () => f.pasteHtml(article.html, opts.paste));
    log.ok(`正文已写入（方式：${how === 'clipboard' ? '剪贴板粘贴' : '页面粘贴事件'}）`);

    for (const img of article.images) {
      await run(`上传第${img.n}/${article.images.length}张图片 ${path.basename(img.file)}`, () => f.insertImage(img));
      log.ok('上传完成');
    }

    await run('检查填写结果', async () => {
      let s = await f.editorState();
      // 图片都已传上去、但个别占位行被编辑器恢复了：把残留的占位文字删掉
      if (s.images >= article.images.length) {
        for (const img of article.images.filter((i) => s.text.includes(i.marker))) {
          log.warn(`第${img.n}张图片的占位行有残留，正在删除`);
          await f.clearMarker(img.marker);
        }
        s = await f.editorState();
      }
      const left = article.images.filter((i) => s.text.includes(i.marker));
      if (left.length) throw new Error(`还有图片占位行没被替换：第${left.map((i) => i.n).join('、')}张`);
      if (s.images < article.images.length) {
        throw new Error(`编辑器里只看到 ${s.images} 张图片，应为 ${article.images.length} 张`);
      }
      const raw = s.text.split('\n').filter((l) => /\*\*|__|^\s*#{1,6}\s|!\[|\]\(/.test(l));
      if (raw.length) log.warn(`正文里可能有Markdown符号原样显示，请检查：\n    ${raw.slice(0, 5).join('\n    ')}`);
      log.ok(`正文 ${s.text.replace(/\s/g, '').length} 字，图片 ${s.images} 张`);
    });

    console.log('\n✅ 已填写完成，请检查后手动发布。（本工具不会点击发布；关闭浏览器窗口即可结束）\n');
  } catch (e) {
    lastError = e.message;
    const dir = path.join(os.homedir(), '.x-article-fill', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const shot = path.join(dir, `error-${Date.now()}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    console.error(`\n❌ 出错步骤：${e.step || '未知'}\n   原因：${e.message}\n   截图：${shot}`);
    if (!/\[未登录\]/.test(e.message)) {
      console.error('   浏览器保持打开，方便你查看现场；已填写的内容X会自动存为草稿。关闭浏览器窗口即可结束。\n');
    }
    process.exitCode = 1;
  }

  if (opts.onDone) await opts.onDone(page, process.exitCode === 1);
  // 未登录时浏览器留着也没用，还会占住配置目录导致 --login 打不开，直接关掉
  if (/\[未登录\]/.test(lastError)) {
    await context.close();
    return;
  }
  if (opts.closeWhenDone) {
    await context.close();
    return;
  }
  await new Promise((resolve) => context.on('close', resolve));
}
