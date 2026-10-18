// 登录模式：用一个普通的 Chrome 窗口（不受自动化控制）打开同一个配置目录，
// 你在里面正常登录X（包括「用Google登录」），关掉窗口后登录状态就保存下来，填充时直接复用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

function chromePath() {
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ],
    win32: [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
  }[process.platform] || [];
  return candidates.find((p) => fs.existsSync(p)) || chromium.executablePath();
}

// 配置目录是否正被另一个浏览器使用
export function profileInUse(profileDir) {
  try {
    const target = fs.readlinkSync(path.join(profileDir, 'SingletonLock')); // 形如 "主机名-进程号"
    const pid = Number(target.split('-').pop());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockPid(profileDir) {
  try {
    return Number(fs.readlinkSync(path.join(profileDir, 'SingletonLock')).split('-').pop()) || null;
  } catch {
    return null;
  }
}

function procInfo(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const m = /^(\d+)\s+(.*)$/s.exec(out);
    return m ? { ppid: Number(m[1]), command: m[2] } : null;
  } catch {
    return null;
  }
}

// 关掉上一次运行留下、还占着配置目录的浏览器（只处理用这个配置目录启动的 Chrome）
export async function closePrevious(profileDir) {
  const pid = lockPid(profileDir);
  if (!pid || !profileInUse(profileDir)) return false;
  const chrome = procInfo(pid);
  if (!chrome || !chrome.command.includes(profileDir)) {
    throw new Error(`配置目录被一个不认识的程序占用（进程 ${pid}），请手动关闭后重试。`);
  }
  // 如果是上一次的 x-article-fill 在控制它，结束那个进程，它会顺带关掉浏览器
  const parent = procInfo(chrome.ppid);
  const target = parent && /x-article-fill/.test(parent.command) ? chrome.ppid : pid;
  process.kill(target, target === pid ? 'SIGTERM' : 'SIGINT');
  for (let i = 0; i < 40 && profileInUse(profileDir); i++) await new Promise((r) => setTimeout(r, 250));
  if (profileInUse(profileDir)) process.kill(pid, 'SIGKILL');
  for (let i = 0; i < 20 && profileInUse(profileDir); i++) await new Promise((r) => setTimeout(r, 250));
  return true;
}

export function openLoginBrowser(profileDir, url) {
  fs.mkdirSync(profileDir, { recursive: true });
  if (profileInUse(profileDir)) {
    const err = new Error(`浏览器配置目录正被占用：${profileDir}。请先关闭上一次运行留下的浏览器窗口（Mac 上按 Cmd+Q）。`);
    err.step = '打开登录窗口';
    throw err;
  }
  const args = [
    `--user-data-dir=${profileDir}`,
    // 与填充时 Playwright 启动 Chrome 的参数保持一致，否则登录信息（Cookie）加密方式不同，填充时读不到
    '--use-mock-keychain',
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ];
  console.log('已打开一个普通的 Chrome 窗口，请在里面登录X（可以用 Google 登录）。');
  console.log('登录成功、能看到X首页后，关闭这个 Chrome 窗口（Mac 上按 Cmd+Q 退出），登录状态会自动保存。');
  return new Promise((resolve, reject) => {
    const child = spawn(chromePath(), args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', () => resolve());
  });
}
