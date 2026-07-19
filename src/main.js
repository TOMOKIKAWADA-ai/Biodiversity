// ============================================================
// 小さな流域 — 生物多様性ジオラマ
// 川のある小さな土地で、季節がめぐり、植物が育ち、
// 虫・魚・鳥が暮らし、外来種と保護のせめぎ合いを眺める仮想自然空間。
//
// 構成:
//   1. 乱数・ノイズ / 定数
//   2. 季節
//   3. 地形・環境(川、距離場、高さ)
//   4. シーン(光、地形、水面、雲)
//   5. シミュレーション状態と1日ごとの更新
//   6. 指標計算
//   7. 植物の描画(在来種 + アレチウリ)
//   8. 虫 / 魚 / 鳥(捕食)
//   9. 希少種
//  10. 人為的保護(保護・駆除)
//  11. UI と視点モード
// ============================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------- 乱数・ノイズ ----------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TERRAIN_SEED = 20260610;
const rng = mulberry32(TERRAIN_SEED);

function hash2(ix, iz) {
  let h = (ix * 374761393 + iz * 668265263) ^ 0x5bf03635;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t) { return t * t * (3 - 2 * t); }

function valueNoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  const u = smooth(fx), v = smooth(fz);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, z) {
  let sum = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < 4; i++) {
    sum += amp * valueNoise(x * freq, z * freq);
    amp *= 0.5; freq *= 2.1;
  }
  return sum; // おおよそ 0..1
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------- 定数 ----------------

const WORLD = 56;                 // 地形の一辺
const HALF = WORLD / 2;
const GRID = 64;                  // シミュレーション格子
const CELL = WORLD / GRID;
const TERR_SEG = 128;             // 地形メッシュ分割数
const WATER_Y = -0.35;
const RIVER_W = 2.0;
const TICK_SEC = 0.45;            // 1ティック(=1日)の実時間

const BIOME = { WATER: 0, WETLAND: 1, BARE: 2, GRASS: 3, SHRUB: 4, FOREST: 5, VINE: 6 };
const NATIVE_BIOME_COUNT = 6;     // 多様性に数えるのは在来の環境タイプのみ

// ---------------- 季節 ----------------

const SEASONS = ['春', '夏', '秋', '冬'];
const DAYS_PER_SEASON = 30;
const YEAR_DAYS = DAYS_PER_SEASON * 4;

// 季節ごとのパラメータ(数値と色)。隣り合う季節は季節末でなめらかにブレンドする
const SEASON_PARAMS = [
  { // 春
    growth: 1.25, insectF: 1.0, birdF: 1.0, fishF: 1.0,
    sun: '#fff2dc', sunI: 1.9, fog: '#ccdcd2',
    grass: '#ffffff', reed: '#ffffff', tree: '#ffffff', shrub: '#ffffff',
    terrGrass: '#7da45a', terrWet: '#55815c', terrForest: '#5e7242',
  },
  { // 夏
    growth: 1.1, insectF: 1.15, birdF: 1.0, fishF: 1.1,
    sun: '#fff8e8', sunI: 2.0, fog: '#cfe2d0',
    grass: '#f0f8dd', reed: '#f3f7de', tree: '#f2f9e6', shrub: '#f2f9e6',
    terrGrass: '#6f9c50', terrWet: '#4f7d57', terrForest: '#56703c',
  },
  { // 秋
    growth: 0.55, insectF: 0.55, birdF: 0.8, fishF: 0.8,
    sun: '#ffe7c2', sunI: 1.7, fog: '#d8d3c0',
    grass: '#e6d3a0', reed: '#dec594', tree: '#e8cf9e', shrub: '#e3cf9e',
    terrGrass: '#a89a58', terrWet: '#6e7e50', terrForest: '#7c7444',
  },
  { // 冬
    growth: 0.12, insectF: 0.1, birdF: 0.5, fishF: 0.55,
    sun: '#eef2f8', sunI: 1.45, fog: '#d6dce0',
    grass: '#d6c9a4', reed: '#cdb98c', tree: '#dfe3d2', shrub: '#d9ddc8',
    terrGrass: '#9c916c', terrWet: '#6f7763', terrForest: '#616a4c',
  },
];
// 文字列カラーを Color に変換しておく
for (const p of SEASON_PARAMS) {
  for (const k of ['sun', 'fog', 'grass', 'reed', 'tree', 'shrub', 'terrGrass', 'terrWet', 'terrForest']) {
    p[k] = new THREE.Color(p[k]);
  }
}

// 現在の季節状態(毎フレーム更新)
const seasonNow = {
  idx: 0, name: '春',
  growth: 1, insectF: 1, birdF: 1, fishF: 1, sunI: 1.9,
  sun: new THREE.Color(), fog: new THREE.Color(),
  grass: new THREE.Color(), reed: new THREE.Color(),
  tree: new THREE.Color(), shrub: new THREE.Color(),
  terrGrass: new THREE.Color(), terrWet: new THREE.Color(), terrForest: new THREE.Color(),
};

function updateSeason(days) {
  const yp = ((days % YEAR_DAYS) + YEAR_DAYS) % YEAR_DAYS / DAYS_PER_SEASON; // 0..4
  const idx = Math.floor(yp) % 4;
  const f = yp - Math.floor(yp);
  const next = (idx + 1) % 4;
  const t = smoothstep(0.72, 1, f); // 季節の終わりにかけて次の季節へ移る
  const a = SEASON_PARAMS[idx], b = SEASON_PARAMS[next];
  seasonNow.idx = idx;
  seasonNow.name = SEASONS[idx];
  for (const k of ['growth', 'insectF', 'birdF', 'fishF', 'sunI']) {
    seasonNow[k] = lerp(a[k], b[k], t);
  }
  for (const k of ['sun', 'fog', 'grass', 'reed', 'tree', 'shrub', 'terrGrass', 'terrWet', 'terrForest']) {
    seasonNow[k].lerpColors(a[k], b[k], t);
  }
}

// ---------------- 川の中心線 ----------------

const riverPhase1 = rng() * Math.PI * 2;
const riverPhase2 = rng() * Math.PI * 2;

function riverX(z) {
  return Math.sin(z * 0.10 + riverPhase1) * 6.5
    + Math.sin(z * 0.27 + riverPhase2) * 2.4
    + Math.sin(z * 0.052 + 1.3) * 3.0;
}

// 中心線サンプル(距離場の計算用)
const riverSamples = [];
for (let i = 0; i <= 260; i++) {
  const z = -HALF - 4 + (WORLD + 8) * (i / 260);
  riverSamples.push([riverX(z), z]);
}

// 距離場(粗い格子 + バイリニア補間)
const DGRID = 96;
const distField = new Float32Array((DGRID + 1) * (DGRID + 1));
for (let j = 0; j <= DGRID; j++) {
  for (let i = 0; i <= DGRID; i++) {
    const x = -HALF + WORLD * (i / DGRID);
    const z = -HALF + WORLD * (j / DGRID);
    let best = 1e9;
    for (let s = 0; s < riverSamples.length; s++) {
      const dx = x - riverSamples[s][0];
      const dz = z - riverSamples[s][1];
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    distField[j * (DGRID + 1) + i] = Math.sqrt(best);
  }
}

function riverDist(x, z) {
  const fx = clamp((x + HALF) / WORLD, 0, 1) * DGRID;
  const fz = clamp((z + HALF) / WORLD, 0, 1) * DGRID;
  const ix = Math.min(Math.floor(fx), DGRID - 1);
  const iz = Math.min(Math.floor(fz), DGRID - 1);
  const tx = fx - ix, tz = fz - iz;
  const w = DGRID + 1;
  const a = distField[iz * w + ix], b = distField[iz * w + ix + 1];
  const c = distField[(iz + 1) * w + ix], d = distField[(iz + 1) * w + ix + 1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

// ---------------- 地形の高さ ----------------

function terrainHeight(x, z) {
  const d = riverDist(x, z);
  let h = fbm(x * 0.055 + 13.7, z * 0.055 + 7.1) * 2.6 - 0.55;
  h += smoothstep(3, 20, d) * 1.25;                      // 川から離れると高くなる
  h += fbm(x * 0.16 + 4.2, z * 0.16 + 9.9) * 0.5 - 0.25; // 細かな起伏
  const bed = -1.1 + fbm(x * 0.3, z * 0.3) * 0.15;
  const carve = smoothstep(RIVER_W * 2.6, RIVER_W * 0.7, d);
  h = lerp(h, bed, carve);
  return h;
}

// ---------------- シーンの基本 ----------------

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();

// 空のグラデーション
function makeSkyTexture(top, bottom) {
  const cv = document.createElement('canvas');
  cv.width = 2; cv.height = 256;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
scene.background = makeSkyTexture('#a8c8cf', '#e6ead4');
scene.fog = new THREE.Fog(0xccdcd2, 60, 150);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 400);
// 縦長画面(スマホ)では少し引いて全体が見えるようにする
const viewFactor = clamp(window.innerHeight / window.innerWidth, 1, 1.5);
const HOME_POS = new THREE.Vector3(40 * viewFactor, 36 * viewFactor, 52 * viewFactor);
const HOME_TARGET = new THREE.Vector3(0, -0.5, 0);
camera.position.copy(HOME_POS);

const controls = new OrbitControls(camera, canvas);
controls.target.copy(HOME_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 10;
controls.maxDistance = 140;
controls.maxPolarAngle = 1.42;
controls.enablePan = false;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.32;
controls.addEventListener('start', () => { controls.autoRotate = false; });

// ---------------- 光 ----------------

const hemi = new THREE.HemisphereLight(0xd8e8f0, 0x7a6a4e, 0.85);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff4e2, 1.9);
sun.position.set(30, 40, 16);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -36;
sun.shadow.camera.right = 36;
sun.shadow.camera.top = 36;
sun.shadow.camera.bottom = -36;
sun.shadow.camera.near = 5;
sun.shadow.camera.far = 110;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.02;
scene.add(sun);
scene.add(sun.target);

const fillLight = new THREE.DirectionalLight(0xbcd4e8, 0.35);
fillLight.position.set(-24, 18, -20);
scene.add(fillLight);

// ---------------- 地形メッシュ ----------------

const terrGeo = new THREE.PlaneGeometry(WORLD, WORLD, TERR_SEG, TERR_SEG);
terrGeo.rotateX(-Math.PI / 2);
{
  const pos = terrGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  }
  terrGeo.computeVertexNormals();
}
const terrColors = new Float32Array(terrGeo.attributes.position.count * 3);
terrGeo.setAttribute('color', new THREE.BufferAttribute(terrColors, 3));

const terrMat = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.95, metalness: 0,
});
const terrain = new THREE.Mesh(terrGeo, terrMat);
terrain.receiveShadow = true;
terrain.castShadow = false;
scene.add(terrain);

// ---------------- 円状カーソル(範囲限定の操作) ----------------
// 駆除・植栽をこのリングの内側だけに効かせる。半径はワールド単位。
// 局所パッチ。調整はこの定数だけ変えれば見た目も効果範囲も同時に変わる。
const CURSOR_RADIUS = 6;                 // ワールド単位の作用半径(= リングの見た目の半径)

// 地面に寝かせる薄いリング(RingGeometry を水平に)。控えめな半透明。
const cursorGeo = new THREE.RingGeometry(CURSOR_RADIUS - 0.35, CURSOR_RADIUS, 64);
cursorGeo.rotateX(-Math.PI / 2);
const cursorMat = new THREE.MeshBasicMaterial({
  color: 0xdff0e2, transparent: true, opacity: 0.5,
  depthWrite: false, side: THREE.DoubleSide,
});
const cursorRing = new THREE.Mesh(cursorGeo, cursorMat);
cursorRing.renderOrder = 5;
scene.add(cursorRing);

// 最後の有効なカーソル位置(常に有効。初期はワールド中央の地表)。
const cursorPos = new THREE.Vector3(0, terrainHeight(0, 0), 0);
cursorRing.position.copy(cursorPos);
cursorRing.position.y += 0.05;
let cursorSelected = false;

// レイキャスト(canvas ポインタ → NDC → terrain との交点)
const cursorRaycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
let orbitDragging = false;   // OrbitControls のドラッグ(回転)中は追従を止める

// OrbitControls のドラッグ開始/終了でフラグ管理(ホバー追従と回転を両立)
controls.addEventListener('start', () => { orbitDragging = true; });
controls.addEventListener('end', () => { orbitDragging = false; });

function updateCursorFromPointer(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  pointerNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  cursorRaycaster.setFromCamera(pointerNDC, camera);
  const hit = cursorRaycaster.intersectObject(terrain, false);
  if (hit.length > 0) {
    cursorPos.copy(hit[0].point);
    return true;
  }
  return false;
}

// PC(マウス):ホバーで追従。ただし回転ドラッグ中はスキップ。
let pointerDownPos = null;
const activePointers = new Set();
let multiTouchGesture = false;
// タッチ:指を置いた/動かした場所にリングを出す(適用はボタンなので回転と競合しない)。
canvas.addEventListener('pointerdown', (e) => {
  if (viewMode !== 'observe') return;
  activePointers.add(e.pointerId);
  if (activePointers.size > 1) multiTouchGesture = true;
  pointerDownPos = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', (e) => {
  activePointers.delete(e.pointerId);
  if (viewMode !== 'observe' || !pointerDownPos) {
    if (activePointers.size === 0) multiTouchGesture = false;
    return;
  }
  const moved = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
  pointerDownPos = null;
  if (multiTouchGesture || moved > 10) {
    if (activePointers.size === 0) multiTouchGesture = false;
    return;
  }
  if (updateCursorFromPointer(e.clientX, e.clientY)) {
    cursorSelected = true;
    updateSelectionUI();
  }
  if (activePointers.size === 0) multiTouchGesture = false;
});
canvas.addEventListener('pointercancel', (e) => {
  activePointers.delete(e.pointerId);
  pointerDownPos = null;
  if (activePointers.size === 0) multiTouchGesture = false;
});

