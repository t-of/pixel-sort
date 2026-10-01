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
const dropMat = $('dropMat'), fileMat = $('fileMat'), controls = $('controls'), canvases = $('canvases');
const dropRef = $('dropRef'), fileRef = $('fileRef'), refFigure = $('refFigure');
const srcCanvas = $('src'), refCanvas = $('ref'), outCanvas = $('out'), animStage = $('animStage');
const ruleSelect = $('rule'), orderSelect = $('order'), orderLabel = $('orderLabel'), saveBtn = $('save'), playBtn = $('play');
const mode1 = $('mode1'), mode2 = $('mode2');

function mode() { return mode2.checked ? '2' : '1'; }
function render() { mode() === '2' ? render2() : render1(); }
function playAnim() { mode() === '2' ? playAnim2() : playAnim1(); }

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

function render1() {
  if (!currentImageData) return;
  const rule = ruleSelect.value, order = orderSelect.value;
  save('rule', rule);
  save('order', order);
  const result = sortPixels(currentImageData, rule, order);
  outCanvas.width = result.width;
  outCanvas.height = result.height;
  outCanvas.getContext('2d').putImageData(result, 0, 0);
}

// ---- 2 枚モード: 素材のピクセルを、お手本に似た位置へ並べ替える ----
let matImageData = null, refImageData = null;   // どちらも同じ大きさ（お手本に合わせる）
let matRawImg = null, refRawImg = null;

// k 番目どうしを組にする（素材の並び orderA[k] の色を、お手本の並び orderB[k] の位置に置く）
function combineTwo(matData, refData, rule) {
  const { width, height } = refData;
  const orderA = computeOrder(matData, rule, 'asc');
  const orderB = computeOrder(refData, rule, 'asc');
  const out = new Uint8ClampedArray(matData.data.length);
  for (let k = 0; k < orderA.length; k++) {
    const from = orderA[k] * 4, to = orderB[k] * 4;
    out[to] = matData.data[from]; out[to + 1] = matData.data[from + 1];
    out[to + 2] = matData.data[from + 2]; out[to + 3] = matData.data[from + 3];
  }
  return new ImageData(out, width, height);
}

function render2() {
  if (!matImageData || !refImageData) return;
  const rule = ruleSelect.value;
  save('rule', rule);
  const result = combineTwo(matImageData, refImageData, rule);
  outCanvas.width = result.width;
  outCanvas.height = result.height;
  outCanvas.getContext('2d').putImageData(result, 0, 0);
}

// 両方そろったら、お手本の大きさに合わせて素材を中央切り抜き（cover）で描き直す
function tryBuildTwo() {
  if (!matRawImg || !refRawImg) return;
  const scale = Math.min(1, MAX_SIDE / Math.max(refRawImg.width, refRawImg.height));
  const w = Math.max(1, Math.round(refRawImg.width * scale));
  const h = Math.max(1, Math.round(refRawImg.height * scale));

  refCanvas.width = w; refCanvas.height = h;
  refCanvas.getContext('2d').drawImage(refRawImg, 0, 0, w, h);
  refImageData = refCanvas.getContext('2d').getImageData(0, 0, w, h);

  srcCanvas.width = w; srcCanvas.height = h;
  const sctx = srcCanvas.getContext('2d');
  const s = Math.max(w / matRawImg.width, h / matRawImg.height);
  const dw = matRawImg.width * s, dh = matRawImg.height * s;
  sctx.drawImage(matRawImg, (w - dw) / 2, (h - dh) / 2, dw, dh);
  matImageData = sctx.getImageData(0, 0, w, h);

  controls.hidden = false;
  canvases.hidden = false;
  refFigure.hidden = false;
  stopAnim();
  render2();
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
  canvases.classList.remove('anim-active');
}

// 小さくした画像を作る（アニメ計算を重くしないため）
function shrinkTo(canvas, w, h) {
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(canvas, 0, 0, w, h);
  return tctx.getImageData(0, 0, w, h);
}

function playAnim1() {
  if (!currentImageData) return;
  stopAnim();
  const myToken = animToken;
  const rule = ruleSelect.value, order = orderSelect.value;

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    render1();
    return;
  }

  const { width: W, height: H } = currentImageData;
  const scale = Math.min(1, MAX_ANIM_SIDE / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const small = shrinkTo(srcCanvas, w, h);

  // order_[i] は「新しい位置 i に来る、元の位置」。左の元の位置から右の並び替え後の位置 i へ飛ぶ
  const order_ = computeOrder(small, rule, order);
  const n = w * h;
  const orderTo = new Int32Array(n);
  for (let i = 0; i < n; i++) orderTo[i] = i;
  runFlight(w, h, order_, orderTo, small.data, myToken, render1);
}

// 2 枚モードの再生: 左は素材の元の位置から、右はお手本に合わせた位置へ飛ぶ
function playAnim2() {
  if (!matImageData || !refImageData) return;
  stopAnim();
  const myToken = animToken;
  const rule = ruleSelect.value;

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    render2();
    return;
  }

  const { width: W, height: H } = matImageData;   // 素材とお手本は同じ大きさ
  const scale = Math.min(1, MAX_ANIM_SIDE / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const smallMat = shrinkTo(srcCanvas, w, h);
  const smallRef = shrinkTo(refCanvas, w, h);

  const orderA = computeOrder(smallMat, rule, 'asc');
  const orderB = computeOrder(smallRef, rule, 'asc');
  runFlight(w, h, orderA, orderB, smallMat.data, myToken, render2);
}

