"""Собирает ролик: кадры с плавным движением камеры, частицы, субтитры по словам, голос, музыка, эффекты.

render(topic, lang, scenes, out_mp4, out_cover, cfg)
scenes: [{"img": путь к PNG, "wav": путь к WAV, "dur": сек, "words": [...], "fx": [...], "cam": ..., "part": ...}]
"""
import math
import os
import subprocess

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import music as mus
from tts import SR, read_wav

W, H = 1080, 1920
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FONT_SUB = os.path.join(ROOT, "fonts", "Montserrat-Black.ttf")
FONT_TITLE = os.path.join(ROOT, "fonts", "Unbounded-Black.ttf")
YELLOW = (255, 217, 59)
CAMS = ["in", "left", "out", "up", "right", "in", "down", "out"]
XFADE = 0.32


def _ease(u):
    u = min(1.0, max(0.0, u))
    return 0.45 * u + 0.55 * (0.5 - 0.5 * math.cos(math.pi * u))


# ---------- кадры ----------

def _prep(path, margin=1.2):
    im = cv2.imread(path, cv2.IMREAD_COLOR)
    h, w = im.shape[:2]
    k = max(W * margin / w, H * margin / h)
    im = cv2.resize(im, (int(round(w * k)), int(round(h * k))), interpolation=cv2.INTER_LANCZOS4 if k > 1 else cv2.INTER_AREA)
    if k > 1.3:  # заметное увеличение: слегка возвращаем резкость
        bl = cv2.GaussianBlur(im, (0, 0), 1.2)
        im = cv2.addWeighted(im, 1.35, bl, -0.35, 0)
    return im


def _camera(cam, u, bw, bh):
    """Возвращает (zoom, cx, cy) для доли сцены u в пределах картинки."""
    p = _ease(u)
    z0, z1 = {"in": (1.0, 1.13), "out": (1.13, 1.0), "shake": (1.04, 1.1)}.get(cam, (1.05, 1.08))
    z = z0 + (z1 - z0) * p
    hx, hy = W / 2 / z, H / 2 / z
    sx, sy = max(0, bw / 2 - hx), max(0, bh / 2 - hy)  # запас для панорамы
    cx, cy = bw / 2, bh / 2
    if cam == "left":
        cx += sx * 0.85 * (1 - 2 * p)
    elif cam == "right":
        cx -= sx * 0.85 * (1 - 2 * p)
    elif cam == "up":
        cy += sy * 0.85 * (1 - 2 * p)
    elif cam == "down":
        cy -= sy * 0.85 * (1 - 2 * p)
    return z, cx, cy


