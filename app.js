// Retro Cam — fotocamera con filtri vintage.
// Tutto gira nel browser: nessun dato lascia il dispositivo.
// Filtri: UI Retro (immagine), Cane (rilevamento volto), Mazz2016 (immagine).

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm";
const TASKS_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20";

// Ordine dei filtri (per swipe) e nomi dei file immagine
const FILTERS = ["ui", "dog", "mazz"];

// ---- Elementi DOM ----
const app     = document.getElementById("app");
const video   = document.getElementById("cam");
const stage   = document.getElementById("stage");
const ctx     = stage.getContext("2d", { willReadFrequently: false });
const startEl = document.getElementById("start");
const startBtn= document.getElementById("startBtn");
const flipBtn = document.getElementById("flip");
const shutter = document.getElementById("shutter");
const previewEl = document.getElementById("preview");
const shotImg = document.getElementById("shot");
const retakeBtn = document.getElementById("retake");
const saveBtn = document.getElementById("save");
const errEl   = document.getElementById("err");
const errMsg  = document.getElementById("errMsg");
const retryBtn= document.getElementById("retry");
const toastEl = document.getElementById("toast");
const segBtns = [...document.querySelectorAll(".seg")];

// ---- Stato ----
let facing = "user";        // "user" = selfie, "environment" = principale
let filter = "ui";
let stream = null;
let running = false;
let lastShot = null;
const VERSION = "10"; // deve combaciare con ?v= in index.html (per la cache)
const DEBUG = new URLSearchParams(location.search).has("debug");

// Diagnostica (mostrata con ?debug)
let dbgKp = -1, dbgBox = false, dbgFaceW = 0, dbgEarsW = 0;

// Rilevatore volti (caricato in modo pigro)
let detector = null;
let detectorLoading = null;
let lastDetections = [];    // keypoints NORMALIZZATI [0..1] nel frame INTERO della camera
let lastDetectTs = -1;
let detectError = "";
let detCanvas = null, detCtx = null; // frame pieno usato per il rilevamento
let detDelegate = "";                // "CPU" o "GPU" (per il debug)

// Immagini dei filtri
let dogLayers = null;       // {ears, nose, tongue} oppure null → fallback vettoriale
let uiLayer = null;         // canvas dell'UI con sfondo bianco reso trasparente
let mazzImg = null;         // immagine Mazz2016

let W = 0, H = 0;
let DPR = Math.min(window.devicePixelRatio || 1, 2);

// =====================================================================
//  Avvio
// =====================================================================
startBtn.addEventListener("click", () => { startEl.classList.add("hidden"); init(); });
retryBtn.addEventListener("click", () => { errEl.classList.add("hidden"); init(); });

flipBtn.addEventListener("click", async () => {
  facing = facing === "user" ? "environment" : "user";
  try { await openCamera(); } catch (e) { showError(e); }
});

segBtns.forEach((b) => b.addEventListener("click", () => setFilter(b.dataset.filter)));

// Swipe orizzontale per cambiare filtro
let touchX = null;
stage.addEventListener("touchstart", (e) => (touchX = e.touches[0].clientX), { passive: true });
stage.addEventListener("touchend", (e) => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 60) {
    const i = FILTERS.indexOf(filter);
    const ni = dx < 0 ? (i + 1) % FILTERS.length : (i - 1 + FILTERS.length) % FILTERS.length;
    setFilter(FILTERS[ni]);
  }
  touchX = null;
});

shutter.addEventListener("click", capture);
retakeBtn.addEventListener("click", () => previewEl.classList.add("hidden"));
saveBtn.addEventListener("click", savePhoto);

window.addEventListener("resize", resize);
window.addEventListener("orientationchange", () => setTimeout(resize, 250));

function setFilter(f) {
  filter = f;
  app.dataset.filter = f;
  segBtns.forEach((b) => b.classList.toggle("is-active", b.dataset.filter === f));
  if (f === "dog") ensureDetector();
}

