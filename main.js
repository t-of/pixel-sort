'use strict';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。
// キーは必ず 'pixel-sort.' で始める。画像はどこにも保存しない（端末の中だけで処理する）。
const STORE = 'pixel-sort.';

function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

WebAppKit.init({ title: 'pixel-sort', text: '画像を選ぶと、ピクセルを明るさや色で並び替えて変換します。画像は端末の中だけで処理します。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// ---- 音（保存したときだけ短く鳴らす） ----
function setAudioSession(on) {
  try { if (navigator.audioSession) navigator.audioSession.type = on ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}
let actx = null;
function unlockAudio() {
  setAudioSession(true);
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; } }
  if (actx.state === 'suspended') actx.resume();
}
addEventListener('pointerdown', unlockAudio, true);
function tone(freq) {
  if (!actx) return;
  const t = actx.currentTime;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.08, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
  o.connect(g).connect(actx.destination);
  o.start(t);
  o.stop(t + 0.16);
}

// ---- ここからアプリ本体 ----

const $ = (id) => document.getElementById(id);
const drop = $('drop'), file = $('file'), controls = $('controls'), canvases = $('canvases');
const srcCanvas = $('src'), outCanvas = $('out');
const ruleSelect = $('rule'), orderSelect = $('order'), saveBtn = $('save'), playBtn = $('play');

const MAX_SIDE = 1024;   // 長辺をこの大きさまで縮めてから処理する
const MAX_ANIM_SIDE = 256;   // 再生アニメはこの大きさで計算する（スマホでも重くならないように）
const ANIM_MS = 2400;

ruleSelect.value = load('rule', 'sum');
orderSelect.value = load('order', 'asc');

let currentImageData = null;   // 元画像（並び替え前）の ImageData

function keyFor(rule, r, g, b) {
  switch (rule) {
    case 'r': return r;
    case 'g': return g;
    case 'b': return b;
    case 'hue': return rgbToHue(r, g, b);
    default: return r + g + b;   // sum（明るさ）
  }
}

function rgbToHue(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

// order_[i] は「並び替え後の位置 i に来る、元のピクセルの位置」
function computeOrder(imageData, rule, order) {
  const { data, width, height } = imageData;
  const n = width * height;
  const order_ = new Array(n);
  const keys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    keys[i] = keyFor(rule, data[o], data[o + 1], data[o + 2]);
    order_[i] = i;
  }
  order_.sort((a, b) => keys[a] - keys[b]);
  if (order === 'desc') order_.reverse();
  return order_;
}

function sortPixels(imageData, rule, order) {
  const { data, width, height } = imageData;
  const order_ = computeOrder(imageData, rule, order);
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < order_.length; i++) {
    const from = order_[i] * 4, to = i * 4;
    out[to] = data[from]; out[to + 1] = data[from + 1]; out[to + 2] = data[from + 2]; out[to + 3] = data[from + 3];
  }
  return new ImageData(out, width, height);
}

function render() {
  if (!currentImageData) return;
  const rule = ruleSelect.value, order = orderSelect.value;
  save('rule', rule);
  save('order', order);
  const result = sortPixels(currentImageData, rule, order);
  outCanvas.width = result.width;
  outCanvas.height = result.height;
  outCanvas.getContext('2d').putImageData(result, 0, 0);
}

// ---- 再生（並び替えのアニメーション） ----
let animFrame = null;
let animToken = 0;   // 新しい再生・ルール変更が来たら古いループを止めるための合図

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

function stopAnim() {
  animToken++;
  if (animFrame) cancelAnimationFrame(animFrame);
  animFrame = null;
  outCanvas.classList.remove('animating');
}

function playAnim() {
  if (!currentImageData) return;
  stopAnim();
  const myToken = animToken;
  const rule = ruleSelect.value, order = orderSelect.value;

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    render();
    return;
  }

  // 重くならないように、小さくした画像でアニメ用の移動元・移動先を計算する
  const { width: W, height: H } = currentImageData;
  const scale = Math.min(1, MAX_ANIM_SIDE / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(srcCanvas, 0, 0, w, h);
  const small = tctx.getImageData(0, 0, w, h);

  const order_ = computeOrder(small, rule, order);
  const n = w * h;
  const fromX = new Float32Array(n), fromY = new Float32Array(n);
  const toX = new Float32Array(n), toY = new Float32Array(n);
  const colR = new Uint8ClampedArray(n), colG = new Uint8ClampedArray(n);
  const colB = new Uint8ClampedArray(n), colA = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    const from = order_[i];
    fromX[i] = from % w; fromY[i] = (from / w) | 0;
    toX[i] = i % w; toY[i] = (i / w) | 0;
    const o = from * 4;
    colR[i] = small.data[o]; colG[i] = small.data[o + 1]; colB[i] = small.data[o + 2]; colA[i] = small.data[o + 3];
  }

  outCanvas.width = w;
  outCanvas.height = h;
  outCanvas.classList.add('animating');
  const buf = new Uint8ClampedArray(w * h * 4);
  const outCtx = outCanvas.getContext('2d');
  const t0 = performance.now();

  function frame(now) {
    if (myToken !== animToken) return;   // 別の再生・変更が割り込んだので、このループは終わり
    const t = Math.min(1, (now - t0) / ANIM_MS);
    const e = easeInOut(t);
    buf.fill(0);   // 透明に消す
    for (let i = 0; i < n; i++) {
      const x = Math.round(fromX[i] + (toX[i] - fromX[i]) * e);
      const y = Math.round(fromY[i] + (toY[i] - fromY[i]) * e);
      const o = (y * w + x) * 4;
      buf[o] = colR[i]; buf[o + 1] = colG[i]; buf[o + 2] = colB[i]; buf[o + 3] = colA[i];
    }
    outCtx.putImageData(new ImageData(buf, w, h), 0, 0);
    if (t < 1) {
      animFrame = requestAnimationFrame(frame);
    } else {
      outCanvas.classList.remove('animating');
      animFrame = null;
      render();   // 終わったら本来の解像度の結果に戻す
    }
  }
  animFrame = requestAnimationFrame(frame);
}

function loadImage(fileObj) {
  if (!fileObj || !fileObj.type.startsWith('image/')) return;
  const img = new Image();
  const url = URL.createObjectURL(fileObj);
  img.onload = () => {
    URL.revokeObjectURL(url);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    srcCanvas.width = w;
    srcCanvas.height = h;
    const ctx = srcCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    currentImageData = ctx.getImageData(0, 0, w, h);
    controls.hidden = false;
    canvases.hidden = false;
    stopAnim();
    render();
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

file.addEventListener('change', () => loadImage(file.files[0]));

drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('dragover');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadImage(f);
});

ruleSelect.addEventListener('change', () => { stopAnim(); render(); });
orderSelect.addEventListener('change', () => { stopAnim(); render(); });
playBtn.addEventListener('click', playAnim);

saveBtn.addEventListener('click', () => {
  tone(880);
  outCanvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pixel-sort.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);   // すぐ消すと Safari で保存できないことがある
  }, 'image/png');
});