// ジオラマの側面(スカート)と台座
function buildSkirt() {
  const depth = -2.6;
  const verts = [];
  const cols = [];
  const topC = new THREE.Color('#6b573f');
  const botC = new THREE.Color('#46382a');
  const N = 80;
  const edges = [
    (t) => [-HALF + WORLD * t, -HALF],
    (t) => [HALF, -HALF + WORLD * t],
    (t) => [HALF - WORLD * t, HALF],
    (t) => [-HALF, HALF - WORLD * t],
  ];
  for (const edge of edges) {
    for (let i = 0; i < N; i++) {
      const [x0, z0] = edge(i / N);
      const [x1, z1] = edge((i + 1) / N);
      const y0 = terrainHeight(x0, z0);
      const y1 = terrainHeight(x1, z1);
      verts.push(x0, y0, z0, x0, depth, z0, x1, y1, z1);
      verts.push(x1, y1, z1, x0, depth, z0, x1, depth, z1);
      cols.push(...topC.toArray(), ...botC.toArray(), ...topC.toArray());
      cols.push(...topC.toArray(), ...botC.toArray(), ...botC.toArray());
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, side: THREE.DoubleSide,
  });
  scene.add(new THREE.Mesh(g, m));

  const plinth = new THREE.Mesh(
    new THREE.BoxGeometry(WORLD + 7, 1.6, WORLD + 7),
    new THREE.MeshStandardMaterial({ color: 0x3a3a3c, roughness: 0.6, metalness: 0.1 })
  );
  plinth.position.y = depth - 0.8;
  plinth.receiveShadow = true;
  scene.add(plinth);

  const bottom = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD, WORLD),
    new THREE.MeshStandardMaterial({ color: 0x46382a, roughness: 1 })
  );
  bottom.rotateX(Math.PI / 2);
  bottom.position.y = depth + 0.01;
  scene.add(bottom);
}
buildSkirt();

// ---------------- 川の水面 ----------------

const waterUniforms = {
  uTime: { value: 0 },
  uRain: { value: 0 },
  uFlood: { value: 0 },
  uColorDeep: { value: new THREE.Color('#2e6470') },
  uColorShallow: { value: new THREE.Color('#7fb6a8') },
};

function buildWater() {
  const segs = 220;
  const halfW = 3.1;
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i <= segs; i++) {
    const z = -HALF + WORLD * (i / segs);
    const x = riverX(z);
    const x2 = riverX(z + 0.4);
    const tx = x2 - x, tz = 0.4;
    const len = Math.hypot(tx, tz);
    const nx = -tz / len, nz = tx / len;
    positions.push(x + nx * -halfW, WATER_Y - 0.34, z + nz * -halfW);
    positions.push(x, WATER_Y, z);
    positions.push(x + nx * halfW, WATER_Y - 0.34, z + nz * halfW);
    uvs.push(0, i / segs * 18, 0.5, i / segs * 18, 1, i / segs * 18);
    if (i < segs) {
      const a = i * 3;
      indices.push(a, a + 1, a + 3, a + 1, a + 4, a + 3);
      indices.push(a + 1, a + 2, a + 4, a + 2, a + 5, a + 4);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();

  const mat = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      uniform float uTime;
      void main() {
        vUv = uv;
        vec3 p = position;
        p.y += sin(uTime * 1.4 + position.z * 1.1 + position.x * 0.7) * 0.025;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec2 vUv;
      uniform float uTime;
      uniform float uRain;
      uniform float uFlood;
      uniform vec3 uColorDeep;
      uniform vec3 uColorShallow;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                   mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }

      void main() {
        float flow1 = noise(vec2(vUv.x * 4.0, vUv.y * 3.0 - uTime * 0.45));
        float flow2 = noise(vec2(vUv.x * 9.0 + 5.0, vUv.y * 7.0 - uTime * 0.9));
        float streak = flow1 * 0.6 + flow2 * 0.4;

        float depthT = 1.0 - abs(vUv.x - 0.5) * 2.0;
        vec3 col = mix(uColorShallow, uColorDeep, depthT * 0.85);
        col += (streak - 0.5) * 0.16;

        float glint = pow(noise(vec2(vUv.x * 10.0, vUv.y * 14.0 - uTime * 1.2)), 9.0);
        col += glint * 0.22;

        float edge = smoothstep(0.32, 0.05, depthT);
        float foamN = noise(vec2(vUv.x * 14.0, vUv.y * 26.0 - uTime * 0.7));
        col = mix(col, vec3(0.92, 0.96, 0.94), edge * (0.35 + foamN * 0.35));

        col = mix(col, vec3(0.62, 0.72, 0.7), uRain * 0.25);
        // 氾濫時は土砂で茶色く濁る
        col = mix(col, vec3(0.55, 0.47, 0.35), uFlood * 0.7);

        float alpha = 0.88 - edge * 0.25;
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
  const waterMesh = new THREE.Mesh(g, mat);
  waterMesh.renderOrder = 2;
  scene.add(waterMesh);
}
buildWater();

// ---------------- 氾濫(自然の攪乱) ----------------
// 水位が上がって低地が濁流に沈み、植物が押し流される。
// 水が引くと土砂が栄養を運び、埋土種子が一斉に芽吹く。
// ボタンのほか、大雨(雨の連打)でも自然に発生する。

const FLOOD_RISE = 1.6;
const floodPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(WORLD - 1.2, WORLD - 1.2),
  new THREE.MeshStandardMaterial({
    color: 0x6e6850, transparent: true, opacity: 0.72,
    roughness: 0.28, metalness: 0.05, depthWrite: false,
  })
);
floodPlane.rotateX(-Math.PI / 2);
floodPlane.position.y = WATER_Y - 1;
floodPlane.visible = false;
floodPlane.renderOrder = 3;
scene.add(floodPlane);

let floodAnim = null; // { t, washed, sprouted }

function computeFloodMask() {
  for (let i = 0; i < NCELL; i++) {
    floodMask[i] = (!isWater[i]
      && cellHeight[i] < WATER_Y + FLOOD_RISE
      && cellRiverD[i] < 18) ? 1 : 0;
  }
}

function applyFloodWash() {
  for (let i = 0; i < NCELL; i++) {
    if (!floodMask[i]) continue;
    // 押し流される(ヨシは流れに強く、成木は根で耐える)
    grass[i] *= 0.05;
    flower[i] = 0;
    reed[i] *= 0.25;
    shrub[i] *= 0.15;
    tree[i] = tree[i] > 0.55 ? tree[i] * 0.85 : tree[i] * 0.2;
    vine[i] *= 0.35;                                   // 濁流はアレチウリも流す
    stability[i] = 0;                                  // 遷移はやり直し
    nutrients[i] = clamp(nutrients[i] + 0.35, 0, 1.2); // 土砂(シルト)が栄養を運ぶ
    moisture[i] = 1;
    germPulse[i] = 30;                                 // 埋土種子の発芽期間
  }
  // 氾濫原の希少種はダメージを受ける(湿地・水辺タイプは増水に少し強い)
  for (const r of rares) {
    if (floodMask[r.cell]) {
      r.health = clamp(r.health - (r.type === 'grass' ? 0.4 : 0.15), 0, 1);
    }
  }
  rainBoost = clamp(rainBoost + 0.2, 0, 0.65);
  computeMetrics();
  updateInsectPopulation();
  updateFishPopulation();
  updateBirdPopulation();
  rebuildAllVegetation();
  recolorTerrain();
  updateStatsUI();
}

function triggerFlood(message) {
  if (floodAnim) return;
  computeFloodMask();
  floodAnim = { t: 0, washed: false, sprouted: false };
  toast(message || '川が氾濫!低地の植物が押し流されました');
}

// ---------------- 雲・共有テクスチャ ----------------

function makeRadialTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
}
const radialTex = makeRadialTexture();

const clouds = [];
for (let i = 0; i < 5; i++) {
  const mat = new THREE.SpriteMaterial({
    map: radialTex, transparent: true, opacity: 0.5 + rng() * 0.2, depthWrite: false,
  });
  const sp = new THREE.Sprite(mat);
  const s = 9 + rng() * 9;
  sp.scale.set(s, s * 0.42, 1);
  sp.position.set((rng() - 0.5) * 80, 17 + rng() * 7, (rng() - 0.5) * 80);
  sp.userData.speed = 0.18 + rng() * 0.22;
  scene.add(sp);
  clouds.push(sp);
}

// ---------------- シミュレーション状態 ----------------

const NCELL = GRID * GRID;
const cellHeight = new Float32Array(NCELL);
const cellRiverD = new Float32Array(NCELL);
const baseMoist = new Float32Array(NCELL);
const moisture = new Float32Array(NCELL);
const nutrients = new Float32Array(NCELL);
const grass = new Float32Array(NCELL);
const reed = new Float32Array(NCELL);
const flower = new Float32Array(NCELL);
const shrub = new Float32Array(NCELL);
const tree = new Float32Array(NCELL);
const vine = new Float32Array(NCELL);     // 侵略的外来種:アレチウリの地上部(繁茂量 biomass)
const vineSeed = new Float32Array(NCELL); // アレチウリの土壌中の種子バンク(seedBank)
const vineCover = new Float32Array(NCELL);// その日に在来植物を覆っていた被度(描画用)
const stability = new Float32Array(NCELL);
const biome = new Uint8Array(NCELL);
const isWater = new Uint8Array(NCELL);
// 埋土種子バンク(土の中で眠っている種)と氾濫後の発芽パルス
const seedGrass = new Float32Array(NCELL);
const seedReed = new Float32Array(NCELL);
const seedFlower = new Float32Array(NCELL);
const germPulse = new Float32Array(NCELL);
const floodMask = new Uint8Array(NCELL);

function cellCenter(i) {
  const cx = i % GRID, cz = Math.floor(i / GRID);
  return [-HALF + (cx + 0.5) * CELL, -HALF + (cz + 0.5) * CELL];
}

for (let i = 0; i < NCELL; i++) {
  const [x, z] = cellCenter(i);
  cellHeight[i] = terrainHeight(x, z);
  cellRiverD[i] = riverDist(x, z);
  isWater[i] = cellHeight[i] < WATER_Y + 0.04 ? 1 : 0;
  const m = clamp(1 - cellRiverD[i] / 26, 0, 1);
  baseMoist[i] = clamp(
    Math.pow(m, 1.15) * 0.8 + fbm(x * 0.09 + 31, z * 0.09 + 17) * 0.28 - cellHeight[i] * 0.05,
    0.05, 1
  );
}

let simDays = 0;
let paused = false;
let timeScale = 1;          // 時間の速さ(日数の進みだけを速める)
const TIME_SCALES = [1, 2, 4];
let rainBoost = 0;
let rainTimer = 0;
let protectionTimer = 0;   // 保護活動の残り日数
let vegSeedRng = mulberry32(777);

function seedInitialVegetation() {
  grass.fill(0); reed.fill(0); flower.fill(0); shrub.fill(0); tree.fill(0);
  vine.fill(0); vineSeed.fill(0); vineCover.fill(0);
  stability.fill(0); germPulse.fill(0);
  for (let i = 0; i < NCELL; i++) {
    moisture[i] = baseMoist[i];
    nutrients[i] = 0.35 + vegSeedRng() * 0.3;
    // 土の中には最初から休眠種子が眠っている
    seedGrass[i] = 0.15 + vegSeedRng() * 0.25;
    seedFlower[i] = 0.25 + vegSeedRng() * 0.35;
    seedReed[i] = cellRiverD[i] < 12 ? 0.2 + vegSeedRng() * 0.3 : 0.05;
  }
  let placed = 0, guard = 0;
  while (placed < 26 && guard++ < 4000) {
    const i = Math.floor(vegSeedRng() * NCELL);
    if (!isWater[i] && moisture[i] > 0.24 && moisture[i] < 0.8) {
      grass[i] = 0.25 + vegSeedRng() * 0.3;
      placed++;
    }
  }
  placed = 0; guard = 0;
  while (placed < 16 && guard++ < 6000) {
    const i = Math.floor(vegSeedRng() * NCELL);
    if (!isWater[i] && cellRiverD[i] < 9 && moisture[i] > 0.55) {
      reed[i] = 0.3 + vegSeedRng() * 0.3;
      placed++;
    }
  }
}
seedInitialVegetation();

function bell(x, center, width) {
  const t = (x - center) / width;
  return Math.exp(-t * t * 2.2);
}

const neighborIdx = (i, dx, dz) => {
  const cx = (i % GRID) + dx, cz = Math.floor(i / GRID) + dz;
  if (cx < 0 || cx >= GRID || cz < 0 || cz >= GRID) return -1;
  return cz * GRID + cx;
};

function neighborAvg(arr, i) {
  let sum = 0, n = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const j = neighborIdx(i, dx, dz);
    if (j >= 0) { sum += arr[j]; n++; }
  }
  return n ? sum / n : 0;
}

