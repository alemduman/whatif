"""Фоновая музыка и звуковые эффекты, синтезируются кодом (никаких чужих треков и прав).

music(dur, mood, seed) -> стерео np.float32 [n, 2], SR = 48000
mood: tense | dark | wonder | epic | fun
"""
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

SR = 48000

# аккорды как полутоны от A (0 = A); у каждого настроения своя гармония и темп
MOODS = {
    "tense":  {"bpm": 96,  "prog": [[0, 3, 7], [-4, 0, 3], [-7, -4, 0], [-5, -1, 2]], "pluck": True,  "kick": "beat", "cut": 1500},
    "dark":   {"bpm": 72,  "prog": [[5, 8, 12], [1, 5, 8], [-2, 1, 5], [0, 4, 7]],   "pluck": False, "kick": "heart", "cut": 1100},
    "wonder": {"bpm": 84,  "prog": [[3, 7, 10, 14], [-2, 2, 5, 10], [0, 3, 7, 10], [-4, 0, 3, 7]], "pluck": True, "kick": None, "cut": 2600},
    "epic":   {"bpm": 104, "prog": [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]], "pluck": True,  "kick": "epic", "cut": 2000},
    "fun":    {"bpm": 112, "prog": [[-4, 0, 3, 7], [3, 7, 10], [0, 3, 7], [-2, 2, 5]], "pluck": True, "kick": "beat", "cut": 3200},
}


def _f(semi, octave=0):
    return 220.0 * 2 ** ((semi + 12 * octave) / 12)


def _saw(freq, n, detune_cents=(0,), harmonics=14):
    t = np.arange(n) / SR
    out = np.zeros(n, np.float32)
    for dc in detune_cents:
        f = freq * 2 ** (dc / 1200)
        ph = np.random.rand() * 2 * np.pi
        for h in range(1, harmonics + 1):
            if f * h > 9000:
                break
            out += (np.sin(2 * np.pi * f * h * t + ph * h) / h).astype(np.float32)
    return out / len(detune_cents)


