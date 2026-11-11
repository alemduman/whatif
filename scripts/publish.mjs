// Публикует out/post.json как Reels через официальный API Instagram (вход через Instagram).
// Токен берётся только из секрета IG_TOKEN и нигде не печатается.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, OUT, readJSON, writeJSON, loadConfig, loadState, setOutput, summary } from './lib.mjs';

async function main() {
  const cfg = loadConfig();
  const post = readJSON(path.join(OUT, 'post.json'), null);
  if (!post) { console.error('Нет out/post.json: сначала запусти render.'); process.exit(1); }
  const pageUrl = (process.env.PAGE_URL || '').replace(/\/?$/, '/');
  const videoUrl = pageUrl + post.video, coverUrl = post.cover ? pageUrl + post.cover : null;
  const DRY = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
  // login: "unified" (по умолчанию) = токен системного пользователя, graph.facebook.com; "instagram" = токен входа через Instagram, graph.instagram.com
  const UNIFIED = (cfg.login || 'unified') !== 'instagram';
  const BASE = (process.env.IG_API_BASE || (UNIFIED ? 'https://graph.facebook.com' : 'https://graph.instagram.com')).replace(/\/$/, '');
  const API = `${BASE}/${cfg.apiVersion || 'v26.0'}`;
  const TOKEN = (process.env.IG_TOKEN || '').trim();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function waitPublic(url, label) {
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(url, { method: 'HEAD' }); if (r.ok) return r.headers.get('content-type') || ''; } catch {}
      await sleep(6000);
    }
    throw new Error(`${label} не открывается по ссылке ${url}. Проверь, что GitHub Pages включён (Settings → Pages → Source: GitHub Actions).`);
  }

  async function api(method, url, params) {
    const body = new URLSearchParams({ ...(params || {}), access_token: TOKEN });
    const opts = method === 'GET' ? { method } : { method, body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
    const full = method === 'GET' ? `${url}${url.includes('?') ? '&' : '?'}${body}` : url;
    let res, data;
    try { res = await fetch(full, opts); data = await res.json().catch(() => ({})); }
    catch (e) { throw new Error(`Нет связи с API Instagram (${e.cause && e.cause.code || e.message}).`); }
    if (!res.ok || data.error) {
      const er = data.error || {};
      const hint = er.code === 190 ? ' Токен недействителен или истёк: сгенерируй новый и обнови секрет IG_TOKEN.'
        : [10, 200, 283].includes(er.code) ? ' Нет прав: у токена должны быть instagram_basic и instagram_content_publish, а у системного пользователя доступ и к приложению, и к аккаунту Instagram (см. README).' : '';
      throw new Error(`API Instagram ответил ошибкой ${res.status}: ${er.message || JSON.stringify(data).slice(0, 300)}${er.code ? ` (код ${er.code}${er.error_subcode ? '/' + er.error_subcode : ''})` : ''}.${hint}`);
    }
    return data;
  }

  const ctype = await waitPublic(videoUrl, 'Видео');
  console.log(`Видео доступно по ссылке: ${videoUrl} (${ctype})`);
  if (coverUrl) await waitPublic(coverUrl, 'Обложка');

  if (DRY) {
    console.log('Проверочный запуск: ролик НЕ публикуется. Посмотри видео по ссылке выше.');
    let access = 'токен не задан, доступ к Instagram не проверялся';
    if (TOKEN) {
      // Ничего не публикуем: только проверяем, что токен рабочий и у него есть право на публикацию
      const uid0 = (process.env.IG_USER_ID || '').trim();
      if (!uid0) { console.error('❌ Нет секрета IG_USER_ID: числовой ID аккаунта Instagram (он начинается на 17841).'); process.exit(1); }
      const acc = await api('GET', `${API}/${uid0}`, { fields: 'username' });
      const lim = await api('GET', `${API}/${uid0}/content_publishing_limit`, { fields: 'quota_usage,config' });
      const q = lim.data && lim.data[0] || {};
      access = `аккаунт @${acc.username || '?'}, право на публикацию есть, использовано ${q.quota_usage ?? '?'} из ${q.config && q.config.quota_total || '?'} публикаций за сутки`;
      console.log('Доступ к Instagram проверен: ' + access);
    } else console.log('Секрет IG_TOKEN не задан: доступ к Instagram не проверялся.');
    summary(`### Проверочный запуск\nРолик не публиковался.\n\n- Видео: ${videoUrl}${coverUrl ? `\n- Обложка: ${coverUrl}` : ''}\n- Instagram: ${access}\n`);
    setOutput('posted', 'false');
    return;
  }
  if (!TOKEN) { console.error('Нет секрета IG_TOKEN. Добавь его: Settings → Secrets and variables → Actions → New repository secret.'); process.exit(1); }

  const state = loadState();
  const next = readJSON(path.join(OUT, 'state.next.json'), state);

  // Токен входа через Instagram живёт 60 дней: раз в неделю продлеваем. Токен системного пользователя продлевать не нужно.
  const week = 7 * 24 * 3600 * 1000;
  if (!UNIFIED && (!state.lastRefresh || Date.now() - Date.parse(state.lastRefresh) > week)) {
    try {
      const r = await api('GET', `${BASE}/refresh_access_token`, { grant_type: 'ig_refresh_token' });
      next.lastRefresh = new Date().toISOString();
      const days = r.expires_in ? Math.round(r.expires_in / 86400) : '?';
      if (r.access_token && r.access_token !== TOKEN) {
        if (process.env.GH_PAT && process.env.GITHUB_REPOSITORY) {
          execFileSync('gh', ['secret', 'set', 'IG_TOKEN', '--repo', process.env.GITHUB_REPOSITORY], { input: r.access_token, env: { ...process.env, GH_TOKEN: process.env.GH_PAT }, stdio: ['pipe', 'ignore', 'pipe'] });
          console.log(`Токен продлён (ещё ~${days} дн.) и сохранён в секрет IG_TOKEN.`);
        } else {
          console.log(`Токен продлён, но Instagram выдал новую строку токена. Добавь секрет GH_PAT (см. README), чтобы он сохранялся сам, иначе через ~${days} дн. токен нужно будет обновить вручную.`);
        }
      } else console.log(`Токен продлён ещё на ~${days} дн.`);
    } catch (e) { console.log('Продлить токен не получилось (это не мешает публикации): ' + e.message); }
  }

  let uid = (process.env.IG_USER_ID || '').trim();
  if (!uid && UNIFIED) { console.error('❌ Нет секрета IG_USER_ID: числовой ID аккаунта Instagram (он начинается на 17841). Добавь его так же, как IG_TOKEN.'); process.exit(1); }
  if (!uid) { const me = await api('GET', `${API}/me`, { fields: 'user_id,username' }); uid = String(me.user_id || me.id); console.log(`Аккаунт: @${me.username || '?'} (${uid})`); }

  // Защита от дублей при повторных запусках по расписанию: если в ленте уже есть пост моложе GUARD минут
  // (например, прошлый запуск опубликовал, но не успел записать state.json), этот слот считаем выполненным
  const GUARD = +(cfg.duplicateGuardMinutes ?? 40);
  if ((process.env.RUN_KIND || process.env.GITHUB_EVENT_NAME) === 'schedule' && GUARD > 0) {
    let last = null;
    try { const r = await api('GET', `${API}/${uid}/media`, { fields: 'id,timestamp,permalink', limit: '1' }); last = r.data && r.data[0]; }
    catch (e) { console.log('Проверить ленту не удалось (публикуем как обычно): ' + e.message); }
    const ts = last && Date.parse(String(last.timestamp).replace(/\+0000$/, 'Z'));
    if (ts && Date.now() - ts < GUARD * 60000 && Date.now() >= ts) {
      console.log(`В ленте уже есть пост ${Math.round((Date.now() - ts) / 60000)} мин назад (${last.permalink || last.id}). Не публикую повторно, отмечаю слот выполненным.`);
      const h0 = next.history || [];
      if (h0.length) h0[h0.length - 1] = { ...h0[h0.length - 1], mediaId: last.id, permalink: last.permalink || undefined, posted: new Date(ts).toISOString(), guard: true };
      writeJSON(path.join(ROOT, 'state.json'), next);
      setOutput('posted', 'true');
      summary(`### Повтор не нужен\nВ ленте уже есть свежий пост: ${last.permalink || last.id}\n`);
      return;
    }
  }

  const params = { media_type: 'REELS', video_url: videoUrl, caption: post.caption, share_to_feed: String(cfg.shareToFeed !== false) };
  if (coverUrl) params.cover_url = coverUrl;
  const POLL = +process.env.POLL_MS || 30000;
  let container, status = '';
  // Если Instagram не смог обработать видео (статус ERROR/EXPIRED), пробуем ещё раз с новым контейнером
  for (let attempt = 1; attempt <= 2; attempt++) {
    container = await api('POST', `${API}/${uid}/media`, params);
    console.log(`Контейнер создан: ${container.id}. Instagram обрабатывает видео…`);
    status = '';
    for (let i = 0; i < 20; i++) {           // до 10 минут, раз в 30 с
      await sleep(POLL);
      let s;
      try { s = await api('GET', `${API}/${container.id}`, { fields: 'status_code,status' }); }
      catch (e) { console.log('Статус не получен, жду: ' + e.message); continue; }
      status = s.status_code;
      console.log(`Статус: ${status}${s.status ? ' — ' + s.status : ''}`);
      if (status === 'FINISHED' || status === 'ERROR' || status === 'EXPIRED' || status === 'PUBLISHED') break;
    }
    if (status === 'FINISHED' || status === 'PUBLISHED') break;
    if (attempt < 2) { console.log(`Instagram не обработал видео (статус ${status || 'нет ответа'}), пробую ещё раз`); await sleep(20000); }
  }
  if (status !== 'FINISHED' && status !== 'PUBLISHED') throw new Error(`Instagram не обработал видео (статус ${status || 'нет ответа'}). Попробуй запустить ещё раз.`);

  // media_publish иногда отвечает ошибкой, хотя пост вышел: перед повтором проверяем статус контейнера
  let pub = status === 'PUBLISHED' ? { id: container.id } : null;
  for (let k = 1; !pub; k++) {
    try { pub = await api('POST', `${API}/${uid}/media_publish`, { creation_id: container.id }); }
    catch (e) {
      console.log(`Публикация ответила ошибкой (попытка ${k}): ${e.message}`);
      await sleep(20000);
      try { const s = await api('GET', `${API}/${container.id}`, { fields: 'status_code' }); if (s.status_code === 'PUBLISHED') { pub = { id: container.id }; break; } } catch {}
      if (k >= 3) throw e;
    }
  }
  console.log(`Опубликовано! ID публикации: ${pub.id}`);
  let link = '';
  try { const m = await api('GET', `${API}/${pub.id}`, { fields: 'permalink' }); link = m.permalink || ''; } catch {}
  if (link) console.log('Ссылка: ' + link);

  const h = next.history || [];
  if (h.length) h[h.length - 1] = { ...h[h.length - 1], mediaId: pub.id, permalink: link || undefined, posted: new Date().toISOString() };
  writeJSON(path.join(ROOT, 'state.json'), next);
  setOutput('posted', 'true');
  summary(`### Опубликовано в Instagram\n${link ? `- ${link}\n` : ''}- ID: ${pub.id}\n`);
}

main().catch(e => { console.error('❌ ' + (e && e.message || e)); process.exit(1); });
