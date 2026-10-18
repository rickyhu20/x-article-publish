#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadArticle, ArticleError } from '../src/parse.js';
import { fillArticle } from '../src/fill.js';
import { openLoginBrowser, closePrevious, profileInUse } from '../src/login.js';
import readline from 'node:readline';

const HELP = `用法：x-article-fill <文章路径> [选项]
      x-article-fill --login      第一次使用：打开普通 Chrome 窗口登录X（支持用Google登录）

把文章填进X长文编辑器（标题、正文格式、图片、封面），填完停下，由你检查后手动发布。

支持格式：.md .markdown .txt .html .htm .docx
图片：按文章里的图片引用读取（相对路径以文章所在文件夹为准）
封面：文章所在文件夹里 cover 开头的图片（如 cover.jpg）自动设为封面，也可以用 --cover 指定

选项：
  --login              只打开登录窗口，登录后关闭窗口即保存登录状态
  --dry-run            只解析文章并打印结果，不打开浏览器
  --title <标题>       指定长文标题（默认用文章里第一个一级标题）
  --cover <图片>       指定封面图片（X长文封面比例约 5:2）
  --no-cover           不设置封面
  --close-previous     如果上一次运行的浏览器还开着，自动关掉它再开始
  --profile <目录>     浏览器配置目录（保存登录状态），默认 ~/.x-article-fill/chrome-profile
  --config <文件>      自定义选择器配置，覆盖 src/selectors.json 中的同名项
  --paste <方式>       正文写入方式：clipboard（默认，真实粘贴）或 event（页面内粘贴事件）
  -h, --help           显示帮助
`;

const here = path.dirname(fileURLToPath(import.meta.url));

function loadConfig(extra) {
  const cfg = JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'selectors.json'), 'utf8'));
  if (!extra) return cfg;
  const override = JSON.parse(fs.readFileSync(path.resolve(extra), 'utf8'));
  return { ...cfg, ...override, timing: { ...cfg.timing, ...(override.timing || {}) } };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      login: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'no-cover': { type: 'boolean' },
      'close-previous': { type: 'boolean' },
      title: { type: 'string' },
      cover: { type: 'string' },
      profile: { type: 'string' },
      config: { type: 'string' },
      paste: { type: 'string', default: 'clipboard' },
      'compose-url': { type: 'string' }, // 测试用：指向本地模拟编辑器
      'close-when-done': { type: 'boolean' }, // 测试用
      help: { type: 'boolean', short: 'h' },
    },
  });
  const profile = path.resolve(values.profile || path.join(os.homedir(), '.x-article-fill', 'chrome-profile'));
  if (values.login) {
    await openLoginBrowser(profile, 'https://x.com/login');
    console.log('✅ 登录窗口已关闭，登录状态已保存。现在可以运行：x-article-fill <文章路径>');
    return;
  }
  if (values.help || !positionals.length) {
    console.log(HELP);
    return;
  }
  if (!['clipboard', 'event'].includes(values.paste)) throw new ArticleError('--paste 只能是 clipboard 或 event');

  const article = await loadArticle(positionals[0], { title: values.title, cover: values.cover });
  console.log(`文章：${article.file}`);
  console.log(`标题：${article.title}`);
  console.log(`图片：${article.images.length} 张${article.images.map((i) => `\n  ${i.n}. ${i.file}`).join('')}`);
  console.log(`封面：${article.cover && !values['no-cover'] ? article.cover : '无'}`);
  for (const w of article.warnings) console.log(`⚠ ${w}`);

  if (values['dry-run']) {
    console.log('\n--- 将要写入正文的HTML ---\n' + article.html.replace(/(<\/(p|h2|h3|ul|ol|blockquote)>)/g, '$1\n'));
    return;
  }

  if (profileInUse(profile)) {
    let close = values['close-previous'];
    if (!close && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ans = await new Promise((r) => rl.question('\n上一次打开的浏览器还没退出（未发布的内容X已自动存为草稿）。关掉它并继续吗？[Y/n] ', r));
      rl.close();
      close = !/^n/i.test(ans.trim());
    }
    if (close && (await closePrevious(profile))) console.log('已关闭上一次的浏览器。');
  }

  const config = loadConfig(values.config);
  await fillArticle(article, {
    config,
    composeUrl: values['compose-url'] || config.composeUrl,
    profile,
    cover: !values['no-cover'],
    paste: values.paste,
    closeWhenDone: values['close-when-done'],
  });
}

main().catch((e) => {
  if (e instanceof ArticleError) console.error(`❌ ${e.message}`);
  else if (e.step) console.error(`❌ 出错步骤：${e.step}\n   原因：${e.message}`);
  else console.error(e);
  process.exit(1);
});
