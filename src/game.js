import * as THREE from "three";
import { InputManager } from "./input.js";
import { loadSettings, saveSettings, loadSavedGame, saveGameState } from "./storage.js";

// —— 3D 帆船賽(sailing3d)——「航海引擎」首發(2026-07-15:fork equestrian3d 換皮;之後換皮=保羅海難/約拿風暴船)。
// 照 3d-game-kit:renderer/lights/makePerson 臉部鐵則、相機視角檔+lerp、量值可調、判定=畫面。
// 玩法核心:船沿航線自動尋路(CatmullRom 閉環),玩家只管兩件事——
//   ①節奏控速(按住 W/↑ 或「加速」鈕=快步,放開=收步)②綠區時機起跳(空白鍵/點畫面)。
// ★判定=畫面(鐵則4):按下轉舵當下就用時機誤差算出「乾淨繞標/擦標」,再把過標演出來;
//   浮標只在船身經過後才傾倒——畫面說不通的罰分=bug。
// ★溫柔規則:不會翻船、不會淘汰;沒按轉舵=船自己勉強繞過(多半擦標),永遠跑得完。

// ---------- 可調量值 ----------
// window=起跳時機窗(秒,skijump 綠區同款);boost=加速增量;timeAllowed=容許時間(超時每 4 秒+1 罰分)
export const DIFFICULTY_PRESETS = {
  // 難度承襲 equestrian 07-15 收緊版:窗更窄、船更快、時間更緊(幼兒保持友善)
  kids: { baseSpeed: 7.0, boost: 2.5, window: 0.32, fences: 6, timeAllowed: 999, assist: 0.5 },
  child: { baseSpeed: 8.2, boost: 3.0, window: 0.21, fences: 7, timeAllowed: 105, assist: 0.3 },
  easy: { baseSpeed: 9.4, boost: 3.6, window: 0.15, fences: 8, timeAllowed: 82, assist: 0.12 },
  normal: { baseSpeed: 10.6, boost: 4.2, window: 0.105, fences: 9, timeAllowed: 66, assist: 0 },
  hard: { baseSpeed: 11.8, boost: 5.0, window: 0.075, fences: 11, timeAllowed: 56, assist: 0 },
};

export const DIFFICULTY_LABELS = {
  kids: "幼兒(超簡單)",
  child: "兒童(簡單)",
  easy: "入門",
  normal: "標準",
  hard: "職業",
};

export const GAME_MODES = {
  standard: {
    label: "繞標賽",
    description: "繞完整條航線——擦到浮標 +4 罰分、超時再加罰;零罰分=Clean Race!",
    goal: "罰分越少越好",
  },
  jumpoff: {
    label: "決勝航段",
    jumpoff: true,
    description: "縮短航線拼速度:成績=時間+罰分換算秒數,敢搶風才會贏。",
    goal: "總秒數越少越好",
  },
  race: {
    label: "雙帆競速",
    race: true,
    description: "跟 AI 銀帆手同場對飆——擦標會失速踉蹌,先衝過終點線的贏!",
    goal: "先到終點者勝",
  },
  windsurf: {
    label: "風浪板",
    windsurf: true,
    description: "換上風浪板站著馭風——船更輕、更快、更飄,繞標時機更刺激!",
    goal: "罰分越少越好",
  },
  practice: {
    label: "練習水域",
    endless: true,
    description: "無限圈數自由練——熟悉拉帆節奏與綠區轉舵手感。",
    goal: "純練手感,不計勝負",
  },
};

export function getModeConfig(modeId) {
  return GAME_MODES[modeId] || GAME_MODES.standard;
}

// ---------- 帆的配色(coat=帆布色、mane=船身/板身色;沿用 equestrian 換色管線) ----------
export const HORSE_COATS = {
  brown: { label: "經典白帆", coat: 0xf2efe6, mane: 0x2a5f8f },
  white: { label: "烈日紅帆", coat: 0xd8433c, mane: 0xf2efe6 },
  black: { label: "深海藍帆", coat: 0x2f5f9a, mane: 0xe8e4da },
  chestnut: { label: "夕陽橙帆", coat: 0xe08a2e, mane: 0x3a3a45 },
  grey: { label: "薄荷綠帆", coat: 0x4fae6a, mane: 0xf2efe6 },
  palomino: { label: "檸檬黃帆", coat: 0xf6d743, mane: 0x2e2a28 },
  pinto: { label: "紫羅蘭帆", coat: 0x8a5ac0, mane: 0xf2efe6 },
};


