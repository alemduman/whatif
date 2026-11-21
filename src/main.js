import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildWorld, makeDustFX } from './world.js';
import { makeSpider } from './spider.js';
import { makeArmory, loadHoplites, poseMan, boneDir, makeSpear } from './hoplite.js';
import { clamp, smooth, lerp, ramp, easeOut, placeSegment, rng } from './util.js';

const Q = new URLSearchParams(location.search);
const W = +(Q.get('w') || 720), H = +(Q.get('h') || 1280), FPS = +(Q.get('fps') || 30);
const DOF = Q.get('dof') !== '0', MSAA = +(Q.get('msaa') ?? 4), SHADOW = +(Q.get('shadow') ?? 2048), BLOOM = Q.get('bloom') !== '0';

const canvas = document.getElementById('c');
const renderer = new T.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1); renderer.setSize(W, H, false);
renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFSoftShadowMap;
const scene = new T.Scene();
const camera = new T.PerspectiveCamera(38, W / H, 0.1, 400);

// --- окружение: HDR-небо заката для освещения и отражений
const hdr = await new RGBELoader().loadAsync('/assets/sunset.hdr');
hdr.mapping = T.EquirectangularReflectionMapping;
const pmrem = new T.PMREMGenerator(renderer);
scene.environment = pmrem.fromEquirectangular(hdr).texture;
scene.background = hdr; scene.backgroundBlurriness = 0.02; scene.backgroundIntensity = 0.75;
scene.fog = new T.FogExp2(0xc89a70, 0.011);
const sun = new T.DirectionalLight(0xffc48a, 3.6); sun.position.set(-13, 10, -15); sun.castShadow = true;
sun.shadow.mapSize.set(SHADOW, SHADOW); Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 60 }); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02; sun.shadow.radius = 3;
scene.add(sun);
const fill = new T.HemisphereLight(0xffd8b0, 0x4a3020, 0.35); scene.add(fill);

const world = buildWorld(scene);
const dust = makeDustFX(scene);
const spider = makeSpider(scene);
const A = makeArmory();
const { men } = await loadHoplites(scene, new GLTFLoader(), A, 5);