const tickRng = mulberry32(31415);

// 希少種の近く(保護の対象範囲)かどうか
function nearRareCell(i, radius) {
  if (rares.length === 0) return false;
  const cx = i % GRID, cz = Math.floor(i / GRID);
  for (const r of rares) {
    const dx = cx - r.cellX, dz = cz - r.cellZ;
    if (dx * dx + dz * dz <= radius * radius) return true;
  }
  return false;
}

// ---------------- アレチウリ(一年草のつる植物)のモデル ----------------
// 個体数だけでなく、季節に沿った生活史(stage)と土壌の種子バンク(vineSeed)を持つ。
//   春   : 種子バンクから発芽。小さく、被害は弱い。駆除がとても効く
//   初夏 : つるが伸び始める。まだ駆除が効く
//   夏   : 成長が速く、周囲の在来植物に絡みついて覆う(繁茂)
//   晩夏〜秋 : 大繁茂し、開花・結実して種子バンクを大きく増やす
//   冬   : 地上部は枯れる。ただし種子バンクは残る
//   翌春 : 残った種子バンクから再び発芽し、発生地点が増える
//
// === デバッグ用の調整定数 ===
// 侵入や発芽が遅すぎて確認できないと困るので、発生確率はここで調整できる。
const VINE_INVASION_START_DAY = 45;  // この日数を過ぎると外部からの侵入が始まる
const VINE_INVASION_RATE = 0.016;    // 1日あたりの新規侵入確率(雨後は上がる)。大きいほど侵入が早い
const VINE_SPRING_GERM_RATE = 0.05;  // 春の1日あたり発芽係数(種子バンク量に比例)。大きいほど翌年の再発生が多い
const VINE_SEED_PRODUCTION = 0.05;   // 結実期に繁茂量から種子バンクへ変換される量。大きいほど翌年リスクが増える

// 当日の生活史フェーズ(年内の経過日 doy から決める)
const vinePh = { stage: 'seedling', cap: 0.28, grow: 0.02, spread: 0, seedProd: 0, dieback: 0 };
const VINE_STAGE_JP = {
  seedling: '芽生え', growing: '伸長', spreading: '繁茂', fruiting: '結実', dead: '枯死',
};

function updateVinePhenology(days) {
  const doy = ((days % YEAR_DAYS) + YEAR_DAYS) % YEAR_DAYS;
  let s;
  if (doy < 14)      s = { stage: 'seedling',  cap: 0.28, grow: 0.020, spread: 0.0, seedProd: 0, dieback: 0 };
  else if (doy < 30) s = { stage: 'growing',   cap: 0.52, grow: 0.045, spread: 0.5, seedProd: 0, dieback: 0 };
  else if (doy < 62) s = { stage: 'spreading', cap: 1.00, grow: 0.075, spread: 1.0, seedProd: 0, dieback: 0 };
  else if (doy < 90) s = { stage: 'fruiting',  cap: 1.00, grow: 0.030, spread: 0.5, seedProd: 1, dieback: 0 };
  else               s = { stage: 'dead',      cap: 0.00, grow: 0.000, spread: 0.0, seedProd: 0, dieback: 1 };
  Object.assign(vinePh, s);
}

// 外部からの偶発的な種子の侵入(川沿い・裸地・草地の縁・植生の弱い場所に入りやすい)
function tryVineInvasion() {
  if (simDays < VINE_INVASION_START_DAY) return;
  if (vinePh.stage === 'dead') return; // 冬は新たな地上部は出ない
  const p = VINE_INVASION_RATE * (rainBoost > 0.12 ? 1.6 : 1) * clamp(seasonNow.growth, 0.2, 1.3);
  if (tickRng() >= p) return;
  for (let tryN = 0; tryN < 120; tryN++) {
    const i = Math.floor(tickRng() * NCELL);
    if (isWater[i] || vine[i] > 0) continue;
    if (tree[i] > 0.3) continue;                       // 林の中には入りにくい
    const nearRiver = cellRiverD[i] < 10;
    const moist = moisture[i] > 0.4;                   // 湿り気のある場所を好む
    const weakVeg = grass[i] + reed[i] < 0.45;         // 植生の弱い場所
    const openCell = biome[i] === BIOME.BARE || biome[i] === BIOME.GRASS
      || (nearRiver && reed[i] < 0.4);                 // 川沿いの開けた場所
    if (((nearRiver || moist) && openCell) || (weakVeg && openCell && tickRng() < 0.5)) {
      vine[i] = 0.16;
      vineSeed[i] = Math.max(vineSeed[i], 0.3);
      const j = neighborIdx(i, tickRng() < 0.5 ? 1 : -1, 0);
      if (j >= 0 && !isWater[j]) vine[j] = Math.max(vine[j], 0.07);
      toast('アレチウリが入り込んだようです…(早めの駆除が有効です)');
      return;
    }
  }
}

// ---------------- 1日ごとの更新 ----------------

function simTick() {
  simDays += 1;
  rainBoost *= 0.965;
  if (protectionTimer > 0) protectionTimer -= 1;
  updateSeason(simDays);
  updateVinePhenology(simDays);
  const gF = seasonNow.growth;

  tryVineInvasion();

  for (let i = 0; i < NCELL; i++) {
    if (isWater[i]) { biome[i] = BIOME.WATER; continue; }

    // 湿り気
    const target = clamp(baseMoist[i] + rainBoost, 0, 1);
    moisture[i] += (target - moisture[i]) * 0.12;
    const m = moisture[i];

    // 栄養はゆっくり回復
    nutrients[i] = clamp(nutrients[i] + 0.0025, 0, 1.2);

    // --- アレチウリ:生活史(発芽→伸長→繁茂→結実→枯死)と種子バンク ---
    const vSuit = bell(m, 0.5, 0.4) * (1 - clamp(tree[i] * 0.6, 0, 0.6));
    const vNb = neighborAvg(vine, i);
    const vSeedNb = neighborAvg(vineSeed, i);

    // 春:前年の種子バンクから発芽(バンクが多い場所ほど発芽が多い)
    if (vinePh.stage === 'seedling' && vine[i] < 0.05 && vineSeed[i] > 0.12) {
      const germP = VINE_SPRING_GERM_RATE * vineSeed[i] * (rainBoost > 0.1 ? 1.4 : 1);
      if (tickRng() < germP) {
        vine[i] = 0.05 + tickRng() * 0.05;
        vineSeed[i] *= 0.7; // 発芽に使われた分だけ種子バンクが減る
      }
    }

    if (vinePh.stage === 'dead') {
      // 冬:地上部は枯れて消える(種子バンクは土に残る)
      vine[i] *= 0.88;
      if (vine[i] < 0.02) vine[i] = 0;
    } else if (vine[i] > 0 || (vNb > 0.02 && vinePh.spread > 0)) {
      // 自分の成長 + 隣からのつるの伸長(spread はフェーズで変わる)
      let dv = vSuit * (vinePh.grow * (0.4 + 0.6 * vine[i])
        + vinePh.spread * (0.05 * vNb + 0.02 * vSeedNb));
      dv *= (1 - reed[i] * 0.3);                  // 密なヨシ原はやや入りにくい
      if (protectionTimer > 0) {
        dv *= nearRareCell(i, 6) ? 0.12 : 0.7;    // 保護中は希少種の周りで特に抑える
      }
      vine[i] = clamp(vine[i] + dv, 0, 1);
      // 段階ごとの上限(春・初夏は小さいまま)
      if (vine[i] > vinePh.cap) vine[i] = lerp(vine[i], vinePh.cap, 0.15);
    }

    // 結実期:十分に茂った株が種子バンクを増やす
    if (vinePh.seedProd > 0 && vine[i] > 0.3) {
      vineSeed[i] = Math.min(1.6, vineSeed[i] + vine[i] * VINE_SEED_PRODUCTION);
    }
    vineSeed[i] *= 0.992; // 種子の寿命(結実を許さなければ年々失活。約1年で6割ほどに減る)

    const cover = clamp(vine[i] * 1.25, 0, 1); // つるに覆われた分だけ在来植物が弱る
    vineCover[i] = cover;

    // --- 草 ---
    const gSuit = bell(m, 0.45, 0.3);
    const gNb = neighborAvg(grass, i);
    const shade = clamp(tree[i] * 0.75 + shrub[i] * 0.4 + reed[i] * 0.5, 0, 0.9);
    let dg = gSuit * (0.010 + 0.085 * gNb + 0.045 * grass[i]) * (0.45 + 0.55 * nutrients[i]) * gF;
    dg *= (1 - shade) * (1 - cover * 0.85); // つるに覆われると光不足で成長が止まる
    if (protectionTimer > 0 && nearRareCell(i, 5)) dg *= 1.3; // 保護中は回復を助ける
    let gDeath = grass[i] * 0.012 + grass[i] * 0.055 * cover;
    if (m < 0.17) gDeath += grass[i] * 0.05;
    grass[i] = clamp(grass[i] + dg - gDeath, 0, 1);
    nutrients[i] = clamp(nutrients[i] + gDeath * 0.3 - dg * 0.06, 0, 1.2);

    // --- ヨシ(湿地) ---
    const rSuit = bell(m, 0.8, 0.22) * (cellRiverD[i] < 16 ? 1 : 0.25);
    const rNb = neighborAvg(reed, i);
    let dr = rSuit * (0.008 + 0.10 * rNb + 0.045 * reed[i]) * (0.5 + 0.5 * nutrients[i]) * gF;
    dr *= (1 - clamp(tree[i], 0, 0.8)) * (1 - cover * 0.8);
    let rDeath = reed[i] * 0.01 + reed[i] * 0.045 * cover + (m < 0.45 ? reed[i] * 0.045 : 0);
    reed[i] = clamp(reed[i] + dr - rDeath, 0, 1);
    nutrients[i] = clamp(nutrients[i] + rDeath * 0.35 - dr * 0.05, 0, 1.2);

    // --- 花(草地に混じる) ---
    if (grass[i] > 0.3 && m > 0.26 && m < 0.62 && gF > 0.4 && cover < 0.3) {
      const fNb = neighborAvg(flower, i);
      flower[i] = clamp(flower[i] + (0.008 + 0.05 * fNb) * gF + (tickRng() < 0.004 ? 0.12 : 0), 0, 0.7);
    } else {
      flower[i] = Math.max(0, flower[i] - 0.02 - flower[i] * 0.12 * cover);
    }

    // --- 発芽パルス(氾濫後、水が引いてから埋土種子が芽吹く) ---
    if (germPulse[i] > 0 && !floodAnim) {
      germPulse[i] -= 1;
      const germF = clamp(gF, 0.15, 1); // 冬は芽吹きが遅い
      // 攪乱地ではまずパイオニアの花が一斉に咲く
      flower[i] = clamp(flower[i] + seedFlower[i] * 0.06 * germF, 0, 0.8);
      seedFlower[i] *= 0.95;
      grass[i] = clamp(grass[i] + seedGrass[i] * 0.035 * bell(m, 0.5, 0.35) * germF, 0, 1);
      seedGrass[i] *= 0.94;
      if (m > 0.55) {
        reed[i] = clamp(reed[i] + seedReed[i] * 0.05 * germF, 0, 1);
        seedReed[i] *= 0.94;
      }
    }

    // --- 種子の堆積(生育中の植物が土に種を残す) ---
    seedGrass[i] = Math.min(1, seedGrass[i] * 0.9995 + grass[i] * 0.005);
    seedReed[i] = Math.min(1, seedReed[i] * 0.9995 + reed[i] * 0.005);
    seedFlower[i] = Math.min(1, seedFlower[i] * 0.9995 + flower[i] * 0.012 + grass[i] * 0.0008);

    // --- 安定度 ---
    if (grass[i] + reed[i] + shrub[i] + tree[i] > 0.3 && cover < 0.5) stability[i] += 1;
    else stability[i] = Math.max(0, stability[i] - 1);

    // --- 低木 ---
    const sSuit = bell(m, 0.42, 0.26);
    if (shrub[i] === 0 && stability[i] > 28 && grass[i] > 0.35 && tree[i] < 0.2) {
      const sNb = neighborAvg(shrub, i);
      if (tickRng() < 0.004 * (1 + sNb * 9) * sSuit * gF) shrub[i] = 0.06;
    } else if (shrub[i] > 0) {
      shrub[i] = clamp(
        shrub[i] + 0.011 * sSuit * (0.5 + 0.5 * nutrients[i]) * gF
        - tree[i] * 0.01 - shrub[i] * 0.02 * cover, 0, 1);
      nutrients[i] = clamp(nutrients[i] - 0.004 * sSuit, 0, 1.2);
    }

    // --- 木 ---
    const tSuit = bell(m, 0.46, 0.3);
    const tNb = neighborAvg(tree, i);
    if (tree[i] === 0 && stability[i] > 70 && (shrub[i] > 0.45 || tNb > 0.12)) {
      if (tickRng() < 0.0035 * (1 + tNb * 10) * tSuit * gF) tree[i] = 0.05;
    } else if (tree[i] > 0) {
      let dt2 = 0.0065 * tSuit * (0.5 + 0.5 * nutrients[i]) * clamp(gF, 0.15, 1);
      if (tree[i] < 0.45) dt2 -= tree[i] * 0.012 * cover; // 若木はつるに弱い
      tree[i] = clamp(tree[i] + dt2, 0, 1);
      nutrients[i] = clamp(nutrients[i] - 0.003 * tSuit, 0, 1.2);
    }

    // --- バイオーム判定 ---
    if (vine[i] > 0.45) biome[i] = BIOME.VINE;
    else if (tree[i] > 0.42) biome[i] = BIOME.FOREST;
    else if (shrub[i] > 0.4) biome[i] = BIOME.SHRUB;
    else if ((m > 0.63 && grass[i] + reed[i] > 0.18) || reed[i] > 0.35) biome[i] = BIOME.WETLAND;
    else if (grass[i] > 0.22) biome[i] = BIOME.GRASS;
    else biome[i] = BIOME.BARE;
  }
}