// ---------- 場地常數 ----------
const TAKEOFF_D = 2.6; // 理想轉舵點:標門前 2.6m(判定用時間域 err=|distToFence-TAKEOFF_D|/speed)
const JUMP_SPAN = 4.4; // 一跳跨越的路徑長(m)
const APPROACH_M = 14; // 進入「備跳」提示的距離
const RACE_LANE = 0.95; // 競速:兩船各偏航線中線一側
// AI 競速對手(依難度):skill=起跳品質期望、boostRatio=全速時間比
const RACE_AI = {
  kids: { skill: 0.35, boostRatio: 0.15 },
  child: { skill: 0.48, boostRatio: 0.3 },
  easy: { skill: 0.58, boostRatio: 0.45 },
  normal: { skill: 0.7, boostRatio: 0.6 },
  hard: { skill: 0.82, boostRatio: 0.78 },
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- 人物(照抄 archery3d makePerson:臉部鐵則+關節人物鐵則+長腿) ----------
function createLimb({ upperMaterial, lowerMaterial, endMaterial, upperLen, lowerLen, upperRadius, lowerRadius, end = "hand", thumbSide = 1 }) {
  const pivot = new THREE.Group();
  const upper = new THREE.Mesh(new THREE.CapsuleGeometry(upperRadius, upperLen, 4, 8), upperMaterial);
  upper.position.y = -upperLen / 2;
  pivot.add(upper);
  const joint = new THREE.Group();
  joint.position.y = -upperLen;
  pivot.add(joint);
  const lower = new THREE.Mesh(new THREE.CapsuleGeometry(lowerRadius, lowerLen, 4, 8), lowerMaterial);
  lower.position.y = -lowerLen / 2;
  joint.add(lower);
  let endMesh;
  if (end === "foot") {
    endMesh = new THREE.Mesh(new THREE.BoxGeometry(lowerRadius * 2.1, lowerRadius, lowerRadius * 3.4), endMaterial);
    endMesh.position.set(0, -lowerLen - lowerRadius * 0.4, lowerRadius * 0.9);
  } else {
    const r = lowerRadius;
    endMesh = new THREE.Group();
    endMesh.position.y = -lowerLen - r * 0.2;
    const palm = new THREE.Mesh(new THREE.BoxGeometry(r * 2.2, r * 1.7, r * 1.0), endMaterial);
    palm.position.y = -r * 0.85;
    endMesh.add(palm);
    for (let i = 0; i < 4; i += 1) {
      const finger = new THREE.Mesh(new THREE.BoxGeometry(r * 0.44, r * 1.25, r * 0.55), endMaterial);
      finger.position.set((i - 1.5) * r * 0.54, -r * 2.1, 0);
      finger.rotation.x = 0.14;
      endMesh.add(finger);
    }
    const thumb = new THREE.Mesh(new THREE.BoxGeometry(r * 0.5, r * 1.0, r * 0.55), endMaterial);
    thumb.position.set(thumbSide * r * 1.3, -r * 0.95, r * 0.1);
    thumb.rotation.z = thumbSide * -0.55;
    endMesh.add(thumb);
  }
  joint.add(endMesh);
  return { pivot, upper, joint, lower, end: endMesh };
}

const HAIR_COLORS = [0x2b2119, 0x4a3120, 0x151515, 0x5e4630, 0x7a5636, 0x3a3a45];

function makePerson({ shirt = 0x2f6f4e, pants = 0x2a3550, skin = 0xf3cca6, hair = 0x2b2119, gender = "m", scale = 1 } = {}) {
  const group = new THREE.Group();
  const rig = new THREE.Group();
  group.add(rig);
  const shirtMat = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.72 });
  const pantsMat = new THREE.MeshStandardMaterial({ color: pants, roughness: 0.8 });
  const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.78, emissive: 0x8a7355, emissiveIntensity: 0.5 });

  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.76, 0.32), shirtMat);
  chest.position.y = 1.42;
  rig.add(chest);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.2, 12), skinMat);
  neck.position.y = 1.88;
  rig.add(neck);
  const waist = new THREE.Group();
  waist.position.y = 1.16;
  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.3, 0.27), shirtMat);
  belly.position.y = -0.05;
  waist.add(belly);
  const hip = new THREE.Mesh(
    gender === "f" ? new THREE.BoxGeometry(0.48, 0.22, 0.3) : new THREE.BoxGeometry(0.42, 0.2, 0.27),
    pantsMat,
  );
  hip.position.y = -0.26;
  waist.add(hip);
  const beltLine = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.06, 0.28), new THREE.MeshStandardMaterial({ color: 0x5a3d22, roughness: 0.6 }));
  beltLine.position.y = -0.15;
  waist.add(beltLine);
  rig.add(waist);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 18, 18), skinMat);
  head.position.y = 2.12;
  rig.add(head);
  const earL = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 10), skinMat);
  earL.scale.set(0.45, 1, 0.8);
  earL.position.set(-0.245, 2.11, 0);
  rig.add(earL);
  const earR = earL.clone();
  earR.position.x = 0.245;
  rig.add(earR);

  const hairMat = new THREE.MeshStandardMaterial({ color: hair, roughness: 0.85 });
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.265, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.46), hairMat);
  hairCap.position.y = 2.13;
  hairCap.rotation.x = -0.22;
  rig.add(hairCap);
  const hairBack = new THREE.Mesh(
    new THREE.SphereGeometry(0.255, 16, 8, Math.PI, Math.PI, Math.PI * 0.35, Math.PI * (gender === "f" ? 0.38 : 0.22)),
    hairMat,
  );
  hairBack.position.y = 2.12;
  rig.add(hairBack);

  const faceDark = new THREE.MeshBasicMaterial({ color: 0x25201a });
  const faceWhite = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 10), faceWhite);
  eyeL.position.set(-0.09, 2.18, 0.21);
  rig.add(eyeL);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.09;
  rig.add(eyeR);
  const pupilL = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 8), faceDark);
  pupilL.position.set(-0.09, 2.18, 0.25);
  rig.add(pupilL);
  const pupilR = pupilL.clone();
  pupilR.position.x = 0.09;
  rig.add(pupilR);
  const browL = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, 0.02), faceDark);
  browL.position.set(-0.09, 2.26, 0.22);
  browL.rotation.z = 0.16;
  rig.add(browL);
  const browR = browL.clone();
  browR.position.x = 0.09;
  browR.rotation.z = -0.16;
  rig.add(browR);
  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.014, 8, 14, Math.PI), faceDark);
  smile.position.set(0, 2.04, 0.21);
  smile.rotation.z = Math.PI;
  rig.add(smile);
  // smile 一併回傳:角色皮要換嘴(如金牙)時把原生嘴關掉,避免雙嘴

  const shoeMat = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.85 });
  const mkArm = (x) => {
    const arm = createLimb({
      upperMaterial: shirtMat, lowerMaterial: skinMat, endMaterial: skinMat,
      upperLen: 0.27, lowerLen: 0.26, upperRadius: 0.07, lowerRadius: 0.058,
      end: "hand", thumbSide: x < 0 ? 1 : -1,
    });
    arm.pivot.position.set(x, 1.72, 0);
    arm.joint.rotation.x = -0.18;
    rig.add(arm.pivot);
    return arm;
  };
  const leftArm = mkArm(-0.4);
  const rightArm = mkArm(0.4);
  const mkLeg = (x) => {
    const leg = createLimb({
      upperMaterial: pantsMat, lowerMaterial: pantsMat, endMaterial: shoeMat,
      upperLen: 0.40, lowerLen: 0.38, upperRadius: 0.09, lowerRadius: 0.072,
      end: "foot",
    });
    leg.pivot.position.set(x, 1.0, 0);
    leg.pivot.rotation.x = -0.05;
    leg.joint.rotation.x = 0.1;
    rig.add(leg.pivot);
    return leg;
  };
  const leftLeg = mkLeg(-0.15);
  const rightLeg = mkLeg(0.15);

  group.scale.setScalar(scale);
  return { group, rig, head, waist, leftArm, rightArm, leftLeg, rightLeg, smile };
}

// ---------- 水手(帆船=坐姿掌舵;風浪板=站姿抓帆桁) ----------
function makeSailor({ windsurf = false } = {}) {
  const sailor = makePerson({ shirt: 0xd8433c, pants: 0x2a3550, hair: 0x2b2119, scale: 0.95 });
  const vest = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.56, 0.4), new THREE.MeshStandardMaterial({ color: 0xe08a2e, roughness: 0.8 }));
  vest.position.set(0, 1.45, 0);
  sailor.rig.add(vest); // 橘救生衣
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.268, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
    new THREE.MeshStandardMaterial({ color: 0xf2f0ec, roughness: 0.7 }),
  );
  cap.position.y = 2.2; // 白水手帽:罩髮、下緣停眉上(蓋到眼睛會「眼珠長帽上」,07-15 踩過)
  sailor.rig.add(cap);
  if (windsurf) poseStanding(sailor);
  else poseSeated(sailor);
  return sailor;
}

// 坐在艇尾:腿往前伸進船艙,一手拉帆索一手掌舵
function poseSeated(rider) {
  rider.leftLeg.pivot.rotation.x = -1.5;
  rider.leftLeg.joint.rotation.x = 1.1;
  rider.rightLeg.pivot.rotation.x = -1.5;
  rider.rightLeg.joint.rotation.x = 1.1;
  rider.leftArm.pivot.rotation.x = -0.85;
  rider.leftArm.joint.rotation.x = -0.45;
  rider.rightArm.pivot.rotation.x = -0.35;
  rider.rightArm.pivot.rotation.z = -0.5;
  rider.group.position.set(0, 0.46, -0.55);
  rider.group.scale.setScalar(0.95);
}

// 站在板上微蹲、側身、雙手前抓帆桁(武鬥系待機架式的馭風版)
function poseStanding(rider) {
  rider.leftLeg.pivot.rotation.x = -0.4;
  rider.leftLeg.joint.rotation.x = 0.6;
  rider.rightLeg.pivot.rotation.x = -0.25;
  rider.rightLeg.joint.rotation.x = 0.45;
  rider.leftArm.pivot.rotation.x = -1.15;
  rider.leftArm.joint.rotation.x = -0.35;
  rider.rightArm.pivot.rotation.x = -1.0;
  rider.rightArm.joint.rotation.x = -0.3;
  rider.group.position.set(0, 0.3, -0.2);
  rider.group.rotation.y = 0.3;
  rider.group.scale.setScalar(0.95);
}