// =====================================================================
//  Inizializzazione
// =====================================================================
async function init() {
  app.dataset.filter = filter;
  loadAssets();
  try {
    await openCamera();
    resize();
    running = true;
    requestAnimationFrame(loop);
  } catch (err) {
    showError(err);
  }
}

// ---- Fotocamera: Full HD (nitida ma affidabile). NIENTE 12MP: le modalità ad
// altissima risoluzione sul telefono danno frame lenti/instabili e mandano in tilt
// il rilevamento volti. 1080p è più che sufficiente per foto e filtri.
async function openCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  };
  stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;
  await video.play();
  await new Promise((res) => {
    if (video.videoWidth) return res();
    video.onloadedmetadata = () => res();
  });
}

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = Math.round(window.innerWidth * DPR);
  H = Math.round(window.innerHeight * DPR);
  stage.width = W;
  stage.height = H;
}

// =====================================================================
//  Ciclo di rendering (anteprima live)
// =====================================================================
function loop(ts) {
  if (!running) return;
  if (video.readyState >= 2 && W && H) {
    paintVideo(ctx, W, H);
    if (filter === "dog") detectOnStage(ts);
    paintFilter(ctx, W, H);
    if (DEBUG) paintDebug();
  }
  requestAnimationFrame(loop);
}

// Trasformazione "cover": riempi (cw,ch) mantenendo le proporzioni del video
function coverBox(cw, ch) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale, dh = vh * scale;
  return { dx: (cw - dw) / 2, dy: (ch - dh) / 2, dw, dh };
}

function paintVideo(c, cw, ch) {
  const box = coverBox(cw, ch);
  const front = facing === "user";
  c.save();
  if (front) { c.translate(cw, 0); c.scale(-1, 1); }
  c.drawImage(video, box.dx, box.dy, box.dw, box.dh);
  c.restore();
}

function paintFilter(c, cw, ch) {
  if (filter === "dog") {
    paintDog(c, cw, ch);
  } else if (filter === "ui") {
    if (uiLayer) drawImageFit(c, cw, ch, uiLayer, "fill");
    else drawRetroUI(c, cw, ch);
  } else if (filter === "mazz") {
    if (mazzImg) drawMazz(c, cw, ch, mazzImg);
    else hintMissing(c, cw, ch, "assets/mazz2016.png");
  }
}

// =====================================================================
//  Rilevamento volti — SUL CANVAS mostrato (robusto sui browser mobili)
// =====================================================================
function detectOnStage(ts) {
  if (!detector) { ensureDetector(); return; }
  if (ts <= lastDetectTs) return;
  lastDetectTs = ts;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  // Rilevo sul FRAME INTERO (non ritagliato): così il volto ha dimensioni
  // normali e BlazeFace lo trova anche quando lo schermo verticale zooma molto.
  if (!detCanvas) { detCanvas = document.createElement("canvas"); detCtx = detCanvas.getContext("2d"); }
  const target = 480;
  const dW = vw >= vh ? target : Math.round(target * vw / vh);
  const dH = vw >= vh ? Math.round(target * vh / vw) : target;
  if (detCanvas.width !== dW) detCanvas.width = dW;
  if (detCanvas.height !== dH) detCanvas.height = dH;
  detCtx.drawImage(video, 0, 0, dW, dH);
  try {
    const res = detector.detectForVideo(detCanvas, ts);
    lastDetections = res.detections || [];
    detectError = "";
  } catch (e) {
    detectError = (e && e.message) || String(e);
    if (DEBUG) console.error("detect:", e);
  }
}