// ---------------- 指標 ----------------

const metrics = {
  plants: 0, diversity: 0, waterside: 0, insects: 0, birds: 0, fish: 0,
  edges: 0, speciesCount: 0, biomeCount: 0,
  grassSum: 0, reedSum: 0, flowerSum: 0, shrubCount: 0, treeCount: 0,
  vineSum: 0, vineCells: 0, invasion: 0,
  vineSeedSum: 0, seedBankLevel: '少', nextYearRisk: '低', removalDifficulty: '低',
  vineStage: '—',
  rareCount: 0, rareRisk: '—',
  vegRatio: 0,
};

const threeLevel = (x, midT, hiT, labels) => (x >= hiT ? labels[2] : x >= midT ? labels[1] : labels[0]);

function computeMetrics() {
  let gSum = 0, rSum = 0, fSum = 0, sCount = 0, tCount = 0;
  let vSum = 0, vCells = 0, vSeedSum = 0, vMaxBio = 0;
  let edges = 0, waterEdges = 0, vegCells = 0;
  const biomesPresent = new Set();

  for (let i = 0; i < NCELL; i++) {
    gSum += grass[i]; rSum += reed[i]; fSum += flower[i];
    vSum += vine[i];
    vSeedSum += vineSeed[i];
    if (vine[i] > vMaxBio) vMaxBio = vine[i];
    if (vine[i] > 0.12) vCells++;
    if (shrub[i] > 0.25) sCount++;
    if (tree[i] > 0.2) tCount++;
    biomesPresent.add(biome[i]);
    if (grass[i] + reed[i] + shrub[i] + tree[i] > 0.25) vegCells++;

    // 右と下の隣だけ見て境目を数える(エコトーン)。アレチウリ地は数えない
    const bi = biome[i];
    const r = neighborIdx(i, 1, 0);
    if (r >= 0 && biome[r] !== bi && bi !== BIOME.VINE && biome[r] !== BIOME.VINE) {
      edges++;
      if (biome[r] === BIOME.WATER || bi === BIOME.WATER ||
          biome[r] === BIOME.WETLAND || bi === BIOME.WETLAND) waterEdges++;
    }
    const d = neighborIdx(i, 0, 1);
    if (d >= 0 && biome[d] !== bi && bi !== BIOME.VINE && biome[d] !== BIOME.VINE) {
      edges++;
      if (biome[d] === BIOME.WATER || bi === BIOME.WATER ||
          biome[d] === BIOME.WETLAND || bi === BIOME.WETLAND) waterEdges++;
    }
  }

  let species = 0;
  if (gSum > 6) species++;
  if (rSum > 4) species++;
  if (fSum > 2) species++;
  if (sCount > 2) species++;
  if (tCount > 1) species++;

  biomesPresent.delete(BIOME.VINE); // 外来種に覆われた場所は環境タイプ数に入れない

  metrics.grassSum = gSum; metrics.reedSum = rSum; metrics.flowerSum = fSum;
  metrics.shrubCount = sCount; metrics.treeCount = tCount;
  metrics.vineSum = vSum; metrics.vineCells = vCells;
  metrics.invasion = Math.min(100, vSum > 0.05 ? Math.max(1, Math.round(vSum / 10)) : 0);
  metrics.vineSeedSum = vSeedSum;
  metrics.vineStage = (vSum > 0.5 || (vSeedSum > 1 && vinePh.stage !== 'dead'))
    ? VINE_STAGE_JP[vinePh.stage] : '—';
  // 種子バンク量(少/中/多)
  metrics.seedBankLevel = threeLevel(vSeedSum, 4, 16, ['少', '中', '多']);
  // 翌年リスク = 種子バンク + 結実中の繁茂量(秋ほど高くなる)
  const nyr = vSeedSum + (vinePh.seedProd > 0 ? vSum * 0.15 : 0);
  metrics.nextYearRisk = threeLevel(nyr, 4, 14, ['低', '中', '高']);
  // 駆除難度 = 総量 × 株あたりの大きさ(大繁茂・結実後ほど高い)
  const diffScore = vSum / 12 + vMaxBio * 2 + (vinePh.seedProd > 0 ? 1.5 : 0);
  metrics.removalDifficulty = threeLevel(diffScore, 1.5, 4, ['低', '中', '高']);
  metrics.edges = edges;
  metrics.speciesCount = species;
  metrics.biomeCount = biomesPresent.size;
  metrics.vegRatio = vegCells / NCELL;

  // 多様性 = 植物種数 + 環境タイプ数 + 境目(エコトーン) + 生きもの − 外来種の影響
  const speciesScore = species / 5;
  const biomeScore = biomesPresent.size / NATIVE_BIOME_COUNT;
  const edgeScore = clamp(edges / 2600, 0, 1);
  const faunaScore = (metrics.insects > 0 ? 0.4 : 0) + (metrics.birds > 0 ? 0.3 : 0)
    + (metrics.fish > 0 ? 0.3 : 0);
  const base = (speciesScore * 0.35 + biomeScore * 0.25 + edgeScore * 0.25 + faunaScore * 0.15) * 100;
  metrics.diversity = Math.round(clamp(base - metrics.invasion * 0.22, 0, 100));

  // 水辺の豊かさ = ヨシの茂み + 水辺の境目(エコトーン)
  metrics.waterside = Math.round(clamp(
    clamp(rSum / 430, 0, 1) * 0.6 + clamp(waterEdges / 680, 0, 1) * 0.4, 0, 1) * 100);

  metrics.rareCount = rares.length;
  if (rares.length === 0) {
    metrics.rareRisk = '—';
  } else {
    const minHealth = Math.min(...rares.map((r) => r.health));
    if (metrics.invasion >= 20 || minHealth < 0.35) metrics.rareRisk = '高';
    else if (metrics.invasion >= 7 || metrics.diversity < 50) metrics.rareRisk = '中';
    else metrics.rareRisk = '低';
  }
}

// ---------------- 植生の描画(インスタンス) ----------------

const sharedSwayUniform = { value: 0 };

function applySway(material, strength) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSway = sharedSwayUniform;
    shader.vertexShader = 'uniform float uSway;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec4 swayWp = instanceMatrix * vec4(transformed, 1.0);
        float swayAmt = sin(uSway * 1.7 + swayWp.x * 0.7 + swayWp.z * 0.55) * ${strength.toFixed(3)} * max(transformed.y, 0.0);
        transformed.x += swayAmt;
        transformed.z += swayAmt * 0.6;
      #endif`
    );
  };
}

function mergeParts(parts) {
  // インデックスの有無・UVの有無が混ざると merge できないため揃える
  return mergeGeometries(parts.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    ng.deleteAttribute('uv');
    return ng;
  }));
}

function bladeGeometry(height, width, lean) {
  const g = new THREE.BufferGeometry();
  const verts = new Float32Array([
    -width / 2, 0, 0,
    width / 2, 0, 0,
    lean, height, 0,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.computeVertexNormals();
  return g;
}

function tuftGeometry(blades, height, width, lean) {
  const parts = [];
  for (let i = 0; i < blades; i++) {
    const b = bladeGeometry(height * (0.7 + 0.45 * (i / blades)), width, lean * (rng() - 0.4));
    b.rotateY((i / blades) * Math.PI * 2 + rng());
    parts.push(b);
  }
  return mergeParts(parts);
}

function setGeoColor(geo, color) {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(arr, i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function shrubGeometry() {
  const parts = [];
  for (let k = 0; k < 3; k++) {
    const s = new THREE.IcosahedronGeometry(0.34 - k * 0.06, 1);
    s.scale(1, 0.72, 1);
    s.translate((rng() - 0.5) * 0.4, 0.26 + k * 0.16, (rng() - 0.5) * 0.4);
    setGeoColor(s, k === 0 ? '#4a6b35' : '#567a3c');
    parts.push(s);
  }
  return mergeParts(parts);
}

function treeGeometry() {
  const trunk = new THREE.CylinderGeometry(0.07, 0.13, 1.1, 6);
  trunk.translate(0, 0.55, 0);
  const c1 = new THREE.IcosahedronGeometry(0.78, 1);
  c1.scale(1, 0.92, 1);
  c1.translate(0.06, 1.55, 0);
  const c2 = new THREE.IcosahedronGeometry(0.5, 1);
  c2.translate(-0.3, 2.05, 0.16);
  const parts = [trunk.toNonIndexed(), c1, c2];
  setGeoColor(parts[0], '#6e553a');
  setGeoColor(parts[1], '#4f7438');
  setGeoColor(parts[2], '#5d8443');
  return mergeParts(parts);
}

function flowerGeometry() {
  const stem = new THREE.CylinderGeometry(0.012, 0.016, 0.3, 4);
  stem.translate(0, 0.15, 0);
  const head = new THREE.OctahedronGeometry(0.055, 0);
  head.scale(1, 0.8, 1);
  head.translate(0, 0.33, 0);
  const parts = [stem.toNonIndexed(), head];
  setGeoColor(parts[0], '#5d7a42');
  setGeoColor(parts[1], '#f2eedd');
  return mergeParts(parts);
}

function reedGeometry() {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const b = bladeGeometry(1.3 + rng() * 0.5, 0.085, 0.22 * (rng() - 0.5));
    b.rotateY(rng() * Math.PI * 2);
    b.translate((rng() - 0.5) * 0.14, 0, (rng() - 0.5) * 0.14);
    setGeoColor(b, i % 2 ? '#8aa05a' : '#7a9a52');
    parts.push(b);
  }
  const head = new THREE.CylinderGeometry(0.012, 0.02, 0.42, 5).toNonIndexed();
  head.translate(0.03, 1.62, 0);
  setGeoColor(head, '#b59c70');
  parts.push(head);
  return mergeParts(parts);
}

function vineGeometry() {
  // 地面や植物を覆う、くすんだつるのもつれ
  const parts = [];
  for (let k = 0; k < 3; k++) {
    const s = new THREE.IcosahedronGeometry(0.3 + rng() * 0.1, 1);
    s.scale(1.25, 0.4, 1.25);
    s.translate((rng() - 0.5) * 0.55, 0.12 + k * 0.09, (rng() - 0.5) * 0.55);
    setGeoColor(s, k === 0 ? '#79855c' : '#849066');
    parts.push(s);
  }
  for (let k = 0; k < 4; k++) {
    const b = bladeGeometry(0.5 + rng() * 0.35, 0.07, 0.4 * (rng() - 0.5));
    b.rotateX(0.9 + rng() * 0.5); // 寝かせて、つるが伸びている感じに
    b.rotateY(rng() * Math.PI * 2);
    b.translate((rng() - 0.5) * 0.5, 0.18, (rng() - 0.5) * 0.5);
    setGeoColor(b, '#8e986d');
    parts.push(b);
  }
  return mergeParts(parts);
}

// --- 種ごとの設定 ---

const SPECIES = {
  grass: {
    max: 9000, perCell: 3, density: grass, minD: 0.12,
    geo: setGeoColor(tuftGeometry(4, 0.62, 0.16, 0.3), '#7fa055'),
    mat: new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, side: THREE.DoubleSide,
    }),
    sway: 0.05, castShadow: false,
    colors: ['#ffffff', '#f4f9e4', '#e7f1cf', '#fdfcf0'],
    scale: () => 0.75 + rng() * 0.6,
    seasonTint: 'grass',
  },
  reed: {
    max: 4500, perCell: 3, density: reed, minD: 0.15,
    geo: reedGeometry(),
    mat: new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, side: THREE.DoubleSide,
    }),
    sway: 0.07, castShadow: false,
    colors: ['#ffffff', '#f0f5e0', '#e4eed2', '#f7fbe8'],
    scale: () => 0.7 + rng() * 0.55,
    seasonTint: 'reed',
  },
  flower: {
    max: 2500, perCell: 2, density: flower, minD: 0.18,
    geo: flowerGeometry(),
    mat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
    sway: 0.04, castShadow: false,
    colors: ['#ffffff', '#ffd9e0', '#fff3c4', '#e8d9ff'],
    scale: () => 0.8 + rng() * 0.5,
    seasonTint: null,
  },
  shrub: {
    max: 900, perCell: 1, density: shrub, minD: 0.1,
    geo: shrubGeometry(),
    mat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }),
    sway: 0, castShadow: true,
    colors: ['#ffffff', '#eef5e4', '#e2eed4', '#f5fbef'],
    scale: () => 0.8 + rng() * 0.7,
    seasonTint: 'shrub',
  },
  tree: {
    max: 600, perCell: 1, density: tree, minD: 0.1,
    geo: treeGeometry(),
    mat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }),
    sway: 0, castShadow: true,
    colors: ['#ffffff', '#eaf2dc', '#dfecd2', '#f2f8e8'],
    scale: () => 0.7 + rng() * 0.75,
    seasonTint: 'tree',
  },
  vine: {
    max: 1500, perCell: 1, density: vine, minD: 0.12,
    geo: vineGeometry(),
    mat: new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, side: THREE.DoubleSide,
    }),
    sway: 0.03, castShadow: false,
    colors: ['#ffffff', '#f2efd8', '#e6e2c2', '#f8f5e2'],
    scale: () => 0.75 + rng() * 0.6,
    seasonTint: null,
    flat: true, // 横に広がるスケール
  },
};