def _env(n, a, r):
    e = np.ones(n, np.float32)
    na, nr = min(int(a * SR), n // 2), min(int(r * SR), n // 2)
    if na:
        e[:na] = np.linspace(0, 1, na) ** 1.5
    if nr:
        e[-nr:] *= np.linspace(1, 0, nr) ** 1.5
    return e


def _lp(x, cut, order=2):
    return sosfilt(butter(order, cut, "low", fs=SR, output="sos"), x).astype(np.float32)


def _hp(x, cut, order=2):
    return sosfilt(butter(order, cut, "high", fs=SR, output="sos"), x).astype(np.float32)


def _reverb(x, seconds=2.2, wet=0.35, seed=0):
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    decay = np.exp(-np.linspace(0, 7, n)).astype(np.float32)
    out = []
    for ch in range(2):
        ir = (rng.standard_normal(n).astype(np.float32) * decay)
        ir = _lp(ir, 5000)
        ir /= np.sqrt((ir ** 2).sum()) + 1e-9
        out.append(fftconvolve(x, ir)[: len(x)].astype(np.float32))
    w = np.stack(out, 1)
    return x[:, None] * (1 - wet) + w * wet


def music(dur, mood="tense", seed=0):
    np.random.seed(seed)
    m = MOODS.get(mood, MOODS["tense"])
    n = int((dur + 1.0) * SR)
    beat = 60 / m["bpm"]
    bar = beat * 4
    chord_len = bar * 2
    pad = np.zeros(n, np.float32)
    bass = np.zeros(n, np.float32)
    pl = np.zeros(n, np.float32)
    drums = np.zeros(n, np.float32)
    k = 0
    t0 = 0.0
    while t0 < dur + 1:
        ch = m["prog"][k % len(m["prog"])]
        s = int(t0 * SR)
        L = min(n - s, int((chord_len + 1.2) * SR))
        if L <= 0:
            break
        seg = np.zeros(L, np.float32)
        for semi in ch:
            seg += _saw(_f(semi, -1), L, (-8, 0, 7), 10)
        seg *= _env(L, 1.0, 1.4)
        pad[s:s + L] += seg * 0.10
        # бас: корень аккорда, мягкий синус с пульсом на долях
        tb = np.arange(L) / SR
        root = _f(ch[0], -2)
        bl = np.sin(2 * np.pi * root * tb) + 0.3 * np.sin(2 * np.pi * root * 2 * tb)
        pulse = 0.55 + 0.45 * np.cos(np.pi * ((tb % beat) / beat)) ** 2
        bass[s:s + L] += (bl * pulse * _env(L, 0.3, 1.2) * 0.16).astype(np.float32)
        # арпеджио-«щипки» восьмыми
        if m["pluck"]:
            notes = ch + [c + 12 for c in ch]
            step = beat / 2
            for j in range(int(chord_len / step)):
                ts = t0 + j * step
                ps = int(ts * SR)
                pn = int(0.45 * SR)
                if ps + pn >= n:
                    break
                f = _f(notes[(j * 2 + (j // 4)) % len(notes)], 1)
                tt = np.arange(pn) / SR
                tone = (np.sin(2 * np.pi * f * tt) + 0.25 * np.sin(2 * np.pi * 2 * f * tt)) * np.exp(-tt * 9)
                vel = 0.75 + 0.25 * ((j % 4) == 0)
                pl[ps:ps + pn] += (tone * 0.05 * vel).astype(np.float32)
        t0 += chord_len
        k += 1
    # ударные
    if m["kick"]:
        def kick(at, amp=0.5, f0=110, f1=42, dec=7):
            s = int(at * SR)
            L = int(0.5 * SR)
            if s + L >= n:
                return
            tt = np.arange(L) / SR
            fr = f1 + (f0 - f1) * np.exp(-tt * 28)
            drums[s:s + L] += (np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-tt * dec) * amp).astype(np.float32)
        t = 0.0
        i = 0
        while t < dur + 1:
            if m["kick"] == "heart":
                if i % 4 == 0:
                    kick(t, 0.45, 70, 38, 9)
                    kick(t + 0.22, 0.32, 65, 36, 10)
            elif m["kick"] == "epic":
                if i % 2 == 0:
                    kick(t, 0.55)
                if i % 8 == 7:
                    kick(t + beat / 2, 0.35)
            else:
                if i % 2 == 0:
                    kick(t, 0.42)
            t += beat
            i += 1
    mix = _lp(pad, m["cut"]) + bass + _lp(pl, 4500) + drums * 0.8
    mix = _hp(mix, 35)
    st = _reverb(mix, 2.4, 0.32, seed)
    st *= _env(len(st), 1.2, 1.8)[:, None]
    st /= np.max(np.abs(st)) + 1e-9
    return st[: int(dur * SR)].astype(np.float32)


def whoosh(seed=0, length=0.55):
    rng = np.random.default_rng(seed)
    L = int(length * SR)
    x = rng.standard_normal(L).astype(np.float32)
    # полосовой фильтр, «едущий» вверх: несколько сегментов с разной частотой
    out = np.zeros(L, np.float32)
    segs = 8
    for i in range(segs):
        a, b = i * L // segs, (i + 1) * L // segs
        fc = 400 * 2 ** (i / segs * 3)
        sos = butter(2, [fc * 0.6, fc * 1.6], "band", fs=SR, output="sos")
        out[a:b] = sosfilt(sos, x[max(0, a - 2000):b])[-(b - a):]
    env = np.sin(np.linspace(0, np.pi, L)) ** 2
    out *= env
    return out / (np.max(np.abs(out)) + 1e-9)


def boom(length=1.6):
    L = int(length * SR)
    t = np.arange(L) / SR
    fr = 30 + 70 * np.exp(-t * 6)
    s = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t * 2.6)
    nz = _lp(np.random.default_rng(1).standard_normal(L).astype(np.float32), 900) * np.exp(-t * 9) * 0.6
    out = (s + nz).astype(np.float32)
    return out / (np.max(np.abs(out)) + 1e-9)
