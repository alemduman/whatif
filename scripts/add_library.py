"""Добавляет сделанные темы из out/produced.json в library.json (без повторов, порядок сохраняется)."""
import datetime
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "out", "produced.json")
lib_p = os.path.join(ROOT, "library.json")
try:
    lib = json.load(open(lib_p, encoding="utf-8"))
except FileNotFoundError:
    lib = {"items": []}
prod = json.load(open(out, encoding="utf-8"))
items = {x["id"]: x for x in lib.get("items", [])}
order = [x["id"] for x in lib.get("items", [])]
today = datetime.date.today().isoformat()
for p in prod:
    langs = {k: {"seconds": v["seconds"], "caption": v["caption"]} for k, v in p["langs"].items()}
    if p["id"] in items:
        items[p["id"]]["langs"].update(langs)
        items[p["id"]]["updated"] = today
    else:
        items[p["id"]] = {"id": p["id"], "date": today, "langs": langs}
        order.append(p["id"])
lib["items"] = [items[i] for i in order]
with open(lib_p, "w", encoding="utf-8") as f:
    json.dump(lib, f, ensure_ascii=False, indent=1)
    f.write("\n")
print(f"library.json: {len(lib['items'])} тем")