// スロット(セルごとの固定配置)を事前計算
const slotRng = mulberry32(424242);
for (const key of Object.keys(SPECIES)) {
  const sp = SPECIES[key];
  const n = NCELL * sp.perCell;
  sp.slotX = new Float32Array(n);
  sp.slotY = new Float32Array(n);
  sp.slotZ = new Float32Array(n);
  sp.slotRot = new Float32Array(n);
  sp.slotScale = new Float32Array(n);
  sp.slotColor = new Uint8Array(n);
  sp.slotOk = new Uint8Array(n);
  for (let i = 0; i < NCELL; i++) {
    const [cx, cz] = cellCenter(i);
    for (let k = 0; k < sp.perCell; k++) {
      const s = i * sp.perCell + k;
      const x = cx + (slotRng() - 0.5) * CELL * 0.95;
      const z = cz + (slotRng() - 0.5) * CELL * 0.95;
      const y = terrainHeight(x, z);
      sp.slotX[s] = x; sp.slotZ[s] = z; sp.slotY[s] = y;
      sp.slotRot[s] = slotRng() * Math.PI * 2;
      sp.slotScale[s] = sp.scale();
      sp.slotColor[s] = Math.floor(slotRng() * sp.colors.length);
      sp.slotOk[s] = y > WATER_Y + 0.06 ? 1 : 0;
    }
  }
  sp.mesh = new THREE.InstancedMesh(sp.geo, sp.mat, sp.max);
  sp.mesh.castShadow = sp.castShadow;
  sp.mesh.receiveShadow = false;
  sp.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sp.mesh.count = 0;
  if (sp.sway > 0) applySway(sp.mat, sp.sway);
  sp.colorObjs = sp.colors.map((c) => new THREE.Color(c));
  scene.add(sp.mesh);
}

const tmpMat = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpEuler = new THREE.Euler();

function rebuildSpecies(key) {
  const sp = SPECIES[key];
  const dens = sp.density;
  let idx = 0;
  for (let i = 0; i < NCELL && idx < sp.max; i++) {
    const d = dens[i];
    if (d < sp.minD || isWater[i]) continue;
    const want = Math.min(sp.perCell, Math.max(1, Math.round(d * sp.perCell)));
    for (let k = 0; k < want && idx < sp.max; k++) {
      const s = i * sp.perCell + k;
      if (!sp.slotOk[s]) continue;
      const grow = 0.45 + 0.55 * clamp(d * 1.4, 0, 1);
      const sc = sp.slotScale[s] * grow;
      tmpPos.set(sp.slotX[s], sp.slotY[s] - 0.02, sp.slotZ[s]);
      tmpQuat.setFromEuler(tmpEuler.set(0, sp.slotRot[s], 0));
      if (sp.flat) tmpScale.set(sc * 1.35, sc * (0.45 + 0.55 * clamp(d, 0, 1)), sc * 1.35);
      else tmpScale.set(sc, sc, sc);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      sp.mesh.setMatrixAt(idx, tmpMat);
      sp.mesh.setColorAt(idx, sp.colorObjs[sp.slotColor[s]]);
      idx++;
    }
  }
  sp.mesh.count = idx;
  sp.mesh.instanceMatrix.needsUpdate = true;
  if (sp.mesh.instanceColor) sp.mesh.instanceColor.needsUpdate = true;
  return idx;
}

function rebuildAllVegetation() {
  let total = 0;
  for (const key of Object.keys(SPECIES)) {
    const n = rebuildSpecies(key);
    if (key !== 'vine') total += n; // 表示する「植物数」は在来植物のみ
  }
  metrics.plants = total;
}

// アレチウリの生活史ごとの色(在来植物より少し明るく青みのある緑。冬は茶色く枯れる)
const VINE_STAGE_COLOR = {
  seedling: new THREE.Color('#aecb7a'),
  growing: new THREE.Color('#a3c06f'),
  spreading: new THREE.Color('#94ad68'),
  fruiting: new THREE.Color('#aeb986'),
  dead: new THREE.Color('#a48d60'),
};
const VINE_GROUND_COLOR = {
  seedling: new THREE.Color('#8f9a6a'),
  growing: new THREE.Color('#878f64'),
  spreading: new THREE.Color('#7c855c'),
  fruiting: new THREE.Color('#8b8a64'),
  dead: new THREE.Color('#8d7d57'),
};
const vineGround = new THREE.Color('#878d6e');

// 季節による植物の色味(material.color はインスタンス色と掛け合わされる)
function applySeasonTints() {
  for (const key of Object.keys(SPECIES)) {
    const sp = SPECIES[key];
    if (sp.seasonTint) sp.mat.color.copy(seasonNow[sp.seasonTint]);
  }
  // アレチウリは生活史ステージで色を変える
  SPECIES.vine.mat.color.copy(VINE_STAGE_COLOR[vinePh.stage]);
  vineGround.copy(VINE_GROUND_COLOR[vinePh.stage]);
}

// ---------------- 地形の色 ----------------

const C_SOIL_DRY = new THREE.Color('#b3a173');
const C_SOIL_WET = new THREE.Color('#74604a');
const C_SAND = new THREE.Color('#c7b289');
const C_BED = new THREE.Color('#5c5448');
const tmpColor = new THREE.Color();
const tmpColor2 = new THREE.Color();

function bilinearCell(arr, x, z) {
  const fx = clamp((x + HALF) / CELL - 0.5, 0, GRID - 1.001);
  const fz = clamp((z + HALF) / CELL - 0.5, 0, GRID - 1.001);
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const a = arr[iz * GRID + ix];
  const b = arr[iz * GRID + Math.min(ix + 1, GRID - 1)];
  const c = arr[Math.min(iz + 1, GRID - 1) * GRID + ix];
  const d = arr[Math.min(iz + 1, GRID - 1) * GRID + Math.min(ix + 1, GRID - 1)];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

function recolorTerrain() {
  const pos = terrGeo.attributes.position;
  const colAttr = terrGeo.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const m = bilinearCell(moisture, x, z);
    const g = bilinearCell(grass, x, z);
    const r = bilinearCell(reed, x, z);
    const t = bilinearCell(tree, x, z);
    const v = bilinearCell(vine, x, z);
    const d = riverDist(x, z);

    if (y < WATER_Y + 0.05) {
      tmpColor.copy(C_BED);
    } else {
      tmpColor.copy(C_SOIL_DRY).lerp(C_SOIL_WET, clamp(m * 1.05, 0, 1));
      const sand = smoothstep(4.6, 2.4, d) * smoothstep(WATER_Y + 0.02, WATER_Y + 0.5, y);
      tmpColor.lerp(C_SAND, sand * 0.85);
      const green = clamp(g * 0.95, 0, 1);
      tmpColor.lerp(seasonNow.terrGrass, green * 0.8);
      // 湿地の緑は植生があるところだけ
      const veg = clamp((g + r) * 2.2, 0, 1);
      const wet = clamp(r * 0.9 + Math.max(0, m - 0.62) * 1.6 * veg, 0, 1);
      tmpColor.lerp(seasonNow.terrWet, wet * 0.7);
      tmpColor.lerp(seasonNow.terrForest, clamp(t * 1.1, 0, 1) * 0.75);
      // アレチウリに覆われた場所はくすんだ色に
      tmpColor.lerp(vineGround, clamp(v * 1.15, 0, 1) * 0.8);
      const hl = clamp((y - 0.4) / 3.2, 0, 1);
      tmpColor2.setRGB(1, 0.99, 0.94);
      tmpColor.lerp(tmpColor2, hl * 0.1);
    }
    const n = (hash2(Math.round(x * 53), Math.round(z * 53)) - 0.5) * 0.07;
    tmpColor.offsetHSL(0, 0, n * 0.5);
    colAttr.setXYZ(i, tmpColor.r, tmpColor.g, tmpColor.b);
  }
  colAttr.needsUpdate = true;
}

// ---------------- 虫 ----------------
// 飛びまわる → 植物に近づいてとまる → しばらく休む → 飛び立つ

const INSECT_MAX = 60;
const insectMat = new THREE.MeshBasicMaterial({ color: 0xfff4c8 });
const insectMesh = new THREE.InstancedMesh(
  new THREE.SphereGeometry(0.05, 5, 4), insectMat, INSECT_MAX
);
insectMesh.count = 0;
scene.add(insectMesh);

const insects = [];
const insectRng = mulberry32(999);

function cellVegAt(i) {
  return grass[i] + reed[i] + flower[i] * 2 + shrub[i];
}

function findInsectAnchor() {
  // 植生があり、できれば境目(エコトーン)や水辺のセルを探す
  for (let tryN = 0; tryN < 60; tryN++) {
    const i = Math.floor(insectRng() * NCELL);
    if (isWater[i] || vine[i] > 0.4) continue;
    const veg = cellVegAt(i);
    const nearWater = cellRiverD[i] < 10;
    if (veg < (nearWater ? 0.28 : 0.35)) continue;
    const r = neighborIdx(i, 1, 0), dn = neighborIdx(i, 0, 1);
    const isEdge = (r >= 0 && biome[r] !== biome[i]) || (dn >= 0 && biome[dn] !== biome[i]);
    if (!isEdge && !nearWater && insectRng() < 0.6) continue;
    const [x, z] = cellCenter(i);
    return { x, z, y: cellHeight[i], cell: i };
  }
  return null;
}

function spawnInsect() {
  const a = findInsectAnchor();
  if (!a) return false;
  const ang = insectRng() * Math.PI * 2;
  const r = 0.25 + insectRng() * 0.7;
  insects.push({
    ax: a.x, az: a.z, ay: a.y + 0.5 + insectRng() * 0.7, cell: a.cell,
    r, ang, speed: 0.8 + insectRng() * 1.6,
    bobPhase: insectRng() * Math.PI * 2,
    bob: 1.2 + insectRng() * 2,
    state: 'fly', timer: 2 + insectRng() * 5,
    px: a.x + Math.cos(ang) * r, py: a.y + 0.8, pz: a.z + Math.sin(ang) * r,
    perchX: 0, perchY: 0, perchZ: 0,
    fx: 1, fz: 0,
    panic: 0,
  });
  return true;
}

function updateInsectPopulation() {
  const target = Math.max(0, Math.min(
    INSECT_MAX,
    Math.floor(
      (metrics.grassSum / 45 + metrics.reedSum / 25 + metrics.flowerSum / 12
        + metrics.edges / 150) * seasonNow.insectF
      - metrics.vineSum / 30
    )
  ));
  let guard = 0;
  while (insects.length < target && guard++ < 30) {
    if (!spawnInsect()) break;
  }
  while (insects.length > target) insects.pop();
  metrics.insects = insects.length;
}

function animateInsects(t, dt) {
  for (let i = 0; i < insects.length; i++) {
    const b = insects[i];
    const speedMul = b.panic > 0 ? 2.6 : 1;
    if (b.panic > 0) b.panic -= dt;
    const prevX = b.px, prevZ = b.pz;

    if (b.state === 'fly') {
      b.ang += dt * b.speed * speedMul;
      b.px = b.ax + Math.cos(b.ang) * b.r + Math.sin(b.ang * 2.3) * 0.1;
      b.py = b.ay + Math.sin(t * b.bob + b.bobPhase) * 0.22;
      b.pz = b.az + Math.sin(b.ang) * b.r;
      b.timer -= dt;
      if (b.timer <= 0) {
        // 植物が多いほどとまりやすい
        const veg = cellVegAt(b.cell);
        if (insectRng() < clamp(0.25 + veg * 0.45, 0, 0.9)) {
          const h = 0.2 + clamp(grass[b.cell] * 0.35 + reed[b.cell] * 0.95 + shrub[b.cell] * 0.55, 0, 1.15);
          b.perchX = b.ax + (insectRng() - 0.5) * 0.5;
          b.perchZ = b.az + (insectRng() - 0.5) * 0.5;
          b.perchY = cellHeight[b.cell] + h;
          b.state = 'toPerch';
        } else {
          b.timer = 3 + insectRng() * 5;
        }
      }
    } else if (b.state === 'toPerch') {
      const dx = b.perchX - b.px, dy = b.perchY - b.py, dz = b.perchZ - b.pz;
      const dist = Math.hypot(dx, dy, dz);
      const step = dt * 1.6 * speedMul;
      if (dist < 0.07) {
        b.state = 'perch';
        b.timer = 2.5 + insectRng() * 4;
      } else {
        b.px += dx / dist * Math.min(step, dist);
        b.py += dy / dist * Math.min(step, dist);
        b.pz += dz / dist * Math.min(step, dist);
      }
      if (b.panic > 0) { b.state = 'fly'; b.timer = 2; } // 狙われたら逃げる
    } else { // perch:植物にとまって休む
      b.px = b.perchX;
      b.py = b.perchY + Math.sin(t * 3 + b.bobPhase) * 0.015;
      b.pz = b.perchZ;
      b.timer -= dt;
      if (b.timer <= 0 || b.panic > 0) {
        // 飛び立つ:とまっていた場所を中心に旋回をやり直す
        b.ax = b.perchX; b.az = b.perchZ;
        b.ay = b.perchY + 0.45 + insectRng() * 0.4;
        b.ang = insectRng() * Math.PI * 2;
        b.r = 0.25 + insectRng() * 0.6;
        b.state = 'fly';
        b.timer = 3 + insectRng() * 5;
      }
    }

    const mvx = b.px - prevX, mvz = b.pz - prevZ;
    if (mvx * mvx + mvz * mvz > 1e-8) {
      const l = Math.hypot(mvx, mvz);
      b.fx = mvx / l; b.fz = mvz / l;
    }
    tmpMat.makeTranslation(b.px, b.py, b.pz);
    insectMesh.setMatrixAt(i, tmpMat);
  }
  insectMesh.count = insects.length;
  insectMesh.instanceMatrix.needsUpdate = true;
}

