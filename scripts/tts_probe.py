"""Диагностика озвучки: какие голоса и настройки отдают звук на этой машине.

python3 scripts/tts_probe.py [id темы]
"""
import asyncio
import json
import os
import sys
import time

import edge_tts

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


async def one(text, voice, rate, boundary):
    kw = {"rate": rate}
    if boundary:
        kw["boundary"] = boundary
    n, marks = 0, 0
    async for ch in edge_tts.Communicate(text, voice, **kw).stream():
        if ch["type"] == "audio":
            n += len(ch["data"])
        elif ch["type"] in ("WordBoundary", "SentenceBoundary"):
            marks += 1
    return n, marks


def run(text, voice, rate="+0%", boundary="WordBoundary"):
    t = time.time()
    try:
        n, m = asyncio.run(one(text, voice, rate, boundary))
        return f"OK {n // 1000} КБ, меток {m}, {time.time() - t:.1f} с"
    except Exception as e:  # noqa: BLE001
        return f"ОШИБКА {type(e).__name__}: {str(e)[:90]} ({time.time() - t:.1f} с)"


print("edge-tts", getattr(edge_tts, "__version__", "?"))
ru = "Что если Солнце внезапно погаснет?"
for voice in ["ru-RU-DmitryNeural", "ru-RU-SvetlanaNeural"]:
    for text in ["Привет.", ru, "Hello world."]:
        for b in ["WordBoundary", "SentenceBoundary"]:
            print(f"{voice:32s} {b:16s} {text[:30]:32s} {run(text, voice, '+0%', b)}", flush=True)
            time.sleep(1)
for voice in ["en-US-AndrewMultilingualNeural", "en-US-BrianMultilingualNeural", "de-DE-FlorianMultilingualNeural"]:
    print(f"{voice:32s} {'WordBoundary':16s} {ru[:30]:32s} {run(ru, voice)}", flush=True)
    time.sleep(1)
tid = sys.argv[1] if len(sys.argv) > 1 else ""
if tid:
    import glob
    topic = None
    for p in glob.glob(os.path.join(ROOT, "topics", "*.json")):
        for t in json.load(open(p, encoding="utf-8")):
            if t["id"] == tid:
                topic = t
    cfg = json.load(open(os.path.join(ROOT, "config.json"), encoding="utf-8"))
    for lang in ["en", "ru"]:
        v = cfg["voices"][lang]["voice"] if lang == "en" else "en-US-AndrewMultilingualNeural"
        for i, s in enumerate(topic["scenes"]):
            print(f"{tid} {lang} сцена {i + 1}: {run(s[lang], v, '+4%')}", flush=True)
            time.sleep(1)
