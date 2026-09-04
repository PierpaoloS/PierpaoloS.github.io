// Retro Cam — fotocamera con due filtri vintage (cane + UI retro).
// Tutto gira nel browser: nessun dato lascia il dispositivo.
// Il rilevamento volti usa MediaPipe FaceDetector (caricato da CDN solo quando serve).

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm";
const TASKS_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20";

// ---- Elementi DOM ----
const app     = document.getElementById("app");
const video   = document.getElementById("cam");
const stage   = document.getElementById("stage");
const ctx     = stage.getContext("2d");
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
let filter = "ui";          // "ui" oppure "dog"
let stream = null;
let running = false;
let lastShot = null;        // Blob dell'ultimo scatto

// Rilevatore volti (caricato in modo pigro)
let detector = null;
let detectorLoading = null;
let lastDetections = [];
let lastDetectTs = -1;

// Immagini del filtro cane (ritagliate da assets/dog.png)
let dogLayers = null;       // {ears, nose, tongue} come canvas, oppure null → fallback vettoriale

// Dimensioni canvas correnti (in pixel reali)
let W = 0, H = 0, DPR = Math.min(window.devicePixelRatio || 1, 2);

// =====================================================================
//  Avvio
// =====================================================================
startBtn.addEventListener("click", () => {
  startEl.classList.add("hidden");
  init();
});
retryBtn.addEventListener("click", () => {
  errEl.classList.add("hidden");
  init();
});

flipBtn.addEventListener("click", async () => {
  facing = facing === "user" ? "environment" : "user";
  await openCamera();
});

segBtns.forEach((b) =>
  b.addEventListener("click", () => setFilter(b.dataset.filter))
);

// Cambio filtro anche con swipe orizzontale sullo schermo
let touchX = null;
stage.addEventListener("touchstart", (e) => (touchX = e.touches[0].clientX), { passive: true });
stage.addEventListener("touchend", (e) => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 60) setFilter(dx < 0 ? "dog" : "ui");
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
  if (f === "dog") ensureDetector(); // precarica il modello alla prima richiesta
}

// =====================================================================
//  Inizializzazione principale
// =====================================================================
async function init() {
  app.dataset.filter = filter;
  loadDogImage(); // in background: ritaglia assets/dog.png se presente
  try {
    await openCamera();
    resize();
    running = true;
    requestAnimationFrame(loop);
  } catch (err) {
    showError(err);
  }
}

async function openCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
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
  const w = window.innerWidth;
  const h = window.innerHeight;
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = Math.round(w * DPR);
  H = Math.round(h * DPR);
  stage.width = W;
  stage.height = H;
}

// =====================================================================
//  Ciclo di rendering
// =====================================================================
function loop(ts) {
  if (!running) return;
  if (video.readyState >= 2 && W && H) {
    drawFrame(ts);
  }
  requestAnimationFrame(loop);
}

// Calcola la trasformazione "cover" (riempi lo schermo mantenendo le proporzioni)
function coverBox() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.max(W / vw, H / vh);
  const dw = vw * scale, dh = vh * scale;
  return { dx: (W - dw) / 2, dy: (H - dh) / 2, dw, dh, vw, vh };
}

function drawFrame(ts) {
  const box = coverBox();
  const front = facing === "user";

  // 1) Disegna il frame della camera (specchiato se selfie)
  ctx.save();
  if (front) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, box.dx, box.dy, box.dw, box.dh);
  ctx.restore();

  // 2) Overlay del filtro
  if (filter === "dog") {
    drawDogFilter(ts, box, front);
  } else {
    drawRetroUI(ts);
  }
}

// Converte un keypoint normalizzato (spazio video grezzo) in coordinate canvas
function mapPoint(nx, ny, box, front) {
  let px = box.dx + nx * box.dw;
  const py = box.dy + ny * box.dh;
  if (front) px = W - px;
  return [px, py];
}

