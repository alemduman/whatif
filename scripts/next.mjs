// Выбирает следующий готовый ролик из library.json (ещё не опубликованный), скачивает его из релиза "library"
// и готовит к публикации: out/site/v/<имя>.mp4 + .jpg, out/post.json, out/state.next.json.
// Правила расписания (слоты, дубли, опоздавшие запуски) те же, что в fba.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, OUT, SITE, loadConfig, loadState, readJSON, writeJSON, setOutput, summary } from './lib.mjs';

function skip(msg, md) { console.log(msg); summary(md || msg); setOutput('skip', 'true'); }

function main() {
  const cfg = loadConfig();
  const state = loadState();
  const KIND = process.env.RUN_KIND || process.env.GITHUB_EVENT_NAME;
  const LANG = cfg.publishLanguage || 'en';
  const lib = readJSON(path.join(ROOT, 'library.json'), { items: [] });
  const posted = new Set(state.history.filter(x => x.lang === LANG).map(x => x.id));
  const queue = (lib.items || []).filter(x => x.langs && x.langs[LANG] && !posted.has(x.id));
  setOutput('stock', String(queue.length));

  if (KIND === 'schedule' && cfg.autoPublish !== true)
    return skip('Публикация по расписанию выключена: в config.json "autoPublish": false.', '### Расписание на паузе\nВ `config.json` стоит `"autoPublish": false`.');
  const NOW = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date();
  const TZ = cfg.timezone || 'Asia/Baku';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(NOW);
  if (KIND === 'schedule' && cfg.startDate && today < cfg.startDate)
    return skip(`Публикации начнутся с ${cfg.startDate} (сейчас ${today}).`);
  let SLOT = '';
  if (KIND === 'schedule') {
    const lastP = [...state.history].reverse().find(x => x.posted);
    if (lastP && NOW - Date.parse(lastP.posted) < 50 * 60000 && NOW >= Date.parse(lastP.posted))
      return skip(`Предыдущий ролик вышел ${lastP.posted}, меньше 50 минут назад. Пропускаем, чтобы не было дубля.`);
    const sch = cfg.schedule || {};
    if (Array.isArray(sch.hours) && sch.hours.length) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(NOW).map(x => [x.type, x.value]));
      const m = (+parts.hour % 24) * 60 + +parts.minute, min = +sch.minute || 0, maxD = +sch.maxDelayMinutes || 120;
      let hit = null;
      for (const h of sch.hours) for (const sh of [-1440, 0, 1440]) { const d = m + sh - (h * 60 + min); if (d >= -20 && d <= maxD && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { h, d, day: sh }; }
      if (!hit) return skip(`Запуск в ${parts.hour}:${parts.minute} (${TZ}) слишком далеко от слотов расписания. Пропускаем.`);
      const dayShift = hit.day === -1440 ? 1 : hit.day === 1440 ? -1 : 0;
      SLOT = `${new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(NOW.getTime() - dayShift * 86400000))}T${String(hit.h).padStart(2, '0')}`;
      if (state.history.some(x => x.slot === SLOT)) return skip(`Слот ${SLOT} уже отработал. Повторный запуск ничего не делает.`);
    }
  }
  const want = (process.env.TOPIC || '').trim();
  const item = want ? (lib.items || []).find(x => x.id === want) : queue[0];
  if (!item) {
    setOutput('empty', 'true');
    return skip(want ? `Темы ${want} нет в library.json (ролик ещё не сделан).` : 'Готовых неопубликованных роликов нет. Запусти «Сделать ролики» (produce).',
      '### Нет готовых роликов\nОчередь пуста. Нужно запустить воркфлоу «Сделать ролики».');
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  const V = path.join(SITE, 'v');
  fs.mkdirSync(V, { recursive: true });
  for (const f of ['index.html', 'privacy.html', 'terms.html']) { const p = path.join(ROOT, 'static', f); if (fs.existsSync(p)) fs.copyFileSync(p, path.join(SITE, f)); }
  const base = `${item.id}.${LANG}`;
  execFileSync('gh', ['release', 'download', 'library', '-p', `${base}.mp4`, '-p', `${base}.jpg`, '-p', `${base}.json`, '-D', V, '--clobber'], { stdio: 'inherit' });
  const meta = readJSON(path.join(V, `${base}.json`), null);
  if (!meta || !fs.existsSync(path.join(V, `${base}.mp4`))) throw new Error(`В релизе library нет файлов ${base}.mp4/.json`);
  // уникальное имя, чтобы Instagram и Pages не взяли старую копию из кэша
  const stamp = `${today}-${item.id}-${process.env.GITHUB_RUN_ID || Date.now()}`;
  fs.renameSync(path.join(V, `${base}.mp4`), path.join(V, `${stamp}.mp4`));
  let cover = null;
  if (fs.existsSync(path.join(V, `${base}.jpg`))) { fs.renameSync(path.join(V, `${base}.jpg`), path.join(V, `${stamp}.jpg`)); cover = `v/${stamp}.jpg`; }
  fs.rmSync(path.join(V, `${base}.json`));
  writeJSON(path.join(OUT, 'post.json'), { video: `v/${stamp}.mp4`, cover, caption: meta.caption, title: meta.title || '', id: item.id, lang: LANG });
  writeJSON(path.join(OUT, 'state.next.json'), { ...state, history: [...state.history, { id: item.id, lang: LANG, date: today, video: `${stamp}.mp4`, ...(SLOT ? { slot: SLOT } : {}) }].slice(-300) });
  console.log(`Ролик: ${item.id} (${LANG}), ${meta.seconds} с. В очереди после него: ${Math.max(0, queue.length - 1)}`);
  summary(`### Ролик к публикации\n- Тема: \`${item.id}\` (${LANG}), ${meta.seconds} с\n- Осталось в очереди: ${Math.max(0, queue.length - 1)}\n`);
  setOutput('stock', String(Math.max(0, queue.length - (want ? 0 : 1))));
}

try { main(); } catch (e) { console.error('❌ ' + (e && e.message || e)); process.exit(1); }
