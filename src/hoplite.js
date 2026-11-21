import * as T from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { clamp, smooth, lerp } from './util.js';

// Гоплиты: манекен Quaternius (CC0) с мокап-анимациями + бронзовый шлем, панцирь, щит, копьё, плащ
const UP = new T.Vector3(0, 1, 0);

function bronzeTex(emblem, hue) {
  const c = document.createElement('canvas'); c.width = c.height = 512; const g = c.getContext('2d');
  const gr = g.createRadialGradient(256, 230, 20, 256, 256, 260); gr.addColorStop(0, '#e0b060'); gr.addColorStop(0.7, '#b07a34'); gr.addColorStop(1, '#7a5222');
  g.fillStyle = gr; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2500; i++) { g.fillStyle = `rgba(${Math.random() < 0.5 ? '60,35,10' : '255,230,170'},${Math.random() * 0.06})`; g.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 10, 1 + Math.random() * 2); }
  // нарисованная эмблема
  g.save(); g.translate(256, 256);
  g.fillStyle = hue; g.beginPath(); g.arc(0, 0, 200, 0, Math.PI * 2); g.fill();
  g.globalAlpha = 0.9; g.fillStyle = '#1a1210'; g.font = 'bold 300px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(emblem, 0, 18);
  g.restore();
  // ободок
  g.strokeStyle = '#6a4418'; g.lineWidth = 14; g.beginPath(); g.arc(256, 256, 214, 0, Math.PI * 2); g.stroke();
  const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
}
function emblemRough() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  g.fillStyle = '#555'; g.fillRect(0, 0, 256, 256); g.fillStyle = '#e8e8e8'; g.beginPath(); g.arc(128, 128, 100, 0, Math.PI * 2); g.fill();
  return new T.CanvasTexture(c);
}

export function makeArmory() {
  const bronze = new T.MeshPhysicalMaterial({ color: 0xc08a48, metalness: 1, roughness: 0.26, clearcoat: 0.3, envMapIntensity: 1.4 });
  const iron = new T.MeshStandardMaterial({ color: 0xb8bcc0, metalness: 1, roughness: 0.22, envMapIntensity: 1.5 });
  const woodC = document.createElement('canvas'); woodC.width = 64; woodC.height = 512; { const g = woodC.getContext('2d'); g.fillStyle = '#7a5532'; g.fillRect(0, 0, 64, 512); for (let i = 0; i < 90; i++) { g.strokeStyle = `rgba(${Math.random() < 0.5 ? '40,25,12' : '160,120,80'},0.35)`; g.beginPath(); const x = Math.random() * 64; g.moveTo(x, 0); g.lineTo(x + Math.random() * 6 - 3, 512); g.stroke(); } }
  const woodT = new T.CanvasTexture(woodC); woodT.colorSpace = T.SRGBColorSpace;
  const wood = new T.MeshStandardMaterial({ map: woodT, roughness: 0.7 });
  const red = new T.MeshStandardMaterial({ color: 0x8a1712, roughness: 0.85, side: T.DoubleSide, sheen: 1 });
  const leather = new T.MeshStandardMaterial({ color: 0x5a3820, roughness: 0.75, side: T.DoubleSide });
  const skin = new T.MeshStandardMaterial({ color: 0xa8714c, roughness: 0.55 });
  return { bronze, iron, wood, red, leather, skin };
}