// 左（素材）の orderFrom[k] の位置から、右（結果）の orderTo[k] の位置へ、ピクセルを 1 枚ずつ飛ばす
function runFlight(w, h, orderFrom, orderTo, srcData, myToken, onDone) {
  const n = w * h;
  const gap = Math.max(4, Math.round(w * 0.06));
  const stageW = w * 2 + gap, stageH = h;
  const fromX = new Float32Array(n), fromY = new Float32Array(n);
  const toX = new Float32Array(n), toY = new Float32Array(n);
  const colR = new Uint8ClampedArray(n), colG = new Uint8ClampedArray(n);
  const colB = new Uint8ClampedArray(n), colA = new Uint8ClampedArray(n);
  for (let k = 0; k < n; k++) {
    const from = orderFrom[k], to = orderTo[k];
    fromX[k] = from % w; fromY[k] = (from / w) | 0;
    toX[k] = (to % w) + w + gap; toY[k] = (to / w) | 0;
    const o = from * 4;
    colR[k] = srcData[o]; colG[k] = srcData[o + 1]; colB[k] = srcData[o + 2]; colA[k] = srcData[o + 3];
  }

  animStage.width = stageW;
  animStage.height = stageH;
  canvases.classList.add('anim-active');
  const buf = new Uint8ClampedArray(stageW * stageH * 4);
  const stageCtx = animStage.getContext('2d');
  const t0 = performance.now();
  const FLIGHT = 0.3;   // 1 匹あたりの移動にかける時間（全体に対する割合）
  const SPREAD = 1 - FLIGHT;   // 出発する時刻をこの割合にずらして広げる

  function frame(now) {
    if (myToken !== animToken) return;   // 別の再生・変更が割り込んだので、このループは終わり
    const t = Math.min(1, (now - t0) / ANIM_MS);
    buf.fill(0);   // 透明に消す
    for (let i = 0; i < n; i++) {
      const start = (i / n) * SPREAD;
      const p = Math.min(1, Math.max(0, (t - start) / FLIGHT));
      const e = easeInOut(p);
      const x = Math.round(fromX[i] + (toX[i] - fromX[i]) * e);
      const y = Math.round(fromY[i] + (toY[i] - fromY[i]) * e);
      const o = (y * stageW + x) * 4;
      buf[o] = colR[i]; buf[o + 1] = colG[i]; buf[o + 2] = colB[i]; buf[o + 3] = colA[i];
    }
    stageCtx.putImageData(new ImageData(buf, stageW, stageH), 0, 0);
    if (t < 1) {
      animFrame = requestAnimationFrame(frame);
    } else {
      canvases.classList.remove('anim-active');
      animFrame = null;
      onDone();   // 終わったら本来の解像度の結果に戻す
    }
  }
  animFrame = requestAnimationFrame(frame);
}

// 1 枚モード: 選んだ画像をそのまま縮めて並び替える
function loadImage1(fileObj) {
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

// 2 枚モード: 画像を読み込んで保っておくだけ（大きさを合わせる処理は両方そろってから）
function loadRaw(fileObj, onReady) {
  if (!fileObj || !fileObj.type.startsWith('image/')) return;
  const img = new Image();
  const url = URL.createObjectURL(fileObj);
  img.onload = () => { URL.revokeObjectURL(url); onReady(img); };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

function onFileMat(fileObj) {
  if (mode() === '2') loadRaw(fileObj, (img) => { matRawImg = img; tryBuildTwo(); });
  else loadImage1(fileObj);
}
function onFileRef(fileObj) {
  loadRaw(fileObj, (img) => { refRawImg = img; tryBuildTwo(); });
}

function bindDrop(dropEl, onFile) {
  dropEl.addEventListener('dragover', (e) => { e.preventDefault(); dropEl.classList.add('dragover'); });
  dropEl.addEventListener('dragleave', () => dropEl.classList.remove('dragover'));
  dropEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropEl.classList.remove('dragover');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) onFile(f);
  });
}

fileMat.addEventListener('change', () => onFileMat(fileMat.files[0]));
fileRef.addEventListener('change', () => onFileRef(fileRef.files[0]));
bindDrop(dropMat, onFileMat);
bindDrop(dropRef, onFileRef);

mode1.addEventListener('change', switchMode);
mode2.addEventListener('change', switchMode);

// モードを切り替えたら、画像をやり直してもらう（1 枚モードと 2 枚モードは別の素材・結果を持つため）
function switchMode() {
  stopAnim();
  currentImageData = null;
  matImageData = null; refImageData = null;
  matRawImg = null; refRawImg = null;
  fileMat.value = ''; fileRef.value = '';
  controls.hidden = true;
  canvases.hidden = true;
  refFigure.hidden = true;
  dropRef.hidden = mode() !== '2';
  orderLabel.hidden = mode() === '2';
}
switchMode();

ruleSelect.addEventListener('change', () => { stopAnim(); render(); });
orderSelect.addEventListener('change', () => { stopAnim(); render(); });
playBtn.addEventListener('click', playAnim);

saveBtn.addEventListener('click', () => {
  tone(880);
  if (animFrame) { stopAnim(); render(); }   // 再生中は小さいアニメの絵ではなく、本来の結果を保存する
  outCanvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pixel-sort.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);   // すぐ消すと Safari で保存できないことがある
  }, 'image/png');
});
