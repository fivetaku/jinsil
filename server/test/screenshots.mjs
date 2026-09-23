// 실제 Chrome(헤드리스, CDP)으로 1440·390 화면을 캡처하고 가로 넘침·스티커-숫자 겹침을 측정한다.
// 산출: docs/screens/*.png + docs/screens/metrics.json. 문제 있으면 exit 1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from './harness.mjs';
import { seed } from './seed.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(root, 'docs', 'screens');
fs.mkdirSync(outDir, { recursive: true });
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else events.push(d); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, d => d.error ? reject(Error(`${method}: ${d.error.message}`)) : resolve(d.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, events, close: () => ws.close() };
}

const MEASURE = `(() => {
  const r = e => e.getBoundingClientRect();
  const hit = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  const overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
  const bigs = [...document.querySelectorAll('.big, .sub, .meta')].map(r);
  const sticks = [...document.querySelectorAll('.st')].map(r);
  let overlaps = 0; for (const s of sticks) for (const b of bigs) if (hit(s, b)) overlaps++;
  let stickerPairs = 0; for (let i = 0; i < sticks.length; i++) for (let j = i + 1; j < sticks.length; j++) if (hit(sticks[i], sticks[j])) stickerPairs++;
  const clipped = [...document.querySelectorAll('td, th, .hd, .big, .st, h1, h2')].filter(e => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow !== 'visible').length;
  const outside = [...document.querySelectorAll('.st, .big, .card, table')].filter(e => r(e).right > window.innerWidth + 1 || r(e).left < -1).length;
  return { overflowX, stickerNumberOverlaps: overlaps, stickerStickerOverlaps: stickerPairs, clipped, outsideViewport: outside,
    stickers: [...document.querySelectorAll('.st')].map(e => e.textContent), height: document.documentElement.scrollHeight };
})()`;

const srv = await startServer();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jinsil-chrome-'));
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
let failed = false;
try {
  const { owner } = await seed(srv.base);
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch {}
    if (!target) await new Promise(r => setTimeout(r, 200));
  }
  const c = await cdp(target.webSocketDebuggerUrl);
  await c.send('Page.enable'); await c.send('Network.enable'); await c.send('Runtime.enable');
  const [name, value] = owner.split('=');
  await c.send('Network.setCookie', { name, value, url: srv.base, httpOnly: true });
  const metrics = {};
  for (const [label, pathname] of [['home', '/'], ['methodology', '/methodology'], ['me', '/me'], ['report', '/me/report']]) {
    for (const [vw, mobile] of [[1440, false], [390, true]]) {
      await c.send('Emulation.setDeviceMetricsOverride', { width: vw, height: 900, deviceScaleFactor: 1, mobile });
      await c.send('Page.navigate', { url: srv.base + pathname });
      await new Promise(r => setTimeout(r, 1200));
      const m = (await c.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true })).result.value;
      await c.send('Emulation.setDeviceMetricsOverride', { width: vw, height: Math.min(m.height, 6000), deviceScaleFactor: 1, mobile });
      await new Promise(r => setTimeout(r, 300));
      const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const file = path.join(outDir, `${label}-${vw}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      metrics[`${label}-${vw}`] = { ...m, file: path.relative(root, file) };
      if (m.overflowX || m.stickerNumberOverlaps || m.stickerStickerOverlaps || m.clipped || m.outsideViewport) failed = true;
    }
  }
  c.close();
  fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify({ captured_at: new Date().toISOString(), metrics }, null, 2) + '\n');
  console.log(JSON.stringify(metrics, null, 2));
} finally {
  chrome.kill('SIGTERM');
  await srv.stop();
}
process.exitCode = failed ? 1 : 0;