// --- постобработка: глубина резкости, свечение, цветокоррекция, зерно
const rt = new T.WebGLRenderTarget(W, H, { type: T.HalfFloatType, samples: MSAA });
const composer = new EffectComposer(renderer, rt); composer.setPixelRatio(1); composer.setSize(W, H);
composer.addPass(new RenderPass(scene, camera));
const bokeh = new BokehPass(scene, camera, { focus: 10, aperture: 0.0012, maxblur: 0.006 }); if (DOF) composer.addPass(bokeh);
const bloom = new UnrealBloomPass(new T.Vector2(W, H), 0.32, 0.6, 0.9); if (BLOOM) composer.addPass(bloom);
composer.addPass(new OutputPass());
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, flash: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float time; uniform float flash; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + time*7.0) * 43758.5453); }
    void main(){
      vec2 d = vUv - 0.5; float ca = 0.0015 * length(d) * 2.0;
      vec3 c = vec3(texture2D(tDiffuse, vUv + d*ca).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - d*ca).b);
      c = mix(c, c*c*(3.0-2.0*c), 0.25);                    // контраст
      c *= vec3(1.04, 1.0, 0.94);                           // тёплый тон
      float v = smoothstep(0.85, 0.25, length(d * vec2(0.9, 1.1)));
      c *= mix(0.55, 1.0, v);                               // виньетка
      c += (h(vUv * 900.0) - 0.5) * 0.035;                  // плёночное зерно
      c = mix(c, vec3(1.0), flash);
      gl_FragColor = vec4(c, 1.0);
    }`,
});
composer.addPass(grade);

// ---------------- Сценарий ----------------
const TL = await (await fetch('/timeline.json')).json();
let acc = 0; const SC = TL.map(s => { const o = { ...s, t0: acc }; acc += s.D; return o; });
const TOTAL = acc;
const at = (i, frac) => SC[i].t0 + SC[i].dur * frac; // момент внутри фразы по доле текста
const word = (i, w) => { const k = SC[i].text.indexOf(w); return at(i, Math.max(0, k) / SC[i].text.length); };
const S = SC.map(s => s.t0);

// Позиции
const LINE_Z = 8, xs = [-3.2, -1.6, 0, 1.6, 3.2];
const EV = []; // события для звука
const ev = (t, type, extra = {}) => EV.push({ t: +t.toFixed(3), type, ...extra });

// Время отпускания копья в броске (ищем пик скорости кисти)
function releaseTime(man) {
  const clip = man.actions.OverhandThrow.getClip(); let best = 0.6, bv = 0, prev = null;
  const save = man.tl; man.tl = [{ t0: 0, clip: 'OverhandThrow' }]; man.path = [{ t: 0, x: 0, z: 0, yaw: 0 }];
  for (let t = 0.2; t < clip.duration - 0.1; t += 1 / 60) { poseMan(man, t); const p = man.B.handR.getWorldPosition(new T.Vector3()); if (prev) { const v = p.z - prev.z; if (v > bv) { bv = v; best = t; } } prev = p; }
  man.tl = save; return best;
}
const REL = releaseTime(men[0]);

// Спланировать действия бойцов
const tThrow = word(2, 'Бросок') - 0.15;
const tCharge = word(3, 'Рывок') - 0.25, tSweep = tCharge + 0.42, tHitKnock = tSweep + 0.16;
const tJab = word(4, 'Удар') - 0.25, tSlash = word(4, 'Ещё') - 0.35;
const tRear = S[5] + 0.15, tWeb = [word(5, 'паутина') + 0.1, word(5, 'Последние') - 0.1, word(5, 'Последние') + 0.35];
const webOrder = [2, 0, 4];

men.forEach((m, i) => {
  const off = i * 0.37;
  const z0 = LINE_Z, z1 = 4.6;
  m.tl = [{ t0: -10, clip: 'Sword_Idle', loop: true, arm: true, from: off }];
  m.path = [{ t: 0, x: xs[i], z: z0, yaw: Math.PI }, { t: S[1] + 0.2, x: xs[i], z: z0, yaw: Math.PI }];
  m.tl.push({ t0: S[1] + 0.2, clip: 'Walk_Loop', loop: true, arm: true, fade: 0.35, from: off });
  m.path.push({ t: S[2] - 0.2, x: xs[i] * 0.95, z: z1, yaw: Math.PI, ease: 'lin' });
  m.tl.push({ t0: S[2] - 0.25, clip: 'Sword_Idle', loop: true, arm: true, fade: 0.3, from: off });
  m.spearMode = [{ t: -10, mode: 'hold' }];
  m.swordFrom = null;
});
// бросок: крайние бойцы
for (const i of [0, 4]) {
  const m = men[i];
  m.tl.push({ t0: tThrow - REL, clip: 'OverhandThrow', fade: 0.15 });
  m.tl.push({ t0: tThrow - REL + 1.3, clip: 'Sword_Idle', loop: true, arm: true, fade: 0.35 });
  m.spearMode.push({ t: tThrow - REL - 0.4, mode: 'overhand' }, { t: tThrow, mode: 'thrown' });
  m.swordFrom = tThrow + 1.0;
}
// рывок паука и удар лапой: 1 и 3 отлетают
const SP = { x0: 0, z0: -8.5 };
const spiderKeys = [
  { t: 0, x: 0, z: -8.5, yaw: 0 }, { t: S[0] + 3.0, x: 0, z: -8.5, yaw: 0 }, { t: S[1], x: 0.3, z: -7.4, yaw: 0.05 },
  { t: S[2], x: 0, z: -5.2, yaw: 0 }, { t: tThrow + 0.6, x: 0, z: -5.2, yaw: 0 }, { t: tThrow + 1.0, x: 0, z: -5.9, yaw: -0.05 },
  { t: tCharge, x: 0, z: -5.6, yaw: 0 }, { t: tCharge + 0.5, x: 0.1, z: 1.4, yaw: 0, ease: 'out' },
  { t: tJab + 0.15, x: 0.1, z: 1.4, yaw: 0.05 }, { t: tSlash + 0.6, x: 0, z: 0.5, yaw: -0.08 },
  { t: tRear, x: 0, z: 0.3, yaw: 0 }, { t: S[6] + 0.3, x: 0, z: 0.3, yaw: 0 }, { t: TOTAL, x: -0.6, z: 1.4, yaw: 0.35 },
];
for (const i of [1, 3]) {
  const m = men[i], dir = i === 1 ? -1 : 1;
  m.tl.push({ t0: tHitKnock, clip: 'Hit_Knockback', fade: 0.08, speed: 1.05 });
  m.path.push({ t: tHitKnock, x: xs[i] * 0.95, z: z1g(), yaw: Math.PI }, { t: tHitKnock + 0.75, x: xs[i] * 0.95 + dir * 2.6, z: 7.6, yaw: Math.PI + dir * 0.6, arc: 0.9 });
  m.spearMode.push({ t: tHitKnock + 0.1, mode: 'drop', dir });
  m.dead = tHitKnock;
}
function z1g() { return 4.6; }
// ответный удар: копьё в упор (2), мечи (0, 4)
{
  const m = men[2];
  m.tl.push({ t0: tJab - 0.9, clip: 'Jog_Fwd_Loop', loop: true, arm: true, fade: 0.2 });
  m.path.push({ t: tJab - 0.9, x: 0, z: 4.6, yaw: Math.PI }, { t: tJab - 0.15, x: 0.2, z: 3.4, yaw: Math.PI + 0.08 });
  m.tl.push({ t0: tJab - 0.2, clip: 'Punch_Jab', arm: true, fade: 0.12, speed: 0.9 });
  m.tl.push({ t0: tJab + 0.75, clip: 'Sword_Idle', loop: true, arm: true, fade: 0.3 });
  m.spearMode.push({ t: tJab - 0.35, mode: 'thrust' }, { t: tJab + 0.9, mode: 'hold' });
}
for (const [i, dx] of [[0, -1.4], [4, 1.4]]) {
  const m = men[i], ts = tSlash + (i === 4 ? 0.35 : 0);
  m.tl.push({ t0: ts - 0.8, clip: 'Jog_Fwd_Loop', loop: true, arm: true, fade: 0.2 });
  m.path.push({ t: ts - 0.8, x: xs[i] * 0.95, z: 4.6, yaw: Math.PI }, { t: ts - 0.05, x: dx, z: 3.0, yaw: Math.PI - Math.sign(dx) * 0.5 });
  m.tl.push({ t0: ts, clip: 'Sword_Attack', arm: true, fade: 0.12 });
  m.tl.push({ t0: ts + 1.2, clip: 'Sword_Idle', loop: true, arm: true, fade: 0.3 });
  m.slashAt = ts + 0.55;
}
// паутина и падение в коконе
webOrder.forEach((i, k) => {
  const m = men[i], tw = tWeb[k] + 0.3;
  m.webAt = tw; m.tl.push({ t0: tw, clip: 'Hit_Chest', arm: true, fade: 0.1 });
  m.fx.fallAt = tw + 0.9 + k * 0.15; m.fx.fallDir = k === 1 ? -1 : 1;
});

// События для звука
ev(0, 'crowd'); ev(word(0, 'паук'), 'hiss');
ev(S[1] + 0.2, 'march');
for (const i of [0, 4]) { ev(tThrow - 0.15, 'grunt'); ev(tThrow, 'whoosh'); }
ev(tThrow + 0.45, 'hit_chitin'); ev(tThrow + 0.5, 'hit_chitin'); ev(tThrow + 0.6, 'screech');
ev(tCharge, 'charge'); ev(tSweep + 0.12, 'impact_big'); ev(tHitKnock + 0.7, 'body_fall'); ev(tHitKnock + 0.8, 'body_fall'); ev(tHitKnock + 0.5, 'crowd_roar');
ev(tJab + 0.15, 'stab'); ev(tJab + 0.25, 'screech'); ev(tSlash + 0.55, 'slash'); ev(tSlash + 0.9, 'slash');
ev(tRear, 'screech_big'); tWeb.forEach(t => ev(t, 'web')); webOrder.forEach(i => ev(men[i].fx.fallAt + 0.6, 'body_fall'));
ev(S[5] + SC[5].dur * 0.75, 'crowd_roar'); ev(S[6], 'drums_end');

// HP
const hpSpider = t => 100 - 14 * ramp(t, tThrow + 0.42, tThrow + 0.6) - 14 * ramp(t, tThrow + 0.5, tThrow + 0.7) - 18 * ramp(t, tJab + 0.1, tJab + 0.35) - 13 * ramp(t, tSlash + 0.5, tSlash + 0.7) - 13 * ramp(t, tSlash + 0.85, tSlash + 1.05);
const alive = t => men.filter(m => !((m.dead != null && t > m.dead + 0.3) || (m.webAt != null && t > m.webAt + 0.3))).length;

// --- вспомогательные объекты: летящие копья, нити паутины
const thrown = {};
for (const i of [0, 4]) { const s = makeSpear(A, 0.95); s.visible = false; scene.add(s); thrown[i] = s; }
const webMat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, emissive: 0x888888, transparent: true, opacity: 0.85 });
const webStrands = webOrder.map(() => { const g = new T.Group(); for (let k = 0; k < 3; k++) { const c = new T.Mesh(new T.CylinderGeometry(0.012 + k * 0.004, 0.02, 1, 6), webMat.clone()); c.geometry.translate(0, 0.5, 0); g.add(c); } g.visible = false; scene.add(g); return g; });

function spiderAt(t) {
  let k = 0; while (k < spiderKeys.length - 1 && spiderKeys[k + 1].t <= t) k++;
  const a = spiderKeys[k], b = spiderKeys[Math.min(k + 1, spiderKeys.length - 1)];
  let u = b.t > a.t ? clamp((t - a.t) / (b.t - a.t)) : 1; u = b.ease === 'out' ? easeOut(u) : smooth(u);
  return { x: lerp(a.x, b.x, u), z: lerp(a.z, b.z, u), yaw: lerp(a.yaw, b.yaw, u) };
}
function spiderMods(t) {
  const raise = Math.max(0.35 * ramp(t, tThrow + 0.5, tThrow + 0.8) * (1 - ramp(t, tThrow + 1.6, tThrow + 2.1)), ramp(t, tRear, tRear + 0.6) * (1 - ramp(t, S[6] + 1.5, S[6] + 2.6)) * 1.0, 0.6 * ramp(t, tCharge + 0.3, tCharge + 0.45) * (1 - ramp(t, tSweep + 0.4, tSweep + 0.8)) * 0);
  const sweep = t > tSweep - 0.15 && t < tSweep + 0.6 ? ramp(t, tSweep - 0.15, tSweep + 0.3) * (t < tSweep + 0.45 ? 1 : 1 - ramp(t, tSweep + 0.45, tSweep + 0.6)) : 0;
  const fang = Math.max(ramp(t, tThrow + 0.55, tThrow + 0.7) * (1 - ramp(t, tThrow + 1.4, tThrow + 1.7)), ramp(t, tRear, tRear + 0.3) * (1 - ramp(t, tRear + 2.5, tRear + 3)), ramp(t, tJab + 0.2, tJab + 0.3) * (1 - ramp(t, tJab + 0.8, tJab + 1.1)), 0.15 + 0.1 * Math.sin(t * 3));
  const crouch = ramp(t, tCharge - 0.35, tCharge - 0.05) * (1 - ramp(t, tCharge, tCharge + 0.2));
  return { raise, sweep: sweep > 0 ? Math.min(1, sweep / 1) : 0, sweepSide: -1, fang, crouch };
}

// ---------------- Симуляция (по порядку кадров) ----------------
const DT = 1 / 60;
let simT = null;
function resetSim() {
  spider.reset(0, -8.5, 0); dust.reset(); simT = 0;
  for (const i of [0, 4]) thrown[i].visible = false;
  hitDone.clear();
}
const stuckDone = new Set(), hitDone = new Set();
function simStep(t, dt) {
  const p = spiderAt(t);
  spider.step(t, dt, p.x, p.z, p.yaw, { ...spiderMods(t), onStep: (f, sp) => { if (sp > 2) dust.burst(t, f.x, 0, f.z, 10, 0.6); } });
  // события попаданий
  const once = (key, cond, fn) => { if (cond && !hitDone.has(key)) { hitDone.add(key); fn(); } };
  once('h1', t >= tThrow + 0.45, () => spider.hit(1.0, new T.Vector3(0.3, 0.3, -1)));
  once('h2', t >= tThrow + 0.52, () => spider.hit(0.8, new T.Vector3(-0.3, 0.2, -1)));
  once('ch', t >= tCharge + 0.48, () => dust.burst(t, p.x, 0, p.z + 1.5, 70, 1.6));
  const lastP = i => men[i].path[men[i].path.length - 1];
  once('kn1', t >= tHitKnock + 0.7, () => dust.burst(t, lastP(1).x, 0, lastP(1).z, 40, 1.0));
  once('kn3', t >= tHitKnock + 0.75, () => dust.burst(t, lastP(3).x, 0, lastP(3).z, 40, 1.0));
  once('jab', t >= tJab + 0.15, () => spider.hit(1.2, new T.Vector3(0, 0.3, -1)));
  once('sl1', t >= tSlash + 0.55, () => spider.hit(0.8, new T.Vector3(0.6, 0.2, -0.6)));
  once('sl2', t >= tSlash + 0.9, () => spider.hit(0.8, new T.Vector3(-0.6, 0.2, -0.6)));
  for (const i of [0, 4]) once('stuck' + i, t >= tThrow + 0.45 + (i === 4 ? 0.07 : 0), () => {
    const tgt = hitPoint(i), from = new T.Vector3(xs[i] * 0.95, 2.0, 4.4); const d = tgt.clone().sub(from).normalize();
    const stuck = makeSpear(A, 0.95); spider.stick(stuck, tgt.clone().addScaledVector(d, -(stuck.userData.tipOffset - 0.45)), d);
  });
  webOrder.forEach((i, k) => once('fall' + i, t >= men[i].fx.fallAt + 0.6, () => dust.burst(t, lastP(i).x, 0, lastP(i).z, 30, 0.8)));
}
function advanceTo(t) {
  if (simT === null || t < simT - 1e-6) resetSim();
  while (simT + DT <= t + 1e-6) { simT += DT; simStep(simT, DT); }
}

// ---------------- Оружие и эффекты в кадре ----------------
const tmpV = new T.Vector3();
function modeAt(m, t) { let r = m.spearMode[0]; for (const s of m.spearMode) if (s.t <= t) r = s; return r; }
function placeWeapons(m, t) {
  const hand = m.B.handR.getWorldPosition(new T.Vector3()), low = m.B.lowR.getWorldPosition(new T.Vector3());
  const fwd = boneDir(m, 'spine', new T.Vector3(0, 0, 1)), up = boneDir(m, 'spine', new T.Vector3(0, 1, 0));
  const forearm = hand.clone().sub(low).normalize();
  const md = modeAt(m, t); const s = m.spear;
  s.visible = true;
  if (md.mode === 'hold') { const d = up.clone().multiplyScalar(1).addScaledVector(fwd, 0.35).normalize(); s.position.copy(hand); s.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d); }
  else if (md.mode === 'overhand' || md.mode === 'thrust') {
    const tgt = spider.centerWorld(); const d = tgt.sub(hand).normalize(); if (md.mode === 'overhand') d.y += 0.15;
    const k = md.mode === 'thrust' ? 0.7 : 0.5; const dir = forearm.clone().lerp(d.normalize(), k).normalize();
    s.position.copy(hand); s.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir);
  } else if (md.mode === 'thrown') s.visible = false;
  else if (md.mode === 'drop') {
    const u = smooth((t - md.t) / 0.6), base = m.root.position;
    const lie = new T.Vector3(base.x + md.dir * 0.7, 0.03, base.z - 0.6);
    s.position.copy(hand).lerp(lie, u);
    const dHold = up.clone().addScaledVector(fwd, 0.35).normalize(), dLie = new T.Vector3(md.dir * 0.3, 0, 1).normalize();
    s.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dHold.lerp(dLie, u).normalize());
  }
  // меч после броска
  if (m.swordFrom != null && t >= m.swordFrom) { m.sword.visible = true; m.sword.position.copy(hand); const d = forearm.clone().lerp(up, 0.15).normalize(); m.sword.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d); } else m.sword.visible = false;
  // щит на левом предплечье
  const hl = m.B.handL.getWorldPosition(new T.Vector3()), ll = m.B.lowL.getWorldPosition(new T.Vector3());
  const mid = hl.clone().add(ll).multiplyScalar(0.5);
  const side = new T.Vector3().crossVectors(up, fwd).normalize(); // влево
  const n = fwd.clone().addScaledVector(side, 0.35).normalize();
  m.shield.position.copy(mid).addScaledVector(n, 0.11);
  m.shield.quaternion.setFromRotationMatrix(new T.Matrix4().lookAt(new T.Vector3(), n.clone().negate(), up));
  // плащ развевается
  m.cape.rotation.x = 0.15 + Math.sin(t * 2.3 + m.i) * 0.05;
  // кокон
  if (m.webAt != null && t >= m.webAt) {
    const u = easeOut((t - m.webAt) / 0.45);
    m.cocoon.visible = true; m.cocoon.position.copy(m.root.position); m.cocoon.quaternion.copy(m.root.quaternion);
    m.cocoon.scale.set(lerp(1.4, 1, u), Math.max(0.01, u), lerp(1.4, 1, u)); m.cocoon.material.opacity = clamp(u * 1.6);
    const hide = u > 0.85; m.root.visible = !hide; m.spear.visible = m.spear.visible && !hide; m.shield.visible = !hide; m.sword.visible = m.sword.visible && !hide;
  } else { m.cocoon.visible = false; m.root.visible = true; m.shield.visible = true; }
}
function placeThrown(t) {
  for (const i of [0, 4]) {
    const s = thrown[i], m = men[i], t0 = tThrow, t1 = tThrow + 0.45 + (i === 4 ? 0.07 : 0);
    if (t < t0) { s.visible = false; continue; }
    if (t >= t1) { s.visible = false; continue; }
    s.visible = true;
    const from = new T.Vector3(xs[i] * 0.95, 2.0, 4.4), to = hitPoint(i);
    m.fx.relPos = from;
    const u = (t - t0) / (t1 - t0);
    const p = from.clone().lerp(to, u); p.y += Math.sin(u * Math.PI) * 0.9;
    const p2 = from.clone().lerp(to, Math.min(1, u + 0.02)); p2.y += Math.sin(Math.min(1, u + 0.02) * Math.PI) * 0.9;
    const d = p2.sub(p).normalize();
    s.position.copy(p).addScaledVector(d, -(s.userData.tipOffset - 0.2)); s.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d);
  }
}
function hitPoint(i) { return new T.Vector3(i === 0 ? -0.35 : 0.42, i === 0 ? 0.25 : 0.1, i === 0 ? 0.9 : 0.2).applyMatrix4(spider.body.matrixWorld); }
function placeWeb(t) {
  webOrder.forEach((i, k) => {
    const g = webStrands[k], t0 = tWeb[k], t1 = t0 + 0.3, t2 = t1 + 0.9;
    if (t < t0 || t > t2) { g.visible = false; return; }
    g.visible = true;
    const a = spider.mouthWorld(), m = men[i], b = m.root.position.clone().add(new T.Vector3(0, 1.2, 0));
    const u = clamp((t - t0) / (t1 - t0)), fade = 1 - clamp((t - t1) / (t2 - t1));
    const end = a.clone().lerp(b, easeOut(u));
    g.children.forEach((c, j) => { const off = new T.Vector3(Math.sin(j * 2.1) * 0.06, Math.cos(j * 1.7) * 0.06, 0); placeSegment(c, a.clone().add(off), end.clone().add(off.multiplyScalar(2))); c.scale.set(1, a.distanceTo(end), 1); c.material.opacity = 0.85 * fade; });
  });
}

// ---------------- Камера ----------------
const R0 = rng(5);
const shakeN = (t, f) => Math.sin(t * f * 6.283) * 0.6 + Math.sin(t * f * 2.17 * 6.283 + 1.3) * 0.4;
function shake(t) { let s = 0; for (const [t0, a] of [[tThrow + 0.45, 0.06], [tCharge + 0.45, 0.16], [tSweep + 0.15, 0.2], [tJab + 0.15, 0.08], [tRear + 0.3, 0.1]]) { const d = t - t0; if (d > 0 && d < 0.8) s += a * Math.exp(-d * 5); } return s; }
const v3 = (x, y, z) => new T.Vector3(x, y, z);
// Автокадрирование: камера ставится так, чтобы все цели попали в узкий вертикальный кадр
const ASPECT = W / H;
const _cam = new T.PerspectiveCamera(40, W / H, 0.1, 400);
function frameOn(pts, yaw, pitch, fov, pad = 0.6, lift = 0, distK = 1) {
  // ищем минимальную дистанцию, при которой все точки помещаются в кадр с полями
  const c = new T.Vector3(); pts.forEach(p => c.add(p)); c.multiplyScalar(1 / pts.length);
  const look = c.clone().add(new T.Vector3(0, lift, 0));
  const dir = new T.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  _cam.fov = fov; _cam.aspect = W / H; _cam.updateProjectionMatrix();
  const margin = clamp(0.92 - pad * 0.15, 0.6, 0.92);
  const fits = d => { _cam.position.copy(look).addScaledVector(dir, d); _cam.lookAt(look); _cam.updateMatrixWorld(true); for (const p of pts) { const v = p.clone().project(_cam); if (v.z > 1 || Math.abs(v.x) > margin || Math.abs(v.y) > margin) return false; } return true; };
  let lo = 0.8, hi = 60; for (let k = 0; k < 22; k++) { const m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
  let d = hi * distK;
  // камера не должна выезжать за стену арены
  const pos = look.clone().addScaledVector(dir, d), lim = 18.5, r = Math.hypot(pos.x, pos.z);
  if (r > lim) { // укорачиваем дистанцию до стены
    let lo2 = 0, hi2 = d; for (let k = 0; k < 20; k++) { const m = (lo2 + hi2) / 2; const q = look.clone().addScaledVector(dir, m); if (Math.hypot(q.x, q.z) > lim) hi2 = m; else lo2 = m; }
    d = lo2;
  }
  return { pos: look.clone().addScaledVector(dir, d), look, fov, focus: d };
}
const headOf = m => m.B.head.getWorldPosition(new T.Vector3());
const feetOf = m => m.root.position.clone();
const spC = () => spider.centerWorld();
const spFront = () => spider.mouthWorld();
function shotAt(t) {
  const cut1 = word(0, 'гигантский') - 0.25, cut2 = word(0, 'Справа') - 0.2;
  const allMen = () => men.flatMap(m => [headOf(m), feetOf(m)]);
  const spPts = () => [spC(), spFront(), spider.root.position.clone().add(new T.Vector3(0, 0.1, 0))];
  if (t < cut1) { const u = smooth(t / cut1); return frameOn([...allMen(), ...spPts()], lerp(0.25, 0.08, u), lerp(0.5, 0.3, u), 46, 0.3, -0.3); }
  if (t < cut2) { const u = (t - cut1) / (cut2 - cut1); return frameOn([spFront(), spC(), spC().add(new T.Vector3(0, 0.9, 0)), spider.root.position.clone().add(new T.Vector3(0, 0, 1.2))], lerp(0.12, 0.02, u), lerp(0.14, 0.1, u), 34, lerp(0.5, 0.2, u), 0.1); }
  if (t < S[1]) { const u = (t - cut2) / (S[1] - cut2); const g = [1, 2, 3].map(i => men[i]); return frameOn(g.flatMap(m => [headOf(m), feetOf(m).add(new T.Vector3(0, 0.3, 0))]), Math.PI + lerp(0.5, 0.35, u), 0.1, 36, lerp(0.5, 0.3, u), 0.2); }
  if (t < S[2]) { const u = (t - S[1]) / (S[2] - S[1]); return frameOn([...[1, 2, 3].map(i => headOf(men[i])), ...spPts()], lerp(0.12, 0.05, u), 0.12, 42, 0.4, -0.2, 0.85); }
  if (t < tCharge - 0.3) { const u = (t - S[2]) / (tCharge - 0.3 - S[2]); const p = [headOf(men[4]), feetOf(men[4]), ...spPts()]; if (thrown[4].visible) p.push(thrown[4].position.clone()); return frameOn(p, lerp(0.42, 0.32, u), 0.18, 42, 0.4, -0.1); }
  if (t < tSweep + 1.2) { const u = (t - tCharge + 0.3) / 1.5; return frameOn([...[1, 2, 3].map(i => headOf(men[i])), ...spPts()], lerp(-0.15, -0.05, u), 0.06, 44, 0.5, 0.1, 0.9); }
  if (t < S[4]) { const u = (t - tSweep - 1.2) / (S[4] - tSweep - 1.2); return frameOn([feetOf(men[1]), feetOf(men[3]), ...spPts()], lerp(0.2, 0.3, u), 0.55, 42, 0.5, -0.3); }
  if (t < tSlash - 0.6) { const u = (t - S[4]) / (tSlash - 0.6 - S[4]); return frameOn([headOf(men[2]), feetOf(men[2]), spFront(), spC()], lerp(0.9, 0.8, u), 0.1, 38, 0.4, 0.1); }
  if (t < S[5]) { const u = (t - tSlash + 0.6) / (S[5] - tSlash + 0.6); return frameOn([headOf(men[0]), headOf(men[4]), feetOf(men[0]), ...spPts()], lerp(-0.35, -0.25, u), 0.15, 42, 0.4, 0); }
  if (t < S[6]) { const u = (t - S[5]) / (S[6] - S[5]); return frameOn([...[0, 2, 4].map(i => feetOf(men[i])), spC(), spC().add(new T.Vector3(0, 1.6, 0))], lerp(0.3, 0.45, u), -0.02, 46, 0.6, 0.4, 0.95); }
  { const u = smooth((t - S[6]) / (TOTAL - S[6])); return frameOn([spC(), spC().add(new T.Vector3(0, 1, 0)), ...[0, 2, 4].map(i => men[i].cocoon.position.clone())], lerp(0.3, 1.5, u), lerp(0.28, 0.18, u), 42, 0.8, 0.2); }
}

// ---------------- HUD ----------------
const hud = { title: document.getElementById('title'), win: document.getElementById('win'), hp: document.getElementById('hp'), pips: [...document.querySelectorAll('.pip')], bars: document.getElementById('bars') };
function setHud(t) {
  const tt = clamp(1 - (t - 2.6) / 0.5); hud.title.style.opacity = Math.min(clamp(t / 0.3), tt);
  hud.title.style.transform = `scale(${1 + (1 - clamp(t / 0.4)) * 0.2})`;
  hud.bars.style.opacity = clamp((t - 2.8) / 0.5) * (1 - clamp((t - (S[6] + 0.5)) / 0.5));
  hud.hp.style.width = hpSpider(t) + '%';
  const a = alive(t); hud.pips.forEach((p, i) => p.classList.toggle('off', i >= a));
  const w = clamp((t - (S[6] + 0.6)) / 0.4); hud.win.style.opacity = w; hud.win.style.transform = `translate(-50%,0) scale(${1 + (1 - w) * 0.3})`;
}

// ---------------- Кадр ----------------
function frame(t) {
  advanceTo(t);
  const excite = 0.3 + ramp(t, tHitKnock, tHitKnock + 0.3) * (1 - ramp(t, tHitKnock + 2, tHitKnock + 3)) * 0.7 + ramp(t, S[5] + 3, S[5] + 3.5) * 0.8;
  world.update(t, excite);
  for (const m of men) { poseMan(m, t); placeWeapons(m, t); }
  placeThrown(t); placeWeb(t); dust.update(t);
  const sh = shotAt(t); const s = shake(t);
  camera.position.copy(sh.pos).add(new T.Vector3(shakeN(t, 7.3) * s, shakeN(t + 3, 6.1) * s, 0));
  camera.position.x += Math.sin(t * 0.9) * 0.04; camera.position.y += Math.sin(t * 1.3) * 0.03; // «ручная» камера
  camera.fov = sh.fov; camera.updateProjectionMatrix(); camera.lookAt(sh.look);
  bokeh.uniforms.focus.value = sh.focus; bokeh.uniforms.aperture.value = 0.0009;
  grade.uniforms.time.value = t;
  grade.uniforms.flash.value = 0.25 * Math.max(0, 1 - Math.abs(t - (tSweep + 0.15)) / 0.08);
  setHud(t);
  composer.render();
}
window.frame = frame; window.TOTAL = TOTAL; window.EVENTS = EV.sort((a, b) => a.t - b.t); window.FPSV = FPS;
window.ready = true;
