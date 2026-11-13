// Отчёт по кратности: просмотры ролика делим на медиану аккаунта (а не смотрим на голые просмотры).
// Читает out/insights.json (его пишет insights.mjs) и историю публикаций из state.json.
// Пишет out/report.md и сводку запуска. Ничего не публикует и ничего не меняет в аккаунте.
import fs from 'node:fs';
import path from 'node:path';
import { OUT, loadState, summary } from './lib.mjs';

const DAY = 864e5, MATURE_DAYS = 3, BASE_N = 30;
const rows = JSON.parse(fs.readFileSync(path.join(OUT, 'insights.json'), 'utf8'));
const hist = new Map((loadState().history || []).filter(h => h.permalink).map(h => [h.permalink.replace(/\/$/, ''), h]));
const repo = (process.env.GITHUB_REPOSITORY || '').split('/').pop() || 'аккаунт';
const now = Date.now();
const t = s => Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
const med = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
const fmt = n => (n == null || Number.isNaN(n)) ? '—' : Math.round(n).toLocaleString('ru-RU');
const x = m => (m == null || !Number.isFinite(m)) ? '—' : (m >= 10 ? m.toFixed(0) : m.toFixed(1)) + '×';
const bakuHour = ms => new Date(ms + 4 * 3600e3).getUTCHours();

function kindOf(h, caption = '') {
  if (/^🏆/.test(caption)) return 'турнир';
  if (!h) return null;
  if (h.sel) {
    const k = h.sel.every(i => /^fc_/.test(i)) ? 'клубы' : h.sel.every(i => /^cb_/.test(i)) ? 'машины' : 'флаги';
    return h.tour || h.mode === 'tournament' ? 'турнир' : `${k} · ${h.sel.length} шт.`;
  }
  if (h.test) return `тест ${h.test}`;
  if (h.id) return `тема ${h.id}`;
  return null;
}

// Если токену не дали право на статистику (insights), просмотров нет: считаем по лайкам и честно пишем об этом
const HAS_VIEWS = rows.some(r => typeof r.views === 'number');
for (const r of rows) if (!HAS_VIEWS) r.views = r.likes_public;
const UNIT = HAS_VIEWS ? 'просмотров' : 'лайков';
const posts = rows.filter(r => typeof r.views === 'number').map(r => {
  const ms = t(r.time), h = hist.get((r.link || '').replace(/\/$/, ''));
  const hour = h?.slot ? +h.slot.slice(11, 13) : bakuHour(ms);
  return { ...r, ms, age: (now - ms) / DAY, h, kind: kindOf(h, r.caption || ''), theme: h?.theme, hour };
}).sort((a, b) => b.ms - a.ms);

const mature = posts.filter(p => p.age >= MATURE_DAYS);
const baseSet = mature.slice(0, BASE_N);
const base = med(baseSet.map(p => p.views));
// Аккаунт растёт, поэтому старый ролик сравниваем с роликами своего же времени:
// база ролика = медиана просмотров ~30 соседних по времени зрелых роликов (без него самого).
const asc = [...mature].reverse();
const localBase = p => {
  const i = asc.indexOf(p);
  if (i < 0) return base;
  let lo = Math.max(0, i - BASE_N / 2), hi = Math.min(asc.length, lo + BASE_N + 1);
  lo = Math.max(0, hi - BASE_N - 1);
  return med(asc.slice(lo, hi).filter(q => q !== p).map(q => q.views));
};
for (const p of posts) {
  p.base = localBase(p);
  p.mult = p.base ? p.views / p.base : null;
  p.shares1k = p.reach ? (p.shares || 0) / p.reach * 1000 : null;
  p.saves1k = p.reach ? (p.saved || 0) / p.reach * 1000 : null;
  p.watch = p.ig_reels_avg_watch_time ? p.ig_reels_avg_watch_time / 1000 : null;
}

const name = p => `[${(p.caption || '').replace(/[|\[\]]/g, ' ').slice(0, 60) || 'ролик'}](${p.link})`;
const line = p => `| ${new Date(p.ms + 4 * 3600e3).toISOString().slice(5, 16).replace('T', ' ')} | ${name(p)} | ${p.kind || '—'} | ${fmt(p.views)} | **${x(p.mult)}** | ${p.shares1k == null ? '—' : p.shares1k.toFixed(1)} | ${p.saves1k == null ? '—' : p.saves1k.toFixed(1)} | ${p.watch == null ? '—' : p.watch.toFixed(1) + ' с'} |`;
const HEAD = () => `| дата (Баку) | ролик | тип | ${UNIT} | кратность | репосты на 1000 охвата | сохранения на 1000 | досмотр, в среднем |\n|---|---|---|---|---|---|---|---|`;