// =====================================================================
//  FILTRO CANE
// =====================================================================
function drawDogFilter(ts, box, front) {
  if (detector) {
    // Rileva ~ ad ogni frame nuovo (timestamp deve crescere)
    if (ts > lastDetectTs) {
      try {
        const res = detector.detectForVideo(video, ts);
        lastDetections = res.detections || [];
      } catch (_) { /* frame non pronto */ }
      lastDetectTs = ts;
    }
  } else {
    ensureDetector();
  }

  for (const det of lastDetections) {
    const kp = det.keypoints;
    if (!kp || kp.length < 6) continue;
    // BlazeFace: 0=occhio dx, 1=occhio sx, 2=naso, 3=bocca, 4=orecchio dx, 5=orecchio sx
    const rEye = mapPoint(kp[0].x, kp[0].y, box, front);
    const lEye = mapPoint(kp[1].x, kp[1].y, box, front);
    const nose = mapPoint(kp[2].x, kp[2].y, box, front);
    const mouth = mapPoint(kp[3].x, kp[3].y, box, front);
    const rEar = mapPoint(kp[4].x, kp[4].y, box, front);
    const lEar = mapPoint(kp[5].x, kp[5].y, box, front);

    const eyeVec = [lEye[0] - rEye[0], lEye[1] - rEye[1]];
    const angle = Math.atan2(eyeVec[1], eyeVec[0]);
    const eyeDist = Math.hypot(eyeVec[0], eyeVec[1]);
    let faceW = Math.hypot(lEar[0] - rEar[0], lEar[1] - rEar[1]);
    if (!faceW || faceW < eyeDist) faceW = eyeDist * 2.4;

    const eyeCx = (rEye[0] + lEye[0]) / 2;
    const eyeCy = (rEye[1] + lEye[1]) / 2;
    // Versore "su" (perpendicolare alla linea degli occhi)
    const up = [Math.sin(angle), -Math.cos(angle)];

    if (dogLayers) {
      // Orecchie: banner sopra la fronte
      const earsW = faceW * 1.7;
      const earsCx = eyeCx + up[0] * faceW * 0.55;
      const earsCy = eyeCy + up[1] * faceW * 0.55;
      drawImgCentered(dogLayers.ears, earsCx, earsCy, earsW, angle);
      // Naso
      drawImgCentered(dogLayers.nose, nose[0], nose[1], faceW * 0.5, angle);
      // Lingua: sotto la bocca
      const tCx = mouth[0] - up[0] * faceW * 0.28;
      const tCy = mouth[1] - up[1] * faceW * 0.28;
      drawImgCentered(dogLayers.tongue, tCx, tCy, faceW * 0.55, angle);
    } else {
      drawVectorDog(eyeCx, eyeCy, nose, mouth, faceW, angle, up);
    }
  }
}

// Disegna un'immagine centrata in (cx,cy) con larghezza w, ruotata di angle,
// mantenendo le proporzioni.
function drawImgCentered(img, cx, cy, w, angle) {
  const h = w * (img.height / img.width);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
}

