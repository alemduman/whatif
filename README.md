# Что если? / What if?

Короткие 2D-мультфильмы на 30–60 секунд: «Что если Солнце погаснет?», «Что если начнётся зомби-апокалипсис?» и так далее.
Английская версия публикуется в Instagram автоматически, русская лежит готовой для TikTok.

## Как это устроено

1. **Банк тем** — `topics/*.json`. В каждой теме 8 сцен: промпт картинки + текст на английском и русском. Сейчас 49 тем.
2. **Сборка** — воркфлоу «Сделать ролики» (`produce.yml`):
   - нейросеть рисует 8 кадров (одни на оба языка, около $0.3 за тему);
   - озвучка нейроголосами Microsoft (edge-tts, бесплатно): `en-US-AndrewMultilingualNeural` и `ru-RU-DmitryNeural`;
   - плавное движение камеры, частицы (снег, искры, звёзды…), титр «Что если?», субтитры по словам с подсветкой, музыка и звуки (синтезируются кодом, без чужих треков);
   - готовое кладётся в релиз **library**: `<id>.en.mp4` (Instagram), `<id>.ru.mp4` (TikTok), обложки `.jpg`, кадры `.images.zip`.
3. **Автопостинг** — `autopost.yml` по расписанию берёт следующий готовый английский ролик и публикует его в Instagram. Когда в очереди меньше `minStock` роликов, сам заказывает новую партию.

## Настройка

Секреты (Settings → Secrets and variables → Actions):

| Секрет | Зачем |
|---|---|
| `GEMINI_API_KEY` или `OPENAI_API_KEY` | картинки (в `config.json` → `images.provider`: `gemini` или `openai`) |
| `IG_TOKEN`, `IG_USER_ID` | публикация в Instagram (как в fba) |
| `GH_PAT` | необязательно: автопродление токена Instagram |

GitHub Pages: Settings → Pages → Source: **GitHub Actions** (через Pages Instagram забирает видео по ссылке).

## config.json

- `autoPublish` — `true`, чтобы расписание публиковало. Пока `false`, ничего не выходит и новые ролики сами не заказываются.
- `schedule.hours` — часы публикаций по Баку (сейчас 13 и 19). При изменении поправь `cron` в `autopost.yml`.
- `images.provider` / `images.model` — нейросеть для картинок; `images.style` — общий стиль; `hero` — постоянный герой роликов.
- `voices` — голоса и скорость речи. Если ролик длиннее `maxSeconds`, голос ускоряется сам.
- `video` — громкость музыки и эффектов, слов в субтитре, водяной знак.
- `minStock`, `produceBatch`, `autoProduce` — пополнение очереди.

## Ручные запуски

- **Сделать ролики**: `count` — сколько новых тем, `ids` — конкретные темы (`sun-off,zombies`). Повторная сборка темы берёт старые кадры и не платит за картинки.
- **What If autopost**: `dry_run` (по умолчанию включён) — подготовить видео без публикации; `topic` — опубликовать конкретную тему.

Проверка локально без ключей и сети: `TTS=fake IMAGE_PROVIDER=placeholder python3 scripts/produce.py --ids sun-off`.

## YouTube Shorts

Тот же английский ролик после Instagram загружается на YouTube (название = вопрос ролика). Включается тремя секретами: `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`. Без них шаг пропускается.

1. console.cloud.google.com → **новый проект** (отдельный от флагов: у каждого проекта своя квота ≈6 загрузок в сутки) → «APIs & Services» → включить **YouTube Data API v3**.
2. «OAuth consent screen» → External → название и почта → scope `youtube.upload` → **Publish app (In production)**, иначе токен живёт 7 дней.
3. «Credentials» → Create credentials → OAuth client ID → **Web application**, Authorized redirect URI: `https://developers.google.com/oauthplayground`. Скопировать Client ID и Client secret.
4. developers.google.com/oauthplayground → шестерёнка → «Use your own OAuth credentials» → вставить их → scope `https://www.googleapis.com/auth/youtube.upload` → Authorize APIs → войти в аккаунт и выбрать **канал «Что если?»** → Exchange authorization code for tokens → скопировать **Refresh token**.
5. Добавить три секрета в GitHub и запустить autopost вручную с `dry_run`: в логе будет «Токен YouTube действителен».

Настройки: `config.json` → `youtube` (`enabled`, `privacy`, `category`: 27 = Education, `tags`).
