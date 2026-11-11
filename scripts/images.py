"""Кадры мультфильма через нейросеть.

provider: "openai" (gpt-image-1 / gpt-image-1-mini), "gemini" (gemini-2.5-flash-image ~$0.04 за кадр; gemini-3.1-flash-image ~$0.07 за кадр 1K,
лучше качество), "placeholder" (локальные заглушки для проверки).
Ключи только из окружения: OPENAI_API_KEY, GEMINI_API_KEY. Нигде не печатаются.
"""
import base64
import io
import json
import os
import textwrap
import time
import urllib.error
import urllib.request

from PIL import Image, ImageDraw, ImageFont

NO_TEXT = "Absolutely no text, letters, numbers, words, captions, logos or watermarks anywhere in the image."


def _post(url, body, headers, timeout=240):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _openai(prompt, cfg):
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("Нет секрета OPENAI_API_KEY")
    body = {"model": cfg.get("model") or "gpt-image-1", "prompt": prompt, "size": "1024x1536",
            "quality": cfg.get("quality") or "medium", "n": 1, "moderation": "low"}
    d = _post("https://api.openai.com/v1/images/generations", body, {"Authorization": "Bearer " + key})
    return base64.b64decode(d["data"][0]["b64_json"])


def _gemini(prompt, cfg, ref=None):
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("Нет секрета GEMINI_API_KEY")
    model = cfg.get("model") or "gemini-2.5-flash-image"
    parts = []
    if ref:
        parts.append({"text": "The attached picture is ONLY a reference for the art style, color palette, line work and the look of the "
                              "recurring character. Do not copy its composition. Draw a completely new scene:"})
        parts.append({"inline_data": {"mime_type": "image/png", "data": base64.b64encode(ref).decode()}})
    parts.append({"text": prompt})
    body = {"contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "9:16"}}}
    if cfg.get("size"):  # только для моделей 3.x: "1K", "2K", "4K"
        body["generationConfig"]["imageConfig"]["imageSize"] = cfg["size"]
    d = _post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", body, {"x-goog-api-key": key})
    for c in d.get("candidates", []):
        for p in (c.get("content") or {}).get("parts", []):
            inl = p.get("inlineData") or p.get("inline_data")
            if inl and inl.get("data"):
                return base64.b64decode(inl["data"])
    why = (d.get("promptFeedback") or {}).get("blockReason") or (d.get("candidates") or [{}])[0].get("finishReason") or "нет картинки в ответе"
    raise RuntimeError(f"Gemini не вернул картинку: {why}")


def _placeholder(prompt, idx):
    W, H = 1024, 1536
    hue = (idx * 47) % 360
    im = Image.new("RGB", (W, H))
    top = Image.new("HSV", (1, 1), (int(hue / 360 * 255), 160, 120)).convert("RGB").getpixel((0, 0))
    bot = Image.new("HSV", (1, 1), (int(((hue + 60) % 360) / 360 * 255), 200, 230)).convert("RGB").getpixel((0, 0))
    d = ImageDraw.Draw(im)
    for y in range(H):
        k = y / H
        d.line([(0, y), (W, y)], fill=tuple(int(top[i] * (1 - k) + bot[i] * k) for i in range(3)))
    for i in range(9):
        x, y, r = (i * 211 + idx * 97) % W, (i * 331 + idx * 53) % H, 60 + (i * 37) % 140
        d.ellipse([x - r, y - r, x + r, y + r], outline=(255, 255, 255), width=10)
    f = ImageFont.truetype(os.path.join(os.path.dirname(__file__), "..", "fonts", "Montserrat-Black.ttf"), 34)
    d.text((60, 120), f"SCENE {idx + 1}", font=ImageFont.truetype(f.path, 90), fill="white")
    d.multiline_text((60, 260), "\n".join(textwrap.wrap(prompt[:300], 40)), font=f, fill="white", spacing=10)
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


def generate(prompt, out_path, cfg, idx=0, ref=None):
    """Рисует один кадр и сохраняет PNG. ref — байты первого кадра (для единого стиля, только Gemini)."""
    provider = (cfg.get("provider") or "placeholder").lower()
    style = cfg.get("style") or ""
    full = f"{prompt.strip()} {style} {NO_TEXT}".strip()
    last = None
    for attempt in range(4):
        try:
            if provider == "openai":
                data = _openai(full, cfg)
            elif provider == "gemini":
                data = _gemini(full, cfg, ref if cfg.get("styleReference", True) else None)
            else:
                data = _placeholder(prompt, idx)
            Image.open(io.BytesIO(data)).convert("RGB").save(out_path, "PNG")
            return
        except urllib.error.HTTPError as e:
            msg = e.read().decode(errors="replace")[:400]
            last = f"HTTP {e.code}: {msg}"
            if e.code in (400, 403) and ("safety" in msg.lower() or "moderation" in msg.lower() or "policy" in msg.lower()):
                full = f"{prompt.strip()} Friendly, family-safe cartoon, nothing graphic. {style} {NO_TEXT}"
            elif e.code in (401,):
                raise RuntimeError(f"Ключ для картинок не подходит ({provider}): {last}")
        except Exception as e:  # noqa: BLE001
            last = str(e)
            if "Gemini не вернул" in last:
                full = f"{prompt.strip()} Friendly, family-safe cartoon, nothing graphic. {style} {NO_TEXT}"
        time.sleep(5 + attempt * 10)
    raise RuntimeError(f"Не удалось нарисовать кадр {idx + 1} ({provider}): {last}")
