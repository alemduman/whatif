"""Учёт баланса предоплаты Gemini: вычитает расходы сборки (out/cost.json) из config.json → credits.balance.

python3 scripts/credits.py out/cost.json   → печатает новый баланс; в GITHUB_OUTPUT: balance, low (true/false), empty (true/false)
Порог «осталось на одну сборку»: баланс меньше стоимости двух сборок (produceBatch тем), то есть хватит максимум на одну.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
p = os.path.join(ROOT, "config.json")
cfg = json.load(open(p, encoding="utf-8"))
cr = cfg.get("credits") or {}
img, tts = float(cr.get("imageUsd", 0.039)), float(cr.get("ttsUsd", 0.0015))
spent = 0.0
if len(sys.argv) > 1 and os.path.exists(sys.argv[1]):
    c = json.load(open(sys.argv[1]))
    spent = c.get("images", 0) * img + (c.get("tts_gemini", 0) + c.get("tts_openai", 0)) * tts
bal = round(float(cr.get("balance", 0)) - spent, 2)
if spent > 0:
    cr["balance"] = bal
    cr["asOf"] = datetime.now(timezone(timedelta(hours=4))).strftime("%Y-%m-%d %H:%M")
    cfg["credits"] = cr
    with open(p, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
        f.write("\n")
scenes = 8
per_topic = scenes * img + scenes * 2 * tts
batch = per_topic * int(cfg.get("produceBatch", 3))
low = bal < 2 * batch
empty = bal < batch
print(f"Потрачено в этой сборке: ${spent:.2f}. Баланс Gemini (расчётный): ${bal:.2f}. Одна сборка ≈ ${batch:.2f}")
out = os.environ.get("GITHUB_OUTPUT")
if out:
    with open(out, "a") as f:
        f.write(f"balance={bal:.2f}\nbatch={batch:.2f}\nlow={'true' if low else 'false'}\nempty={'true' if empty else 'false'}\n")