// Ricava i 6 punti del viso in pixel del canvas MOSTRATO, partendo dal
// rilevamento fatto sul frame intero: mappo con lo stesso "cover" del video e
// specchio se è la camera frontale. Se mancano i keypoints, li stimo dal riquadro.
function faceLandmarks(det, cw, ch) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const box = coverBox(vw, vh, cw, ch);
  const front = facing === "user";
  const mapN = (nx, ny) => {           // da normalizzato-frame a pixel-schermo
    const px = box.dx + nx * box.dw;
    return [front ? cw - px : px, box.dy + ny * box.dh];
  };
  const kp = det.keypoints;
  if (kp && kp.length >= 6)
    return [0, 1, 2, 3, 4, 5].map((i) => mapN(kp[i].x, kp[i].y));
  const b = det.boundingBox; // PIXEL del detCanvas → normalizzo
  if (b && b.width && b.height && detCanvas) {
    const nx = (v) => v / detCanvas.width, ny = (v) => v / detCanvas.height;
    const x = b.originX, y = b.originY, w = b.width, h = b.height;
    return [
      mapN(nx(x + 0.32 * w), ny(y + 0.42 * h)), // occhio dx
      mapN(nx(x + 0.68 * w), ny(y + 0.42 * h)), // occhio sx
      mapN(nx(x + 0.50 * w), ny(y + 0.58 * h)), // naso
      mapN(nx(x + 0.50 * w), ny(y + 0.78 * h)), // bocca
      mapN(nx(x + 0.02 * w), ny(y + 0.45 * h)), // orecchio dx
      mapN(nx(x + 0.98 * w), ny(y + 0.45 * h)), // orecchio sx
    ];
  }
  return null;
}

function paintDog(c, cw, ch) {
  for (const det of lastDetections) {
    const kp = det.keypoints;
    dbgKp = kp ? kp.length : 0;
    dbgBox = !!det.boundingBox;
    const L = faceLandmarks(det, cw, ch);
    if (!L) continue;
    const rEye = L[0], lEye = L[1], nose = L[2], mouth = L[3], rEar = L[4], lEar = L[5];

    const eyeCx = (rEye[0] + lEye[0]) / 2, eyeCy = (rEye[1] + lEye[1]) / 2;
    // Verticale del volto = da centro-occhi verso la bocca. La bocca è SEMPRE
    // sotto gli occhi, anche con la camera specchiata: così il cane non si
    // capovolge mai (il problema di prima nasceva dall'usare la linea occhi).
    const dnx = mouth[0] - eyeCx, dny = mouth[1] - eyeCy;
    const dlen = Math.hypot(dnx, dny) || 1;
    const down = [dnx / dlen, dny / dlen];
    const up = [-down[0], -down[1]];
    const angle = Math.atan2(dny, dnx) - Math.PI / 2; // 0 quando il volto è dritto
    const eyeDist = Math.hypot(lEye[0] - rEye[0], lEye[1] - rEye[1]);
    let faceW = Math.hypot(lEar[0] - rEar[0], lEar[1] - rEar[1]);
    if (!faceW || faceW < eyeDist) faceW = eyeDist * 2.4;

    if (dogLayers) {
      // Il cane è proporzionale alla larghezza del volto (faceW) → si adatta.
      // k = fattore globale delle dimensioni. MAX_W = tetto: sul telefono la
      // camera 4:3 viene zoomata su schermo verticale e il volto diventa enorme;
      // qui limitiamo le orecchie al 90% della larghezza schermo così il cane
      // non esce mai dai bordi, mantenendo le proporzioni tra le parti.
      const k = 0.82;
      let scale = k;
      let earsW = faceW * 1.7 * k;
      const maxW = cw * 0.9;
      if (earsW > maxW) { scale *= maxW / earsW; earsW = maxW; }
      dbgFaceW = Math.round(faceW); dbgEarsW = Math.round(earsW);
      drawImgCentered(c, dogLayers.ears, eyeCx + up[0] * faceW * 0.55, eyeCy + up[1] * faceW * 0.55, earsW, angle);
      drawImgCentered(c, dogLayers.nose, nose[0], nose[1], faceW * 0.5 * scale, angle);
      drawImgCentered(c, dogLayers.tongue, mouth[0] - up[0] * faceW * 0.28, mouth[1] - up[1] * faceW * 0.28, faceW * 0.55 * scale, angle);
    } else {
      drawVectorDog(c, eyeCx, eyeCy, nose, mouth, faceW, angle, up);
    }
  }
}

