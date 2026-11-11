"""Озвучка через edge-tts (нейроголоса Microsoft) с таймингами слов для субтитров.

synth(text, voice, rate, out_wav) -> {"dur": секунды, "words": [{"w": слово, "s": начало, "e": конец}, ...]}
TTS=fake — локальная проверка без сети: тишина нужной длины и тайминги по числу букв.
"""
import asyncio
import os
import re
import subprocess
import wave

import numpy as np

SR = 48000


def _norm(s):
    return re.sub(r"[^\w]", "", s.lower().replace("ё", "е"))


def _tokens(text):
    return [t for t in text.split() if _norm(t)]


def _even_timing(tokens, t0, t1):
    """Раскладывает слова по отрезку пропорционально длине (если сервис не дал меток)."""
    lens = [max(2, len(_norm(t))) + 1 for t in tokens]
    tot = sum(lens)
    out, t = [], t0
    for tok, l in zip(tokens, lens):
        d = (t1 - t0) * l / tot
        out.append({"w": tok, "s": round(t, 3), "e": round(t + d * 0.92, 3)})
        t += d
    return out


def _align(tokens, marks, dur):
    """Сопоставляет слова исходного текста (с пунктуацией) с метками сервиса."""
    out, j = [], 0
    for i, tok in enumerate(tokens):
        n = _norm(tok)
        hit = None
        for k in range(j, min(j + 4, len(marks))):
            m = _norm(marks[k]["text"])
            if m and (m == n or n.startswith(m) or m.startswith(n)):
                hit = k
                break
        if hit is not None:
            out.append({"w": tok, "s": marks[hit]["s"], "e": marks[hit]["e"]})
            j = hit + 1
        else:
            out.append({"w": tok, "s": None, "e": None})
    # дыры заполняем интерполяцией между соседями
    for i, o in enumerate(out):
        if o["s"] is None:
            prev = next((out[k]["e"] for k in range(i - 1, -1, -1) if out[k]["e"] is not None), 0.0)
            nxt_i = next((k for k in range(i + 1, len(out)) if out[k]["s"] is not None), None)
            nxt = out[nxt_i]["s"] if nxt_i is not None else dur
            gap = (nxt_i - i + 1) if nxt_i is not None else (len(out) - i + 1)
            d = max(0.08, (nxt - prev) / gap)
            o["s"], o["e"] = round(prev + d * 0.1, 3), round(prev + d, 3)
    return out


def _decode_to_wav(mp3, wav):
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", mp3, "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", wav], check=True)


def read_wav(path):
    with wave.open(path) as w:
        n = w.getnframes()
        a = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768
        if w.getnchannels() == 2:
            a = a.reshape(-1, 2).mean(1)
        return a


def _trim(a, thr=0.004):
    """Обрезает тишину по краям, оставляя по 40 мс."""
    idx = np.where(np.abs(a) > thr)[0]
    if not len(idx):
        return a, 0.0
    pad = int(0.04 * SR)
    s, e = max(0, idx[0] - pad), min(len(a), idx[-1] + pad)
    return a[s:e], s / SR


async def _edge(text, voice, rate, mp3):
    import edge_tts
    try:
        com = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    except TypeError:  # старые версии edge-tts без параметра boundary
        com = edge_tts.Communicate(text, voice, rate=rate)
    marks = []
    with open(mp3, "wb") as f:
        async for ch in com.stream():
            if ch["type"] == "audio":
                f.write(ch["data"])
            elif ch["type"] == "WordBoundary":
                s = ch["offset"] / 1e7
                marks.append({"text": ch["text"], "s": round(s, 3), "e": round(s + ch["duration"] / 1e7, 3)})
    return marks


