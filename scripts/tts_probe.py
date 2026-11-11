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
import glob
tid = sys.argv[1] if len(sys.argv) > 1 else "zombies"
topic = None
for p in glob.glob(os.path.join(ROOT, "topics", "*.json")):
    for t in json.load(open(p, encoding="utf-8")):
        if t["id"] == tid:
            topic = t
for lang, voice in [("ru", "ru-RU-DmitryNeural"), ("en", "en-US-AndrewMultilingualNeural")]:
    for i, s in enumerate(topic["scenes"]):
        res = []
        for k in range(8):
            r = run(s[lang], voice, "+5%")
            res.append(r)
            if r.startswith("OK"):
                break
            time.sleep(3 + 3 * k)
        print(f"{tid} {lang} {voice} сцена {i + 1}: попыток {len(res)} -> {res[-1]}", flush=True)
        time.sleep(1)