// ---------------- 魚 ----------------
// 川の中を行き来し、背中が水面に少しだけ出る。水辺が豊かなほど増える。

const FISH_MAX = 8;
const fishes = [];
const fishRng = mulberry32(5150);
const fishBodyMat = new THREE.MeshStandardMaterial({ color: 0x5e7079, roughness: 0.55 });
const fishTailMat = new THREE.MeshStandardMaterial({
  color: 0x52626a, roughness: 0.6, side: THREE.DoubleSide,
});

function spawnFish() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.13, 6, 5), fishBodyMat);
  body.scale.set(0.5, 0.55, 1.5);
  group.add(body);
  const tail = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.1), fishTailMat);
  tail.rotation.y = Math.PI / 2;
  tail.position.set(0, 0.01, -0.24);
  group.add(tail);
  scene.add(group);
  const f = {
    group, tail,
    z: -HALF + 4 + fishRng() * (WORLD - 8),
    dir: fishRng() < 0.5 ? 1 : -1,
    speed: 0.55 + fishRng() * 0.5,
    offPhase: fishRng() * Math.PI * 2,
    yaw: 0,
    targeted: false,
  };
  fishes.push(f);
  return f;
}

function removeFish(f) {
  const idx = fishes.indexOf(f);
  if (idx >= 0) fishes.splice(idx, 1);
  scene.remove(f.group);
  metrics.fish = fishes.length;
}

function updateFishPopulation() {
  const target = clamp(
    Math.floor(metrics.waterside / 16 * seasonNow.fishF) - Math.floor(metrics.invasion / 15),
    0, FISH_MAX
  );
  while (fishes.length < target) spawnFish();
  while (fishes.length > target) removeFish(fishes[fishes.length - 1]);
  metrics.fish = fishes.length;
}

function animateFish(t, dt) {
  for (const f of fishes) {
    const sp = f.speed * seasonNow.fishF * (f.targeted ? 2.4 : 1);
    f.z += f.dir * sp * dt;
    if (f.z > HALF - 3) { f.z = HALF - 3; f.dir = -1; }
    if (f.z < -HALF + 3) { f.z = -HALF + 3; f.dir = 1; }
    const off = Math.sin(t * 0.4 + f.offPhase) * 0.55 + (f.targeted ? Math.sin(t * 6) * 0.3 : 0);
    const x = riverX(f.z) + off;
    const y = WATER_Y - 0.04 + Math.sin(t * 1.8 + f.offPhase) * 0.025;
    const prev = f.group.position;
    const dx = x - prev.x, dz = f.z - prev.z;
    if (dx * dx + dz * dz > 1e-9) {
      const targetYaw = Math.atan2(dx, dz);
      let dyaw = targetYaw - f.yaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      f.yaw += dyaw * Math.min(1, dt * 4);
    }
    f.group.position.set(x, y, f.z);
    f.group.rotation.y = f.yaw;
    f.tail.rotation.y = Math.PI / 2 + Math.sin(t * 7 + f.offPhase) * 0.45 * (f.targeted ? 1.6 : 1);
  }
}

// 水しぶき(鳥が魚を捕るときの小さな演出)
const splashes = [];
for (let i = 0; i < 4; i++) {
  const mat = new THREE.SpriteMaterial({
    map: radialTex, transparent: true, opacity: 0, depthWrite: false,
  });
  const sp = new THREE.Sprite(mat);
  sp.visible = false;
  scene.add(sp);
  splashes.push({ sprite: sp, t: 1 });
}

function splashAt(x, z) {
  const s = splashes.find((sp) => sp.t >= 1) || splashes[0];
  s.t = 0;
  s.sprite.position.set(x, WATER_Y + 0.08, z);
  s.sprite.visible = true;
}

function animateSplashes(dt) {
  for (const s of splashes) {
    if (s.t >= 1) { s.sprite.visible = false; continue; }
    s.t += dt * 2.0;
    const k = Math.min(s.t, 1);
    s.sprite.scale.setScalar(0.4 + k * 1.4);
    s.sprite.material.opacity = 0.55 * (1 - k);
  }
}

// ---------------- 鳥 ----------------
// ふだんは旋回し、ときどき虫や魚に狙いを定めて
// 「近づく → 捕る → 離れる」の流れで捕食する。

const BIRD_MAX = 6;
const birds = [];
const birdRng = mulberry32(2222);

function makeBird() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4d4a44, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.7, 6), bodyMat);
  body.rotation.x = Math.PI / 2;
  group.add(body);
  const wingGeo = new THREE.PlaneGeometry(0.62, 0.2);
  wingGeo.translate(0.31, 0, 0);
  const wingMat = new THREE.MeshStandardMaterial({
    color: 0x5a564e, roughness: 0.85, side: THREE.DoubleSide,
  });
  const wingL = new THREE.Mesh(wingGeo, wingMat);
  const wingR = new THREE.Mesh(wingGeo.clone(), wingMat);
  wingR.rotation.z = Math.PI;
  group.add(wingL, wingR);
  group.scale.setScalar(0.8);
  group.visible = false;
  scene.add(group);
  return {
    group, wingL, wingR,
    cx: (birdRng() - 0.5) * 18, cz: (birdRng() - 0.5) * 18,
    r: 8 + birdRng() * 6,
    h: 11.5 + birdRng() * 4.5,
    speed: (0.1 + birdRng() * 0.08) * (birdRng() < 0.5 ? 1 : -1),
    phase: birdRng() * Math.PI * 2,
    flap: 5 + birdRng() * 3,
    mode: 'soar',
    target: null,        // { kind: 'insect'|'fish', ref }
    timer: 0,
    huntCd: 6 + birdRng() * 10,
    leaveX: 0, leaveY: 0, leaveZ: 0,
    roll: 0,
    prev: new THREE.Vector3(),
  };
}
for (let i = 0; i < BIRD_MAX; i++) birds.push(makeBird());

function clearBirdTarget(b) {
  if (b.target) {
    if (b.target.kind === 'fish' && b.target.ref) b.target.ref.targeted = false;
    b.target = null;
  }
}

function updateBirdPopulation() {
  // 虫がある程度いて環境が豊かだと鳥が来る。魚がいるとさらに来やすい
  let base = Math.floor((metrics.diversity - 40) / 8);
  if (metrics.fish > 2) base += 1;
  let target = clamp(Math.round(base * seasonNow.birdF), 0, BIRD_MAX);
  if (metrics.insects < 3) target = Math.min(target, metrics.insects > 0 ? 1 : 0);
  for (let i = 0; i < BIRD_MAX; i++) {
    const b = birds[i];
    const show = i < target;
    if (!show && b.group.visible) {
      clearBirdTarget(b);
      b.mode = 'soar';
    }
    b.group.visible = show;
  }
  metrics.birds = target;
}

function birdTryHunt(b, t) {
  const wantFish = fishes.length > 0 && (birdRng() < 0.35 || insects.length === 0);
  if (wantFish) {
    const ref = fishes[Math.floor(birdRng() * fishes.length)];
    ref.targeted = true;
    b.target = { kind: 'fish', ref };
    b.mode = 'approach';
    return true;
  }
  if (insects.length > 0) {
    const ref = insects[Math.floor(birdRng() * insects.length)];
    ref.panic = 2.5;
    b.target = { kind: 'insect', ref };
    b.mode = 'approach';
    return true;
  }
  return false;
}

const birdTp = new THREE.Vector3();

function birdTargetPoint(b) {
  if (b.target.kind === 'insect') {
    const r = b.target.ref;
    birdTp.set(r.px, r.py + 0.05, r.pz);
  } else {
    const p = b.target.ref.group.position;
    birdTp.set(p.x, WATER_Y + 0.34, p.z);
  }
  return birdTp;
}

function birdTargetAlive(b) {
  if (!b.target) return false;
  if (b.target.kind === 'insect') return insects.includes(b.target.ref);
  return fishes.includes(b.target.ref);
}

function reanchorBird(b, t) {
  // いまの位置を通る旋回円に戻す(ワープさせない)
  const p = b.group.position;
  const dx = p.x - b.cx, dz = p.z - b.cz;
  b.r = clamp(Math.hypot(dx, dz), 7, 14);
  b.h = clamp(p.y, 8.5, 16);
  const ang = Math.atan2(dz, dx);
  b.phase = ang - t * b.speed;
  b.mode = 'soar';
  b.huntCd = (7 + birdRng() * 9) / Math.max(0.35, seasonNow.birdF);
}

function animateBirds(t, dt) {
  for (const b of birds) {
    if (!b.group.visible) continue;
    b.prev.copy(b.group.position);
    const p = b.group.position;
    let flapMul = 1;
    let targetRoll = 0;

    if (b.mode === 'soar') {
      const a = t * b.speed + b.phase;
      p.set(
        b.cx + Math.cos(a) * b.r,
        b.h + Math.sin(t * 0.5 + b.phase) * 0.8,
        b.cz + Math.sin(a) * b.r
      );
      targetRoll = -0.25 * (b.speed > 0 ? 1 : -1);
      b.huntCd -= dt;
      if (b.huntCd <= 0) {
        if (!birdTryHunt(b, t)) b.huntCd = 4 + birdRng() * 6;
      }
    } else if (b.mode === 'approach') {
      if (!birdTargetAlive(b)) {
        clearBirdTarget(b);
        b.mode = 'leave';
        b.timer = 1.2;
        b.leaveX = p.x; b.leaveY = p.y + 3; b.leaveZ = p.z;
      } else {
        const tp = birdTargetPoint(b);
        const speed = b.target.kind === 'fish' ? 7.5 : 6.5;
        const dx = tp.x - p.x, dy = tp.y - p.y, dz = tp.z - p.z;
        const dist = Math.hypot(dx, dy, dz);
        const step = Math.min(speed * dt, dist);
        p.x += dx / dist * step;
        p.y += dy / dist * step;
        p.z += dz / dist * step;
        flapMul = 1.9;
        if (dist < 0.5) { b.mode = 'strike'; b.timer = 0.32; }
      }
    } else if (b.mode === 'strike') {
      b.timer -= dt;
      if (birdTargetAlive(b)) {
        const tp = birdTargetPoint(b);
        p.lerp(tp, Math.min(1, dt * 8)); // 獲物に食らいつく
      }
      flapMul = 2.4;
      if (b.timer <= 0) {
        if (birdTargetAlive(b)) {
          if (b.target.kind === 'insect') {
            const idx = insects.indexOf(b.target.ref);
            if (idx >= 0) insects.splice(idx, 1);
            metrics.insects = insects.length;
          } else {
            splashAt(p.x, p.z);
            removeFish(b.target.ref);
          }
        }
        clearBirdTarget(b);
        // 上空へ離脱
        const awayX = p.x - b.cx, awayZ = p.z - b.cz;
        const awayL = Math.hypot(awayX, awayZ) || 1;
        b.leaveX = p.x + awayX / awayL * 2.5;
        b.leaveY = Math.max(p.y + 3.5, 9);
        b.leaveZ = p.z + awayZ / awayL * 2.5;
        b.mode = 'leave';
        b.timer = 2.2;
      }
    } else { // leave:飛び去って旋回に戻る
      b.timer -= dt;
      const dx = b.leaveX - p.x, dy = b.leaveY - p.y, dz = b.leaveZ - p.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 0.4 && b.timer > 0) {
        const step = Math.min(5 * dt, dist);
        p.x += dx / dist * step;
        p.y += dy / dist * step;
        p.z += dz / dist * step;
        flapMul = 1.5;
      } else {
        reanchorBird(b, t);
      }
    }

    // 進行方向を向く
    const vx = p.x - b.prev.x, vz = p.z - b.prev.z;
    if (vx * vx + vz * vz > 1e-9) {
      b.group.rotation.y = Math.atan2(vx, vz);
    }
    b.roll += (targetRoll - b.roll) * Math.min(1, dt * 4);
    b.group.rotation.z = b.roll;

    const flap = Math.sin(t * b.flap * flapMul + b.phase) * 0.55;
    b.wingL.rotation.z = flap;
    b.wingR.rotation.z = Math.PI - flap;
  }
}

// ---------------- 希少種 ----------------
// 条件のよいエコトーンにだけ、低確率でひっそりと現れる。

