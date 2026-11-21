import * as T from 'three';
import { rng, tileFbm, fbm, makeTextureSet, softDot, clamp } from './util.js';

// Арена: песок, каменная стена, трибуны со зрителями, жаровни с огнём, пыль в воздухе
export function buildWorld(scene, env) {
  const R = rng(7), W = { fires: [], update: () => {} };
  const ARENA = 21;

  // ---- песок
  const sand = makeTextureSet(512,
    (x, y) => tileFbm(x / 40, y / 40, 512 / 40, 6, 0.55) * 0.7 + tileFbm(x / 6, y / 6, 512 / 6, 3, 0.5) * 0.3,
    (h, x, y) => { const v = 0.82 + h * 0.35 + (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453 % 1) * 0.04; return [196 * v, 156 * v, 108 * v]; },
    h => 0.85 + h * 0.1, 6, 9);
  const floorGeo = new T.CircleGeometry(ARENA + 0.5, 160, 0, Math.PI * 2);
  {
    // мелкий рельеф песка (следы, бугорки)
    const p = floorGeo.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i); p.setZ(i, fbm(x * 0.18, y * 0.18, 4) * 0.12 + fbm(x * 0.9, y * 0.9, 2) * 0.02); }
    floorGeo.computeVertexNormals();
  }
  const floor = new T.Mesh(floorGeo, new T.MeshStandardMaterial({ ...sand, color: 0xffffff, roughness: 1, normalScale: new T.Vector2(1.2, 1.2) }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  // Тёмные пятна и следы на песке
  {
    const c = document.createElement('canvas'); c.width = c.height = 1024; const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 260; i++) { const x = R() * 1024, y = R() * 1024, r = 8 + R() * 60; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(90,60,35,${0.15 + R() * 0.2})`); gr.addColorStop(1, 'rgba(90,60,35,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); }
    const ao = new T.CanvasTexture(c); ao.colorSpace = T.SRGBColorSpace;
    floor.material.onBeforeCompile = sh => {
      sh.uniforms.stainMap = { value: ao };
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n diffuseColor.rgb *= texture2D(stainMap, vMapUv / 9.0).rgb;').replace('void main() {', 'uniform sampler2D stainMap;\nvoid main() {');
    };
    floor.material.customProgramCacheKey = () => 'sandstain';
    // vUv нужен без repeat — используем отдельную копию через uv по умолчанию (map transform включает repeat), поэтому делим
  }

  // ---- каменные блоки стены
  const stone = makeTextureSet(256,
    (x, y) => tileFbm(x / 18, y / 18, 256 / 18, 5, 0.6) + tileFbm(x / 3, y / 3, 256 / 3, 2, 0.5) * 0.25,
    (h) => { const v = 0.7 + h * 0.45; return [150 * v, 135 * v, 115 * v]; }, h => 0.8 + h * 0.15, 5, 1);
  const stoneMat = new T.MeshStandardMaterial({ ...stone, color: 0xffffff, roughness: 1 });
  const blockGeo = new T.BoxGeometry(1, 1, 1, 2, 2, 2);
  {
    const p = blockGeo.attributes.position; for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i); const k = 1 - 0.06 * (Math.abs(x) + Math.abs(y) + Math.abs(z) > 1.2 ? 1 : 0); p.setXYZ(i, x * k, y * k, z * k); }
    blockGeo.computeVertexNormals();
  }
  const rows = 6, wallH = 5.2, bh = wallH / rows;
  const perRow = Math.round(2 * Math.PI * ARENA / 1.9);
  const blocks = new T.InstancedMesh(blockGeo, stoneMat, rows * perRow);
  const m4 = new T.Matrix4(), q = new T.Quaternion(), sc = new T.Vector3(), pos = new T.Vector3(), col = new T.Color();
  let n = 0;
  for (let r = 0; r < rows; r++) for (let i = 0; i < perRow; i++) {
    const a = (i + (r % 2) * 0.5) / perRow * Math.PI * 2, rr = ARENA + 0.45 + (R() - 0.5) * 0.06;
    pos.set(Math.cos(a) * rr, bh * (r + 0.5), Math.sin(a) * rr);
    q.setFromAxisAngle(new T.Vector3(0, 1, 0), -a + Math.PI / 2);
    sc.set(1.86 - R() * 0.1, bh * 0.95, 0.8 + R() * 0.15);
    m4.compose(pos, q, sc); blocks.setMatrixAt(n, m4);
    const v = 0.55 + R() * 0.45; col.setRGB(v, v * (0.93 + R() * 0.06), v * (0.84 + R() * 0.1)); blocks.setColorAt(n, col); n++;
  }
  blocks.castShadow = true; blocks.receiveShadow = true; scene.add(blocks);
  const backing = new T.Mesh(new T.CylinderGeometry(ARENA + 0.75, ARENA + 0.75, wallH, 120, 1, true), new T.MeshStandardMaterial({ color: 0x2a2018, roughness: 1, side: T.BackSide })); backing.position.y = wallH / 2; scene.add(backing);
  // Карниз
  const cornice = new T.Mesh(new T.TorusGeometry(ARENA + 0.55, 0.32, 8, 160), stoneMat); cornice.rotation.x = Math.PI / 2; cornice.position.y = wallH + 0.15; cornice.castShadow = true; scene.add(cornice);
  // Тёмная полоса у основания стены (влага, грязь)
  const skirt = new T.Mesh(new T.CylinderGeometry(ARENA + 0.02, ARENA + 0.02, 0.6, 160, 1, true), new T.MeshStandardMaterial({ color: 0x3b2a1e, roughness: 1, transparent: true, opacity: 0.55, side: T.BackSide }));
  skirt.position.y = 0.3; scene.add(skirt);

  // ---- ворота
  const gate = new T.Group();
  const wood = makeTextureSet(256, (x, y) => tileFbm(x / 60, y / 4, 256 / 60, 4, 0.5) + Math.sin(x / 256 * Math.PI * 2 * 8) * 0.15, h => { const v = 0.55 + h * 0.35; return [110 * v, 72 * v, 44 * v]; }, () => 0.8, 4, 1);
  const gateDoor = new T.Mesh(new T.BoxGeometry(4.2, 4.2, 0.3), new T.MeshStandardMaterial({ ...wood, color: 0xffffff }));
  gateDoor.position.y = 2.1; gate.add(gateDoor);
  for (let i = -1; i <= 1; i += 2) for (let j = 0; j < 3; j++) { const band = new T.Mesh(new T.BoxGeometry(4.3, 0.18, 0.36), new T.MeshStandardMaterial({ color: 0x2a2622, metalness: 0.9, roughness: 0.45 })); band.position.set(0, 0.6 + j * 1.5, 0.02 * i); gate.add(band); }
  const arch = new T.Mesh(new T.TorusGeometry(2.4, 0.4, 10, 24, Math.PI), stoneMat); arch.position.y = 4.2; gate.add(arch);
  gate.position.set(0, 0, -ARENA - 0.1); scene.add(gate);

  // ---- трибуны и зрители
  const tierMat = new T.MeshStandardMaterial({ ...stone, color: 0xd8cbb8, roughness: 1 });
  for (let k = 0; k < 9; k++) {
    const r0 = ARENA + 1.2 + k * 1.3;
    const tier = new T.Mesh(new T.CylinderGeometry(r0 + 1.3, r0 + 1.3, 0.9, 120, 1, true), tierMat);
    tier.position.y = wallH + 0.45 + k * 0.9; tier.material.side = T.BackSide; scene.add(tier);
    const top = new T.Mesh(new T.RingGeometry(r0, r0 + 1.3, 120), tierMat); top.rotation.x = -Math.PI / 2; top.position.y = wallH + 0.9 + k * 0.9; top.receiveShadow = true; scene.add(top);
  }
  // Зрители: тело + голова, разные цвета одежды, лёгкое покачивание
  const crowdCount = 3200;
  const bodyG = new T.CapsuleGeometry(0.22, 0.5, 3, 6); bodyG.translate(0, 0.5, 0);
  const headG = new T.SphereGeometry(0.15, 8, 6); headG.translate(0, 1.05, 0);
  const crowdMat = new T.MeshStandardMaterial({ roughness: 0.9 });
  const headMat = new T.MeshStandardMaterial({ roughness: 0.7, color: 0xb88a68 });
  const crowd = new T.InstancedMesh(bodyG, crowdMat, crowdCount), heads = new T.InstancedMesh(headG, headMat, crowdCount);
  const cloth = [0xb03a2e, 0xe8dcc0, 0x5a4a8a, 0x3b6e4a, 0xd4a03c, 0x8a5a3a, 0xf0ece4, 0x2c4a6e, 0x9a2a2a];
  const crowdData = [];
  for (let i = 0; i < crowdCount; i++) {
    const k = Math.floor(R() * 9), a = R() * Math.PI * 2, r0 = ARENA + 1.6 + k * 1.3 + R() * 0.7;
    if (Math.abs(((a + Math.PI * 2.5) % (Math.PI * 2)) - Math.PI) < 0.12) continue; // проход над воротами
    const y = wallH + 0.9 + k * 0.9, s = 0.9 + R() * 0.25;
    crowdData.push({ x: Math.cos(a) * r0, y, z: Math.sin(a) * r0, s, ph: R() * 10, amp: 0.04 + R() * 0.12, yaw: -a - Math.PI / 2 });
    col.setHex(cloth[Math.floor(R() * cloth.length)]).lerp(new T.Color(0x6a5a4a), 0.45).multiplyScalar(0.45 + R() * 0.35); crowd.setColorAt(crowdData.length - 1, col);
    col.setHex(0xb88a68).multiplyScalar(0.6 + R() * 0.6); heads.setColorAt(crowdData.length - 1, col);
  }
  crowd.count = heads.count = crowdData.length;
  scene.add(crowd, heads);
  const setCrowd = (t, excite) => {
    for (let i = 0; i < crowdData.length; i++) {
      const c = crowdData[i], j = Math.max(0, Math.sin(t * (6 + (i % 5)) + c.ph)) * c.amp * (0.3 + excite);
      pos.set(c.x, c.y + j, c.z); q.setFromAxisAngle(new T.Vector3(0, 1, 0), c.yaw); sc.setScalar(c.s); m4.compose(pos, q, sc);
      crowd.setMatrixAt(i, m4); heads.setMatrixAt(i, m4);
    }
    crowd.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = true;
  };

  // ---- колонны с жаровнями
  const metal = new T.MeshStandardMaterial({ color: 0x3a3530, metalness: 0.85, roughness: 0.4 });
  const fireTex = softDot(64);
  const fireMat = new T.SpriteMaterial({ map: fireTex, color: 0xffa040, blending: T.AdditiveBlending, depthWrite: false, transparent: true });
  const nF = 10;
  for (let i = 0; i < nF; i++) {
    const a = (i + 0.5) / nF * Math.PI * 2, r0 = ARENA - 0.9;
    const g = new T.Group(); g.position.set(Math.cos(a) * r0, 0, Math.sin(a) * r0);
    const col1 = new T.Mesh(new T.CylinderGeometry(0.32, 0.4, 2.6, 16), stoneMat); col1.position.y = 1.3; col1.castShadow = true; g.add(col1);
    const bowl = new T.Mesh(new T.LatheGeometry([new T.Vector2(0.12, 0), new T.Vector2(0.55, 0.18), new T.Vector2(0.7, 0.5), new T.Vector2(0.66, 0.52)], 24), metal);
    bowl.position.y = 2.6; g.add(bowl);
    const coals = new T.Mesh(new T.CircleGeometry(0.62, 20), new T.MeshStandardMaterial({ color: 0x220800, emissive: 0xff5a10, emissiveIntensity: 2.5 })); coals.rotation.x = -Math.PI / 2; coals.position.y = 3.05; g.add(coals);
    const light = new T.PointLight(0xff8a3a, 18, 14, 2); light.position.y = 3.6; g.add(light);
    const sprites = [];
    for (let k = 0; k < 16; k++) { const s = new T.Sprite(fireMat.clone()); g.add(s); sprites.push({ s, ph: k / 16, sx: (R() - 0.5) * 0.5, sz: (R() - 0.5) * 0.5, sp: 0.8 + R() * 0.6 }); }
    scene.add(g); W.fires.push({ g, light, sprites, seed: R() * 10 });
  }
  const setFires = t => {
    for (const f of W.fires) {
      f.light.intensity = 16 + Math.sin(t * 13 + f.seed) * 3 + Math.sin(t * 29 + f.seed * 2) * 2;
      for (const p of f.sprites) {
        const u = (t * p.sp + p.ph) % 1;
        p.s.position.set(p.sx * (1 - u) + Math.sin(t * 7 + p.ph * 20) * 0.08, 3.1 + u * 1.4, p.sz * (1 - u));
        const s = (1 - u) * 0.9 + 0.2; p.s.scale.set(s * 0.8, s, 1);
        p.s.material.opacity = Math.sin(u * Math.PI) * 0.9;
        p.s.material.color.setHSL(0.07 - u * 0.05, 1, 0.55 - u * 0.25);
      }
    }
  };

  // ---- камни и мусор на песке
  const rockGeo = new T.DodecahedronGeometry(1, 1);
  { const p = rockGeo.attributes.position; for (let i = 0; i < p.count; i++) { const v = new T.Vector3().fromBufferAttribute(p, i); v.multiplyScalar(0.75 + fbm(v.x * 2 + 3, v.y * 2 + v.z) * 0.5); v.y *= 0.6; p.setXYZ(i, v.x, v.y, v.z); } rockGeo.computeVertexNormals(); }
  const rocks = new T.InstancedMesh(rockGeo, stoneMat, 140);
  for (let i = 0; i < 140; i++) {
    const a = R() * Math.PI * 2, r0 = Math.pow(R(), 0.4) * (ARENA - 1.5), s = 0.04 + Math.pow(R(), 3) * 0.35;
    if (r0 < 6 && R() < 0.7) { i--; continue; }
    m4.compose(pos.set(Math.cos(a) * r0, s * 0.15, Math.sin(a) * r0), q.setFromEuler(new T.Euler(R() * 0.4, R() * 6, R() * 0.4)), sc.setScalar(s)); rocks.setMatrixAt(i, m4);
    col.setScalar(0.6 + R() * 0.3); rocks.setColorAt(i, col);
  }
  rocks.castShadow = rocks.receiveShadow = true; scene.add(rocks);

  // ---- пыль в воздухе (ловит свет)
  const dustN = 900, dg = new T.BufferGeometry(), dp = new Float32Array(dustN * 3), dseed = [];
  for (let i = 0; i < dustN; i++) dseed.push([R() * 40 - 20, R() * 7, R() * 40 - 20, R() * 10]);
  dg.setAttribute('position', new T.BufferAttribute(dp, 3));
  const dust = new T.Points(dg, new T.PointsMaterial({ size: 0.05, map: softDot(32), color: 0xffe2b0, transparent: true, opacity: 0.55, depthWrite: false, blending: T.AdditiveBlending }));
  scene.add(dust);
  const setDust = t => { for (let i = 0; i < dustN; i++) { const s = dseed[i]; dp[i * 3] = s[0] + Math.sin(t * 0.2 + s[3]) * 0.8; dp[i * 3 + 1] = (s[1] + t * 0.05 + Math.sin(t * 0.3 + s[3]) * 0.3) % 7; dp[i * 3 + 2] = s[2] + Math.cos(t * 0.17 + s[3]) * 0.8; } dg.attributes.position.needsUpdate = true; };

  W.update = (t, excite = 0.3) => { setFires(t); setCrowd(t, excite); setDust(t); };
  W.ARENA = ARENA;
  return W;
}

// Облака пыли от ударов и шагов: частицы, время жизни ~1.5 с
export function makeDustFX(scene) {
  const N = 600, g = new T.BufferGeometry(), p = new Float32Array(N * 3), a = new Float32Array(N), s = new Float32Array(N);
  g.setAttribute('position', new T.BufferAttribute(p, 3)); g.setAttribute('alpha', new T.BufferAttribute(a, 1)); g.setAttribute('size', new T.BufferAttribute(s, 1));
  const mat = new T.ShaderMaterial({
    uniforms: { map: { value: softDot(64) }, color: { value: new T.Color(0xcaa47a) } },
    vertexShader: 'attribute float alpha; attribute float size; varying float vA; void main(){ vA=alpha; vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=size*600./-mv.z; gl_Position=projectionMatrix*mv; }',
    fragmentShader: 'uniform sampler2D map; uniform vec3 color; varying float vA; void main(){ vec4 t=texture2D(map,gl_PointCoord); gl_FragColor=vec4(color, t.a*vA); }',
    transparent: true, depthWrite: false,
  });
  const pts = new T.Points(g, mat); pts.frustumCulled = false; scene.add(pts);
  const bursts = []; // {t0, x, y, z, n, power, seed}
  const R = rng(99);
  return {
    burst(t0, x, y, z, nn = 40, power = 1) { bursts.push({ t0, x, y, z, n: nn, power, seed: Math.floor(R() * 1e6) }); },
    reset() { bursts.length = 0; },
    update(t) {
      let k = 0;
      for (const b of bursts) {
        const age = t - b.t0; if (age < 0 || age > 2.2) continue;
        const r = rng(b.seed);
        for (let i = 0; i < b.n && k < N; i++, k++) {
          const ang = r() * Math.PI * 2, sp = (0.6 + r() * 1.6) * b.power, up = r() * 0.8 * b.power;
          const e = 1 - Math.exp(-age * 2.2);
          p[k * 3] = b.x + Math.cos(ang) * sp * e; p[k * 3 + 1] = b.y + 0.1 + up * e + age * 0.15; p[k * 3 + 2] = b.z + Math.sin(ang) * sp * e;
          a[k] = clamp(1 - age / 2.2) * 0.35 * (0.5 + r() * 0.5); s[k] = (0.4 + r() * 0.6) * (0.5 + age * 0.9) * b.power;
        }
      }
      for (; k < N; k++) a[k] = 0;
      g.attributes.position.needsUpdate = g.attributes.alpha.needsUpdate = g.attributes.size.needsUpdate = true;
    },
  };
}
