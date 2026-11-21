import * as T from 'three';

// Детерминированный генератор случайных чисел и шум (одинаковый результат на каждом кадре и в CI)
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const P = new Uint8Array(512);
{ const r = rng(1337); const p = [...Array(256).keys()]; for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) P[i] = p[i & 255]; }
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
const grad = (h, x, y) => ((h & 1) ? -x : x) + ((h & 2) ? -y : y);
export function noise2(x, y) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255; x -= Math.floor(x); y -= Math.floor(y);
  const u = fade(x), v = fade(y), a = P[X] + Y, b = P[X + 1] + Y;
  return T.MathUtils.lerp(T.MathUtils.lerp(grad(P[a], x, y), grad(P[b], x - 1, y), u), T.MathUtils.lerp(grad(P[a + 1], x, y - 1), grad(P[b + 1], x - 1, y - 1), u), v);
}
export function fbm(x, y, oct = 5, per = 0.5) { let a = 1, f = 1, s = 0, n = 0; for (let i = 0; i < oct; i++) { s += a * noise2(x * f, y * f); n += a; a *= per; f *= 2; } return s / n; }
// тайлящийся шум: смешиваем 4 копии по краям
export function tileFbm(x, y, period, oct, per) {
  const fx = x / period, fy = y / period;
  const a = fbm(x, y, oct, per), b = fbm(x - period, y, oct, per), c = fbm(x, y - period, oct, per), d = fbm(x - period, y - period, oct, per);
  return T.MathUtils.lerp(T.MathUtils.lerp(a, b, fx), T.MathUtils.lerp(c, d, fx), fy);
}

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
export const lerp = (a, b, t) => a + (b - a) * t;
export const ramp = (t, a, b) => smooth((t - a) / (b - a));
export const easeOut = x => 1 - Math.pow(1 - clamp(x), 3);
export const easeIn = x => Math.pow(clamp(x), 3);

// Текстуры из высотной карты: цвет, нормали, шероховатость
export function makeTextureSet(size, heightFn, colorFn, roughFn, normalStrength = 2, repeat = 1) {
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) H[y * size + x] = heightFn(x, y);
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = size; return c; };
  const cc = mk(), nc = mk(), rc = mk();
  const ci = cc.getContext('2d').createImageData(size, size), ni = nc.getContext('2d').createImageData(size, size), ri = rc.getContext('2d').createImageData(size, size);
  const h = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, hv = h(x, y);
    const [r, g, b] = colorFn(hv, x, y); ci.data[i] = r; ci.data[i + 1] = g; ci.data[i + 2] = b; ci.data[i + 3] = 255;
    const dx = (h(x + 1, y) - h(x - 1, y)) * normalStrength, dy = (h(x, y + 1) - h(x, y - 1)) * normalStrength;
    const l = Math.hypot(dx, dy, 1);
    ni.data[i] = (-dx / l * 0.5 + 0.5) * 255; ni.data[i + 1] = (dy / l * 0.5 + 0.5) * 255; ni.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; ni.data[i + 3] = 255;
    const rv = roughFn(hv, x, y) * 255; ri.data[i] = ri.data[i + 1] = ri.data[i + 2] = rv; ri.data[i + 3] = 255;
  }
  cc.getContext('2d').putImageData(ci, 0, 0); nc.getContext('2d').putImageData(ni, 0, 0); rc.getContext('2d').putImageData(ri, 0, 0);
  const tex = (c, srgb) => { const t = new T.CanvasTexture(c); t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(repeat, repeat); t.anisotropy = 8; if (srgb) t.colorSpace = T.SRGBColorSpace; return t; };
  return { map: tex(cc, true), normalMap: tex(nc), roughnessMap: tex(rc) };
}

// Ставим отрезок-цилиндр (ось Y геометрии) между точками a и b
const _UP = new T.Vector3(0, 1, 0), _d = new T.Vector3();
export function placeSegment(obj, a, b) {
  _d.subVectors(b, a); const l = _d.length();
  obj.position.copy(a); obj.quaternion.setFromUnitVectors(_UP, _d.multiplyScalar(1 / (l || 1)));
  return l;
}

// Мягкая круглая текстура для частиц
export function softDot(size = 64, inner = 0.0) {
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, size * inner / 2, size / 2, size / 2, size / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, size, size);
  const t = new T.CanvasTexture(c); return t;
}