// Копьё (дори): древко 2.6 м, железный наконечник, бронзовый подток. Ось +Y, 0 = хват
export function makeSpear(A, grip = 1.0) {
  const g = new T.Group();
  const shaft = new T.Mesh(new T.CylinderGeometry(0.017, 0.02, 2.5, 8), A.wood); shaft.position.y = 1.25 - grip; g.add(shaft);
  const tipG = new T.LatheGeometry([new T.Vector2(0.015, 0), new T.Vector2(0.03, 0.03), new T.Vector2(0.045, 0.12), new T.Vector2(0.03, 0.24), new T.Vector2(0, 0.32)], 4);
  tipG.scale(1, 1, 0.3);
  const tip = new T.Mesh(tipG, A.iron); tip.position.y = 2.5 - grip; g.add(tip);
  const butt = new T.Mesh(new T.ConeGeometry(0.022, 0.22, 8), A.bronze); butt.rotation.x = Math.PI; butt.position.y = -grip - 0.1; g.add(butt);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  g.userData.tipOffset = 2.5 - grip + 0.3;
  return g;
}
export function makeSword(A) {
  const g = new T.Group();
  const sh = new T.Shape(); sh.moveTo(-0.025, 0); sh.quadraticCurveTo(-0.05, 0.3, -0.03, 0.5); sh.lineTo(0, 0.6); sh.lineTo(0.03, 0.5); sh.quadraticCurveTo(0.05, 0.3, 0.025, 0); sh.closePath();
  const blade = new T.Mesh(new T.ExtrudeGeometry(sh, { depth: 0.008, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.004, bevelSegments: 1 }), A.iron); blade.position.set(0, 0.06, -0.004); g.add(blade);
  const guard = new T.Mesh(new T.BoxGeometry(0.12, 0.02, 0.03), A.bronze); guard.position.y = 0.05; g.add(guard);
  const hilt = new T.Mesh(new T.CylinderGeometry(0.014, 0.014, 0.11, 8), A.leather); g.add(hilt);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}
// Щит (аспис): выпуклый диск с нарисованной эмблемой, бронзовый обод, деревянная тыльная сторона
export function makeShield(A, emblem, hue) {
  const g = new T.Group(), Rr = 0.46, D = 0.1;
  const front = new T.CircleGeometry(Rr, 64, 0, Math.PI * 2); front.attributes.position.count;
  { const p = front.attributes.position; for (let i = 0; i < p.count; i++) { const r = Math.hypot(p.getX(i), p.getY(i)) / Rr; p.setZ(i, D * (1 - r * r)); } front.computeVertexNormals(); }
  const fm = new T.Mesh(front, new T.MeshPhysicalMaterial({ map: bronzeTex(emblem, hue), metalness: 0.85, roughness: 0.3, roughnessMap: emblemRough(), clearcoat: 0.4, envMapIntensity: 1.5 }));
  g.add(fm);
  const back = new T.Mesh(front.clone(), A.wood); back.rotation.y = Math.PI; back.scale.z = 0.6; back.position.z = 0.0; g.add(back);
  const rim = new T.Mesh(new T.TorusGeometry(Rr, 0.025, 8, 64), A.bronze); g.add(rim);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g; // нормаль лицевой стороны: +Z
}
function makeHelmet(A) {
  const g = new T.Group();
  // коринфский шлем: купол с Т-образным вырезом для глаз и рта
  const prof = [[0.118, -0.16], [0.125, -0.1], [0.132, -0.02], [0.13, 0.05], [0.118, 0.11], [0.085, 0.155], [0.04, 0.175], [0.0, 0.18]].map(([r, y]) => new T.Vector2(r, y));
  const geo = new T.LatheGeometry(prof, 48);
  const c = document.createElement('canvas'); c.width = 512; c.height = 256; const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 512, 256); ctx.fillStyle = '#000';
  // u=0 и u=1 — передняя сторона (lathe начинается с +Z)
  for (const off of [0, 512]) { ctx.fillRect(off - 46, 256 * (1 - 0.55), 92, 22); ctx.fillRect(off - 11, 256 * (1 - 0.55), 22, 256 * 0.55); }
  const alpha = new T.CanvasTexture(c);
  const helm = new T.Mesh(geo, new T.MeshPhysicalMaterial({ color: 0xc08a48, metalness: 1, roughness: 0.24, alphaMap: alpha, alphaTest: 0.5, side: T.DoubleSide, envMapIntensity: 1.5, clearcoat: 0.4 }));
  helm.castShadow = true; g.add(helm);
  // гребень из конского волоса
  const cs = new T.Shape(); cs.moveTo(-0.2, 0.0); cs.quadraticCurveTo(-0.18, 0.24, 0.05, 0.22); cs.quadraticCurveTo(0.2, 0.2, 0.22, 0.04); cs.lineTo(0.15, 0.0); cs.quadraticCurveTo(0.05, 0.12, -0.12, 0.0); cs.closePath();
  const crestG = new T.ExtrudeGeometry(cs, { depth: 0.035, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.01, bevelSegments: 2, curveSegments: 16 });
  crestG.translate(0, 0, -0.0175); crestG.rotateY(Math.PI / 2);
  const crest = new T.Mesh(crestG, new T.MeshStandardMaterial({ color: 0x9a1810, roughness: 0.95 })); crest.position.y = 0.16; crest.castShadow = true; g.add(crest);
  const holder = new T.Mesh(new T.BoxGeometry(0.03, 0.05, 0.2), A.bronze); holder.position.y = 0.17; g.add(holder);
  return g;
}