function drawImgCentered(c, img, cx, cy, w, angle) {
  const h = w * (img.height / img.width);
  c.save();
  c.translate(cx, cy); c.rotate(angle);
  c.drawImage(img, -w / 2, -h / 2, w, h);
  c.restore();
}

function drawVectorDog(c, eyeCx, eyeCy, nose, mouth, faceW, angle, up) {
  c.save();
  c.translate(eyeCx + up[0] * faceW * 0.5, eyeCy + up[1] * faceW * 0.5); c.rotate(angle);
  const ew = faceW * 0.42, eh = faceW * 0.62;
  for (const s of [-1, 1]) {
    c.save(); c.translate(s * faceW * 0.62, 0); c.rotate(s * 0.25);
    c.fillStyle = "#7a4a22"; c.beginPath(); c.ellipse(0, 0, ew / 2, eh / 2, 0, 0, 7); c.fill();
    c.fillStyle = "#f4c6c6"; c.beginPath(); c.ellipse(0, eh * 0.05, ew / 3.4, eh / 3, 0, 0, 7); c.fill();
    c.restore();
  }
  c.restore();
  c.save(); c.translate(nose[0], nose[1]); c.rotate(angle);
  c.fillStyle = "#3a2416"; c.beginPath(); c.ellipse(0, 0, faceW * 0.16, faceW * 0.12, 0, 0, 7); c.fill();
  c.fillStyle = "rgba(255,255,255,.35)"; c.beginPath(); c.ellipse(-faceW * 0.05, -faceW * 0.04, faceW * 0.04, faceW * 0.03, 0, 0, 7); c.fill();
  c.restore();
  c.save(); c.translate(mouth[0] - up[0] * faceW * 0.22, mouth[1] - up[1] * faceW * 0.22); c.rotate(angle);
  c.fillStyle = "#e8607a"; roundRect(c, -faceW * 0.12, 0, faceW * 0.24, faceW * 0.32, faceW * 0.12); c.fill();
  c.strokeStyle = "rgba(150,20,50,.6)"; c.lineWidth = faceW * 0.02;
  c.beginPath(); c.moveTo(0, faceW * 0.04); c.lineTo(0, faceW * 0.26); c.stroke();
  c.restore();
}

// =====================================================================
//  Caricamento immagini dei filtri
// =====================================================================
function loadAssets() {
  // Cane
  loadImg("assets/dog.png", (img) => { try { dogLayers = splitDog(img); } catch (_) { dogLayers = null; } });
  // UI Pokémon: rendo trasparente lo sfondo bianco
  loadImg("assets/ui.png", (img) => { try { uiLayer = keyOutWhite(img); } catch (_) { uiLayer = null; } });
  // Mazz2016 (già con sfondo trasparente)
  loadImg("assets/mazz2016.png", (img) => { mazzImg = img; });
}

function loadImg(src, ok) {
  const img = new Image();
  // Niente crossOrigin: le immagini sono nello stesso sito, così funziona
  // anche aprendo il file in locale. Aggiungo ?v per evitare la cache vecchia.
  img.onload = () => ok(img);
  img.onerror = () => {};
  img.src = src + (src.includes("?") ? "&" : "?") + "v=" + VERSION;
}

