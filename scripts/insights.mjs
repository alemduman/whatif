// Собирает статистику последних Reels: просмотры, охват, лайки, комментарии, репосты, сохранения.
// Токен только из секрета IG_TOKEN и нигде не печатается. Результат: out/insights.json и таблица в логе.
import fs from 'node:fs';
import path from 'node:path';
import { OUT, loadConfig, loadState } from './lib.mjs';

const cfg = loadConfig(), state = loadState();
const UNIFIED = (cfg.login || 'unified') !== 'instagram';
const BASE = UNIFIED ? 'https://graph.facebook.com' : 'https://graph.instagram.com';
const API = `${BASE}/${cfg.apiVersion || 'v26.0'}`;
const TOKEN = (process.env.IG_TOKEN || '').trim(), UID = (process.env.IG_USER_ID || '').trim();
if (!TOKEN || !UID) { console.error('Нет IG_TOKEN или IG_USER_ID'); process.exit(1); }

async function get(p, params = {}) {
  const u = new URL(API + '/' + p);
  for (const [k, v] of Object.entries({ ...params, access_token: TOKEN })) u.searchParams.set(k, v);
  const r = await fetch(u); const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j };
}

const med = [];
let next = null, page = 0;
{
  const r = await get(`${UID}/media`, { fields: 'id,caption,timestamp,permalink,media_product_type,like_count,comments_count', limit: 50 });
  if (!r.ok) { console.error('media:', JSON.stringify(r.j.error || r.j).slice(0, 300)); process.exit(1); }
  med.push(...(r.j.data || [])); next = r.j.paging?.next;
}
while (next && page++ < 3 && med.length < 150) {
  const j = await (await fetch(next)).json(); med.push(...(j.data || [])); next = j.paging?.next;
}
const METRICS = ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'ig_reels_avg_watch_time'];
const byLink = new Map((state.history || []).filter(h => h.permalink).map(h => [h.permalink.replace(/\/$/, ''), h]));
const rows = [];
for (const m of med) {
  const row = { id: m.id, time: m.timestamp, link: m.permalink, type: m.media_product_type, likes_public: m.like_count, comments_public: m.comments_count, caption: (m.caption || '').split('\n')[0].slice(0, 90), first_len: [...(m.caption || '').split('\n')[0]].length };
  const h = byLink.get((m.permalink || '').replace(/\/$/, ''));
  if (h) { row.sel = h.sel; row.topic = h.topic; row.style = h.style; row.mode = h.mode; row.tour = h.tour; }
  const r = await get(`${m.id}/insights`, { metric: METRICS.join(',') });
  if (!r.ok && rows.length === 0) console.log('INSIGHTS_ERR', JSON.stringify(r.j.error || r.j).slice(0, 400));
  if (r.ok) for (const d of r.j.data || []) row[d.name] = d.values?.[0]?.value ?? d.total_value?.value;
  else {
    // если какая-то метрика не поддерживается, берём по одной
    for (const mt of METRICS) { const q = await get(`${m.id}/insights`, { metric: mt }); if (q.ok) { const d = q.j.data?.[0]; row[mt] = d?.values?.[0]?.value ?? d?.total_value?.value; } }
  }
  rows.push(row);
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'insights.json'), JSON.stringify(rows, null, 1));
console.log('INSIGHTS_BEGIN');
console.log(JSON.stringify(rows));
console.log('INSIGHTS_END');
console.log(`Роликов: ${rows.length}`);