// ---------- 船(帆船 dinghy / 風浪板):coatMat=帆布、maneMat=船身,沿用共用材質換色管線 ----------
// 介面與馬相容(rig/legs/neckPivot/tail 皆在):updateHorsePose 的節奏擺動直接變成「浪上顛簸」。
function makeHorse({ coat = 0xf2efe6, mane = 0x2a5f8f, windsurf = false } = {}) {
  const group = new THREE.Group(); // 原點=水面、+z 朝前
  const coatMat = new THREE.MeshStandardMaterial({ color: coat, roughness: 0.6, side: THREE.DoubleSide });
  const maneMat = new THREE.MeshStandardMaterial({ color: mane, roughness: 0.55 });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0xe9e2d2, roughness: 0.8 });
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x8a7355, roughness: 0.6 });
  const rig = new THREE.Group();
  group.add(rig);

  const mkSail = (h, w) => {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(0, h);
    shape.lineTo(w, 0.12);
    shape.closePath();
    return new THREE.Mesh(new THREE.ShapeGeometry(shape), coatMat);
  };

  let body;
  if (windsurf) {
    // 風浪板:扁長板+翹板頭+斜桅大三角帆
    body = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.14, 2.9), maneMat);
    body.position.set(0, 0.28, 0);
    rig.add(body);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 0.5), maneMat);
    nose.position.set(0, 0.36, 1.6);
    nose.rotation.x = -0.18;
    rig.add(nose);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 3.0, 8), mastMat);
    mast.position.set(0, 1.75, 0.55);
    mast.rotation.x = 0.22;
    rig.add(mast);
    const sail = mkSail(2.3, -1.35); // 帆面朝 -z 後方展開
    sail.rotation.y = Math.PI / 2;
    sail.position.set(0, 0.55, 0.62);
    rig.add(sail);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 8), mastMat);
    boom.rotation.x = Math.PI / 2;
    boom.position.set(0, 1.35, -0.1);
    rig.add(boom);
  } else {
    // 小帆船:船身+四角錐艏+甲板+船艙+主帆+前帆+舵
    body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.5, 3.2), maneMat);
    body.position.set(0, 0.42, 0);
    rig.add(body);
    const bow = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.0, 4), maneMat);
    bow.rotation.x = Math.PI / 2;
    bow.rotation.z = Math.PI / 4;
    bow.position.set(0, 0.42, 2.05);
    rig.add(bow);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 3.0), deckMat);
    deck.position.set(0, 0.7, 0);
    rig.add(deck);
    const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, 1.3), new THREE.MeshStandardMaterial({ color: 0x33241a, roughness: 0.9 }));
    cockpit.position.set(0, 0.74, -0.55);
    rig.add(cockpit);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 3.4, 8), mastMat);
    mast.position.set(0, 2.35, 0.35);
    rig.add(mast);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.7, 8), mastMat);
    boom.rotation.x = Math.PI / 2;
    boom.position.set(0, 1.05, -0.5);
    rig.add(boom);
    const main = mkSail(2.6, -1.55); // 主帆:桅後向 -z
    main.rotation.y = Math.PI / 2;
    main.position.set(0, 1.05, 0.32);
    rig.add(main);
    const jib = mkSail(1.7, 1.0); // 前帆:桅前向 +z(艏)
    jib.rotation.y = Math.PI / 2;
    jib.position.set(0, 0.95, 0.42);
    rig.add(jib);
    const rudder = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.34), mastMat);
    rudder.position.set(0, 0.2, -1.72);
    rig.add(rudder);
  }

  // 與馬同介面的啞件:節奏擺動寫進來無害(浪上顛簸交給 rig 的 bob)
  const mkDummyLeg = () => ({ pivot: new THREE.Group(), joint: new THREE.Group() });
  const legs = [mkDummyLeg(), mkDummyLeg(), mkDummyLeg(), mkDummyLeg()];
  const neckPivot = new THREE.Group();
  const head = new THREE.Group();
  const tail = new THREE.Group();
  const saddle = new THREE.Group();
  rig.add(neckPivot, head, tail, saddle);

  return { group, rig, body, neckPivot, head, tail, legs, saddle, coatMat, maneMat };
}