def print_voices(lang):
    """Печатает доступные голоса для языка (диагностика, когда голос не отвечает)."""
    try:
        import edge_tts
        vs = asyncio.run(edge_tts.list_voices())
        names = [v["ShortName"] for v in vs if v["Locale"].lower().startswith(lang.lower()) or "Multilingual" in v["ShortName"]]
        print(f"  доступные голоса ({lang} и мультиязычные): {', '.join(names)}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"  список голосов получить не удалось: {e}", flush=True)


def _factor(rate):
    try:
        return 1 + float(str(rate).strip().rstrip("%")) / 100
    except ValueError:
        return 1.0


def _to_wav(src, dst, tempo=1.0, extra=None):
    af = ["-af", f"atempo={tempo:.3f}"] if abs(tempo - 1) > 0.005 else []
    subprocess.run(["ffmpeg", "-y", "-v", "error", *(extra or []), "-i", src, *af, "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", dst], check=True)


STYLE = {"en": "Read this aloud like an enthusiastic, curious science storyteller in a short video, natural pace: ",
         "ru": "Прочитай вслух живо и увлечённо, как рассказчик научно-популярного ролика, в естественном темпе: "}


def _gemini(text, voice, lang, raw, model):
    import base64, json, urllib.request
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    body = {"contents": [{"parts": [{"text": STYLE.get(lang, "") + text}]}],
            "generationConfig": {"responseModalities": ["AUDIO"],
                                 "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}}}}
    req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                                 data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": key})
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read())
    for c in d.get("candidates", []):
        for part in (c.get("content") or {}).get("parts", []):
            inl = part.get("inlineData") or part.get("inline_data")
            if inl and inl.get("data"):
                rate = 24000
                mt = inl.get("mimeType", "")
                if "rate=" in mt:
                    rate = int(mt.split("rate=")[1].split(";")[0])
                pcm = raw + ".pcm"
                open(pcm, "wb").write(base64.b64decode(inl["data"]))
                return pcm, ["-f", "s16le", "-ar", str(rate), "-ac", "1"]
    raise RuntimeError("Gemini не вернул звук")


def _openai(text, voice, lang, raw, model):
    import json, urllib.request
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    body = {"model": model, "voice": voice, "input": text, "response_format": "wav",
            "instructions": STYLE.get(lang, "").rstrip(": ")}
    req = urllib.request.Request("https://api.openai.com/v1/audio/speech", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=180) as r:
        open(raw, "wb").write(r.read())
    return raw, None


def _piper(text, voice, lang, raw, model):
    import urllib.request
    d = os.path.expanduser("~/.cache/piper")
    os.makedirs(d, exist_ok=True)
    onnx = os.path.join(d, voice + ".onnx")
    if not os.path.exists(onnx):
        loc, name, q = voice.split("-")
        base = f"https://huggingface.co/rhasspy/piper-voices/resolve/main/{loc.split('_')[0]}/{loc}/{name}/{q}/{voice}"
        for ext in (".onnx", ".onnx.json"):
            urllib.request.urlretrieve(base + ext, os.path.join(d, voice + ext))
    try:
        from piper import PiperVoice
    except ImportError:
        from piper.voice import PiperVoice
    pv = PiperVoice.load(onnx)
    with wave.open(raw, "wb") as wf:
        if hasattr(pv, "synthesize_wav"):
            pv.synthesize_wav(text, wf)
        else:
            pv.synthesize(text, wf)
    return raw, None


_WHISPER = {}


def _whisper_marks(wav, lang, text):
    """Метки слов распознаванием речи (для голосов, которые не отдают тайминги сами)."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return []
    name = os.environ.get("WHISPER_MODEL", "base")
    if name not in _WHISPER:
        _WHISPER[name] = WhisperModel(name, device="cpu", compute_type="int8")
    # звук передаём массивом 16 кГц: так не нужен декодер PyAV (его версии конфликтуют с faster-whisper)
    from scipy.signal import resample_poly
    a16 = resample_poly(read_wav(wav), 1, SR // 16000).astype(np.float32)
    segs, _ = _WHISPER[name].transcribe(a16, language=lang, word_timestamps=True, beam_size=1, initial_prompt=text)
    return [{"text": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3)} for sg in segs for w in (sg.words or [])]


def available(engine):
    if engine == "gemini":
        return bool(os.environ.get("GEMINI_API_KEY", "").strip())
    if engine == "openai":
        return bool(os.environ.get("OPENAI_API_KEY", "").strip())
    return True


def synth(text, voice, rate, out_wav, engine="edge", lang="en", model=None, tries=None):
    """Озвучивает фразу движком engine (edge | gemini | openai | piper). Возвращает длительность и тайминги слов."""
    import time
    tokens = _tokens(text)
    if os.environ.get("TTS") == "fake":
        dur = 0.36 * len(tokens) + 0.002 * len(text) * 10 + 0.3
        a = np.zeros(int(dur * SR), np.float32)
        # тихий тон вместо голоса, чтобы было слышно, где «говорит»
        for w in _even_timing(tokens, 0.05, dur - 0.1):
            s, e = int(w["s"] * SR), int(w["e"] * SR)
            t = np.arange(e - s) / SR
            a[s:e] += 0.15 * np.sin(2 * np.pi * 220 * t) * np.hanning(e - s)
        _write(out_wav, a)
        return {"dur": round(dur, 3), "words": _even_timing(tokens, 0.05, dur - 0.1)}
    tries = tries or int(os.environ.get("TTS_TRIES", "6" if engine == "edge" else "3"))
    last, marks = None, []
    for attempt in range(tries):
        try:
            if engine == "edge":
                mp3 = out_wav[:-4] + ".mp3"
                marks = asyncio.run(_edge(text, voice, rate, mp3))
                _decode_to_wav(mp3, out_wav)
            else:
                fn = {"gemini": _gemini, "openai": _openai, "piper": _piper}[engine]
                src, extra = fn(text, voice, lang, out_wav[:-4] + ".raw.wav", model)
                _to_wav(src, out_wav, _factor(rate), extra)
            break
        except Exception as e:  # noqa: BLE001  сервисы иногда не отвечают — повторяем с паузой
            last = e
            if "HTTP Error 4" in str(e) and "429" not in str(e):
                break
            time.sleep(3 + attempt * 3)
    else:
        raise RuntimeError(f"Озвучка не удалась ({engine} {voice}): {last}")
    if last is not None and not os.path.exists(out_wav):
        raise RuntimeError(f"Озвучка не удалась ({engine} {voice}): {last}")
    a = read_wav(out_wav)
    a, off = _trim(a)
    dur = len(a) / SR
    _write(out_wav, a)
    if engine != "edge":
        try:
            marks = _whisper_marks(out_wav, lang, text)
        except Exception as e:  # noqa: BLE001
            print(f"  тайминги слов не распознаны ({e}), раскладываю равномерно", flush=True)
            marks = []
    else:
        for m in marks:
            m["s"] = max(0.0, round(m["s"] - off, 3))
            m["e"] = max(m["s"] + 0.05, round(m["e"] - off, 3))
    words = _align(tokens, marks, dur) if marks else _even_timing(tokens, 0.05, dur - 0.05)
    return {"dur": round(dur, 3), "words": words}


def _write(path, a):
    a = np.clip(a, -1, 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((a * 32767).astype(np.int16).tobytes())
