// 播報詞庫(固定句,全部預烤 mp3)+key 函式——scripts/gen-voice.mjs 與 runtime voice.js 共用。
// ★字幕可以帶罰分/秒數等動態字,「唸出來的」一律用這裡的固定句(人聲鐵律:不用 Web Speech 機器聲)。
// ⚠ edge-tts 雷:太短的句子會斷流——句子保持完整、以驚嘆/句號收尾。
export function voiceKey(text) {
  const s = String(text).replace(/\s+/g, "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export const PHRASES = [
  // 開賽/出航
  "歡迎來到帆船賽!控好節奏,綠區轉舵!",
  "出航!穩住節奏,盯住第一道標門!",
  // 繞標
  "漂亮!完美轉舵,俐落繞過!",
  "好一手!乾乾淨淨!",
  "繞標成功,節奏很穩!",
  // 擦標/失誤
  "哎呀,擦到浮標了,加四個罰分。",
  "太早轉舵了,穩住再來。",
  "來不及轉舵,船自己硬繞了過去!",
  // 終場
  "零罰分!完美的一輪,全場歡呼!",
  "全程完成!辛苦了,好帆手!",
  "決勝航段完賽!好快的速度!",
];

// 帆船=奧運皮,無經文(聖經皮「保羅海難/約拿風暴船」換皮時再加)
export const SCRIPTURES = [];