export async function loadHoplites(scene, loader, A, count = 5) {
  const [g1, g2] = await Promise.all([loader.loadAsync('/assets/UAL1_Standard.glb'), loader.loadAsync('/assets/UAL2_Standard.glb')]);
  const clips = {}; for (const c of [...g1.animations, ...g2.animations]) clips[c.name] = c;
  const armBones = /(clavicle_l|upperarm_l|lowerarm_l|hand_l|_0\d_l|_04_leaf_l)$/;
  const cut = (clip, keepArm) => { const c = clip.clone(); c.tracks = c.tracks.filter(tr => armBones.test(tr.name.split('.')[0]) === keepArm); c.name = clip.name + (keepArm ? '_arm' : '_noarm'); return c; };
  clips.ShieldArm = cut(clips.Idle_Shield_Loop, true);
  for (const n of ['Walk_Loop', 'Jog_Fwd_Loop', 'Sword_Idle', 'Idle_Loop', 'Punch_Jab', 'Sword_Attack']) clips[n + '_noarm'] = cut(clips[n], false);
  const emblems = [['Λ', '#7a1a14'], ['Ψ', '#1f3a5a'], ['Ω', '#7a1a14'], ['Σ', '#2a4a2a'], ['Δ', '#1f3a5a']];
  const men = [];
  for (let i = 0; i < count; i++) {
    const root = SkeletonUtils.clone(g1.scene);
    root.traverse(o => {
      if (o.isSkinnedMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; o.material = A.skin; }
    });
    scene.add(root); root.updateMatrixWorld(true);
    const bone = n => root.getObjectByName(n);
    const B = { head: bone('Head'), spine: bone('spine_03'), spine2: bone('spine_02'), pelvis: bone('pelvis'), handR: bone('hand_r'), lowR: bone('lowerarm_r'), handL: bone('hand_l'), lowL: bone('lowerarm_l'), calfL: bone('calf_l'), calfR: bone('calf_r'), thighL: bone('thigh_l'), thighR: bone('thigh_r') };
    const wp = o => o.getWorldPosition(new T.Vector3());
    // Снаряжение крепим в позе покоя (T-поза, лицом к +Z): ставим в мир и привязываем к кости
    const put = (b, mesh, pos, rot) => { mesh.position.copy(pos); if (rot) mesh.rotation.copy(rot); scene.add(mesh); mesh.updateMatrixWorld(true); b.attach(mesh); };
    const headP = wp(B.head);
    put(B.head, makeHelmet(A), new T.Vector3(0, headP.y + 0.085, 0.012));
    // панцирь
    const cuirG = new T.LatheGeometry([[0.0, -0.3], [0.15, -0.3], [0.165, -0.2], [0.18, -0.05], [0.19, 0.08], [0.175, 0.17], [0.11, 0.22], [0.06, 0.23]].map(([r, y]) => new T.Vector2(r, y)), 32);
    cuirG.scale(1.12, 1, 0.78);
    const cuir = new T.Mesh(cuirG, A.bronze); cuir.castShadow = true;
    const spP = wp(B.spine); put(B.spine, cuir, new T.Vector3(0, spP.y - 0.02, 0.0));
    // туника и птеруги
    const tunic = new T.Mesh(new T.CylinderGeometry(0.19, 0.26, 0.34, 24, 1, true), A.red); tunic.castShadow = true;
    const peP = wp(B.pelvis); put(B.pelvis, tunic, new T.Vector3(0, peP.y - 0.06, 0));
    const ptG = new T.CylinderGeometry(0.205, 0.24, 0.22, 28, 1, true);
    const ptc = document.createElement('canvas'); ptc.width = 256; ptc.height = 16; { const x = ptc.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 256, 16); x.fillStyle = '#fff'; for (let k = 0; k < 28; k++) x.fillRect(k * 256 / 28 + 1, 0, 256 / 28 - 2, 16); }
    const pter = new T.Mesh(ptG, new T.MeshStandardMaterial({ color: 0x6a4424, roughness: 0.8, alphaMap: new T.CanvasTexture(ptc), alphaTest: 0.5, side: T.DoubleSide })); pter.castShadow = true;
    put(B.pelvis, pter, new T.Vector3(0, peP.y + 0.02, 0));
    // поножи
    for (const [c, s] of [[B.calfL, 1], [B.calfR, -1]]) {
      const cp = wp(c);
      const gr = new T.Mesh(new T.LatheGeometry([[0.05, -0.2], [0.062, -0.12], [0.068, 0.0], [0.06, 0.12], [0.052, 0.16]].map(([r, y]) => new T.Vector2(r, y)), 20, -Math.PI * 0.55, Math.PI * 1.1), new T.MeshPhysicalMaterial({ color: 0xc08a48, metalness: 1, roughness: 0.3, side: T.DoubleSide, envMapIntensity: 1.4 }));
      gr.castShadow = true; put(c, gr, new T.Vector3(cp.x, cp.y - 0.2, cp.z + 0.01));
    }
    // плащ
    const capeG = new T.PlaneGeometry(0.5, 0.95, 6, 10); capeG.translate(0, -0.475, 0);
    { const p = capeG.attributes.position; for (let k = 0; k < p.count; k++) { const x = p.getX(k), y = p.getY(k); p.setZ(k, -Math.abs(x) * 0.35 - y * y * 0.05 + Math.sin(x * 18) * 0.012); p.setX(k, x * (1 - y * 0.4)); } capeG.computeVertexNormals(); }
    const cape = new T.Mesh(capeG, A.red); cape.castShadow = true;
    put(B.spine, cape, new T.Vector3(0, spP.y + 0.18, -0.16));
    // оружие и щит — позиционируются каждый кадр
    const spear = makeSpear(A, 0.95); scene.add(spear);
    const shield = makeShield(A, emblems[i][0], emblems[i][1]); scene.add(shield);
    const sword = makeSword(A); sword.visible = false; scene.add(sword);
    // кокон паутины
    const cocoon = makeCocoon(); cocoon.visible = false; scene.add(cocoon);
    // запоминаем «покой» костей для расчёта направлений
    const restQ = {}; for (const [k, b] of Object.entries(B)) restQ[k] = b.getWorldQuaternion(new T.Quaternion()).invert();
    const mixer = new T.AnimationMixer(root);
    const actions = {};
    for (const [n, c] of Object.entries(clips)) { const a = mixer.clipAction(c); a.play(); a.setEffectiveWeight(0); actions[n] = a; }
    men.push({ i, root, B, restQ, mixer, actions, spear, shield, sword, cape, cocoon, tl: [], path: [], spearState: [], fx: {} });
  }
  return { men, clips };
}

