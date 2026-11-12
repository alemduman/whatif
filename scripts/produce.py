"""Делает ролики «Что если?» из банка тем: кадры (общие), озвучка и видео на каждом языке, обложки.

python3 scripts/produce.py --count 3             # следующие 3 темы, которых ещё нет в library.json
python3 scripts/produce.py --ids sun-off,zombies  # конкретные темы
Результат: out/<id>/<id>.<lang>.mp4 + .jpg + .json, out/<id>/<id>.images.zip, out/produced.json
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import images  # noqa: E402
import render  # noqa: E402
import tts  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def load(p, fb=None):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return fb


def all_topics():
    out = []
    for p in sorted(glob.glob(os.path.join(ROOT, "topics", "*.json"))):
        d = load(p)
        out += d if isinstance(d, list) else [d]
    ids = [t["id"] for t in out]
    dup = {i for i in ids if ids.count(i) > 1}
    if dup:
        raise SystemExit(f"В темах повторяются id: {', '.join(sorted(dup))}")
    return out


def check(t, langs):
    errs = []
    for lang in langs:
        if lang not in t or not t[lang].get("cover"):
            errs.append(f"нет {lang}.cover")
    for i, s in enumerate(t.get("scenes", [])):
        for k in ["img"] + langs:
            if not s.get(k):
                errs.append(f"сцена {i + 1}: нет «{k}»")
    if len(t.get("scenes", [])) < 4:
        errs.append("меньше 4 сцен")
    return errs


def caption(t, lang, cfg):
    c = t[lang]
    tags = (cfg.get("hashtags", {}).get(lang) or [])
    tags = list(dict.fromkeys((c.get("tags") or []) + tags))[: int(cfg.get("maxHashtags", 5))]
    return (c.get("caption") or "").strip() + ("\n\n" + " ".join(tags) if tags else "")


_VOICE_OK = {}
COST = {"images": 0, "tts_gemini": 0, "tts_openai": 0}  # платные запросы этой сборки (для учёта баланса)
HERO_PNG = os.path.join(ROOT, "assets", "hero.png")


def hero_ref(cfg, icfg):
    """Портрет постоянного героя: рисуется один раз и дальше служит образцом стиля для всех кадров."""
    if (icfg.get("provider") or "placeholder") != "gemini":
        return None
    if not os.path.exists(HERO_PNG):
        os.makedirs(os.path.dirname(HERO_PNG), exist_ok=True)
        print("  рисую портрет героя (образец стиля, один раз)…", flush=True)
        prompt = (f"Character design sheet: {cfg.get('hero', '')}. Full body, front view, friendly curious expression, "
                  "standing on a plain soft light-blue background with a subtle round spotlight, nothing else in the picture.")
        images.generate(prompt, HERO_PNG, icfg, 0, None)
        COST["images"] += 1
    with open(HERO_PNG, "rb") as f:
        return f.read()


def produce(t, cfg, langs, out_root):
    tid = t["id"]
    od = os.path.join(out_root, tid)
    imgd = os.path.join(od, "img")
    os.makedirs(imgd, exist_ok=True)
    icfg = dict(cfg.get("images", {}))
    hero = cfg.get("hero", "")
    if os.environ.get("IMAGE_PROVIDER"):
        icfg["provider"] = os.environ["IMAGE_PROVIDER"]
    # 1) кадры: одни на все языки; уже готовые (например, скачанные из релиза) не перерисовываем
    if os.environ.get("REUSE_IMAGES") == "1" and not glob.glob(os.path.join(imgd, "*.png")):
        try:
            subprocess.run(["gh", "release", "download", "library", "-p", f"{tid}.images.zip", "-D", od, "--clobber"],
                           check=True, capture_output=True)
            with zipfile.ZipFile(os.path.join(od, f"{tid}.images.zip")) as z:
                z.extractall(imgd)
            print("  кадры взяты из прошлой сборки (повторно не рисуются)", flush=True)
        except Exception:  # noqa: BLE001
            pass
    # образец стиля и героя: один «портрет героя» на все ролики (assets/hero.png), а не первый кадр,
    # иначе нейросеть копирует композицию первого кадра во все сцены
    ref = hero_ref(cfg, icfg) if icfg.get("styleReference", True) else None
    paths = []
    for i, s in enumerate(t["scenes"]):
        p = os.path.join(imgd, f"{i + 1:02d}.png")
        if not os.path.exists(p):
            print(f"  кадр {i + 1}/{len(t['scenes'])}…", flush=True)
            images.generate(s["img"].replace("{hero}", hero), p, icfg, i, ref)
            if (icfg.get("provider") or "placeholder") != "placeholder":
                COST["images"] += 1
        paths.append(p)
    zp = os.path.join(od, f"{tid}.images.zip")
    with zipfile.ZipFile(zp, "w") as z:
        for p in paths:
            z.write(p, os.path.basename(p))
    res = {"id": tid, "langs": {}}
    maxs = float(cfg.get("maxSeconds", 59))
    for lang in langs:
        v = cfg["voices"][lang]
        tmp = tempfile.mkdtemp(prefix=f"wi_{tid}_{lang}_")
        rates = [v.get("rate", "+0%")] + list(v.get("fasterRates", ["+8%", "+15%", "+22%"]))
        # цепочка голосов: первый сработавший озвучивает весь ролик; варианты без ключа пропускаются
        chain = [tuple(x[:2]) for x in v.get("chain", [])] or [("edge", v.get("voice", ""))]
        only = [x for x in os.environ.get("TTS_ONLY", "").split(",") if x]
        chain = [c for c in chain if tts.available(c[0]) and (not only or c[0] in only)]
        if not chain:
            raise RuntimeError(f"Нет доступных голосов для «{lang}» (проверь voices.{lang}.chain в config.json)")
        scenes, eng, voice, rate = None, "", "", rates[0]
        for ci in range(_VOICE_OK.get(lang, 0), len(chain)):
            eng, voice = chain[ci]
            model = (cfg.get("ttsModels") or {}).get(eng)
            try:
                for rate in rates:
                    scenes = []
                    for i, s in enumerate(t["scenes"]):
                        wav = os.path.join(tmp, f"s{i + 1:02d}.wav")
                        r = tts.synth(s[lang], voice, rate, wav, engine=eng, lang=lang, model=model)
                        if eng in ("gemini", "openai") and os.environ.get("TTS") != "fake":
                            COST["tts_" + eng] += 1
                        scenes.append({"img": paths[i], "wav": wav, "dur": r["dur"], "words": r["words"],
                                       "fx": s.get("fx"), "cam": s.get("cam"), "part": s.get("part")})
                    est = sum(x["dur"] for x in scenes) + 0.35 + 0.28 * (len(scenes) - 1) + 1.6 + 0.1 * len(scenes)
                    if est <= maxs:
                        break
                    print(f"  {lang}: выходит {est:.1f} с при скорости {rate}, ускоряю голос", flush=True)
                _VOICE_OK[lang] = ci
                print(f"  {lang}: голос {eng} / {voice}", flush=True)
                break
            except Exception as e:  # noqa: BLE001
                scenes = None
                print(f"  {lang}: {eng} / {voice} не сработал ({str(e)[:200]}), пробую следующий вариант", flush=True)
        if scenes is None:
            raise RuntimeError(f"Ни один голос для «{lang}» не сработал: {chain}")
        mp4 = os.path.join(od, f"{tid}.{lang}.mp4")
        jpg = os.path.join(od, f"{tid}.{lang}.jpg")
        print(f"  {lang}: собираю видео…", flush=True)
        topic = dict(t)
        topic["_seed"] = zlib.crc32(tid.encode()) % 1000
        dur = render.render(topic, lang, scenes, mp4, jpg, cfg.get("video", {}), tmp)
        meta = {"id": tid, "lang": lang, "video": os.path.basename(mp4), "cover": os.path.basename(jpg),
                "seconds": round(dur, 1), "caption": caption(t, lang, cfg), "title": t["scenes"][0][lang], "rate": rate, "voice": f"{eng}/{voice}"}
        with open(os.path.join(od, f"{tid}.{lang}.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=1)
        res["langs"][lang] = meta
        shutil.rmtree(tmp, ignore_errors=True)
        print(f"  {lang}: готово, {dur:.1f} с", flush=True)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", default="")
    ap.add_argument("--count", type=int, default=1)
    ap.add_argument("--langs", default="")
    ap.add_argument("--out", default=os.path.join(ROOT, "out"))
    ap.add_argument("--check", action="store_true", help="только проверить банк тем")
    a = ap.parse_args()
    cfg = load(os.path.join(ROOT, "config.json"), {})
    langs = [x for x in (a.langs or ",".join(cfg.get("languages", ["en", "ru"]))).split(",") if x]
    topics = all_topics()
    bad = {t["id"]: check(t, langs) for t in topics}
    bad = {k: v for k, v in bad.items() if v}
    if bad:
        for k, v in bad.items():
            print(f"❌ {k}: {'; '.join(v)}")
        raise SystemExit(1)
    if a.check:
        print(f"Банк тем в порядке: {len(topics)} тем")
        return
    lib = load(os.path.join(ROOT, "library.json"), {"items": []})
    done = {x["id"] for x in lib.get("items", [])}
    by = {t["id"]: t for t in topics}
    if a.ids:
        ids = [x.strip() for x in a.ids.split(",") if x.strip()]
        miss = [i for i in ids if i not in by]
        if miss:
            raise SystemExit(f"Нет таких тем: {', '.join(miss)}")
    else:
        order = cfg.get("order") or []
        rest = [t["id"] for t in topics]
        ids = [i for i in order if i in by] + [i for i in rest if i not in order]
        ids = [i for i in ids if i not in done][: a.count]
    if not ids:
        print("Новых тем нет: все темы из банка уже сделаны. Добавь темы в папку topics/.")
        return
    os.makedirs(a.out, exist_ok=True)
    produced = []
    try:
        for tid in ids:
            print(f"▶ {tid}", flush=True)
            produced.append(produce(by[tid], cfg, langs, a.out))
    except Exception as e:
        with open(os.path.join(a.out, "error.txt"), "w", encoding="utf-8") as f:
            f.write(str(e))
        raise
    finally:  # расходы пишем и при сбое: картинки до сбоя уже оплачены
        with open(os.path.join(a.out, "cost.json"), "w", encoding="utf-8") as f:
            json.dump(COST, f)
    with open(os.path.join(a.out, "produced.json"), "w", encoding="utf-8") as f:
        json.dump(produced, f, ensure_ascii=False, indent=1)
    print(f"Сделано тем: {len(produced)}")


if __name__ == "__main__":
    main()
