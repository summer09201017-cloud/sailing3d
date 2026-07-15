# CLAUDE.md — sailing3d(3D 帆船賽=航海引擎的家)

> 2026-07-16 拍板:航海引擎首發=帆船賽(奧運皮,fork equestrian3d 換皮);
> 聖經皮佇列=保羅海難(徒27)、約拿風暴船(拿1)。GitHub 唯一真相;帳號 summer09201017-cloud。

## 引擎核心(換皮時別動的)

- fork 自 equestrian3d:`buildCourse/posAt/tangentAt` CatmullRom 閉環航線,一切以「里程 dist」為域。
- `jump()` 判定=畫面:轉舵時機 `err=|distToFence-TAKEOFF_D|/speed`(skijump 綠區同款);
  按下當下定「乾淨繞標/擦標」,浮標在船過後才傾倒半沉。
- `makeHorse`(名字沿用馬,介面相容):帆船 dinghy / 風浪板 windsurf 兩種;
  `coatMat`=帆布、`maneMat`=船身 → `setHorseCoat` 換帆色不重建(HORSE_COATS 七色帆)。
  啞件 legs/neckPivot/tail 讓 `updateHorsePose` 的節奏擺動直接變「浪上顛簸」。
- `makeSailor`:坐姿(帆船)/站姿微蹲(風浪板);橘救生衣+白帽(帽下緣停眉上)。
- 模式:繞標賽/決勝航段/雙帆競速(AI)/風浪板(`mode.windsurf` → `setVesselKind` 換板)/練習水域。
- 溫柔規則:沒按=船自己勉強繞過(多半擦標),永不淘汰。
- `this.running` 只給 RAF;鏡頭切場面必硬切(joash 教訓)。

## 換皮清單(保羅海難/約拿風暴照這裡)

場景(setupScene 水色/小島/碼頭)、船外觀(makeHorse)、水手(makeSailor)、GAME_MODES 文案、
浮標門(rebuildFences → 障礙=礁石/浪頭)、voicePhrases(+SCRIPTURES 曉臻)、
identity 件組(manifest/sw cache/storage 鍵/title/icon)。經文必先 cuv 查驗。

## 本機地雷

- vite preview 接管線會 SIGPIPE;地面貼片 rotation.order="YXZ";[hidden] 修正在 styles.css 底部。
- edge-tts 短句斷流——句子保持完整、驚嘆/句號收尾。
- 溝通一律繁體中文。

## 部署

Netlify 手動站 hfpc-sailing3d(`--no-build --dir dist --site` 鐵則);sw 是 network-first(nf1)。
