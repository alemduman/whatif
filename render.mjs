// Рендер: локальный сервер + headless Chromium. AT=1,2,3 — отдельные кадры; иначе всё видео в out/video.mp4
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const root = process.cwd(), mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.hdr': 'application/octet-stream' };
const srv = http.createServer((q, r) => { let u = decodeURIComponent(q.url.split('?')[0]); if (u === '/') u = '/index.html'; const f = path.join(root, u); if (!f.startsWith(root) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }).listen(0);
const port = srv.address().port;
const W = +(process.env.W || 720), H = +(process.env.H || 1280), FPS = +(process.env.FPS || 30), DOF = process.env.DOF || '1';
const b = await chromium.launch({ ...(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {}), args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
p.on('pageerror', e => console.log('PAGEERR', e.message)); p.on('console', m => { if (/error|warn/i.test(m.type())) console.log('CONSOLE', m.text().slice(0, 300)); });
await p.goto(`http://localhost:${port}/?w=${W}&h=${H}&fps=${FPS}&dof=${DOF}&msaa=${process.env.MSAA || 4}&shadow=${process.env.SHADOW || 2048}&bloom=${process.env.BLOOM || 1}`);
await p.waitForFunction('window.ready === true', null, { timeout: 180000 });
const total = await p.evaluate('TOTAL'); console.log('total', total.toFixed(2));
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/events.json', JSON.stringify(await p.evaluate('EVENTS'), null, 1));
if (process.env.AT) {
  for (const t of process.env.AT.split(',')) { await p.evaluate(t => frame(t), +t - 1 / 30); const t0 = Date.now(); await p.evaluate(t => frame(t), +t); await p.screenshot({ path: `out/shot_${t}.jpg`, type: 'jpeg', quality: 88 }); console.log('shot', t, Date.now() - t0, 'ms'); }
} else {
  const out = process.env.OUT || 'out/video.mp4', NF = Math.round(total * FPS);
  let n0 = Math.round(+(process.env.FROM || 0) * FPS), n1 = Math.round(Math.min(total, +(process.env.TO || total)) * FPS);
  if (process.env.PARTS) { const P = +process.env.PARTS, k = +process.env.PART; n0 = Math.floor(NF * k / P); n1 = Math.floor(NF * (k + 1) / P); }
  console.log('кадры', n0, n1);
  const ff = spawn(process.env.FFMPEG || 'ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', process.env.CRF || '16', '-pix_fmt', 'yuv420p', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let i = n0; i < n1; i++) {
    await p.evaluate(t => frame(t), i / FPS);
    const buf = await p.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if ((i - n0) % 30 === 0) console.log(`${i - n0}/${n1 - n0}  ${((Date.now() - t0) / (i - n0 + 1)).toFixed(0)} ms/кадр`);
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r)); console.log('готово', out, ((Date.now() - t0) / 1000).toFixed(0), 'с');
}
await b.close(); srv.close();