function makeCocoon() {
  const g = new T.SphereGeometry(0.46, 40, 30); g.scale(1, 2.3, 0.9); g.translate(0, 1.0, 0);
  { const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const y = p.getY(i), a = Math.atan2(p.getZ(i), p.getX(i)); const k = 1 + 0.06 * Math.sin(a * 3 + y * 9) + 0.04 * Math.sin(y * 23); p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k); } g.computeVertexNormals(); }
  const c = document.createElement('canvas'); c.width = 512; c.height = 512; const x = c.getContext('2d');
  x.fillStyle = '#bdb8ac'; x.fillRect(0, 0, 512, 512); for (let k = 0; k < 120; k++) { x.fillStyle = `rgba(90,85,75,${Math.random() * 0.25})`; x.fillRect(0, Math.random() * 512, 512, 2 + Math.random() * 8); }
  for (let k = 0; k < 700; k++) { x.strokeStyle = `rgba(255,255,255,${0.2 + Math.random() * 0.5})`; x.lineWidth = 0.5 + Math.random() * 2; x.beginPath(); const y0 = Math.random() * 512; x.moveTo(0, y0); x.bezierCurveTo(170, y0 + Math.random() * 80 - 40, 340, y0 + Math.random() * 80 - 40, 512, y0 + Math.random() * 60 - 30); x.stroke(); }
  const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace;
  const nm = new T.CanvasTexture(c); const m = new T.Mesh(g, new T.MeshPhysicalMaterial({ map: t, bumpMap: nm, bumpScale: 3, roughness: 0.6, sheen: 1, sheenColor: new T.Color(0xffffff), sheenRoughness: 0.3, transparent: true, opacity: 1 }));
  m.castShadow = true; return m;
}