// Ritaglia dog.png in 3 fasce (orecchie/naso/lingua) usando gli spazi trasparenti
function splitDog(img) {
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const data = x.getImageData(0, 0, c.width, c.height).data;
  const rowHas = new Array(c.height).fill(false);
  for (let y = 0; y < c.height; y++)
    for (let xx = 0; xx < c.width; xx++)
      if (data[(y * c.width + xx) * 4 + 3] > 20) { rowHas[y] = true; break; }
  const segs = []; let start = -1;
  for (let y = 0; y <= c.height; y++) {
    const on = y < c.height && rowHas[y];
    if (on && start < 0) start = y;
    else if (!on && start >= 0) { segs.push([start, y - 1]); start = -1; }
  }
  segs.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  const top = segs.slice(0, 3).sort((a, b) => a[0] - b[0]);
  if (top.length < 3) throw new Error("layout dog.png inatteso");
  const crop = ([y0, y1]) => {
    let minX = c.width, maxX = 0;
    for (let y = y0; y <= y1; y++)
      for (let xx = 0; xx < c.width; xx++)
        if (data[(y * c.width + xx) * 4 + 3] > 20) { if (xx < minX) minX = xx; if (xx > maxX) maxX = xx; }
    const w = maxX - minX + 1, h = y1 - y0 + 1;
    const cc = document.createElement("canvas"); cc.width = w; cc.height = h;
    cc.getContext("2d").drawImage(c, minX, y0, w, h, 0, 0, w, h);
    return cc;
  };
  return { ears: crop(top[0]), nose: crop(top[1]), tongue: crop(top[2]) };
}

// Rende trasparente lo sfondo bianco di uno screenshot (flood fill dai bordi + centro),
// preservando gli elementi UI colorati (pokéball, pulsanti, testo).
function keyOutWhite(img, thr = 236) {
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const id = x.getImageData(0, 0, c.width, c.height);
  const d = id.data, w = c.width, h = c.height;
  const white = (p) => d[p] >= thr && d[p + 1] >= thr && d[p + 2] >= thr && d[p + 3] > 8;
  const stack = [];
  const push = (px, py) => { const p = (py * w + px); if (!seen[p]) stack.push(p); };
  const seen = new Uint8Array(w * h);
  // semi: tutto il bordo + il centro
  for (let px = 0; px < w; px++) { push(px, 0); push(px, h - 1); }
  for (let py = 0; py < h; py++) { push(0, py); push(w - 1, py); }
  push(w >> 1, h >> 1);
  while (stack.length) {
    const p = stack.pop();
    if (seen[p]) continue;
    seen[p] = 1;
    const i = p * 4;
    if (!white(i)) continue;
    d[i + 3] = 0; // trasparente
    const px = p % w, py = (p / w) | 0;
    if (px > 0) push(px - 1, py);
    if (px < w - 1) push(px + 1, py);
    if (py > 0) push(px, py - 1);
    if (py < h - 1) push(px, py + 1);
  }
  x.putImageData(id, 0, 0);
  return c;
}

// =====================================================================
//  Rilevatore volti (MediaPipe) — caricato solo quando serve
// =====================================================================
function ensureDetector() {
  if (detector || detectorLoading) return detectorLoading;
  showToast("Carico il filtro cane…", 0);
  detectorLoading = (async () => {
    const vision = await import(TASKS_URL);
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.3,
    });
    // CPU prima: su molti telefoni il delegate GPU "parte" ma non restituisce
    // rilevamenti. La CPU è affidabile ovunque (e a 480px è velocissima).
    try {
      detector = await vision.FaceDetector.createFromOptions(fileset, opts("CPU"));
      detDelegate = "CPU";
    } catch (_) {
      detector = await vision.FaceDetector.createFromOptions(fileset, opts("GPU"));
      detDelegate = "GPU";
    }
    lastDetectTs = -1;
    hideToast();
  })().catch((e) => {
    console.error(e);
    detectError = (e && e.message) || String(e);
    showToast("Filtro cane non disponibile (rete?)", 3000);
    detectorLoading = null;
  });
  return detectorLoading;
}