const RARE_MAX = 5;
const RARE_TYPES = {
  wet: { name: '湿地の希少植物', color: new THREE.Color('#e9b7cf') },
  grass: { name: '草地の希少植物', color: new THREE.Color('#cdd6f7') },
  water: { name: '水辺の希少生物', color: new THREE.Color('#bfe6dd') },
};
const rares = [];
const rareRng = mulberry32(8989);

function makeRareVisual(type, x, y, z) {
  const group = new THREE.Group();
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.02, 0.34, 5),
    new THREE.MeshStandardMaterial({ color: 0x6f8a55, roughness: 0.9 })
  );
  stem.position.y = 0.17;
  group.add(stem);
  const blossom = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.085, 0),
    new THREE.MeshStandardMaterial({
      color: RARE_TYPES[type].color,
      emissive: RARE_TYPES[type].color,
      emissiveIntensity: 0.4,
      roughness: 0.5,
    })
  );
  blossom.scale.set(1, 1.25, 1);
  blossom.position.y = 0.42;
  group.add(blossom);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTex, color: RARE_TYPES[type].color,
    transparent: true, opacity: 0.16, depthWrite: false,
  }));
  halo.scale.setScalar(1.25);
  halo.position.y = 0.42;
  group.add(halo);
  group.position.set(x, y, z);
  scene.add(group);
  return { group, halo, blossom };
}

function isEcotoneCell(i) {
  const r = neighborIdx(i, 1, 0), dn = neighborIdx(i, 0, 1);
  const l = neighborIdx(i, -1, 0), up = neighborIdx(i, 0, -1);
  return (r >= 0 && biome[r] !== biome[i]) || (dn >= 0 && biome[dn] !== biome[i])
    || (l >= 0 && biome[l] !== biome[i]) || (up >= 0 && biome[up] !== biome[i]);
}

function tryRareSpawn() {
  if (rares.length >= RARE_MAX || simDays < 40) return;
  if (metrics.diversity < 55 || metrics.edges < 600 || metrics.vineSum > 150) return;
  const p = protectionTimer > 0 ? 0.02 : 0.012;
  if (rareRng() >= p) return;
  for (let tryN = 0; tryN < 80; tryN++) {
    const i = Math.floor(rareRng() * NCELL);
    if (isWater[i] || vine[i] > 0.05) continue;
    if (grass[i] + reed[i] + shrub[i] < 0.3) continue;
    if (!isEcotoneCell(i)) continue;
    const cx = i % GRID, cz = Math.floor(i / GRID);
    let tooClose = false;
    for (const r of rares) {
      const dx = cx - r.cellX, dz = cz - r.cellZ;
      if (dx * dx + dz * dz < 36) { tooClose = true; break; }
    }
    if (tooClose) continue;
    let type = 'grass';
    if (biome[i] === BIOME.WETLAND || moisture[i] > 0.6) type = 'wet';
    else if (cellRiverD[i] < 6) type = 'water';
    const [x, z] = cellCenter(i);
    const jx = x + (rareRng() - 0.5) * 0.4;
    const jz = z + (rareRng() - 0.5) * 0.4;
    const vis = makeRareVisual(type, jx, terrainHeight(jx, jz) - 0.02, jz);
    rares.push({
      ...vis, type, cell: i, cellX: cx, cellZ: cz,
      health: 0.5, pulse: rareRng() * Math.PI * 2,
    });
    toast(`希少種が現れました:${RARE_TYPES[type].name}`);
    return;
  }
}

function updateRares() {
  tryRareSpawn();
  for (let k = rares.length - 1; k >= 0; k--) {
    const r = rares[k];
    const i = r.cell;
    const localVine = vine[i] + neighborAvg(vine, i);
    const veg = clamp(grass[i] + reed[i] + shrub[i] + tree[i], 0, 1);
    const q = 0.5 * veg
      + 0.25 * clamp(metrics.diversity / 60, 0, 1)
      + 0.25 * (isEcotoneCell(i) ? 1 : 0.4);
    let dh = (q - 0.55) * 0.02 - localVine * 0.08;
    if (protectionTimer > 0) dh += 0.015;
    if (seasonNow.growth < 0.3) dh -= 0.002; // 冬はわずかに厳しい
    r.health = clamp(r.health + dh, 0, 1);
    if (r.health <= 0.03) {
      scene.remove(r.group);
      rares.splice(k, 1);
      toast('希少種が姿を消しました…');
    }
  }
}

function animateRares(t) {
  for (const r of rares) {
    const s = 0.55 + 0.65 * r.health;
    r.group.scale.setScalar(s);
    r.halo.material.opacity = (0.1 + 0.07 * Math.sin(t * 1.4 + r.pulse)) * (0.4 + 0.6 * r.health);
  }
}

// ---------------- 雨 ----------------

const RAIN_COUNT = 900;
const rainGeo = new THREE.BufferGeometry();
{
  const arr = new Float32Array(RAIN_COUNT * 3);
  for (let i = 0; i < RAIN_COUNT; i++) {
    arr[i * 3] = (rng() - 0.5) * WORLD;
    arr[i * 3 + 1] = rng() * 16;
    arr[i * 3 + 2] = (rng() - 0.5) * WORLD;
  }
  rainGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
}
const rainMat = new THREE.PointsMaterial({
  color: 0xc2d4e4, size: 0.24, transparent: true, opacity: 0, depthWrite: false,
});
const rainPoints = new THREE.Points(rainGeo, rainMat);
scene.add(rainPoints);

function animateRain(dt) {
  if (rainTimer <= 0 && rainMat.opacity <= 0) return;
  rainTimer = Math.max(0, rainTimer - dt);
  const targetOp = rainTimer > 0 ? 0.7 : 0;
  rainMat.opacity += (targetOp - rainMat.opacity) * dt * 2.5;
  const pos = rainGeo.attributes.position;
  for (let i = 0; i < RAIN_COUNT; i++) {
    let y = pos.getY(i) - 17 * dt;
    if (y < -1) y = 14 + rng() * 3;
    pos.setY(i, y);
  }
  pos.needsUpdate = true;
  waterUniforms.uRain.value = clamp(rainMat.opacity / 0.7, 0, 1);
}

// ---------------- UI ----------------

const el = (id) => document.getElementById(id);
const valSeason = el('val-season');
const valTime = el('val-time');
const valPlants = el('val-plants');
const valDiversity = el('val-diversity');
const valWater = el('val-water');
const valInsects = el('val-insects');
const valBirds = el('val-birds');
const valFish = el('val-fish');
const valVine = el('val-vine');
const valSeedbank = el('val-seedbank');
const valNextrisk = el('val-nextrisk');
const valRemoval = el('val-removal');
const valRare = el('val-rare');
const meterDiversity = el('meter-diversity');
const toastEl = el('toast');
let toastTimer = null;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

const RISK_CLASS = { '低': 'low', '中': 'mid', '高': 'high' };

function updateSelectionUI() {
  const title = el('selection-title');
  const detail = el('selection-detail');
  const cullBtn = el('btn-cull');
  const plantBtn = el('btn-plant');
  if (!cursorSelected) {
    title.textContent = '手入れする場所を選択';
    detail.textContent = '地面をクリック／タップしてください';
    cullBtn.disabled = true;
    plantBtn.disabled = true;
    return;
  }
  const r2 = CURSOR_RADIUS * CURSOR_RADIUS;
  let visibleVines = 0;
  let seedCells = 0;
  for (let i = 0; i < NCELL; i++) {
    const [x, z] = cellCenter(i);
    const dx = x - cursorPos.x;
    const dz = z - cursorPos.z;
    if (dx * dx + dz * dz > r2) continue;
    if (vine[i] > 0.01) visibleVines++;
    if (vineSeed[i] > 0.05) seedCells++;
  }
  title.textContent = visibleVines > 0 ? `外来種あり：${visibleVines}か所` : '外来種は見つかりません';
  detail.textContent = seedCells > visibleVines
    ? `選択範囲に土中の種子あり（${VINE_STAGE_JP[vinePh.stage]}）`
    : `選択範囲を手入れできます（${VINE_STAGE_JP[vinePh.stage]}）`;
  cullBtn.disabled = visibleVines === 0;
  plantBtn.disabled = false;
}

function updateStatsUI() {
  valSeason.textContent = seasonNow.name;
  valTime.textContent = `${Math.floor(simDays)}日`;
  valPlants.textContent = metrics.plants.toLocaleString();
  valDiversity.textContent = metrics.diversity;
  valWater.textContent = metrics.waterside;
  valInsects.textContent = metrics.insects;
  valBirds.textContent = metrics.birds;
  valFish.textContent = metrics.fish;
  // 外来種:侵略度% と現在の生活史ステージ
  valVine.textContent = metrics.vineStage === '—'
    ? `${metrics.invasion}%`
    : `${metrics.invasion}% ${metrics.vineStage}`;
  const lvlClass = (lvl) => RISK_CLASS[lvl] || (lvl === '多' ? 'high' : lvl === '中' ? 'mid' : 'low');
  valSeedbank.innerHTML = `<span class="lvl ${lvlClass(metrics.seedBankLevel)}">${metrics.seedBankLevel}</span>`;
  valNextrisk.innerHTML = `<span class="lvl ${lvlClass(metrics.nextYearRisk)}">${metrics.nextYearRisk}</span>`;
  valRemoval.innerHTML = `<span class="lvl ${lvlClass(metrics.removalDifficulty)}">${metrics.removalDifficulty}</span>`;
  if (metrics.rareCount === 0) {
    valRare.textContent = metrics.rareRisk === '—' ? '—' : '0';
  } else {
    const cls = RISK_CLASS[metrics.rareRisk] || 'low';
    valRare.innerHTML = `${metrics.rareCount}<span class="risk ${cls}">${metrics.rareRisk}</span>`;
  }
  meterDiversity.style.width = `${metrics.diversity}%`;
  // 保護ボタンの状態
  const pBtn = el('btn-protect');
  pBtn.classList.toggle('active', protectionTimer > 0);
  pBtn.querySelector('.label').textContent = protectionTimer > 0 ? '保護中' : '保護';
  updateSelectionUI();
}

el('btn-pause').addEventListener('click', () => {
  paused = !paused;
  const btn = el('btn-pause');
  btn.querySelector('.icon').textContent = paused ? '▶' : '⏸';
  btn.querySelector('.label').textContent = paused ? '再開' : '停止';
  btn.classList.toggle('active', paused);
  toast(paused ? '時間を止めました' : '時間が流れはじめました');
});

el('btn-speed').addEventListener('click', () => {
  const next = TIME_SCALES[(TIME_SCALES.indexOf(timeScale) + 1) % TIME_SCALES.length];
  timeScale = next;
  const btn = el('btn-speed');
  btn.querySelector('.label').textContent = `×${next}`;
  btn.classList.toggle('active', next !== 1);
  toast(`時間の速さ:×${next}`);
});

el('btn-rain').addEventListener('click', () => {
  rainBoost = clamp(rainBoost + 0.38, 0, 0.65);
  rainTimer = 9;
  // 土が水を吸いきれないほどの大雨は氾濫につながる
  if (rainBoost > 0.55 && !floodAnim) {
    triggerFlood('大雨で川が氾濫!低地が濁流に沈みました');
  } else {
    toast('雨が降りはじめました');
  }
});

el('btn-flood').addEventListener('click', () => {
  if (floodAnim) return;
  rainTimer = Math.max(rainTimer, 5);
  triggerFlood();
});

el('btn-plant').addEventListener('click', () => {
  if (!cursorSelected) return;
  const r2 = CURSOR_RADIUS * CURSOR_RADIUS; // カーソル範囲(水平距離の二乗で判定)
  // まずカーソル範囲内の適地セルを集める(陸で条件を満たすセルのみ)
  const candidates = [];
  for (let i = 0; i < NCELL; i++) {
    if (isWater[i]) continue;
    const [cxw, czw] = cellCenter(i);
    const dx = cxw - cursorPos.x, dz = czw - cursorPos.z;
    if (dx * dx + dz * dz > r2) continue;
    if (moisture[i] > 0.24) candidates.push(i);
  }
  if (candidates.length === 0) {
    toast('この範囲には植えられる場所がありません');
    return;
  }
  // 適地に植える。1回で植える数は範囲内適地に応じた適量(最大12)。
  const target = Math.min(12, candidates.length);
  let placed = 0, guard = 0;
  while (placed < target && guard++ < 3000) {
    const i = candidates[Math.floor(insectRng() * candidates.length)];
    const m = moisture[i];
    if (m > 0.58 && cellRiverD[i] < 14) {
      reed[i] = Math.max(reed[i], 0.3 + insectRng() * 0.2);
    } else {
      grass[i] = Math.max(grass[i], 0.3 + insectRng() * 0.25);
      if (insectRng() < 0.3) flower[i] = Math.max(flower[i], 0.2);
    }
    placed++;
  }
  rebuildAllVegetation();
  updateStatsUI();
  toast('カーソル範囲に種をまきました');
});