export class EquestrianGame {
  constructor({ canvas, touchRoot }) {
    this.canvas = canvas;
    this.touchRoot = touchRoot;

    const settings = loadSettings();
    this.difficulty = DIFFICULTY_PRESETS[settings.difficulty] ? settings.difficulty : "normal";
    this.modeId = GAME_MODES[settings.modeId] ? settings.modeId : "standard";
    this.mode = getModeConfig(this.modeId);
    this.coatId = HORSE_COATS[settings.horseCoat] ? settings.horseCoat : "brown";

    this.input = new InputManager();
    this.input.bindTouchButtons(this.touchRoot);

    this.onHudUpdate = null;
    this.onEvent = null;

    this.running = false; // ★只給主迴圈 RAF 用(athletics this.running 撞名事故鐵則)
    this.time = 0;
    this.phase = "menu"; // menu | gate | riding | jumping | ended
    this.message = "在首頁選擇模式與難度後開始。";
    this.cameraView = 0; // 0 跟隨 1 側面轉播 2 高空 3 甲板視角
    this.autoSaveTimer = 0;

    // 賽況
    this.dist = 0;
    this.speed = 0;
    this.elapsed = 0;
    this.faults = 0;
    this.clears = 0;
    this.fenceIdx = 0;
    this.lastResult = null; // 'clear' | 'knock' | 'early' | null
    this.jumpAnim = null; // {t, dur, quality, height, fence}
    this.gallopT = 0;
    this.finishDist = 0;
    this.lap = 1;
    this.knockAnims = [];

    this.overlay = { visible: false, eyebrow: "", title: "", text: "", canResume: false };

    // ---- three ----
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8fc4e8);
    this.scene.fog = new THREE.Fog(0x9fd0ee, 60, 160);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 240);
    this.camPos = new THREE.Vector3(0, 6, -14);
    this.camLook = new THREE.Vector3(0, 1.2, 0);
    this.camera.position.copy(this.camPos);

    this.clock = new THREE.Clock();

    this.buildCourse();
    this.setupScene();
    this.setupInput();

    window.addEventListener("resize", () => this.resize());
    this.resize();
    this.pushHud();
  }

  emitEvent(type, payload = {}) {
    if (this.onEvent) this.onEvent({ type, ...payload });
  }

  // ---------- 賽道(閉環樣條)+障礙 ----------
  buildCourse() {
    const pts = [];
    const RX = 30, RZ = 21;
    for (let i = 0; i < 10; i += 1) {
      const a = (i / 10) * Math.PI * 2;
      const w = i % 2 === 0 ? 1.0 : 1.14; // 交錯外凸=直線與彎道交替的有機環
      pts.push(new THREE.Vector3(Math.cos(a) * RX * w, 0, Math.sin(a) * RZ * w));
    }
    this.curve = new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.5);
    this.courseLen = this.curve.getLength();
  }

  posAt(dist) {
    const u = (((dist % this.courseLen) + this.courseLen) % this.courseLen) / this.courseLen;
    return this.curve.getPointAt(u);
  }

  tangentAt(dist) {
    const u = (((dist % this.courseLen) + this.courseLen) % this.courseLen) / this.courseLen;
    return this.curve.getTangentAt(u);
  }

  rebuildFences() {
    if (this.fenceGroup) this.scene.remove(this.fenceGroup);
    this.fenceGroup = new THREE.Group();
    this.fences = [];
    const preset = DIFFICULTY_PRESETS[this.difficulty];
    const n = this.mode.jumpoff ? Math.max(5, preset.fences - 2) : preset.fences;
    const railColors = [0xd8433c, 0x3f7be0, 0xf6d743, 0x4fae6a];
    for (let i = 0; i < n; i += 1) {
      const d = this.courseLen * ((i + 1) / (n + 1));
      const p = this.posAt(d);
      const t = this.tangentAt(d);
      const yaw = Math.atan2(t.x, t.z);
      const g = new THREE.Group();
      g.position.copy(p);
      g.rotation.y = yaw;
      const buoyMat = new THREE.MeshStandardMaterial({ color: railColors[i % railColors.length], roughness: 0.55 });
      const poleMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.7 });
      let topRail = null;
      for (const side of [-1, 1]) {
        const buoy = new THREE.Group();
        buoy.position.set(side * 1.9, 0, 0);
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 10), buoyMat);
        ball.position.y = 0.38;
        buoy.add(ball);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.3, 8), poleMat);
        pole.position.y = 1.2;
        buoy.add(pole);
        const flag = new THREE.Mesh(
          new THREE.PlaneGeometry(0.34, 0.22),
          new THREE.MeshStandardMaterial({ color: side < 0 ? 0xd8433c : 0xf5f5f5, side: THREE.DoubleSide }),
        );
        flag.position.set(side < 0 ? 0.17 : -0.17, 1.72, 0);
        buoy.add(flag);
        g.add(buoy);
        if (side > 0) topRail = buoy; // 擦標演出:右浮標傾倒半沉
      }
      // 門線泡沫帶(告訴孩子「從兩顆浮標中間過」)
      const gateFoam = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.5), new THREE.MeshBasicMaterial({ color: 0xeaf6ff, transparent: true, opacity: 0.55 }));
      gateFoam.rotation.x = -Math.PI / 2;
      gateFoam.position.y = 0.03;
      g.add(gateFoam);
      const numPlate = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.05), new THREE.MeshStandardMaterial({ color: 0xf6d743 }));
      numPlate.position.set(-2.5, 0.6, 0);
      g.add(numPlate);
      this.fenceGroup.add(g);
      this.fences.push({ dist: d, group: g, topRail, knocked: false, resolved: false });
    }
    this.scene.add(this.fenceGroup);
    this.knockAnims = [];
  }

  // ---------- 場景 ----------
  setupScene() {
    const sun = new THREE.HemisphereLight(0xffffff, 0x557040, 1.3);
    this.scene.add(sun);
    const key = new THREE.DirectionalLight(0xfff2d4, 1.9);
    key.position.set(30, 50, -20);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9ccbff, 0.6);
    rim.position.set(-25, 30, 25);
    this.scene.add(rim);

    const openSea = new THREE.Mesh(new THREE.PlaneGeometry(320, 320), new THREE.MeshStandardMaterial({ color: 0x1f5e96, roughness: 0.85 }));
    openSea.rotation.x = -Math.PI / 2;
    openSea.position.y = -0.02;
    this.scene.add(openSea);
    const regatta = new THREE.Mesh(new THREE.PlaneGeometry(96, 72), new THREE.MeshStandardMaterial({ color: 0x2e77b8, roughness: 0.75 }));
    regatta.rotation.x = -Math.PI / 2;
    this.scene.add(regatta);

    // 場邊浮筒界線(橘色,貼著水面)
    const railMat = new THREE.MeshStandardMaterial({ color: 0xff7043, roughness: 0.7 });
    const mkRail = (w, x, z, rot = 0) => {
      const r = new THREE.Mesh(new THREE.BoxGeometry(w, 0.14, 0.14), railMat);
      r.position.set(x, 0.12, z);
      r.rotation.y = rot;
      this.scene.add(r);
      const r2 = r.clone();
      r2.position.y = 0.0;
      this.scene.add(r2);
    };
    mkRail(96, 0, 36);
    mkRail(96, 0, -36);
    mkRail(72, 48, 0, Math.PI / 2);
    mkRail(72, -48, 0, Math.PI / 2);

    // 浪花航線帶(把航線畫在水面上,孩子一眼看懂要跑哪)
    const laneMat = new THREE.MeshBasicMaterial({ color: 0xd7ecfa });
    for (let i = 0; i < 120; i += 1) {
      const d = (i / 120) * this.courseLen;
      const p = this.posAt(d);
      const t = this.tangentAt(d);
      const dot = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.6), laneMat);
      dot.rotation.order = "YXZ"; // 先繞 y 對齊路徑方向,再倒平到地面(XYZ 順序會變鋸齒)
      dot.rotation.y = Math.atan2(t.x, t.z);
      dot.rotation.x = -Math.PI / 2;
      dot.position.set(p.x, 0.012, p.z);
      this.scene.add(dot);
    }

    // 帆船+水手;帆色照設定
    const coat = HORSE_COATS[this.coatId] || HORSE_COATS.brown;
    this.horse = makeHorse({ coat: coat.coat, mane: coat.mane });
    this.scene.add(this.horse.group);

    // 競速模式的 AI 對手:銀灰帆船(非競速模式隱藏)
    this.aiHorse = makeHorse({ coat: 0x9aa0a8, mane: 0x5f6670 });
    this.scene.add(this.aiHorse.group);
    this.aiHorse.group.visible = false;

    this.buildCrew();

    this.buildCrowd();
    this.rebuildFences();

    // 觀賽碼頭+小島
    const standMat = new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.85 });
    for (const side of [-1, 1]) {
      const stand = new THREE.Mesh(new THREE.BoxGeometry(60, 3.2, 5), standMat);
      stand.position.set(0, 1.6, side * 41.5);
      this.scene.add(stand);
    }
    const treeMat = new THREE.MeshStandardMaterial({ color: 0x3f7a35, roughness: 1 });
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.9 });
    const isleMat = new THREE.MeshStandardMaterial({ color: 0xd9c9a0, roughness: 1 });
    for (const [x, z] of [[-62, 20], [-58, -18], [60, 24], [64, -10], [-30, 55], [25, 58], [0, -60], [40, -55]]) {
      const isle = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.6, 0.35, 10), isleMat);
      isle.position.set(x, 0.1, z);
      this.scene.add(isle); // 小沙洲,樹長在島上
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 3, 8), trunkMat);
      trunk.position.set(x, 1.6, z);
      this.scene.add(trunk);
      const crown = new THREE.Mesh(new THREE.SphereGeometry(2.6, 12, 10), treeMat);
      crown.position.set(x, 4.7, z);
      this.scene.add(crown);
    }

    this.placeHorse();
  }

  buildCrowd() {
    // 兩側觀賽台前的有臉觀眾(臉朝場內;07-11 鐵則:觀眾要有臉、男女各半)
    this.crowd = new THREE.Group();
    const shirts = [0xd98a3d, 0x3d78d9, 0xc94f8f, 0x4fae6a, 0xb0552f, 0x8a5ac0];
    for (const side of [-1, 1]) {
      for (let i = 0; i < 7; i += 1) {
        const p = makePerson({
          shirt: shirts[(i + (side > 0 ? 3 : 0)) % shirts.length],
          pants: 0x2c3340,
          hair: HAIR_COLORS[(i * 2 + (side > 0 ? 1 : 0)) % HAIR_COLORS.length],
          gender: (i + (side > 0 ? 1 : 0)) % 2 === 0 ? "m" : "f",
          scale: 0.92,
        });
        p.group.position.set(-27 + i * 9, 0, side * 38.2);
        p.group.rotation.y = side > 0 ? Math.PI : 0;
        this.crowd.add(p.group);
      }
    }
    this.scene.add(this.crowd);
  }

  placeHorse() {
    const p = this.posAt(this.dist);
    const t = this.tangentAt(this.dist);
    let ox = 0, oz = 0;
    if (this.mode.race) { // 我方靠內線,AI 外線
      ox = -t.z * RACE_LANE;
      oz = t.x * RACE_LANE;
    }
    this.horse.group.position.set(p.x + ox, this.jumpY(), p.z + oz);
    this.horse.group.rotation.y = Math.atan2(t.x, t.z);
    if (this.mode.race && this.aiHorse && this.aiHorse.group.visible) {
      const ap = this.posAt(this.aiDist);
      const at = this.tangentAt(this.aiDist);
      const ay = this.aiJumpAnim ? Math.sin(Math.PI * clamp(this.aiJumpAnim.t, 0, 1)) * this.aiJumpAnim.height : 0;
      this.aiHorse.group.position.set(ap.x + at.z * RACE_LANE, ay, ap.z - at.x * RACE_LANE);
      this.aiHorse.group.rotation.y = Math.atan2(at.x, at.z);
    }
  }

  jumpY() {
    if (!this.jumpAnim) return 0;
    const k = clamp(this.jumpAnim.t, 0, 1);
    return Math.sin(Math.PI * k) * this.jumpAnim.height;
  }

  // ---------- 輸入 ----------
  setupInput() {
    this.canvas.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.jump();
    });
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  // ---------- 局面控制 ----------
  applyPresentation({ difficulty, modeId, horseCoat }) {
    if (difficulty && DIFFICULTY_PRESETS[difficulty]) this.difficulty = difficulty;
    if (modeId && GAME_MODES[modeId]) {
      this.modeId = modeId;
      this.mode = getModeConfig(modeId);
    }
    if (horseCoat && HORSE_COATS[horseCoat]) this.setHorseCoat(horseCoat);
    this.setVesselKind(); // 風浪板模式=換板;其餘=帆船
    saveSettings({ difficulty: this.difficulty, modeId: this.modeId, horseCoat: this.coatId });
    this.message = `${this.mode.label} · ${DIFFICULTY_LABELS[this.difficulty]} · ${HORSE_COATS[this.coatId].label} 已設定。`;
    this.pushHud();
  }