// =====================================================================
//  FILTRO UI RETRO — fallback disegnato (usato solo se manca assets/ui.png)
// =====================================================================
function drawRetroUI(c, W, H) {
  const s = Math.min(W, H);
  c.save(); c.textBaseline = "middle";
  const barH = s * 0.052;
  const g = c.createLinearGradient(0, 0, 0, barH);
  g.addColorStop(0, "rgba(10,14,18,.45)"); g.addColorStop(1, "rgba(10,14,18,0)");
  c.fillStyle = g; c.fillRect(0, 0, W, barH * 1.4);
  c.fillStyle = "rgba(255,255,255,.92)";
  const now = new Date(); let hh = now.getHours(); const mm = String(now.getMinutes()).padStart(2, "0");
  const ampm = hh >= 12 ? "PM" : "AM"; hh = hh % 12 || 12;
  c.textAlign = "right"; c.font = `600 ${Math.round(barH * 0.46)}px system-ui, sans-serif`;
  c.fillText(`${hh}:${mm} ${ampm}`, W - s * 0.03, barH * 0.55);
  c.font = `${Math.round(barH * 0.4)}px system-ui, sans-serif`;
  c.fillText("74%  LTE", W - s * 0.16, barH * 0.55);
  c.textAlign = "left";
  for (let i = 0; i < 4; i++) { c.globalAlpha = 0.85 - i * 0.12; c.beginPath(); c.arc(s * 0.045 + i * s * 0.028, barH * 0.55, s * 0.008, 0, 7); c.fill(); }
  c.globalAlpha = 1;
  drawCircleBtn(c, s * 0.03 + s * 0.075, barH + s * 0.02 + s * 0.075, s * 0.075, "🏃");
  const arW = s * 0.17, arH = s * 0.052, arX = W - arW - s * 0.03, arY = barH + s * 0.03;
  roundRect(c, arX, arY, arW, arH, arH / 2); c.fillStyle = "rgba(205,228,228,.5)"; c.fill();
  c.fillStyle = "rgba(20,60,66,.95)"; c.font = `700 ${Math.round(arH * 0.5)}px system-ui, sans-serif`;
  c.textAlign = "left"; c.fillText("AR", arX + arH * 0.45, arY + arH * 0.52);
  c.beginPath(); c.arc(arX + arW - arH * 0.52, arY + arH * 0.5, arH * 0.36, 0, 7); c.fillStyle = "#37b6c4"; c.fill();
  const rbR = s * 0.082, rx = W - s * 0.045 - rbR;
  drawCircleBtn(c, rx, H - s * 0.30, rbR, "📷");
  drawCircleBtn(c, rx, H - s * 0.135, rbR, "🎒");
  drawPokeball(c, W * 0.5, H - s * 0.13, s * 0.115);
  c.restore();
}
function drawCircleBtn(c, cx, cy, r, glyph) {
  c.save(); c.beginPath(); c.arc(cx, cy, r, 0, 7);
  c.fillStyle = "rgba(210,232,232,.30)"; c.fill();
  c.lineWidth = r * 0.14; c.strokeStyle = "rgba(120,190,196,.85)"; c.stroke();
  c.font = `${Math.round(r * 1.05)}px system-ui, "Segoe UI Emoji", sans-serif`;
  c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = "rgba(30,70,76,.95)";
  c.fillText(glyph, cx, cy + r * 0.04); c.restore();
}
function drawPokeball(c, cx, cy, r) {
  c.save(); c.translate(cx, cy);
  c.beginPath(); c.arc(0, 0, r, Math.PI, 0); c.fillStyle = "#e64b3c"; c.fill();
  c.beginPath(); c.arc(0, 0, r, 0, Math.PI); c.fillStyle = "#f4f4f4"; c.fill();
  c.fillStyle = "#232323"; c.fillRect(-r, -r * 0.11, r * 2, r * 0.22);
  c.lineWidth = r * 0.06; c.strokeStyle = "rgba(0,0,0,.5)"; c.beginPath(); c.arc(0, 0, r, 0, 7); c.stroke();
  c.beginPath(); c.arc(0, 0, r * 0.3, 0, 7); c.fillStyle = "#232323"; c.fill();
  c.beginPath(); c.arc(0, 0, r * 0.2, 0, 7); c.fillStyle = "#f4f4f4"; c.fill();
  c.lineWidth = r * 0.05; c.strokeStyle = "#9aa"; c.stroke();
  c.beginPath(); c.arc(-r * 0.35, -r * 0.4, r * 0.18, 0, 7); c.fillStyle = "rgba(255,255,255,.35)"; c.fill();
  c.restore();
}