def _warp(base, z, cx, cy, rot=0.0, dx=0.0, dy=0.0):
    a = math.radians(rot)
    c, s = math.cos(a) * z, math.sin(a) * z
    M = np.array([[c, -s, W / 2 + dx - (c * cx - s * cy)], [s, c, H / 2 + dy - (s * cx + c * cy)]], np.float32)
    return cv2.warpAffine(base, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


# ---------- частицы ----------

class Particles:
    def __init__(self, kind, seed):
        self.kind = kind
        r = np.random.default_rng(seed)
        n = {"snow": 90, "embers": 60, "dust": 45, "stars": 120, "rain": 110, "bubbles": 35, "ash": 70}.get(kind, 0)
        self.x, self.y = r.random(n) * W, r.random(n) * H
        self.sz = r.random(n)
        self.ph = r.random(n) * 6.28
        self.sp = 0.5 + r.random(n)

    def draw(self, t, alpha=1.0):
        if not len(self.x) or alpha <= 0.01:
            return None
        ov = np.zeros((H // 2, W // 2, 3), np.uint8)
        k = self.kind
        for i in range(len(self.x)):
            s, sp, ph = self.sz[i], self.sp[i], self.ph[i]
            if k in ("snow", "ash"):
                x = (self.x[i] + 40 * math.sin(t * 0.8 * sp + ph) + 25 * t * sp) % W
                y = (self.y[i] + t * (60 + 90 * sp)) % H
                col = (235, 240, 245) if k == "snow" else (150, 150, 150)
                cv2.circle(ov, (int(x / 2), int(y / 2)), int(1 + s * 3), col, -1, cv2.LINE_AA)
            elif k == "embers":
                x = (self.x[i] + 30 * math.sin(t * 1.4 * sp + ph)) % W
                y = (self.y[i] - t * (80 + 120 * sp)) % H
                fl = 0.6 + 0.4 * math.sin(t * 7 * sp + ph)
                cv2.circle(ov, (int(x / 2), int(y / 2)), int(1 + s * 2.5), (int(40 * fl), int(150 * fl), int(255 * fl)), -1, cv2.LINE_AA)
            elif k == "dust":
                x = (self.x[i] + 18 * t * (sp - 1) + 20 * math.sin(t * 0.5 + ph)) % W
                y = (self.y[i] + 14 * math.sin(t * 0.4 * sp + ph) - 8 * t) % H
                v = int(90 + 80 * (0.5 + 0.5 * math.sin(t * 2 + ph)))
                cv2.circle(ov, (int(x / 2), int(y / 2)), int(1 + s * 2), (v, v, v), -1, cv2.LINE_AA)
            elif k == "stars":
                v = (0.5 + 0.5 * math.sin(t * 3 * sp + ph)) ** 3
                if v > 0.15:
                    c = int(255 * v)
                    cv2.circle(ov, (int(self.x[i] / 2), int(self.y[i] / 2)), int(1 + s * 1.6), (c, c, c), -1, cv2.LINE_AA)
            elif k == "rain":
                x = (self.x[i] - t * 160) % W
                y = (self.y[i] + t * (1300 + 500 * sp)) % H
                cv2.line(ov, (int(x / 2), int(y / 2)), (int((x - 8) / 2), int((y + 46) / 2)), (170, 160, 150), 1, cv2.LINE_AA)
            elif k == "bubbles":
                x = (self.x[i] + 22 * math.sin(t * 1.1 * sp + ph)) % W
                y = (self.y[i] - t * (50 + 70 * sp)) % H
                cv2.circle(ov, (int(x / 2), int(y / 2)), int(3 + s * 8), (230, 220, 180), 1, cv2.LINE_AA)
        if k in ("embers", "stars", "dust"):
            ov = cv2.add(ov, cv2.GaussianBlur(ov, (0, 0), 3))
        ov = cv2.resize(ov, (W, H), interpolation=cv2.INTER_LINEAR)
        if alpha < 1:
            ov = (ov * alpha).astype(np.uint8)
        return ov


# ---------- текст ----------

def _font(path, size, cache={}):
    key = (path, size)
    if key not in cache:
        cache[key] = ImageFont.truetype(path, size)
    return cache[key]


# Безопасная зона Reels/TikTok на 1080×1920: сверху ~14% (270 px) занимает шапка, снизу ~25% (от 1440 px) —
# подпись и ник, справа у нижней половины — кнопки лайк/комменты. Титр и субтитры держим внутри.
SAFE_TITLE_W, SAFE_TITLE_H = 880, 500   # титр по центру на 0.28·H: не выше 270 px, не шире 100 px от краёв
SAFE_CAP_W, SAFE_CAP_H = 800, 210       # субтитры на 0.67·H: правый край ≤ ~950 px, низ ≤ 1440 px


def _text_block(words, active, font_path, size, max_w, hl=None, stroke=9, shown=None, max_h=None):
    """Рисует строку(и) слов: активное слово жёлтое. shown — сколько слов показать (для титра).
    max_h — предельная высота строк: если текст не влезает, шрифт уменьшается (безопасная зона кадра)."""
    f = _font(font_path, size)
    # слишком длинное слово с дефисом («ЗОМБИ-АПОКАЛИПСИС?») переносим по дефису, а не уменьшаем весь текст
    parts = []  # (индекс слова, кусок, перенос строки после куска)
    for i, w in enumerate(words):
        if "-" in w.strip("-") and f.getlength(w) + 2 * stroke > max_w:
            bits = w.split("-")
            for k, b in enumerate(bits):
                last = k == len(bits) - 1
                parts.append((i, b if last else b + "-", not last))
        else:
            parts.append((i, w, False))
    # самый длинный кусок должен влезать в строку: иначе уменьшаем шрифт
    while size > 40 and max(f.getlength(p[1]) for p in parts) + 2 * stroke > max_w:
        size -= 4
        f = _font(font_path, size)
    while True:
        space = f.getlength(" ")
        lines, cur, cw, brk = [], [], 0, False
        for i, w, nb in parts:
            lw = f.getlength(w)
            if cur and (brk or cw + space + lw > max_w):
                lines.append(cur)
                cur, cw = [], 0
            cur.append((i, w, lw))
            cw += (space if cw else 0) + lw
            brk = nb
        if cur:
            lines.append(cur)
        lh = int(size * 1.18)
        if not max_h or lh * len(lines) <= max_h or size <= 40:
            break
        size -= 4
        f = _font(font_path, size)
    pad = stroke + 14
    tw = int(max(sum(x[2] for x in ln) + space * (len(ln) - 1) for ln in lines)) + pad * 2
    th = lh * len(lines) + pad * 2
    im = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    sh = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    d, ds = ImageDraw.Draw(im), ImageDraw.Draw(sh)
    for li, ln in enumerate(lines):
        lwid = sum(x[2] for x in ln) + space * (len(ln) - 1)
        x = (tw - lwid) / 2
        y = pad + li * lh
        for i, w, wl in ln:
            vis = shown is None or i < shown
            if vis:
                col = YELLOW if (i == active or (hl and i in hl)) else (255, 255, 255)
                ds.text((x + 5, y + 7), w, font=f, fill=(0, 0, 0, 150), stroke_width=stroke, stroke_fill=(0, 0, 0, 150))
                d.text((x, y), w, font=f, fill=col + (255,), stroke_width=stroke, stroke_fill=(10, 10, 14, 255))
            x += wl + space
    from PIL import ImageFilter
    sh = sh.filter(ImageFilter.GaussianBlur(6))
    out = Image.alpha_composite(sh, im)
    a = np.array(out)
    return a  # RGBA


def _blit(frame, rgba, cx, cy, scale=1.0, alpha=1.0):
    if scale != 1.0:
        rgba = cv2.resize(rgba, (max(1, int(rgba.shape[1] * scale)), max(1, int(rgba.shape[0] * scale))), interpolation=cv2.INTER_LINEAR)
    h, w = rgba.shape[:2]
    x0, y0 = int(cx - w / 2), int(cy - h / 2)
    x1, y1 = max(0, x0), max(0, y0)
    x2, y2 = min(W, x0 + w), min(H, y0 + h)
    if x2 <= x1 or y2 <= y1:
        return
    src = rgba[y1 - y0:y2 - y0, x1 - x0:x2 - x0]
    a = (src[:, :, 3:4].astype(np.float32) / 255) * alpha
    roi = frame[y1:y2, x1:x2].astype(np.float32)
    rgb = src[:, :, 2::-1].astype(np.float32)  # RGB -> BGR
    frame[y1:y2, x1:x2] = (roi * (1 - a) + rgb * a).astype(np.uint8)


def _chunks(words, max_words=3, max_chars=17):
    out, cur = [], []
    for w in words:
        txt = " ".join(x["w"] for x in cur + [w])
        if cur and (len(cur) >= max_words or len(txt) > max_chars):
            out.append(cur)
            cur = []
        cur.append(w)
        if w["w"][-1:] in ".!?…,;:—":
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def _vignette():
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    d = np.sqrt(((x - W / 2) / (W * 0.75)) ** 2 + ((y - H / 2) / (H * 0.7)) ** 2)
    v = np.clip(1.08 - 0.55 * d ** 2.2, 0.45, 1.0)
    v = (v * 255).astype(np.uint8)
    return cv2.merge([v, v, v])


def _upper(s, lang):
    return s.upper()


# ---------- обложка ----------

def cover(img_path, hook, title, out_jpg):
    base = _prep(img_path, 1.0)
    bh, bw = base.shape[:2]
    x0, y0 = (bw - W) // 2, (bh - H) // 2
    fr = base[y0:y0 + H, x0:x0 + W].copy()
    grad = np.linspace(1, 0, int(H * 0.55)).astype(np.float32) ** 1.4
    dark = np.ones((H, 1, 1), np.float32)
    dark[: len(grad), 0, 0] = 1 - 0.6 * grad
    fr = (fr.astype(np.float32) * dark).astype(np.uint8)
    hook_rgba = _text_block([hook], 0, FONT_TITLE, 120, 1000, stroke=10)
    _blit(fr, hook_rgba, W / 2, H * 0.17)
    t_rgba = _text_block(title.split(), -1, FONT_TITLE, 92, 960, stroke=10)
    _blit(fr, t_rgba, W / 2, H * 0.17 + hook_rgba.shape[0] / 2 + t_rgba.shape[0] / 2 - 10)
    cv2.imwrite(out_jpg, fr, [cv2.IMWRITE_JPEG_QUALITY, 92])


# ---------- сборка ----------

def render(topic, lang, scenes, out_mp4, out_cover, cfg, tmpdir):
    fps = int(cfg.get("fps", 30))
    lead, gap, tail = 0.35, float(cfg.get("gap", 0.28)), 1.6
    # раскладка по времени
    t = 0.0
    for i, s in enumerate(scenes):
        s["start"] = t
        s["vstart"] = t + (lead if i == 0 else 0.1)
        s["end"] = s["vstart"] + s["dur"] + (tail if i == len(scenes) - 1 else gap)
        t = s["end"]
    total = t
    # ---------- звук ----------
    n = int(total * SR) + SR
    voice = np.zeros(n, np.float32)
    for s in scenes:
        a = read_wav(s["wav"])
        st = int(s["vstart"] * SR)
        voice[st:st + len(a)] += a[: n - st]
    pk = np.max(np.abs(voice)) + 1e-9
    voice *= 0.89 / pk
    bg = mus.music(total + 0.5, topic.get("mood", "tense"), seed=topic.get("_seed", 0))
    bg = np.pad(bg, ((0, max(0, n - len(bg))), (0, 0)))[:n]
    # приглушение музыки под голос
    env = np.abs(voice)
    k = int(0.25 * SR)
    env = np.convolve(env, np.ones(k) / k, mode="same")
    duck = 1 - 0.55 * np.clip(env / (env.max() * 0.25 + 1e-9), 0, 1)
    mvol = float(cfg.get("musicVolume", 0.16))
    mix = bg * (mvol * duck)[:, None] + voice[:, None]
    fx_vol = float(cfg.get("sfxVolume", 0.22))
    b = mus.boom()
    mix[: len(b)] += (b * fx_vol * 1.5)[:, None]
    for i, s in enumerate(scenes[1:], 1):
        w = mus.whoosh(seed=i)
        at = int((s["start"] - 0.3) * SR)
        if at > 0:
            mix[at:at + len(w)] += (w * fx_vol)[: n - at, None]
        if "boom" in (s.get("fx") or []) or "shake" in (s.get("fx") or []):
            bb = mus.boom(1.2)
            at = int(s["start"] * SR)
            mix[at:at + len(bb)] += (bb * fx_vol * 1.3)[: n - at, None]
    mix = np.tanh(mix * 1.1) / np.tanh(1.1)
    wav = os.path.join(tmpdir, f"mix_{lang}.wav")
    import wave
    with wave.open(wav, "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes((np.clip(mix[: int(total * SR)], -1, 1) * 32767).astype(np.int16).tobytes())
    # ---------- картинка ----------
    bases = {}
    for i, s in enumerate(scenes):
        if s["img"] not in bases:
            bases[s["img"]] = _prep(s["img"])
    parts = [Particles(s.get("part"), 100 + i) if s.get("part") else None for i, s in enumerate(scenes)]
    vig = _vignette()
    # субтитры: сцена 0 — большой титр, дальше — по 1–3 слова
    title_words = [_upper(w["w"], lang) for w in scenes[0]["words"]]
    hook_n = int(topic[lang].get("hookWords", 2))
    chunks = []
    for s in scenes[1:]:
        for ch in _chunks(s["words"], int(cfg.get("wordsPerCaption", 3)), int(cfg.get("captionChars", 17))):
            chunks.append({"words": ch, "s": s["vstart"] + ch[0]["s"], "e": s["vstart"] + ch[-1]["e"]})
    for i, c in enumerate(chunks):
        nxt = chunks[i + 1]["s"] if i + 1 < len(chunks) else total
        c["until"] = min(nxt, c["e"] + 0.6)
    cache = {}
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
           "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", cfg.get("preset", "medium"), "-crf", str(cfg.get("crf", 17)),
           "-profile:v", "high", "-pix_fmt", "yuv420p", "-g", str(fps * 2),
           "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
           "-movflags", "+faststart", "-shortest", out_mp4]
    pr = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    nf = int(total * fps)
    wm = cfg.get("watermark") or ""
    wm_rgba = _text_block([wm], -1, FONT_SUB, 34, 900, stroke=4) if wm else None
    for fi in range(nf):
        tt = fi / fps
        frame = None
        for i, s in enumerate(scenes):
            a0, a1 = s["start"] - (XFADE if i else 0), s["end"]
            if not (a0 <= tt < a1 + (XFADE if i < len(scenes) - 1 else 1)):
                continue
            base = bases[s["img"]]
            bh, bw = base.shape[:2]
            u = (tt - a0) / (a1 + XFADE - a0)
            cam = s.get("cam") or CAMS[i % len(CAMS)]
            z, cx, cy = _camera(cam, u, bw, bh)
            tl = tt - s["start"]
            z *= 1 + 0.06 * max(0.0, 1 - max(0.0, tl) / 0.45) ** 2  # «толчок» в начале сцены
            dx = 4 * math.sin(tt * 0.7 + i) + 2.5 * math.sin(tt * 1.9)
            dy = 3 * math.sin(tt * 0.9 + 2 * i)
            rot = 0.35 * math.sin(tt * 0.45 + i)
            fx = s.get("fx") or []
            if "shake" in fx and tl >= 0:
                amp = 18 * math.exp(-tl * 1.6)
                dx += amp * math.sin(tt * 61)
                dy += amp * math.sin(tt * 47 + 1)
                rot += amp * 0.05 * math.sin(tt * 37)
            img = _warp(base, z, cx, cy, rot, dx, dy)
            pt = parts[i]
            if pt is not None:
                ov = pt.draw(tt)
                if ov is not None:
                    img = cv2.add(img, ov)
            if "flash" in fx and 0 <= tl < 0.5:
                img = cv2.addWeighted(img, 1.0, np.full_like(img, 255), 0.85 * (1 - tl / 0.5) ** 2, 0)
            if frame is None:
                frame = img
            else:
                k = min(1.0, max(0.0, (tt - a0) / XFADE))
                frame = cv2.addWeighted(frame, 1 - k, img, k, 0)
        frame = cv2.multiply(frame, vig, scale=1 / 255)
        # титр «Что если…?» в первой сцене: слова появляются по мере произнесения
        s0 = scenes[0]
        if tt < s0["end"] + XFADE:
            shown = sum(1 for w in s0["words"] if s0["vstart"] + w["s"] <= tt + 0.05)
            if shown:
                key = ("T", shown)
                if key not in cache:
                    cache[key] = _text_block(title_words, -1, FONT_TITLE, 96, SAFE_TITLE_W, hl=set(range(hook_n)), stroke=11, shown=shown, max_h=SAFE_TITLE_H)
                last_w = s0["words"][shown - 1]
                pop = 1 + 0.08 * max(0.0, 1 - (tt - s0["vstart"] - last_w["s"]) / 0.15)
                fade = 1 - max(0.0, (tt - (s0["end"] - 0.1)) / XFADE)
                _blit(frame, cache[key], W / 2, H * 0.28, pop, max(0.0, min(1.0, fade)))
        # обычные субтитры
        for ci, c in enumerate(chunks):
            if c["s"] - 0.02 <= tt < c["until"]:
                act = -1
                for j, w in enumerate(c["words"]):
                    if tt >= c["s"] - c["words"][0]["s"] + w["s"] - 0.02:
                        act = j
                key = ("C", ci, act)
                if key not in cache:
                    cache[key] = _text_block([_upper(w["w"], lang) for w in c["words"]], act, FONT_SUB, 84, SAFE_CAP_W, stroke=10, max_h=SAFE_CAP_H)
                age = tt - c["s"]
                sc = 0.82 + 0.18 * min(1.0, age / 0.09) + 0.05 * math.sin(min(1.0, age / 0.18) * math.pi)
                _blit(frame, cache[key], W / 2, H * 0.67, sc)
                break
        if wm_rgba is not None:
            _blit(frame, wm_rgba, W / 2, H * 0.085, 1.0, 0.55)
        if len(cache) > 400:
            cache.clear()
        pr.stdin.write(frame.tobytes())
    pr.stdin.close()
    if pr.wait() != 0:
        raise RuntimeError("ffmpeg не смог собрать видео")
    cover(scenes[0]["img"], topic[lang].get("coverHook") or ("WHAT IF" if lang == "en" else "ЧТО ЕСЛИ"), topic[lang]["cover"], out_cover)
    return total