// 造船/上水手(風浪板模式=站姿板,其餘=坐姿帆船;競速對手固定帆船)
  setVesselKind() {
    const wind = !!this.mode.windsurf;
    if (this.horseIsWindsurf === wind && this.horse) return;
    this.horseIsWindsurf = wind;
    const coat = HORSE_COATS[this.coatId] || HORSE_COATS.brown;
    if (this.horse) this.scene.remove(this.horse.group);
    this.horse = makeHorse({ coat: coat.coat, mane: coat.mane, windsurf: wind });
    this.scene.add(this.horse.group);
    this.rider = null;
    this.buildCrew();
    this.placeHorse();
  }

  buildCrew() {
    if (this.rider && this.horse) this.horse.rig.remove(this.rider.group);
    this.rider = makeSailor({ windsurf: !!this.mode.windsurf });
    this.horse.rig.add(this.rider.group);
    if (this.aiHorse) {
      if (this.aiRider) this.aiHorse.rig.remove(this.aiRider.group);
      this.aiRider = makeSailor({});
      this.aiHorse.rig.add(this.aiRider.group);
    }
  }

  // 換帆色:帆/船身共用 coatMat/maneMat,改材質色即可(不重建船)
  setHorseCoat(coatId) {
    if (!HORSE_COATS[coatId]) return;
    this.coatId = coatId;
    if (this.horse) {
      this.horse.coatMat.color.setHex(HORSE_COATS[coatId].coat);
      this.horse.maneMat.color.setHex(HORSE_COATS[coatId].mane);
    }
  }

  openHomeMenu() {
    this.phase = "menu";
    if (this.confetti) {
      for (const c of this.confetti) this.scene.remove(c.mesh);
      this.confetti = [];
    }
    this.message = "在首頁選擇模式與難度後開始。";
    this.overlay.visible = false;
    this.pushHud();
  }

  startSelectedMatch() {
    this.dist = 0;
    this.speed = 0;
    this.elapsed = 0;
    this.faults = 0;
    this.clears = 0;
    this.fenceIdx = 0;
    this.lastResult = null;
    this.jumpAnim = null;
    this.lap = 1;
    this.rebuildFences();
    this.finishDist = this.fences.length ? this.fences[this.fences.length - 1].dist + 22 : this.courseLen;
    // 競速 AI 重置
    this.aiDist = -2.5;
    this.aiSpeed = 0;
    this.aiGallopT = 0;
    this.aiFenceIdx = 0;
    this.aiJumpAnim = null;
    this.aiKnockSlowT = 9;
    this.knockSlowT = 9;
    this.aiFinished = false;
    if (this.aiHorse) this.aiHorse.group.visible = !!this.mode.race;
    this.placeHorse();
    // 起航鏡頭直接切到船後方(joash 教訓:lerp 穿場=整幀糊掉)
    const t0 = this.tangentAt(0);
    const p0 = this.posAt(0);
    this.camPos.set(p0.x - t0.x * 9, 4.6, p0.z - t0.z * 9);
    this.camLook.set(p0.x, 1.4, p0.z);
    this.phase = "gate";
    this.message = "按「轉舵鍵」出航!沿浪花航線跑,接近浮標門時抓綠區轉舵!";
    this.emitEvent("match-start", { mode: this.mode.label });
    this.pushHud();
  }

  // 出發/起跳共用(空白鍵/點畫面/觸控跳鍵)
  jump() {
    if (this.overlay.visible) return;
    if (this.phase === "gate") {
      this.phase = "riding";
      this.speed = DIFFICULTY_PRESETS[this.difficulty].baseSpeed * 0.6;
      this.message = "出發!按住「加速」提速,放開收步穩節奏。";
      this.emitEvent("gate", {});
      this.pushHud();
      return;
    }
    if (this.phase !== "riding") return;
    const fence = this.fences[this.fenceIdx];
    if (!fence) return;
    const distToFence = fence.dist - this.dist;
    if (distToFence > APPROACH_M) {
      // 離欄還遠就按=小跳一下,不罰但提示(溫柔)
      this.startJump(fence, 0.35, true);
      this.lastResult = "early";
      this.message = "太早轉舵了——等靠近浮標門、時機條進綠區再轉!";
      this.emitEvent("fence-early", {});
      this.pushHud();
      return;
    }
    const preset = DIFFICULTY_PRESETS[this.difficulty];
    const err = Math.abs(distToFence - TAKEOFF_D) / Math.max(this.speed, 1);
    let quality = clamp(1 - err / (preset.window * 2.2), 0, 1); // skijump 綠區同款判定式
    quality = clamp(quality + preset.assist * (1 - quality), 0, 1); // 幼兒輔助:往綠區拉
    this.startJump(fence, quality, false);
  }

  startJump(fence, quality, hop) {
    const dur = (hop ? JUMP_SPAN * 0.6 : JUMP_SPAN) / Math.max(this.speed, 3);
    this.jumpAnim = {
      t: 0,
      dur,
      quality,
      height: hop ? 0.25 : 0.4 + quality * 0.3, // 船過標=壓浪小躍,不是馬的大跳
      fence: hop ? null : fence,
    };
    this.phase = "jumping";
    this.emitEvent("jump", { quality, hop });
  }

  resolveFence(fence, quality) {
    fence.resolved = true;
    const clean = quality >= 0.5; // 07-15 加難:過欄門檻 0.45→0.5
    if (clean) {
      this.clears += 1;
      this.lastResult = "clear";
      const perfect = quality >= 0.88;
      this.message = perfect ? "完美轉舵!俐落繞標!" : "過標!繼續盯下一道門。";
      this.emitEvent("fence-clear", { idx: this.fenceIdx + 1, perfect });
    } else {
      fence.knocked = true;
      this.faults += 4;
      this.lastResult = "knock";
      if (this.mode.race) {
        this.knockSlowT = 0; // 競速:碰桿=踉蹌減速 1.4 秒
        this.message = "擦標!船失速踉蹌——穩住追回來!";
      } else {
        this.message = "擦標!+4 罰分——穩住,下一道門抓準綠區。";
      }
      this.knockAnims.push({ fence, t: 0 });
      this.emitEvent("fence-knock", { idx: this.fenceIdx + 1, faults: this.faults });
    }
    this.fenceIdx += 1;
    // 練習水域:繞完一輪重置浮標再來一圈(標門里程推進到下一圈)
    if (this.mode.endless && this.fenceIdx >= this.fences.length) {
      this.fenceIdx = 0;
      this.lap += 1;
      for (const f of this.fences) {
        f.resolved = false;
        if (f.knocked) {
          f.knocked = false;
          f.topRail.position.set(0, 1.35, 0);
          f.topRail.rotation.set(0, 0, Math.PI / 2);
        }
        f.dist += this.courseLen;
      }
      this.finishDist += this.courseLen;
    }
  }

  // 零罰分慶祝(07-15 使用者提議:天上掉彩花/花瓣/彩帶):
  // 尊重 prefers-reduced-motion;彩紙+花瓣+彩帶三種形狀,7 秒自然落完
  spawnConfetti() {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!this.confetti) this.confetti = [];
    const colors = [0xffd24a, 0xff6b81, 0x7de08c, 0x6ec6ff, 0xc890ff, 0xffa050, 0xf5f0e0];
    const p = this.posAt(this.dist);
    for (let i = 0; i < 160; i += 1) {
      const kind = i % 3; // 0 彩紙方片 1 花瓣圓片 2 彩帶長條
      const geo = kind === 0
        ? new THREE.PlaneGeometry(0.16, 0.16)
        : kind === 1
          ? new THREE.CircleGeometry(0.1, 6)
          : new THREE.PlaneGeometry(0.06, 0.5);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: colors[i % colors.length], side: THREE.DoubleSide, transparent: true, opacity: 0.95,
      }));
      mesh.position.set(p.x + (Math.random() * 2 - 1) * 14, 8 + Math.random() * 7, p.z + (Math.random() * 2 - 1) * 14);
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      this.scene.add(mesh);
      this.confetti.push({
        mesh,
        vy: 1.2 + Math.random() * 1.6,
        swayA: Math.random() * Math.PI * 2,
        swayF: 1.5 + Math.random() * 2,
        spin: (Math.random() * 2 - 1) * 3,
        t: 0,
      });
    }
  }

  finishCourse() {
    this.phase = "ended";
    if (this.mode.race) {
      const win = !this.aiFinished; // 我方先觸發完賽=贏;AI 先到觸發=輸
      const timeText = this.elapsed.toFixed(1) + " 秒";
      if (win) this.spawnConfetti();
      this.overlay = {
        visible: true,
        eyebrow: win ? "勝利!" : "惜敗",
        title: win ? "第一個衝線!" : "AI 先到了……",
        text: win
          ? timeText + " 衝過終點,把銀帆手甩在後面!(擦標 " + this.faults / 4 + " 次)"
          : "差一點!穩住節奏、少擦標,再來一場追回來!(用時 " + timeText + ")",
        canResume: false,
      };
      this.emitEvent("race-end", { win, elapsed: this.elapsed });
      this.message = win ? "勝利!" + timeText + " 先馳得點!" : "AI 先衝線——再來一場!";
      this.saveGame(true);
      this.pushHud();
      return;
    }
    const preset = DIFFICULTY_PRESETS[this.difficulty];
    const overTime = Math.max(0, this.elapsed - preset.timeAllowed);
    const timeFaults = preset.timeAllowed >= 999 ? 0 : Math.ceil(overTime / 4);
    const total = this.faults + timeFaults;
    const timeText = `${this.elapsed.toFixed(1)} 秒`;
    if (this.mode.jumpoff) {
      const score = this.elapsed + this.faults;
      this.overlay = {
        visible: true,
        eyebrow: "決勝圈完賽",
        title: `${score.toFixed(1)} 秒`,
        text: `航行 ${timeText}+罰分 ${this.faults}(換算秒)。敢搶風、又穩得住,才是決勝航段之王!`,
        canResume: false,
      };
      if (this.faults === 0) this.spawnConfetti();
      this.emitEvent("finish", { faults: this.faults, elapsed: this.elapsed, clearRound: this.faults === 0 });
    } else {
      const clearRound = total === 0;
      this.overlay = {
        visible: true,
        eyebrow: clearRound ? "零罰分!" : "完賽",
        title: clearRound ? "Clear Round!" : `罰分 ${total}`,
        text: clearRound
          ? `完美的一輪!${timeText} 繞完全程、一標未擦。`
          : `擦標 ${this.faults}${timeFaults ? ` + 超時 ${timeFaults}` : ""} 罰分,用時 ${timeText}。再來一場,朝零罰分前進!`,
        canResume: false,
      };
      if (clearRound) this.spawnConfetti();
      this.emitEvent("finish", { faults: total, elapsed: this.elapsed, clearRound });
    }
    this.message = `完賽——罰分 ${total},${timeText}。`;
    this.saveGame(true);
    this.pushHud();
  }

  togglePause() {
    if (this.phase === "menu" || this.phase === "ended") return;
    if (this.overlay.visible) {
      this.resume();
    } else {
      this.overlay = { visible: true, eyebrow: "暫停中", title: "喘口氣", text: "帆也鬆一鬆,準備好再繼續。", canResume: true };
      this.pushHud();
    }
  }

  resume() {
    if (!this.overlay.canResume) return;
    this.overlay.visible = false;
    this.pushHud();
  }

  cycleCameraView() {
    this.cameraView = (this.cameraView + 1) % 4;
    const names = ["跟隨視角", "側面轉播", "高空俯瞰", "甲板視角"];
    this.message = `視角:${names[this.cameraView]}。`;
    this.pushHud();
  }

  // ---------- 主迴圈 ----------
  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const tick = () => {
      if (!this.running) return;
      const delta = Math.min(this.clock.getDelta(), 0.05);
      this.update(delta);
      this.render();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  resize() {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height || 1.6;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  update(delta) {
    this.time += delta;
    const paused = this.overlay.visible;

    if (!paused && (this.phase === "riding" || this.phase === "jumping")) {
      this.elapsed += delta;
      const preset = DIFFICULTY_PRESETS[this.difficulty];
      const boosting = this.input.isDown("up") || this.input.isDown("sprint");
      const slowing = this.input.isDown("down");
      let target = preset.baseSpeed + (boosting ? preset.boost : 0) - (slowing ? 2.2 : 0);
      this.knockSlowT = (this.knockSlowT ?? 9) + delta;
      if (this.mode.race && this.knockSlowT < 1.4) target *= 0.5; // 擦標踉蹌
      this.speed += (Math.max(3, target) - this.speed) * Math.min(1, delta * 1.8);
      this.dist += this.speed * delta;
      this.gallopT += delta * (this.speed / 8);

      if (this.phase === "jumping" && this.jumpAnim) {
        this.jumpAnim.t += delta / this.jumpAnim.dur;
        if (this.jumpAnim.t >= 1) {
          const jump = this.jumpAnim;
          this.jumpAnim = null;
          this.phase = "riding";
          if (jump.fence) this.resolveFence(jump.fence, jump.quality);
        }
      } else if (this.phase === "riding") {
        // 沒按轉舵就衝到標門前=船自己勉強繞(溫柔:不停不翻,但多半擦標)
        const fence = this.fences[this.fenceIdx];
        if (fence && fence.dist - this.dist <= 0.5 && !fence.resolved) {
          this.startJump(fence, 0.18, false);
          this.message = "來不及轉舵——船自己硬繞了過去!";
        }
      }

      if (!this.mode.endless && this.dist >= this.finishDist && this.phase !== "ended") {
        this.finishCourse();
      }

      // —— 競速 AI(同航線外線):控速+轉舵品質依難度,擦標一樣踉蹌 ——
      if (this.mode.race && this.phase !== "ended") {
        const ai = RACE_AI[this.difficulty];
        this.aiKnockSlowT += delta;
        const aiBoosting = Math.sin(this.time * 0.7 + 1.3) * 0.5 + 0.5 < ai.boostRatio;
        let aiTarget = preset.baseSpeed + (aiBoosting ? preset.boost : 0);
        if (this.aiKnockSlowT < 1.4) aiTarget *= 0.5;
        this.aiSpeed += (Math.max(3, aiTarget) - this.aiSpeed) * Math.min(1, delta * 1.8);
        this.aiDist += this.aiSpeed * delta;
        this.aiGallopT += delta * (this.aiSpeed / 8);
        if (this.aiJumpAnim) {
          this.aiJumpAnim.t += delta / this.aiJumpAnim.dur;
          if (this.aiJumpAnim.t >= 1) {
            const q = this.aiJumpAnim.quality;
            this.aiJumpAnim = null;
            if (q < 0.5) this.aiKnockSlowT = 0; // AI 擦標踉蹌(不動浮標,傾倒演出留給玩家標門)
            this.aiFenceIdx += 1;
          }
        } else {
          const aiFence = this.fences[this.aiFenceIdx];
          if (aiFence && aiFence.dist - this.aiDist <= TAKEOFF_D + 0.3) {
            const q = clamp(ai.skill + (Math.random() * 2 - 1) * 0.22, 0, 1);
            this.aiJumpAnim = { t: 0, dur: JUMP_SPAN / Math.max(this.aiSpeed, 3), quality: q, height: 0.4 + q * 0.3 };
          }
        }
        if (this.aiDist >= this.finishDist && !this.aiFinished) {
          this.aiFinished = true;
          if (this.phase !== "ended") this.finishCourse(); // AI 先到=直接結算(我方輸)
        }
      }
    }

    // 擦到的浮標:傾倒半沉再慢慢回正
    for (const k of this.knockAnims) {
      k.t += delta;
      const kt = clamp(k.t / 0.7, 0, 1);
      k.fence.topRail.position.y = -kt * 0.3; // 半沉
      k.fence.topRail.position.z = kt * 0.6; // 被船帶著漂
      k.fence.topRail.rotation.x = kt * 0.9; // 傾倒
    }
    this.knockAnims = this.knockAnims.filter((k) => k.t < 0.9);

    // 彩花飄落(零罰分慶祝):左右搖曳+自旋,7 秒淡出回收
    if (this.confetti && this.confetti.length) {
      for (const c of this.confetti) {
        c.t += delta;
        c.mesh.position.y -= c.vy * delta;
        c.mesh.position.x += Math.sin(c.swayA + c.t * c.swayF) * delta * 1.2;
        c.mesh.rotation.x += c.spin * delta;
        c.mesh.rotation.z += c.spin * 0.7 * delta;
        if (c.t > 5.5) c.mesh.material.opacity = Math.max(0, 0.95 * (1 - (c.t - 5.5) / 1.5));
      }
      this.confetti = this.confetti.filter((c) => {
        if (c.t >= 7 || c.mesh.position.y < -0.5) {
          this.scene.remove(c.mesh);
          return false;
        }
        return true;
      });
    }

    this.handleKeys();
    this.updateHorsePose();
    this.placeHorse();
    this.updateCamera(delta);

    this.autoSaveTimer += delta;
    if (this.autoSaveTimer > 5) {
      this.autoSaveTimer = 0;
      this.saveGame(true);
    }

    this.input.endFrame();
    this.pushHud();
  }

  handleKeys() {
    if (this.input.consumePress("camera")) this.cycleCameraView();
    if (this.input.consumePress("pause")) this.togglePause();
    if (this.overlay.visible) return;
    if (this.input.consumePress("shoot")) this.jump();
  }

  updateHorsePose() {
    const h = this.horse;
    if (!h) return;
    if (this.phase === "jumping" && this.jumpAnim) {
      // 過標:船身沿弧線俯仰壓浪;水手前傾
      const k = clamp(this.jumpAnim.t, 0, 1);
      const pitch = Math.cos(Math.PI * k) * 0.35;
      h.rig.rotation.x = -pitch;
      h.rig.position.y = 0;
      const tuck = Math.sin(Math.PI * k);
      h.legs[0].pivot.rotation.x = -1.3 * tuck;
      h.legs[1].pivot.rotation.x = -1.3 * tuck;
      h.legs[0].joint.rotation.x = 1.8 * tuck;
      h.legs[1].joint.rotation.x = 1.8 * tuck;
      h.legs[2].pivot.rotation.x = 0.85 * tuck;
      h.legs[3].pivot.rotation.x = 0.85 * tuck;
      h.legs[2].joint.rotation.x = 0.5 * tuck;
      h.legs[3].joint.rotation.x = 0.5 * tuck;
      h.neckPivot.rotation.x = -0.25 + pitch * 0.4;
      if (this.rider) this.rider.rig.rotation.x = 0.4 * tuck;
      return;
    }
    // 奔跑循環:相位錯開的四腿擺動(簡化 canter)
    const sp = this.phase === "riding" ? this.speed : 0;
    const amp = clamp(sp / 14, 0, 0.62);
    const t = this.gallopT * Math.PI * 2;
    const phases = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];
    h.legs.forEach((leg, i) => {
      leg.pivot.rotation.x = Math.sin(t + phases[i]) * amp;
      leg.joint.rotation.x = Math.max(0, Math.sin(t + phases[i] + 0.8)) * amp * 1.3;
    });
    h.rig.rotation.x = 0;
    h.rig.position.y = Math.abs(Math.sin(t)) * amp * 0.14;
    h.neckPivot.rotation.x = Math.sin(t) * amp * 0.12;
    h.tail.rotation.x = 0.55 + Math.sin(t * 0.9) * 0.15;
    if (this.rider) this.rider.rig.rotation.x = amp * 0.18;

    // AI 船動畫(競速)
    if (this.mode.race && this.aiHorse && this.aiHorse.group.visible) {
      const ah = this.aiHorse;
      if (this.aiJumpAnim) {
        const k = clamp(this.aiJumpAnim.t, 0, 1);
        const tuck = Math.sin(Math.PI * k);
        ah.rig.rotation.x = -Math.cos(Math.PI * k) * 0.35;
        ah.legs.forEach((leg, i) => {
          leg.pivot.rotation.x = (i < 2 ? -1.3 : 0.85) * tuck;
          leg.joint.rotation.x = (i < 2 ? 1.8 : 0.5) * tuck;
        });
      } else {
        const aamp = clamp(this.aiSpeed / 14, 0, 0.62);
        const at2 = this.aiGallopT * Math.PI * 2;
        const phases2 = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];
        ah.rig.rotation.x = 0;
        ah.legs.forEach((leg, i) => {
          leg.pivot.rotation.x = Math.sin(at2 + phases2[i]) * aamp;
          leg.joint.rotation.x = Math.max(0, Math.sin(at2 + phases2[i] + 0.8)) * aamp * 1.3;
        });
        ah.rig.position.y = Math.abs(Math.sin(at2)) * aamp * 0.14;
        ah.neckPivot.rotation.x = Math.sin(at2) * aamp * 0.12;
        ah.tail.rotation.x = 0.55 + Math.sin(at2 * 0.9) * 0.15;
      }
    }
  }

  updateCamera(delta) {
    const p = this.posAt(this.dist);
    const t = this.tangentAt(this.dist);
    const y = this.jumpY();
    let desiredPos;
    let desiredLook;
    if (this.phase === "menu") {
      // 選單:慢速繞場巡禮
      const a = this.time * 0.08;
      desiredPos = new THREE.Vector3(Math.cos(a) * 40, 12, Math.sin(a) * 40);
      desiredLook = new THREE.Vector3(0, 1, 0);
    } else if (this.cameraView === 0) {
      desiredPos = new THREE.Vector3(p.x - t.x * 8.6, 4.4 + y * 0.5, p.z - t.z * 8.6);
      desiredLook = new THREE.Vector3(p.x + t.x * 7, 1.3 + y, p.z + t.z * 7);
    } else if (this.cameraView === 1) {
      const side = new THREE.Vector3(t.z, 0, -t.x);
      desiredPos = new THREE.Vector3(p.x + side.x * 13, 3.6, p.z + side.z * 13);
      desiredLook = new THREE.Vector3(p.x, 1.2 + y, p.z);
    } else if (this.cameraView === 2) {
      desiredPos = new THREE.Vector3(p.x + 3, 26, p.z + 3);
      desiredLook = new THREE.Vector3(p.x + t.x * 6, 0.5, p.z + t.z * 6);
    } else {
      desiredPos = new THREE.Vector3(p.x - t.x * 0.6, 2.5 + y, p.z - t.z * 0.6);
      desiredLook = new THREE.Vector3(p.x + t.x * 12, 1.2 + y, p.z + t.z * 12);
    }
    const k = 1 - Math.exp(-delta * 3.2);
    this.camPos.lerp(desiredPos, k);
    this.camLook.lerp(desiredLook, k);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  // 小地圖資料(競速模式;path 取樣一次快取)
  getMinimapData() {
    if (!this._miniPath) {
      this._miniPath = [];
      for (let i = 0; i <= 100; i += 1) {
        const p = this.posAt((this.courseLen * i) / 100);
        this._miniPath.push([p.x, p.z]);
      }
    }
    const me = this.posAt(this.dist);
    const ai = this.mode.race && this.aiHorse && this.aiHorse.group.visible ? this.posAt(this.aiDist) : null;
    return {
      path: this._miniPath,
      me: [me.x, me.z],
      ai: ai ? [ai.x, ai.z] : null,
      fences: (this.fences || []).map((f) => {
        const p = this.posAt(f.dist % this.courseLen);
        return [p.x, p.z];
      }),
    };
  }

  // ---------- HUD ----------
  pushHud() {
    if (!this.onHudUpdate) return;
    const preset = DIFFICULTY_PRESETS[this.difficulty];
    const fence = this.fences && this.fences[this.fenceIdx];
    const distToFence = fence ? Math.max(0, fence.dist - this.dist) : null;
    // 起跳時機條:進 APPROACH_M 內開始充,到理想起跳點=滿;err<window=綠區
    let approach01 = 0;
    let inWindow = false;
    if ((this.phase === "riding" || this.phase === "jumping") && fence && distToFence !== null && distToFence <= APPROACH_M) {
      approach01 = clamp(1 - (distToFence - TAKEOFF_D) / (APPROACH_M - TAKEOFF_D), 0, 1);
      const err = Math.abs(distToFence - TAKEOFF_D) / Math.max(this.speed, 1);
      inWindow = err <= preset.window;
    }
    const phaseLabels = { menu: "主選單", gate: "出發線", riding: "騎行", jumping: "騰空", ended: "完賽" };
    const mins = Math.floor(this.elapsed / 60);
    const secs = (this.elapsed % 60).toFixed(1).padStart(4, "0");
    this.onHudUpdate({
      faults: this.faults,
      clears: this.clears,
      fenceIdx: this.fences && this.fences.length ? Math.min(this.fenceIdx + 1, this.fences.length) : 1,
      fenceCount: this.fences ? this.fences.length : 0,
      lap: this.lap,
      endless: !!this.mode.endless,
      timeText: `${mins}:${secs}`,
      timeAllowed: this.mode.race
        ? (this.phase === "riding" || this.phase === "jumping"
          ? (this.dist >= this.aiDist ? "領先 " + (this.dist - this.aiDist).toFixed(0) + " m" : "落後 " + (this.aiDist - this.dist).toFixed(0) + " m")
          : "先到終點者勝")
        : preset.timeAllowed >= 999 ? "不限時" : preset.timeAllowed + " 秒",
      modeLabel: this.mode.label,
      difficultyLabel: DIFFICULTY_LABELS[this.difficulty],
      phaseLabel: phaseLabels[this.phase] || "",
      message: this.message,
      speed01: clamp(this.speed / (preset.baseSpeed + preset.boost), 0, 1),
      speedText: `${(this.speed * 3.6).toFixed(0)} km/h`,
      approach01,
      inWindow,
      nextFenceText: distToFence === null ? "—" : distToFence > 90 ? "衝線!" : `${distToFence.toFixed(0)} m`,
      lastResult: this.lastResult,
      overlay: { ...this.overlay },
    });
  }

  // ---------- 存讀檔(記最佳成績,不存賽中進度) ----------
  saveGame(silent = false) {
    const prev = loadSavedGame() || {};
    const snapshot = { difficulty: this.difficulty, modeId: this.modeId, bestFaults: prev.bestFaults, bestTime: prev.bestTime };
    if (this.phase === "ended" && !this.mode.endless) {
      const better =
        prev.bestFaults === undefined ||
        this.faults < prev.bestFaults ||
        (this.faults === prev.bestFaults && this.elapsed < (prev.bestTime ?? Infinity));
      if (better) {
        snapshot.bestFaults = this.faults;
        snapshot.bestTime = this.elapsed;
      }
    }
    saveGameState(snapshot);
    if (!silent) {
      this.message = "已存檔。";
      this.pushHud();
    }
  }

  loadGame() {
    const snap = loadSavedGame();
    if (!snap) return false;
    if (DIFFICULTY_PRESETS[snap.difficulty]) this.difficulty = snap.difficulty;
    if (GAME_MODES[snap.modeId]) {
      this.modeId = snap.modeId;
      this.mode = getModeConfig(snap.modeId);
    }
    this.openHomeMenu();
    this.message = snap.bestFaults !== undefined
      ? `最佳成績:罰分 ${snap.bestFaults}、${(snap.bestTime || 0).toFixed(1)} 秒——挑戰它!`
      : "尚無最佳成績,先跑一場吧!";
    this.pushHud();
    return true;
  }
}