// Fallback: un cane "cartoon" disegnato al volo se manca assets/dog.png
function drawVectorDog(eyeCx, eyeCy, nose, mouth, faceW, angle, up) {
  ctx.save();
  ctx.translate(eyeCx + up[0] * faceW * 0.5, eyeCy + up[1] * faceW * 0.5);
  ctx.rotate(angle);
  const ew = faceW * 0.42, eh = faceW * 0.62;
  for (const s of [-1, 1]) {
    ctx.save();
    ctx.translate(s * faceW * 0.62, 0);
    ctx.rotate(s * 0.25);
    ctx.fillStyle = "#7a4a22";
    ctx.beginPath(); ctx.ellipse(0, 0, ew / 2, eh / 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#f4c6c6";
    ctx.beginPath(); ctx.ellipse(0, eh * 0.05, ew / 3.4, eh / 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  // Naso
  ctx.save();
  ctx.translate(nose[0], nose[1]); ctx.rotate(angle);
  ctx.fillStyle = "#3a2416";
  ctx.beginPath(); ctx.ellipse(0, 0, faceW * 0.16, faceW * 0.12, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.35)";
  ctx.beginPath(); ctx.ellipse(-faceW * 0.05, -faceW * 0.04, faceW * 0.04, faceW * 0.03, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // Lingua
  ctx.save();
  ctx.translate(mouth[0] - up[0] * faceW * 0.22, mouth[1] - up[1] * faceW * 0.22);
  ctx.rotate(angle);
  ctx.fillStyle = "#e8607a";
  roundRect(ctx, -faceW * 0.12, 0, faceW * 0.24, faceW * 0.32, faceW * 0.12);
  ctx.fill();
  ctx.strokeStyle = "rgba(150,20,50,.6)"; ctx.lineWidth = faceW * 0.02;
  ctx.beginPath(); ctx.moveTo(0, faceW * 0.04); ctx.lineTo(0, faceW * 0.26); ctx.stroke();
  ctx.restore();
}

// =====================================================================
//  Caricamento e ritaglio dell'immagine del cane
// =====================================================================
function loadDogImage() {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => { try { dogLayers = splitDog(img); } catch (_) { dogLayers = null; } };
  img.onerror = () => { dogLayers = null; }; // userà il fallback vettoriale
  img.src = "assets/dog.png";
}

// Ritaglia la PNG del cane in 3 fasce verticali (orecchie / naso / lingua)
// individuando i "vuoti" (righe completamente trasparenti).
function splitDog(img) {
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const x = c.getContext("2d");
  x.drawImage(img, 0, 0);
  const data = x.getImageData(0, 0, c.width, c.height).data;

  const rowHas = new Array(c.height).fill(false);
  for (let y = 0; y < c.height; y++) {
    for (let xx = 0; xx < c.width; xx++) {
      if (data[(y * c.width + xx) * 4 + 3] > 20) { rowHas[y] = true; break; }
    }
  }
  // Segmenti di righe consecutive con contenuto
  const segs = [];
  let start = -1;
  for (let y = 0; y <= c.height; y++) {
    const on = y < c.height && rowHas[y];
    if (on && start < 0) start = y;
    else if (!on && start >= 0) { segs.push([start, y - 1]); start = -1; }
  }
  // Tieni i 3 segmenti più alti (per area verticale), ordinati dall'alto in basso
  segs.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  const top = segs.slice(0, 3).sort((a, b) => a[0] - b[0]);
  if (top.length < 3) throw new Error("layout inatteso");

  const crop = ([y0, y1]) => {
    let minX = c.width, maxX = 0;
    for (let y = y0; y <= y1; y++)
      for (let xx = 0; xx < c.width; xx++)
        if (data[(y * c.width + xx) * 4 + 3] > 20) {
          if (xx < minX) minX = xx;
          if (xx > maxX) maxX = xx;
        }
    const w = maxX - minX + 1, h = y1 - y0 + 1;
    const cc = document.createElement("canvas");
    cc.width = w; cc.height = h;
    cc.getContext("2d").drawImage(c, minX, y0, w, h, 0, 0, w, h);
    return cc;
  };
  return { ears: crop(top[0]), nose: crop(top[1]), tongue: crop(top[2]) };
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
      minDetectionConfidence: 0.5,
    });
    try {
      detector = await vision.FaceDetector.createFromOptions(fileset, opts("GPU"));
    } catch (_) {
      // Alcuni dispositivi non hanno il delegate GPU: ripiego su CPU
      detector = await vision.FaceDetector.createFromOptions(fileset, opts("CPU"));
    }
    hideToast();
  })().catch((e) => {
    console.error(e);
    showToast("Filtro cane non disponibile (rete?)", 2500);
    detectorLoading = null;
  });
  return detectorLoading;
}