function hintMissing(c, W, H, name) {
  c.save();
  c.fillStyle = "rgba(0,0,0,.55)";
  const bw = Math.min(W * 0.8, 520), bh = 80 * DPR, bx = (W - bw) / 2, by = H * 0.5 - bh / 2;
  roundRect(c, bx, by, bw, bh, 16 * DPR); c.fill();
  c.fillStyle = "#fff"; c.textAlign = "center"; c.textBaseline = "middle";
  c.font = `${Math.round(16 * DPR)}px system-ui, sans-serif`;
  c.fillText("Manca " + name, W / 2, by + bh / 2 - 10 * DPR);
  c.font = `${Math.round(13 * DPR)}px system-ui, sans-serif`;
  c.fillStyle = "rgba(255,255,255,.75)";
  c.fillText("aggiungila nella cartella assets/", W / 2, by + bh / 2 + 14 * DPR);
  c.restore();
}

// =====================================================================
//  Scatto ad alta risoluzione + salvataggio
// =====================================================================
function captureSize() {
  const aspect = window.innerWidth / window.innerHeight;
  const long = Math.min(Math.max(video.videoWidth, video.videoHeight) || 1920, 2560);
  let w, h;
  if (aspect <= 1) { h = long; w = Math.round(h * aspect); }   // verticale
  else { w = long; h = Math.round(w / aspect); }               // orizzontale
  return { w: Math.max(w, 2), h: Math.max(h, 2) };
}

function capture() {
  const { w, h } = captureSize();
  const cap = document.createElement("canvas");
  cap.width = w; cap.height = h;
  const cc = cap.getContext("2d");
  paintVideo(cc, w, h);
  paintFilter(cc, w, h);           // riusa lastDetections (normalizzate) per il cane
  cap.toBlob((blob) => {
    if (!blob) return;
    lastShot = blob;
    if (shotImg.src) URL.revokeObjectURL(shotImg.src);
    shotImg.src = URL.createObjectURL(blob);
    previewEl.classList.remove("hidden");
  }, "image/jpeg", 0.95);
}