// Поза бойца в момент t — чистая функция от расписания действий (можно перематывать в любую сторону)
const _q = new T.Quaternion(), _v = new T.Vector3(), _v2 = new T.Vector3();
export function boneDir(man, key, local) { const b = man.B[key]; b.getWorldQuaternion(_q); return local.clone().applyQuaternion(_q.multiply(man.restQ[key])); }

export function poseMan(man, t) {
  // действия: [{t0, clip, loop, speed, fade, arm (щит в руке), from}]
  const tl = man.tl; let ci = -1; for (let k = 0; k < tl.length; k++) if (tl[k].t0 <= t) ci = k;
  for (const a of Object.values(man.actions)) a.setEffectiveWeight(0);
  const apply = (ac, w) => {
    if (!ac || w <= 0) return;
    const clipName = ac.arm ? ac.clip + '_noarm' : ac.clip;
    const a = man.actions[clipName] || man.actions[ac.clip]; const d = a.getClip().duration;
    let tt = (t - ac.t0) * (ac.speed || 1) + (ac.from || 0);
    tt = ac.loop ? ((tt % d) + d) % d : clamp(tt, 0, d - 0.001);
    a.time = tt; a.setEffectiveWeight(a.getEffectiveWeight() + w);
    if (ac.arm) { const s = man.actions.ShieldArm; s.time = (t * 0.9) % s.getClip().duration; s.setEffectiveWeight(s.getEffectiveWeight() + w); }
  };
  if (ci >= 0) {
    const cur = tl[ci], w = ci > 0 ? clamp((t - cur.t0) / (cur.fade ?? 0.25)) : 1;
    apply(cur, w); if (ci > 0 && w < 1) apply(tl[ci - 1], 1 - w);
  }
  man.mixer.update(0);
  // положение и поворот корня по ключам пути
  const P = man.path; let k = 0; while (k < P.length - 1 && P[k + 1].t <= t) k++;
  const a = P[k], b = P[Math.min(k + 1, P.length - 1)];
  const u = b.t > a.t ? (b.ease === 'lin' ? clamp((t - a.t) / (b.t - a.t)) : smooth((t - a.t) / (b.t - a.t))) : 0;
  const x = lerp(a.x, b.x, t >= b.t ? 1 : u), z = lerp(a.z, b.z, t >= b.t ? 1 : u);
  const arc = b.arc && t < b.t && t > a.t ? Math.sin(u * Math.PI) * b.arc : 0;
  man.root.position.set(x, arc, z);
  man.root.rotation.set(0, lerp(a.yaw, b.yaw, t >= b.t ? 1 : u), 0);
  const fall = man.fx.fallAt != null ? smooth((t - man.fx.fallAt) / 0.7) : 0; // падение в коконе
  man.root.rotation.x = fall * -1.45 * (man.fx.fallDir || 1);
  if (fall > 0) man.root.position.y += Math.sin(fall * Math.PI) * 0.1;
  man.root.updateMatrixWorld(true);
}