// --- 駆除:アレチウリを刈り取る。成長段階で効果が変わる ---
// 芽生え・伸長:ほぼ根絶でき、種子バンクも減らせる
// 繁茂:一部だけ除去。大株ほど取り残しが多い(駆除難度)
// 結実後・枯死:地上部は減るが種子バンクは土に残り、翌年に発芽する
el('btn-cull').addEventListener('click', () => {
  if (!cursorSelected) return;
  const stage = vinePh.stage;
  const r2 = CURSOR_RADIUS * CURSOR_RADIUS; // カーソル範囲(水平距離の二乗で判定)
  let n = 0, seedLeft = false;
  for (let i = 0; i < NCELL; i++) {
    // カーソル範囲内のセルだけを対象にする(セル中心と cursorPos の水平距離)
    const [cxw, czw] = cellCenter(i);
    const dx = cxw - cursorPos.x, dz = czw - cursorPos.z;
    if (dx * dx + dz * dz > r2) continue;
    if (vine[i] <= 0.01 && vineSeed[i] <= 0.05) continue;
    if (vine[i] > 0.01) n++;
    const near = nearRareCell(i, 7); // 希少種の周りは優先的に手をかける
    if (stage === 'seedling' || stage === 'growing') {
      vine[i] = 0;
      vineSeed[i] *= near ? 0.12 : 0.35;   // 早期は種子バンクも大きく減らせる
    } else if (stage === 'spreading') {
      // 大株ほど取り残す(駆除難度)。希少種周りは手厚く
      const leave = near ? 0.12 : clamp(0.25 + vine[i] * 0.35, 0.2, 0.6);
      vine[i] *= leave;
      vineSeed[i] *= near ? 0.5 : 0.75;
    } else {
      // 結実後・枯死:地上部は減り、立ち枯れごと取り除くと種子も多少持ち去れる
      // (ただし早期ほどは減らせず、土に残った種は翌年に発芽する)
      vine[i] *= near ? 0.2 : 0.5;
      vineSeed[i] *= near ? 0.6 : 0.8;
      if (vineSeed[i] > 0.3) seedLeft = true;
    }
  }
  if (n === 0 && !seedLeft) {
    toast('この範囲にアレチウリはありません');
    return;
  }
  computeMetrics();
  rebuildAllVegetation();
  recolorTerrain();
  updateStatsUI();
  if (seedLeft) {
    toast('地上部は刈れましたが、土の中に種子が残っています(翌年に注意)');
  } else if (stage === 'seedling' || stage === 'growing') {
    toast(`早期駆除に成功(カーソル範囲・${n}か所・種子バンクも抑制)`);
  } else {
    toast(`アレチウリを駆除しました(カーソル範囲・${n}か所・大株は取り残しあり)`);
  }
});

// --- 保護:希少種が生き残れる環境をしばらく見守る ---
el('btn-protect').addEventListener('click', () => {
  protectionTimer = 100; // 約100日のあいだ保護がつづく
  if (rares.length > 0) {
    toast('保護活動をはじめました(希少種のまわりを見守ります)');
  } else {
    toast('保護活動をはじめました(よい環境を見守ります)');
  }
  updateStatsUI();
});

// ---------------- 視点モード ----------------
// 観察(ジオラマ全体) / 鳥 / 魚 / 虫

const VIEW_SEQ = ['observe', 'bird', 'fish', 'insect'];
const VIEW_LABEL = { observe: '観察', bird: '鳥', fish: '魚', insect: '虫' };
const VIEW_ICON = { observe: '👁', bird: '🐦', fish: '🐟', insect: '🐝' };
let viewMode = 'observe';
let camTween = null;
const lookCur = new THREE.Vector3();
const camGoal = new THREE.Vector3();
const lookGoal = new THREE.Vector3();

function viewTargetExists(mode) {
  if (mode === 'bird') return birds.some((b) => b.group.visible);
  if (mode === 'fish') return fishes.length > 0;
  if (mode === 'insect') return insects.length > 0;
  return true;
}

function applyViewButton() {
  const btn = el('btn-view');
  btn.querySelector('.icon').textContent = VIEW_ICON[viewMode];
  btn.querySelector('.label').textContent = VIEW_LABEL[viewMode];
  btn.classList.toggle('active', viewMode !== 'observe');
}

function setViewMode(mode, silent) {
  const prevMode = viewMode;
  viewMode = mode;
  if (mode === 'observe') {
    controls.enabled = true;
    if (prevMode !== 'observe') {
      camTween = {
        t: 0,
        fromPos: camera.position.clone(),
        toPos: HOME_POS.clone(),
        fromTarget: lookCur.clone(),
        toTarget: HOME_TARGET.clone(),
      };
      controls.target.copy(lookCur);
    }
    if (!silent) toast('視点:観察(ジオラマ全体)');
  } else {
    controls.enabled = false;
    controls.autoRotate = false;
    camTween = null;
    lookCur.copy(controls.target);
    if (!silent) toast(`視点:${VIEW_LABEL[mode]}(ボタンでもどれます)`);
  }
  // 鳥視点では虫と魚をほんの少し見つけやすく
  insectMat.color.set(viewMode === 'bird' ? 0xffffff : 0xfff4c8);
  fishBodyMat.emissive.set(viewMode === 'bird' ? 0x16282e : 0x000000);
  applyViewButton();
}

el('btn-view').addEventListener('click', () => {
  const next = VIEW_SEQ[(VIEW_SEQ.indexOf(viewMode) + 1) % VIEW_SEQ.length];
  if (next !== 'observe' && !viewTargetExists(next)) {
    toast(`まだ${VIEW_LABEL[next]}がいません(観察にもどります)`);
    setViewMode('observe', true);
    return;
  }
  setViewMode(next);
});

function updateCreatureCamera(dt) {
  let ok = false;
  if (viewMode === 'bird') {
    // 狩りの最中の鳥がいれば優先して追う
    const b = birds.find((x) => x.group.visible && x.mode !== 'soar')
      || birds.find((x) => x.group.visible);
    if (b) {
      const p = b.group.position;
      const yaw = b.group.rotation.y;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const low = b.mode === 'approach' || b.mode === 'strike' ? 1.1 : 2.0;
      camGoal.set(p.x - fx * 4.5, p.y + low, p.z - fz * 4.5);
      lookGoal.set(p.x + fx * 3, p.y - (b.mode === 'soar' ? 1.2 : 0.2), p.z + fz * 3);
      ok = true;
    }
  } else if (viewMode === 'fish') {
    const f = fishes[0];
    if (f) {
      const p = f.group.position;
      const fx = Math.sin(f.yaw), fz = Math.cos(f.yaw);
      camGoal.set(p.x - fx * 2.6, Math.max(p.y + 0.7, WATER_Y + 0.32), p.z - fz * 2.6);
      lookGoal.set(p.x + fx * 2.2, p.y + 0.1, p.z + fz * 2.2);
      ok = true;
    }
  } else if (viewMode === 'insect') {
    const ins = insects[0];
    if (ins) {
      camGoal.set(ins.px - ins.fx * 1.1, ins.py + 0.34, ins.pz - ins.fz * 1.1);
      const minY = terrainHeight(camGoal.x, camGoal.z) + 0.22;
      if (camGoal.y < minY) camGoal.y = minY;
      lookGoal.set(ins.px + ins.fx * 0.7, ins.py + 0.03, ins.pz + ins.fz * 0.7);
      ok = true;
    }
  }
  if (!ok) {
    toast(`${VIEW_LABEL[viewMode]}がいなくなったので観察にもどります`);
    setViewMode('observe', true);
    return;
  }
  const k = 1 - Math.exp(-dt * 2.2);
  camera.position.lerp(camGoal, k);
  lookCur.lerp(lookGoal, k);
  camera.lookAt(lookCur);
}

el('btn-reset').addEventListener('click', () => {
  vegSeedRng = mulberry32(Math.floor(Math.random() * 1e9));
  simDays = 0;
  rainBoost = 0;
  rainTimer = 0;
  protectionTimer = 0;
  floodAnim = null;
  floodPlane.visible = false;
  waterUniforms.uFlood.value = 0;
  insects.length = 0;
  while (fishes.length) removeFish(fishes[0]);
  for (const r of rares) scene.remove(r.group);
  rares.length = 0;
  for (const b of birds) { clearBirdTarget(b); b.mode = 'soar'; }
  seedInitialVegetation();
  for (let i = 0; i < NCELL; i++) biome[i] = isWater[i] ? BIOME.WATER : BIOME.BARE;
  updateSeason(0);
  updateVinePhenology(0);
  if (viewMode !== 'observe') setViewMode('observe', true);
  computeMetrics();
  updateInsectPopulation();
  updateFishPopulation();
  updateBirdPopulation();
  rebuildAllVegetation();
  applySeasonTints();
  recolorTerrain();
  updateStatsUI();
  toast('はじめからやり直します');
});

// ---------------- メインループ ----------------

let tickAccum = 0;
let lastTime = performance.now() / 1000;
const warmSunColor = new THREE.Color(0xffdfae);
const richFog = new THREE.Color(0xc4d8c2);
const baseGround = new THREE.Color(0x7a6a4e);
const richGround = new THREE.Color(0x5f7048);
const tmpSun = new THREE.Color();

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000;
  const dt = Math.min(now - lastTime, 0.1);
  lastTime = now;

  // シミュレーション(timeScale で日数の進みだけを速める)
  if (!paused) {
    tickAccum += dt * timeScale;
    while (tickAccum >= TICK_SEC) {
      tickAccum -= TICK_SEC;
      simTick();
      computeMetrics();
      updateRares();
      updateInsectPopulation();
      updateFishPopulation();
      updateBirdPopulation();
      computeMetrics(); // 生きものの数を多様性に反映
      rebuildAllVegetation();
      applySeasonTints();
      recolorTerrain();
      updateStatsUI();
    }
  }

  // 季節と1日の中の淡い光の変化
  const cyc = (now * 0.02) % 1;
  const warm = (Math.sin(cyc * Math.PI * 2) + 1) / 2;
  tmpSun.copy(seasonNow.sun).lerp(warmSunColor, warm * 0.25);
  sun.color.copy(tmpSun);
  sun.intensity = seasonNow.sunI * lerp(1, 0.92, warm) * lerp(1, 0.82, waterUniforms.uRain.value);
  hemi.intensity = lerp(0.85, 0.75, waterUniforms.uRain.value);

  // 植生が増えると空気が少し緑がかる
  const rich = clamp(metrics.vegRatio * 1.6, 0, 1);
  scene.fog.color.copy(seasonNow.fog).lerp(richFog, rich * 0.4);
  hemi.groundColor.copy(baseGround).lerp(richGround, rich);

  // 氾濫:水位が上がり、低地が沈み、引いた土から芽が出る
  if (floodAnim) {
    floodAnim.t += dt / 14; // 全体で約14秒
    const env = smoothstep(0, 0.16, floodAnim.t) * (1 - smoothstep(0.55, 0.92, floodAnim.t));
    floodPlane.visible = env > 0.02;
    floodPlane.position.y = WATER_Y + 0.05 + FLOOD_RISE * env
      + Math.sin(now * 1.7) * 0.02; // 水面のゆらぎ
    floodPlane.material.opacity = 0.72 + Math.sin(now * 2.3) * 0.035;
    waterUniforms.uFlood.value = env;
    if (!floodAnim.washed && floodAnim.t > 0.18) {
      floodAnim.washed = true;
      applyFloodWash();
    }
    if (!floodAnim.sprouted && floodAnim.t > 0.85) {
      floodAnim.sprouted = true;
      toast('土の中で眠っていた種が芽吹きはじめました');
    }
    if (floodAnim.t >= 1) {
      floodAnim = null;
      floodPlane.visible = false;
      waterUniforms.uFlood.value = 0;
    }
  }

  // アニメーション
  waterUniforms.uTime.value = now;
  sharedSwayUniform.value = now;
  animateInsects(now, dt);
  animateFish(now, dt);
  animateBirds(now, dt);
  animateSplashes(dt);
  animateRares(now);
  animateRain(dt);
  for (const c of clouds) {
    c.position.x += c.userData.speed * dt;
    if (c.position.x > 55) c.position.x = -55;
  }

  // 円状カーソル:観察モードのときだけ表示し、cursorPos へなめらかに追従。
  // 視点モード(鳥/魚/虫)中は隠す。
  if (viewMode === 'observe') {
    cursorRing.visible = cursorSelected;
    cursorRing.position.x = lerp(cursorRing.position.x, cursorPos.x, 0.25);
    cursorRing.position.z = lerp(cursorRing.position.z, cursorPos.z, 0.25);
    cursorRing.position.y = lerp(cursorRing.position.y, cursorPos.y + 0.05, 0.25);
    // ごく弱い脈動(透明度)。派手にしない。
    cursorMat.opacity = 0.42 + Math.sin(now * 2.2) * 0.08;
  } else {
    cursorRing.visible = false;
  }

  // カメラ
  if (viewMode !== 'observe') {
    updateCreatureCamera(dt);
  } else {
    if (camTween) {
      camTween.t += dt / 1.6;
      const k = camTween.t >= 1 ? 1 : (camTween.t < 0.5
        ? 4 * camTween.t ** 3
        : 1 - Math.pow(-2 * camTween.t + 2, 3) / 2);
      camera.position.lerpVectors(camTween.fromPos, camTween.toPos, k);
      controls.target.lerpVectors(camTween.fromTarget, camTween.toTarget, k);
      if (camTween.t >= 1) camTween = null;
    }
    controls.update();
  }
  renderer.render(scene, camera);
}

// ---------------- 初期化 ----------------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

updateSeason(0);
updateVinePhenology(0);
simTick();
computeMetrics();
updateInsectPopulation();
updateFishPopulation();
updateBirdPopulation();
rebuildAllVegetation();
applySeasonTints();
recolorTerrain();
updateStatsUI();
applyViewButton();
frame();