function groups(key, list, min = 2) {
  const g = new Map();
  for (const p of list) { const k = key(p); if (k == null) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(p); }
  return [...g.entries()].filter(([, a]) => a.length >= min)
    .map(([k, a]) => ({ k, n: a.length, m: med(a.map(p => p.mult)), v: med(a.map(p => p.views)) }))
    .sort((a, b) => b.m - a.m);
}

const md = [];
md.push(`# Отчёт по кратности · ${repo} · ${new Date(now + 4 * 3600e3).toISOString().slice(0, 10)}`);
md.push('');
md.push(`Кратность = ${UNIT} ролика ÷ медиана аккаунта. Сейчас медиана по ${baseSet.length} последним роликам старше ${MATURE_DAYS} дней: **${fmt(base)} ${UNIT}**; старые ролики сравниваются с соседними по времени, потому что аккаунт растёт. Выше 3× — ролик реально выстрелил, ниже 1.5× — обычный день аккаунта.`);
if (!HAS_VIEWS) md.push('\n⚠ У токена Instagram нет права на статистику (insights), поэтому просмотров нет и отчёт посчитан по лайкам. Чтобы видеть просмотры, токен нужно перевыпустить с правом instagram_business_manage_insights.');
if (baseSet.length < 10) md.push(`\n⚠ Роликов старше ${MATURE_DAYS} дней пока ${baseSet.length}: выводы предварительные.`);

const week = posts.filter(p => p.age < 7);
md.push('', `## Последние 7 дней (${week.length})`, '');
md.push(week.length ? HEAD() + '\n' + week.map(line).join('\n') : 'Публикаций не было.');
if (week.some(p => p.age < MATURE_DAYS)) md.push('', `_Ролики младше ${MATURE_DAYS} дней ещё набирают просмотры, их кратность пока занижена._`);

const top = mature.filter(p => p.mult >= 3).slice(0, 10);
md.push('', '## Выстрелили (≥ 3×, за всё время в выборке)', '');
md.push(top.length ? HEAD() + '\n' + top.sort((a, b) => b.mult - a.mult).map(line).join('\n') : 'Пока ни одного ролика выше 3×.');

const g1 = groups(p => p.kind, mature);
if (g1.length) {
  md.push('', '## Что работает лучше (тип ролика)', '', `| тип | роликов | кратность (медиана) | ${UNIT} (медиана) |\n|---|---|---|---|`);
  md.push(g1.map(r => `| ${r.k} | ${r.n} | **${x(r.m)}** | ${fmt(r.v)} |`).join('\n'));
}
const g2 = groups(p => p.theme, mature);
if (g2.length) {
  md.push('', '## Фон / оформление', '', '| фон | роликов | кратность (медиана) |\n|---|---|---|');
  md.push(g2.map(r => `| ${r.k} | ${r.n} | **${x(r.m)}** |`).join('\n'));
}
const g3 = groups(p => p.hour, mature);
if (g3.length > 1) {
  md.push('', '## Время публикации (Баку)', '', '| час | роликов | кратность (медиана) |\n|---|---|---|');
  md.push(g3.map(r => `| ${String(r.k).padStart(2, '0')}:00 | ${r.n} | **${x(r.m)}** |`).join('\n'));
}
md.push('', `_Группы с одним роликом не показаны. Меньше 5 роликов в группе — это наблюдение, а не вывод._`);

const longCap = posts.filter(p => (p.first_len || 0) > 125);
md.push('', '## Подписи', '');
const measured = posts.filter(p => typeof p.first_len === 'number');
md.push(!measured.length ? 'Длина подписей не измерена (нет данных).'
  : longCap.length
    ? `Первая строка длиннее 125 символов (в ленте обрежется до «… ещё»): ` + longCap.slice(0, 10).map(p => `${name(p)} (${p.first_len})`).join(', ')
    : `Все первые строки подписей (${measured.length} роликов) влезают в 125 символов, которые лента показывает до «… ещё».`);

const text = md.join('\n') + '\n';
fs.writeFileSync(path.join(OUT, 'report.md'), text);
summary(text);
console.log(`База: ${fmt(base)} ${UNIT} (${baseSet.length} роликов). За неделю: ${week.length}. Выше 3×: ${top.length}.`);