// =====================================================================
//  FILTRO UI RETRO (stile gioco AR) — disegnato sul canvas, centro trasparente
// =====================================================================
function drawRetroUI(ts) {
  const s = Math.min(W, H);
  ctx.save();
  ctx.textBaseline = "middle";

  // --- Barra di stato in alto ---
  const barH = s * 0.052;
  const grad = ctx.createLinearGradient(0, 0, 0, barH);
  grad.addColorStop(0, "rgba(10,14,18,.45)");
  grad.addColorStop(1, "rgba(10,14,18,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, barH * 1.4);

  ctx.fillStyle = "rgba(255,255,255,.92)";
  // Orario a destra
  const now = new Date();
  let hh = now.getHours(); const mm = String(now.getMinutes()).padStart(2, "0");
  const ampm = hh >= 12 ? "PM" : "AM"; hh = hh % 12 || 12;
  ctx.textAlign = "right";
  ctx.font = `600 ${Math.round(barH * 0.46)}px system-ui, sans-serif`;
  ctx.fillText(`${hh}:${mm} ${ampm}`, W - s * 0.03, barH * 0.55);
  ctx.font = `${Math.round(barH * 0.4)}px system-ui, sans-serif`;
  ctx.fillText("74%  LTE", W - s * 0.16, barH * 0.55);
  // Puntini segnale a sinistra
  ctx.textAlign = "left";
  for (let i = 0; i < 4; i++) {
    ctx.globalAlpha = 0.85 - i * 0.12;
    ctx.beginPath();
    ctx.arc(s * 0.045 + i * s * 0.028, barH * 0.55, s * 0.008, 0, 7);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // --- Pulsante "corsa"/bussola in alto a sinistra ---
  drawCircleBtn(s * 0.03 + s * 0.075, barH + s * 0.02 + s * 0.075, s * 0.075, "🏃");

  // --- Toggle AR in alto a destra ---
  const arW = s * 0.17, arH = s * 0.052, arX = W - arW - s * 0.03, arY = barH + s * 0.03;
  roundRect(ctx, arX, arY, arW, arH, arH / 2);
  ctx.fillStyle = "rgba(205,228,228,.5)"; ctx.fill();
  ctx.fillStyle = "rgba(20,60,66,.95)";
  ctx.font = `700 ${Math.round(arH * 0.5)}px system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText("AR", arX + arH * 0.45, arY + arH * 0.52);
  ctx.beginPath();
  ctx.arc(arX + arW - arH * 0.52, arY + arH * 0.5, arH * 0.36, 0, 7);
  ctx.fillStyle = "#37b6c4"; ctx.fill();

  // --- Pulsanti laterali destri: fotocamera + zaino ---
  const rbR = s * 0.082, rx = W - s * 0.045 - rbR;
  drawCircleBtn(rx, H - s * 0.30, rbR, "📷");
  drawCircleBtn(rx, H - s * 0.135, rbR, "🎒");

  // --- Pokéball in basso al centro (sopra ci sta il pulsante di scatto) ---
  drawPokeball(W * 0.5, H - s * 0.13, s * 0.115);

  ctx.restore();
}

function drawCircleBtn(cx, cy, r, glyph) {
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7);
  ctx.fillStyle = "rgba(210,232,232,.30)"; ctx.fill();
  ctx.lineWidth = r * 0.14; ctx.strokeStyle = "rgba(120,190,196,.85)"; ctx.stroke();
  ctx.font = `${Math.round(r * 1.05)}px system-ui, "Segoe UI Emoji", sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(30,70,76,.95)";
  ctx.fillText(glyph, cx, cy + r * 0.04);
  ctx.restore();
}

function drawPokeball(cx, cy, r) {
  ctx.save();
  ctx.translate(cx, cy);
  // metà superiore rossa
  ctx.beginPath(); ctx.arc(0, 0, r, Math.PI, 0); ctx.fillStyle = "#e64b3c"; ctx.fill();
  // metà inferiore bianca
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI); ctx.fillStyle = "#f4f4f4"; ctx.fill();
  // banda nera
  ctx.fillStyle = "#232323";
  ctx.fillRect(-r, -r * 0.11, r * 2, r * 0.22);
  // bordo
  ctx.lineWidth = r * 0.06; ctx.strokeStyle = "rgba(0,0,0,.5)";
  ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.stroke();
  // bottone centrale
  ctx.beginPath(); ctx.arc(0, 0, r * 0.3, 0, 7); ctx.fillStyle = "#232323"; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, r * 0.2, 0, 7); ctx.fillStyle = "#f4f4f4"; ctx.fill();
  ctx.lineWidth = r * 0.05; ctx.strokeStyle = "#9aa"; ctx.stroke();
  // luce
  ctx.beginPath(); ctx.arc(-r * 0.35, -r * 0.4, r * 0.18, 0, 7);
  ctx.fillStyle = "rgba(255,255,255,.35)"; ctx.fill();
  ctx.restore();
}

// =====================================================================
//  Scatto e salvataggio
// =====================================================================
function capture() {
  stage.toBlob((blob) => {
    if (!blob) return;
    lastShot = blob;
    shotImg.src = URL.createObjectURL(blob);
    previewEl.classList.remove("hidden");
  }, "image/jpeg", 0.95);
}

async function savePhoto() {
  if (!lastShot) return;
  const file = new File([lastShot], `retrocam-${stamp()}.jpg`, { type: "image/jpeg" });

  // 1) Web Share con file → su iOS/Android permette "Salva immagine" nella galleria
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Retro Cam" });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // l'utente ha annullato
    }
  }
  // 2) Fallback: download classico
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
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

let toastTimer = null;
function showToast(msg, ms = 2000) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  if (ms > 0) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { toastEl.classList.add("hidden"); }

function showError(err) {
  running = false;
  console.error(err);
  let msg = "Non riesco ad accedere alla fotocamera.";
  if (err && err.name === "NotAllowedError")
    msg = "Permesso negato. Consenti l'accesso alla fotocamera nelle impostazioni del browser.";
  else if (err && err.name === "NotFoundError")
    msg = "Nessuna fotocamera trovata su questo dispositivo.";
  else if (location.protocol !== "https:" && location.hostname !== "localhost")
    msg = "La fotocamera richiede HTTPS. Apri il sito da GitHub Pages (https://…).";
  errMsg.textContent = msg;
  errEl.classList.remove("hidden");
}
