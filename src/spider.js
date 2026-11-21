import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng, clamp, smooth, lerp, placeSegment } from './util.js';

// Гигантский паук-птицеед: опушённое тело, сегментированные лапы, походка с опорой лап о землю (IK)
const UP = new T.Vector3(0, 1, 0);

function colorize(geo, fn) {
  const p = geo.attributes.position, c = new Float32Array(p.count * 3), tmp = new T.Color();
  for (let i = 0; i < p.count; i++) { fn(tmp, p.getX(i), p.getY(i), p.getZ(i)); c[i * 3] = tmp.r; c[i * 3 + 1] = tmp.g; c[i * 3 + 2] = tmp.b; }
  geo.setAttribute('color', new T.BufferAttribute(c, 3)); return geo;
}
function hairCone(len, r, base, tip) {
  const g = new T.ConeGeometry(r, len, 3, 1, true); g.translate(0, len / 2, 0);
  return colorize(g, (c, x, y) => c.copy(base).lerp(tip, clamp(y / len)));
}
const _q = new T.Quaternion(), _m = new T.Matrix4(), _v = new T.Vector3(), _s = new T.Vector3(1, 1, 1);
function placeHair(h, pos, dir) { const g = h.clone(); _q.setFromUnitVectors(UP, dir.clone().normalize()); _m.compose(pos, _q, _s); g.applyMatrix4(_m); return g; }

// Мех «оболочками»: N слоёв той же геометрии, раздутых по нормали; в каждом слое остаются только «волоски» из шумовой текстуры
let FURTEX = null;
function furTexture() {
  if (FURTEX) return FURTEX;
  const N = 256, cell = 4, c = document.createElement('canvas'); c.width = c.height = N; const g = c.getContext('2d'); const img = g.createImageData(N, N); const R = rng(77);
  const hcell = []; for (let i = 0; i < (N / cell) ** 2; i++) hcell.push([0.35 + R() * 0.65, 0.3 + R() * 0.4, 0.3 + R() * 0.4]);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), h = hcell[cy * (N / cell) + cx];
    const dx = (x % cell) / cell - h[1], dy = (y % cell) / cell - h[2], d = Math.hypot(dx, dy) / 0.5;
    const v = Math.max(0, h[0] * (1 - d * 0.9)); const i = (y * N + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = v * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0); FURTEX = new T.CanvasTexture(c); FURTEX.wrapS = FURTEX.wrapT = T.RepeatWrapping; FURTEX.minFilter = T.LinearMipmapLinearFilter; return FURTEX;
}
function addFur(mesh, { layers = 12, len = 0.06, rep = [8, 4], comb = new T.Vector3(0, 0, -1), combK = 0.6, tip = 0xb08a60, root = 0.35 }) {
  const mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, alphaTest: 0.5, side: T.FrontSide });
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { furLen: { value: len }, furLayers: { value: layers }, furTex: { value: furTexture() }, furRep: { value: new T.Vector2(...rep) }, furComb: { value: comb.clone().normalize().multiplyScalar(combK) }, furTip: { value: new T.Color(tip) }, furRoot: { value: root } });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float furLen; uniform float furLayers; uniform vec2 furRep; uniform vec3 furComb; varying float vH; varying vec2 vFurUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vH = (float(gl_InstanceID) + 1.0) / furLayers; transformed += normalize(objectNormal) * furLen * vH + furComb * furLen * vH * vH; vFurUv = uv * furRep;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D furTex; uniform vec3 furTip; uniform float furRoot; varying float vH; varying vec2 vFurUv;')
      .replace('#include <alphatest_fragment>', 'float fh = texture2D(furTex, vFurUv).r; if (fh < vH) discard; diffuseColor.rgb = mix(diffuseColor.rgb * mix(furRoot, 1.0, vH), furTip, smoothstep(0.55, 1.0, vH / max(fh, 0.01)) * 0.75);');
  };
  mat.customProgramCacheKey = () => 'fur';
  const shells = new T.InstancedMesh(mesh.geometry, mat, layers);
  const id = new T.Matrix4(); for (let i = 0; i < layers; i++) shells.setMatrixAt(i, id);
  shells.frustumCulled = false; mesh.add(shells); return shells;
}
function ellipsoid(rx, ry, rz, colFn) { const g = new T.SphereGeometry(1, 56, 40); g.scale(rx, ry, rz); return colorize(g, (c, x, y, z) => colFn(c, x / rx, y / ry, z / rz)); }
function segmentGeo(L, r0, r1, colFn) {
  const g = new T.CylinderGeometry(r1, r0, L, 16, 12, false); g.translate(0, L / 2, 0);
  { const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const y = p.getY(i) / L, k = 1 + 0.12 * Math.exp(-((y - 0.08) ** 2) / 0.004) + 0.05 * Math.sin(y * Math.PI); p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k); } g.computeVertexNormals(); }
  return colorize(g, (c, x, y) => colFn(c, y / L));
}
function guardHairs(n, place, len, R, col) {
  const parts = []; for (let i = 0; i < n; i++) { const [p, d] = place(R); parts.push(placeHair(hairCone(len * (0.6 + R() * 0.8), 0.0035, col, new T.Color(0xc8a070)), p, d)); }
  return mergeGeometries(parts.map(g => { g.deleteAttribute('uv'); return g.index ? g.toNonIndexed() : g; }));
}