async function savePhoto() {
  if (!lastShot) return;
  const file = new File([lastShot], `retrocam-${stamp()}.jpg`, { type: "image/jpeg" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Retro Cam" }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(lastShot);
  const a = document.createElement("a");
  a.href = url; a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  showToast("Foto salvata ⬇︎", 1800);
  previewEl.classList.add("hidden");
}

// =====================================================================
//  Utility
// =====================================================================
function roundRect(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function drawImageFit(c, cw, ch, img, mode, ax = 0.5, ay = 0.5) {
  const iw = img.width || img.naturalWidth, ih = img.height || img.naturalHeight;
  if (!iw || !ih) return;
  if (mode === "fill") { c.drawImage(img, 0, 0, cw, ch); return; }
  const scale = mode === "cover" ? Math.max(cw / iw, ch / ih) : Math.min(cw / iw, ch / ih);
  const dw = iw * scale, dh = ih * scale;
  // ax/ay: ancoraggio 0=inizio, .5=centro, 1=fine
  c.drawImage(img, (cw - dw) * ax, (ch - dh) * ay, dw, dh);
}
// Mazz2016: soggetto allineato in basso-a-destra. Lo teniamo un po' più piccolo
// del "cover" e ancorato all'angolo basso-destra, così resta più spazio di
// sfondo (camera) a sinistra e in alto.
// MAZZ_SCALE: 1 = riempie l'altezza; più basso = più piccolo e più a destra.
function drawMazz(c, cw, ch, img) {
  const iw = img.width || img.naturalWidth, ih = img.height || img.naturalHeight;
  if (!iw || !ih) return;
  const MAZZ_SCALE = 0.8;    // 1 = riempie l'altezza; più basso = più piccolo
  const MAZZ_SHIFT_X = 0.12; // quanto spostarlo verso destra (frazione larghezza)
  const s = Math.max(cw / iw, ch / ih) * MAZZ_SCALE;
  const dw = iw * s, dh = ih * s;
  c.drawImage(img, cw - dw + dw * MAZZ_SHIFT_X, ch - dh, dw, dh);
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
let toastTimer = null;
function showToast(msg, ms = 2000) {
  toastEl.textContent = msg; toastEl.classList.remove("hidden");
  clearTimeout(toastTimer); if (ms > 0) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { toastEl.classList.add("hidden"); }

function paintDebug() {
  ctx.save();
  // Miniatura di ciò che ANALIZZA il rilevatore (frame intero) + riquadro rosso
  if (detCanvas) {
    const tw = Math.min(150 * DPR, W * 0.42), th = tw * detCanvas.height / detCanvas.width;
    const tx = W - tw - 8 * DPR, ty = 76 * DPR;
    ctx.drawImage(detCanvas, tx, ty, tw, th);
    ctx.lineWidth = 2 * DPR; ctx.strokeStyle = "#0f0"; ctx.strokeRect(tx, ty, tw, th);
    ctx.strokeStyle = "#f00";
    for (const d of lastDetections) {
      const b = d.boundingBox;
      if (b) ctx.strokeRect(tx + b.originX / detCanvas.width * tw, ty + b.originY / detCanvas.height * th,
        b.width / detCanvas.width * tw, b.height / detCanvas.height * th);
    }
    ctx.fillStyle = "#0f0"; ctx.font = `${Math.round(11 * DPR)}px monospace`; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText("rilevatore vede:", tx, ty - 2 * DPR);
  }
  const boxH = 108 * DPR;
  ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillRect(0, H - boxH, W, boxH);
  ctx.fillStyle = "#0f0"; ctx.font = `${Math.round(13 * DPR)}px monospace`; ctx.textAlign = "left"; ctx.textBaseline = "top";
  const dsz = detCanvas ? `${detCanvas.width}x${detCanvas.height}` : "-";
  const lines = [
    `VERSIONE=${VERSION}  filtro=${filter} cam=${facing} ${video.videoWidth}x${video.videoHeight}`,
    `detector=${detector ? "ok" : "no"}(${detDelegate}) volti=${lastDetections.length} fr=${dsz}`,
    `keypoints=${dbgKp} riquadro=${dbgBox} faceW=${dbgFaceW} earsW=${dbgEarsW}`,
    `assets dog=${!!dogLayers} ui=${!!uiLayer} mazz=${!!mazzImg}`,
    detectError ? `err=${detectError.slice(0, 60)}` : "",
  ];
  lines.forEach((l, i) => ctx.fillText(l, 8 * DPR, H - boxH + 6 * DPR + i * 18 * DPR));
  ctx.restore();
}

function showError(err) {
  running = false;
  console.error(err);
  let msg = "Non riesco ad accedere alla fotocamera.";
  if (err && err.name === "NotAllowedError")
    msg = "Permesso negato. Consenti l'accesso alla fotocamera.";
  else if (err && err.name === "NotFoundError")
    msg = "Nessuna fotocamera trovata su questo dispositivo.";
  else if (location.protocol !== "https:" && location.hostname !== "localhost")
    msg = "La fotocamera richiede HTTPS. Apri il sito da GitHub Pages (https://…).";
  errMsg.textContent = msg;
  errEl.classList.remove("hidden");
}
