// 用本地模拟的X长文编辑器（真实的 Draft.js）跑一遍完整流程，并检查结果
// 用法：node test/run-mock.js [--headed] [--paste clipboard|event]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArticle } from '../src/parse.js';
import { fillArticle } from '../src/fill.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => path.join(root, 'node_modules', p);
const routes = {
  '/vendor/react.js': nm('react/umd/react.development.js'),
  '/vendor/react-dom.js': nm('react-dom/umd/react-dom.development.js'),
  '/vendor/immutable.js': nm('immutable/dist/immutable.js'),
  '/vendor/Draft.js': nm('draft-js/dist/Draft.js'),
  '/vendor/Draft.css': nm('draft-js/dist/Draft.css'),
};
const server = http.createServer((req, res) => {
  const file = routes[req.url] || path.join(root, 'test', 'mock', 'index.html');
  res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/compose/articles`;

const argv = process.argv.slice(2);
const paste = argv.includes('--paste') ? argv[argv.indexOf('--paste') + 1] : 'clipboard';
const config = JSON.parse(fs.readFileSync(path.join(root, 'src', 'selectors.json'), 'utf8'));
config.timing = { ...config.timing, minDelayMs: 100, maxDelayMs: 250, typeDelayMs: 10, optionalStepTimeoutMs: 1500 };

const article = await loadArticle(path.join(root, 'test', 'sample', 'article.md'));
const failures = [];
const expect = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };

await fillArticle(article, {
  config,
  composeUrl: url,
  profile: fs.mkdtempSync(path.join(os.tmpdir(), 'xaf-test-profile-')),
  cover: true,
  paste,
  headless: !argv.includes('--headed'),
  closeWhenDone: true,
  onDone: async (page, failed) => {
    console.log(`\n=== 检查模拟编辑器里的结果（粘贴方式：${paste}） ===`);
    expect(!failed, '填写流程无报错');
    const s = await page.evaluate(() => window.__state());
    const blocks = s.blocks.filter((b) => !(b.type === 'unstyled' && !b.text.trim()));
    console.log(blocks.map((b) => `    [${b.type}${b.styles.length ? ' ' + b.styles.join(',') : ''}${b.entities ? ' link/img' : ''}] ${b.text}`).join('\n'));
    const types = blocks.map((b) => b.type);
    expect(s.title === article.title, `标题正确：${s.title}`);
    expect(s.cover, '封面已设置');
    expect(types.filter((t) => t === 'atomic').length === 3, '正文里有3张图片');
    expect(types.filter((t) => t === 'header-two').length === 3, '3个小标题(h2)');
    expect(types.includes('header-three'), '有h3');
    expect(types.filter((t) => t === 'unordered-list-item').length === 3, '无序列表3项');
    expect(types.filter((t) => t === 'ordered-list-item').length === 3, '有序列表3项');
    expect(blocks.some((b) => b.type === 'blockquote' && b.text.includes('\n第二行')), '引用里的换行保留');
    expect(blocks.some((b) => b.styles.includes('BOLD')), '有加粗');
    expect(blocks.some((b) => b.styles.includes('ITALIC')), '有斜体');
    expect(blocks.some((b) => b.text.includes('Playwright 官方文档') && b.entities), '有链接');
    expect(!s.blocks.some((b) => /XAFIMG|\*\*|^#/.test(b.text)), '没有占位符或Markdown符号残留');
    // 图片位置：每张图前一个非空块应是原文中图片前面的内容
    const before = (i) => blocks[blocks.findIndex((b, k) => b.type === 'atomic' && blocks.slice(0, k + 1).filter((x) => x.type === 'atomic').length === i) - 1];
    expect(before(1)?.text === '记录全过程，写成这篇文章', '第1张图在列表之后');
    expect(before(2)?.type === 'blockquote', '第2张图在引用之后');
    expect(before(3)?.text.startsWith('更多细节'), '第3张图在链接段落之后');
    expect(blocks.at(-1).text.startsWith('最后一段'), '最后一段在最后');
    expect(!(await page.evaluate(() => window.__published)), '没有点击发布');
  },
});

// 安全拦截测试：把「新建」按钮故意指向 Publish，工具必须拒绝点击
console.log('\n=== 安全拦截测试 ===');
const bad = { ...config, createButton: [{ role: 'button', name: 'Publish' }], titleInput: [{ placeholder: 'Add a title' }] };
await fillArticle(article, {
  config: bad, composeUrl: url, profile: fs.mkdtempSync(path.join(os.tmpdir(), 'xaf-test-profile-')),
  cover: false, paste, headless: true, closeWhenDone: true,
  onDone: async (page) => expect(!(await page.evaluate(() => window.__published)), '误指向发布按钮时被拦截，没有发布'),
});
process.exitCode = 0;

server.close();
console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过');
process.exit(failures.length ? 1 : 0);