export function makeSpider(scene) {
  const R = rng(2024);
  const root = new T.Group(); scene.add(root);
  const body = new T.Group(); root.add(body); body.scale.setScalar(1.3);
  const mat = new T.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.4, sheen: 0.7, sheenRoughness: 0.6, sheenColor: new T.Color(0x8a6a48), envMapIntensity: 1.0 });
  const hairMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  const C = (h) => new T.Color(h);
  const dark = C(0x120c09), band = C(0xb08a60), band2 = C(0x6a4a30);

  // Головогрудь: невысокий купол с лучевым узором и светлой каймой
  const cephM = new T.Mesh(ellipsoid(0.62, 0.27, 0.7, (c, x, y, z) => { c.copy(C(0x2a1d14)); const ang = Math.atan2(x, z); if (y > 0 && Math.abs(Math.sin(ang * 4)) < 0.22) c.multiplyScalar(0.5); if (Math.hypot(x, z) > 0.82 && y > -0.3) c.lerp(C(0xb89060), 0.7); if (y < -0.2) c.copy(dark); }), mat);
  cephM.position.set(0, 0, 0.5); cephM.castShadow = true; body.add(cephM);
  addFur(cephM, { layers: 8, len: 0.028, rep: [10, 5], comb: new T.Vector3(0, -0.2, -1), tip: 0xc8a070 });
  // Глаза: маленький бугорок и 8 блестящих глаз
  const eyeMat = new T.MeshPhysicalMaterial({ color: 0x030303, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 2.5 });
  const tub = new T.Mesh(new T.SphereGeometry(0.075, 20, 14), new T.MeshStandardMaterial({ color: 0x2a1d14, roughness: 0.85 })); tub.scale.set(1, 0.6, 1); tub.position.set(0, 0.255, 0.98); body.add(tub);
  for (const [x, y, z, r] of [[0.025, 0.29, 1.03, 0.024], [-0.025, 0.29, 1.03, 0.024], [0.06, 0.27, 1.02, 0.017], [-0.06, 0.27, 1.02, 0.017], [0.05, 0.28, 0.94, 0.015], [-0.05, 0.28, 0.94, 0.015], [0.075, 0.26, 0.97, 0.013], [-0.075, 0.26, 0.97, 0.013]]) {
    const e = new T.Mesh(new T.SphereGeometry(r * 0.75, 14, 10), eyeMat); e.position.set(x, y, z); body.add(e);
  }
  // Брюшко: крупное, густо опушённое, со светлыми длинными волосками
  const abdG = new T.Group(); abdG.position.set(0, 0.12, -0.32); body.add(abdG);
  const abdM = new T.Mesh(ellipsoid(0.78, 0.66, 0.95, (c, x, y, z) => { c.copy(C(0x1e140e)); if (y > 0.25 && Math.abs(x) < 0.22) c.lerp(C(0x3a2618), 0.6); }), mat);
  abdM.position.set(0, 0, -0.95); abdM.castShadow = true; abdG.add(abdM);
  addFur(abdM, { layers: 14, len: 0.09, rep: [14, 7], comb: new T.Vector3(0, -0.4, -1), tip: 0x7a5a3c, root: 0.3 });
  abdM.add(new T.Mesh(guardHairs(500, R => { const u = R() * 2 - 1, a = R() * 6.283, s = Math.sqrt(1 - u * u); const n = new T.Vector3(s * Math.cos(a), u, s * Math.sin(a)); const p = new T.Vector3(n.x * 0.78, n.y * 0.66, n.z * 0.95); return [p, n.clone().add(new T.Vector3(0, -0.2, -0.8))]; }, 0.22, R, C(0x6a4a30)), hairMat));
  const ped = new T.Mesh(new T.CylinderGeometry(0.13, 0.16, 0.35, 12), new T.MeshStandardMaterial({ color: 0x15100c, roughness: 0.6 })); ped.rotation.x = Math.PI / 2; ped.position.set(0, 0.06, -0.2); body.add(ped);
  // Хелицеры и клыки
  const fangMat = new T.MeshPhysicalMaterial({ color: 0x080404, roughness: 0.12, clearcoat: 1, envMapIntensity: 1.8 });
  const chel = [-1, 1].map(s => {
    const g = new T.Group(); g.position.set(s * 0.12, -0.04, 1.08); body.add(g);
    const m = new T.Mesh(ellipsoid(0.11, 0.14, 0.18, c => c.copy(C(0x1a120c))), mat); m.position.set(0, 0, 0.1); m.castShadow = true; g.add(m);
    addFur(m, { layers: 8, len: 0.035, rep: [6, 3], comb: new T.Vector3(0, -1, 0.4), tip: 0xd0a878 });
    const fg = new T.ConeGeometry(0.03, 0.26, 10, 6); fg.translate(0, -0.13, 0);
    { const p = fg.attributes.position; for (let i = 0; i < p.count; i++) { const y = -p.getY(i); p.setZ(i, p.getZ(i) - y * y * 1.4); } fg.computeVertexNormals(); }
    const fang = new T.Mesh(fg, fangMat); fang.position.set(0, -0.11, 0.2); g.add(fang);
    return { g, fang, s };
  });
  // Сегмент лапы с мехом и светлыми кольцами у суставов
  const seg = (L, r0, r1, bands, fl) => {
    const m = new T.Mesh(segmentGeo(L, r0, r1, (c, y) => { c.copy(dark); for (const b of bands) { const k = clamp(1 - Math.abs(y - b.at) / b.w); if (k > 0) c.lerp(b.c, smooth(k)); } }), mat);
    m.castShadow = true; scene.add(m);
    addFur(m, { layers: 10, len: fl, rep: [Math.max(2, (r0 + r1) * Math.PI / 0.009 / 64), L / 0.009 / 64], comb: new T.Vector3(0, 1, 0), combK: 0.9, tip: 0x6a4c34 });
    m.add(new T.Mesh(guardHairs(Math.round(L * 45), R => { const y = R() * L, a = R() * 6.283, r = lerp(r0, r1, y / L); const n = new T.Vector3(Math.cos(a), 0, Math.sin(a)); return [new T.Vector3(n.x * r, y, n.z * r), n.clone().add(new T.Vector3(0, 0.9, 0))]; }, 0.13, R, C(0x5a4030)), hairMat));
    return m;
  };
  // Педипальпы
  const palps = [-1, 1].map(s => ({ s, segs: [seg(0.42, 0.05, 0.045, [], 0.04), seg(0.38, 0.045, 0.04, [{ at: 0.02, w: 0.12, c: band }], 0.045)] }));
  // Прядильные бородавки
  for (const s of [-1, 1]) { const sp = new T.Mesh(new T.ConeGeometry(0.05, 0.18, 8), mat); sp.rotation.x = -Math.PI / 2 - 0.4; sp.position.set(s * 0.07, -0.2, -1.85); abdG.add(sp); }

  // Лапы
  const LEG = [
    { a: 30, r: 2.95, L: [1.55, 1.4, 1.25] }, { a: 66, r: 2.9, L: [1.45, 1.3, 1.12] },
    { a: 110, r: 2.8, L: [1.38, 1.25, 1.06] }, { a: 148, r: 3.0, L: [1.6, 1.45, 1.3] }];
  const hipsZ = [0.95, 0.68, 0.42, 0.18], hipsX = [0.42, 0.54, 0.55, 0.46];
  const legs = [];
  for (const side of [1, -1]) for (let k = 0; k < 4; k++) {
    const d = LEG[k], rad = d.a * Math.PI / 180;
    const segs = [
      seg(d.L[0], 0.135, 0.115, [{ at: 0.985, w: 0.07, c: band }], 0.075),
      seg(d.L[1], 0.12, 0.095, [{ at: 0.02, w: 0.1, c: band }, { at: 0.985, w: 0.05, c: band2 }], 0.075),
      seg(d.L[2], 0.085, 0.055, [{ at: 0.02, w: 0.06, c: band2 }], 0.07),
    ];
    const joints = [0.12, 0.095].map(r => { const m = new T.Mesh(new T.SphereGeometry(r, 14, 10), mat); m.geometry = colorize(m.geometry, c => c.copy(C(0x2a1c12))); m.castShadow = true; scene.add(m); return m; });
    const group = ((k % 2 === 0) === (side === 1)) ? 0 : 1;
    legs.push({
      side, k, L: d.L, segs, joints, group,
      hip: new T.Vector3(side * hipsX[k], -0.02, hipsZ[k]),
      rest: new T.Vector3(side * Math.sin(rad) * d.r, 0, 0.5 + Math.cos(rad) * d.r),
      foot: new T.Vector3(), from: new T.Vector3(), to: new T.Vector3(), stepping: false, t0: 0, dur: 0.3,
    });
  }

  const S = {
    root, body, legs, chel, palps, abdG,
    height: 1.2, raise: 0, raiseL: 0, raiseR: 0, sweep: 0, sweepSide: 1, fangOpen: 0, crouch: 0,
    jolt: new T.Vector3(), joltV: new T.Vector3(), lastT: null, vel: new T.Vector3(), prevPos: new T.Vector3(), yawRate: 0, prevYaw: 0,
    stuck: [],
  };

  S.reset = (x, z, yaw) => {
    root.position.set(x, 0, z); root.rotation.y = yaw; root.updateMatrixWorld(true);
    for (const l of legs) { l.foot.copy(l.rest).applyMatrix4(root.matrixWorld); l.stepping = false; }
    S.prevPos.copy(root.position); S.prevYaw = yaw; S.jolt.set(0, 0, 0); S.joltV.set(0, 0, 0); S.lastT = null;
    for (const s of S.stuck) body.remove(s); S.stuck.length = 0;
  };
  S.hit = (strength, dirLocal = new T.Vector3(0, 0.2, -1)) => { S.joltV.addScaledVector(dirLocal.clone().normalize(), strength * 3.5); };

  const tmp = new T.Vector3(), tmp2 = new T.Vector3(), hipW = new T.Vector3(), ankle = new T.Vector3(), kneeP = new T.Vector3();
  function ik(H, A, L1, L2, pole, out) {
    tmp.subVectors(A, H); let d = tmp.length();
    d = clamp(d, Math.abs(L1 - L2) + 0.02, (L1 + L2) * 0.995); tmp.normalize();
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0.0001, L1 * L1 - a * a));
    tmp2.copy(pole).addScaledVector(tmp, -pole.dot(tmp)).normalize();
    out.copy(H).addScaledVector(tmp, a).addScaledVector(tmp2, h);
    return d;
  }

  // Шаг симуляции: x,z,yaw — желаемое положение тела в момент t; mods — подъём передних лап, удар, клыки
  S.step = (t, dt, x, z, yaw, mods = {}) => {
    root.position.set(x, 0, z); root.rotation.y = yaw; root.updateMatrixWorld(true);
    S.vel.subVectors(root.position, S.prevPos).divideScalar(Math.max(dt, 1e-4)); S.prevPos.copy(root.position);
    const speed = Math.hypot(S.vel.x, S.vel.z); S.yawRate = (yaw - S.prevYaw) / Math.max(dt, 1e-4); S.prevYaw = yaw;
    S.raise = mods.raise || 0; S.sweep = mods.sweep || 0; S.sweepSide = mods.sweepSide || 1; S.fangOpen = mods.fang || 0; S.crouch = mods.crouch || 0;
    // пружина «толчка» от попаданий
    S.joltV.addScaledVector(S.jolt, -60 * dt); S.joltV.multiplyScalar(Math.exp(-7 * dt)); S.jolt.addScaledVector(S.joltV, dt);
    // тело: высота, наклон, дыхание
    const bob = Math.sin(t * 2.1) * 0.03 + (speed > 0.3 ? Math.sin(t * 16) * 0.04 * Math.min(1, speed / 4) : 0);
    body.position.set(S.jolt.x * 0.5, S.height + bob + S.raise * 0.55 - S.crouch * 0.45 + S.jolt.y * 0.4, S.jolt.z * 0.6);
    body.rotation.set(-S.raise * 0.55 + S.crouch * 0.12 + S.jolt.z * 0.25 - Math.min(0.12, speed * 0.02), Math.sin(t * 0.7) * 0.03, S.jolt.x * 0.3 - S.yawRate * 0.05);
    S.abdG.rotation.x = S.raise * 0.5 + Math.sin(t * 1.3) * 0.03; S.abdG.scale.setScalar(1 + Math.sin(t * 2.6) * 0.012);
    body.updateMatrixWorld(true);
    // походка
    const stepDur = clamp(0.36 - speed * 0.035, 0.13, 0.36), thr = speed > 0.2 ? 0.42 : 0.15;
    const des = legs.map(l => { const d = l.rest.clone().applyMatrix4(root.matrixWorld); d.addScaledVector(S.vel, stepDur * 0.7); d.y = 0; return d; });
    const groupStepping = [0, 1].map(g => legs.some(l => l.group === g && l.stepping));
    for (const g of [0, 1]) {
      if (groupStepping[g] || groupStepping[1 - g]) continue;
      const need = legs.filter(l => l.group === g).some((l, i2) => l.foot.distanceTo(des[legs.indexOf(l)]) > thr);
      const otherNeed = legs.filter(l => l.group === 1 - g).reduce((m, l) => Math.max(m, l.foot.distanceTo(des[legs.indexOf(l)])), 0);
      const mine = legs.filter(l => l.group === g).reduce((m, l) => Math.max(m, l.foot.distanceTo(des[legs.indexOf(l)])), 0);
      if (need && mine >= otherNeed) {
        for (const l of legs) if (l.group === g) { l.stepping = true; l.t0 = t; l.dur = stepDur * (0.9 + 0.2 * ((l.k * 7 + (l.side > 0 ? 3 : 0)) % 5) / 5); l.from.copy(l.foot); l.to.copy(des[legs.indexOf(l)]); }
        break;
      }
    }
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      if (l.stepping) {
        const e = clamp((t - l.t0) / l.dur);
        l.to.lerp(des[i], 0.25);
        l.foot.lerpVectors(l.from, l.to, smooth(e)); l.foot.y = Math.sin(e * Math.PI) * (0.3 + Math.min(0.4, speed * 0.05));
        if (e >= 1) { l.stepping = false; l.foot.y = 0; if (mods.onStep) mods.onStep(l.foot, speed); }
      }
    }
    // позы лап и IK
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      const foot = l.foot.clone();
      let lift = 0;
      if (l.k === 0) lift = S.raise; else if (l.k === 1) lift = S.raise * 0.35;
      if (l.k === 0 && S.sweep > 0 && l.side === S.sweepSide) lift = Math.max(lift, 1);
      if (lift > 0) {
        let tgt;
        if (l.k === 0 && S.sweep > 0 && l.side === S.sweepSide) {
          // взмах передней лапой: дуга перед телом от бока к центру
          const a = lerp(0.95, -0.35, smooth(S.sweep)) * l.side;
          tgt = new T.Vector3(Math.sin(a) * 3.4, 0.7 + Math.sin(S.sweep * Math.PI) * 0.5, 0.9 + Math.cos(a) * 3.1).applyMatrix4(root.matrixWorld);
        } else {
          const wave = Math.sin(t * 5 + l.side) * 0.35;
          tgt = new T.Vector3(l.side * (1.25 + l.k * 0.55), 0.75 + wave * 0.5 - l.k * 0.55, 2.35 - l.k * 0.6).applyMatrix4(body.matrixWorld);
        }
        foot.lerp(tgt, smooth(lift));
      }
      hipW.copy(l.hip).applyMatrix4(body.matrixWorld);
      // лапка (метатарзус): от стопы вверх и к телу
      const outH = tmp2.subVectors(foot, hipW); outH.y = 0; outH.normalize();
      const metaDir = new T.Vector3().copy(outH).multiplyScalar(-0.55).add(new T.Vector3(0, 0.82, 0)).normalize();
      if (lift > 0) metaDir.lerp(new T.Vector3().subVectors(hipW, foot).normalize().add(new T.Vector3(0, 0.35, 0)).normalize(), smooth(lift) * 0.85).normalize();
      ankle.copy(foot).addScaledVector(metaDir, l.L[2]);
      const pole = new T.Vector3().copy(outH).multiplyScalar(0.45).add(UP); if (lift > 0) pole.addScaledVector(new T.Vector3(0, 0, 1).transformDirection(root.matrixWorld), -0.4 * lift).normalize();
      ik(hipW, ankle, l.L[0], l.L[1], pole, kneeP);
      placeSegment(l.segs[0], hipW, kneeP); placeSegment(l.segs[1], kneeP, ankle); placeSegment(l.segs[2], ankle, foot);
      // сегменты построены нужной длины — масштаб не меняем
      l.joints[0].position.copy(kneeP); l.joints[1].position.copy(ankle);
    }
    // педипальпы
    for (const p of palps) {
      const a = new T.Vector3(p.s * 0.24, -0.08, 1.08).applyMatrix4(body.matrixWorld);
      const lift = 0.25 + S.fangOpen * 0.5 + Math.sin(t * 3 + p.s) * 0.06;
      const b = new T.Vector3(p.s * 0.42, 0.05 + lift * 0.35, 1.42).applyMatrix4(body.matrixWorld);
      const c = new T.Vector3(p.s * 0.48, -0.45 + lift * 0.8, 1.72).applyMatrix4(body.matrixWorld);
      b.copy(a).add(b.clone().sub(a).normalize().multiplyScalar(0.42)); c.copy(b).add(c.clone().sub(b).normalize().multiplyScalar(0.38));
      placeSegment(p.segs[0], a, b); placeSegment(p.segs[1], b, c);
    }
    for (const c of chel) { c.g.rotation.x = -S.fangOpen * 0.35 + Math.sin(t * 9) * 0.02 * S.fangOpen; c.fang.rotation.x = S.fangOpen * 0.9; c.fang.rotation.z = c.s * S.fangOpen * 0.3; }
  };

  // Воткнуть копьё в тело: worldPoint/worldDir — куда и как вошло
  S.stick = (mesh, worldPoint, worldDir) => {
    body.updateMatrixWorld(true);
    const inv = body.matrixWorld.clone().invert();
    const p = worldPoint.clone().applyMatrix4(inv);
    const q = new T.Quaternion().setFromUnitVectors(UP, worldDir.clone().normalize());
    const bq = new T.Quaternion(); body.getWorldQuaternion(bq);
    mesh.position.copy(p); mesh.quaternion.copy(bq.invert().multiply(q));
    body.add(mesh); S.stuck.push(mesh);
  };
  S.mouthWorld = () => new T.Vector3(0, -0.15, 1.3).applyMatrix4(body.matrixWorld);
  S.centerWorld = () => new T.Vector3(0, 0.1, 0).applyMatrix4(body.matrixWorld);
  return S;
}
