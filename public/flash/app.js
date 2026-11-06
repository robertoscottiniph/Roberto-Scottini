import { BeatDetector, BeatClock, ANALYSIS_DELAY_MS } from "./beat.js";
import { Torch } from "./torch.js";

const $ = (s) => document.querySelector(s);
const STORE = "flash-ritmo:impostazioni";
const DEFAULTS = { source: "mic", mode: "beat", sensitivity: 50, duration: 90, focus: "all", screen: "off", sync: 0 };
const settings = { ...DEFAULTS, ...loadSettings() };

// Con un brano dal telefono l'audio esce con questo ritardo rispetto all'analisi:
// così sappiamo in anticipo dove cadono i colpi e il flash arriva puntuale.
const LOOKAHEAD_MS = 300;
// Tempo con cui lo schermo mostra un cambiamento (disegno + display)
const SCREEN_LEAD_MS = 35;
// Tempo di accensione del flash finché non l'abbiamo misurato
const DEFAULT_TORCH_LEAD_MS = 60;

const power = $("#power");
const powerLabel = $("#power-label");
const screenEl = $("#screen-flash");
const player = $("#player");
const meterBar = $("#meter-bar");
const meterThr = $("#meter-thr");
const torch = new Torch($("#cam"));
const LATENCY_STORE = "flash-ritmo:latenza-flash";
try {
  const saved = Number(localStorage.getItem(LATENCY_STORE));
  if (saved > 0 && saved < 500) torch.latency = saved; // misurata l'ultima volta
} catch {}

let ctx, analyser, freq, detector, clock, micStream, micNode, mediaNode, delayNode;
let running = false;
let starting = false;
let hasTorch = false;
let raf = 0;
let lastFrame = 0;
let frameMs = 16.7;
let micLatencyMs = 0;
let lastScheduled = -Infinity;
let volumeWant = false;
let flashes = 0;
let hue = 0;
let lastReadout = 0;
let wakeLock = null;
let queue = [];
let queueIndex = 0;
const pending = new Set();
const lastOn = { torch: NaN, visual: NaN };

// ---------------------------------------------------------------------------
// Impostazioni
// ---------------------------------------------------------------------------
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) || {};
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORE, JSON.stringify(settings));
  } catch {}
}

function setSetting(key, value) {
  if (settings[key] === value) return;
  settings[key] = value;
  saveSettings();
  render();
  if (key === "source" && running) restart();
  if (key === "mode" || key === "screen") allOff();
  applyDetectorSettings();
}

function applyDetectorSettings() {
  if (!detector) return;
  detector.sensitivity = settings.sensitivity / 100;
  detector.bassOnly = settings.focus === "bass";
}

function render() {
  for (const seg of document.querySelectorAll(".seg")) {
    for (const b of seg.querySelectorAll("button")) {
      b.setAttribute("aria-checked", String(settings[seg.dataset.setting] === b.dataset.value));
    }
  }
  for (const el of document.querySelectorAll("[data-show]")) {
    const [k, v] = el.dataset.show.split("=");
    el.hidden = settings[k] !== v;
  }
  for (const id of ["sensitivity", "duration", "sync", "focus", "screen"]) $("#" + id).value = settings[id];
  $("#sensitivity-out").textContent = `${settings.sensitivity}%`;
  $("#duration-out").textContent = `${settings.duration} ms`;
  const s = settings.sync;
  $("#sync-out").textContent = s === 0 ? "0 ms" : s > 0 ? `+${s} ms (più tardi)` : `−${-s} ms (prima)`;
  meterThr.style.display = settings.mode === "volume" ? "block" : "none";
  meterThr.style.left = `${volumeThreshold() * 100}%`;
}

function bindControls() {
  for (const seg of document.querySelectorAll(".seg")) {
    for (const b of seg.querySelectorAll("button")) {
      b.addEventListener("click", () => setSetting(seg.dataset.setting, b.dataset.value));
    }
  }
  for (const id of ["sensitivity", "duration", "sync"]) {
    $("#" + id).addEventListener("input", (e) => setSetting(id, Number(e.target.value)));
  }
  for (const id of ["focus", "screen"]) {
    $("#" + id).addEventListener("change", (e) => setSetting(id, e.target.value));
  }
}

// Soglia della modalità "Segue il volume": più sensibilità = flash acceso più spesso
function volumeThreshold() {
  return 0.9 - 0.6 * (settings.sensitivity / 100);
}

// ---------------------------------------------------------------------------
// Avvio e arresto
// ---------------------------------------------------------------------------
async function start() {
  if (running || starting) return;
  if (settings.source === "file" && !queue.length) {
    status("Scegli prima un brano.");
    $("#file").click();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return status(window.isSecureContext
      ? "Questo browser non può usare fotocamera e microfono. Usa Chrome."
      : "Apri l'app da un indirizzo https:// per usare flash e microfono.", true);
  }

  starting = true;
  renderPower();
  try {
    ctx ??= new AudioContext({ latencyHint: "interactive" });
    await ctx.resume();
    if (!analyser) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0; // servono i colpi netti, non la media
      freq = new Float32Array(analyser.frequencyBinCount);
    }

    status("Accendo il flash…");
    let torchDenied = false;
    try {
      hasTorch = await torch.open();
    } catch {
      hasTorch = false;
      torchDenied = true;
    }
    let torchNote = "";
    if (!hasTorch) {
      torchNote = torchDenied
        ? "Senza il permesso della fotocamera non posso usare il flash: lampeggia lo schermo."
        : "Questo telefono o browser non permette di comandare il flash: lampeggia lo schermo.";
      if (settings.screen === "off") {
        settings.screen = "white";
        render();
      }
    }

    if (settings.source === "mic") {
      status("Accendo il microfono…");
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0 },
        });
      } catch (err) {
        throw new Error(err.name === "NotFoundError" ? "Nessun microfono trovato." : "Serve il permesso per il microfono.");
      }
      const reported = micStream.getAudioTracks()[0]?.getSettings?.().latency;
      micLatencyMs = (typeof reported === "number" && reported > 0 && reported < 0.5 ? reported : 0.02) * 1000;
      micNode = ctx.createMediaStreamSource(micStream);
      micNode.connect(analyser);
    } else {
      connectPlayer();
    }

    detector = new BeatDetector(ctx.sampleRate, analyser.fftSize);
    clock = new BeatClock();
    applyDetectorSettings();
    running = true;
    flashes = 0;
    volumeWant = false;
    lastScheduled = -Infinity;
    lastFrame = 0;
    keepAwake();
    raf = requestAnimationFrame(frame);

    let msg = settings.source === "mic"
      ? "Ti ascolto: fai partire la musica 🎶 Dopo qualche battito il flash si aggancia al ritmo."
      : "In riproduzione 🎶";
    if (settings.source === "file") {
      try {
        await player.play();
      } catch {
        msg = "Premi ▶ sul lettore per far partire il brano.";
      }
    }
    status(torchNote ? `${torchNote} ${msg}` : msg, torchDenied);
  } catch (err) {
    stop();
    status(err.message || "Qualcosa è andato storto.", true);
  } finally {
    starting = false;
    renderPower();
  }
}

function stop(message = "") {
  running = false;
  cancelAnimationFrame(raf);
  allOff();
  saveTorchLatency();
  torch.close();
  hasTorch = false;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  micNode?.disconnect();
  micNode = null;
  if (mediaNode) {
    try {
      mediaNode.disconnect(analyser);
    } catch {}
  }
  player.pause();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  meterBar.style.width = "0";
  $("#bpm").textContent = "— BPM";
  $("#lock").textContent = "";
  renderPower();
  status(message);
}

async function restart() {
  stop();
  await start();
}

function connectPlayer() {
  if (!mediaNode) {
    mediaNode = ctx.createMediaElementSource(player);
    delayNode = ctx.createDelay(1);
    delayNode.delayTime.value = LOOKAHEAD_MS / 1000;
    mediaNode.connect(delayNode).connect(ctx.destination);
  }
  try {
    mediaNode.disconnect(analyser);
  } catch {}
  mediaNode.connect(analyser);
}

function saveTorchLatency() {
  try {
    if (torch.latency) localStorage.setItem(LATENCY_STORE, String(Math.round(torch.latency)));
  } catch {}
}

function renderPower() {
  power.disabled = starting;
  power.classList.toggle("running", running);
  power.setAttribute("aria-pressed", String(running));
  powerLabel.textContent = starting ? "…" : running ? "Ferma" : "Avvia";
}

// ---------------------------------------------------------------------------
// Ciclo di analisi
// ---------------------------------------------------------------------------
function frame(now) {
  raf = requestAnimationFrame(frame);
  if (lastFrame) frameMs = frameMs * 0.9 + Math.min(100, now - lastFrame) * 0.1;
  lastFrame = now;

  analyser.getFloatFrequencyData(freq);
  const r = detector.process(freq, now);
  // Istante in cui il suono appena analizzato è stato prodotto (microfono)
  // o verrà sentito (brano riprodotto dall'app, con l'audio in ritardo)
  const analysisDelay = Math.max(ANALYSIS_DELAY_MS, frameMs);
  const soundTime = settings.source === "file"
    ? now - analysisDelay + LOOKAHEAD_MS + outputLatencyMs()
    : now - analysisDelay - micLatencyMs;

  let locked = settings.source === "file";
  if (settings.mode === "beat") {
    if (settings.source === "file") {
      if (r.beat) flashAt(soundTime);
    } else {
      if (r.beat) clock.add(soundTime, detector.bpm(now));
      locked = clock.isLocked(now);
      if (locked) {
        // Ritmo agganciato: lampi sui battiti previsti, comandati in anticipo
        const lead = leadMs();
        const T = clock.next(now + lead - settings.sync + 1);
        if (T + settings.sync - lead - now < 3 * frameMs && T > lastScheduled + clock.period / 2) {
          lastScheduled = T;
          flashAt(T);
        }
      } else if (r.beat) {
        flashAt(soundTime); // non ancora agganciato: lampo appena sentito il colpo
      }
    }
  } else {
    const thr = volumeThreshold();
    const want = r.level > (volumeWant ? thr - 0.12 : thr);
    if (want !== volumeWant) {
      volumeWant = want;
      if (want) flashes++;
      lightAt(soundTime, want);
    }
  }

  meterBar.style.width = `${Math.round(r.level * 100)}%`;
  if (now - lastReadout > 300) {
    lastReadout = now;
    const bpm = settings.source === "mic" && locked ? Math.round(60000 / clock.period) : detector.bpm(now);
    $("#bpm").textContent = bpm ? `≈ ${bpm} BPM` : "— BPM";
    $("#count").textContent = `${flashes} ${flashes === 1 ? "lampo" : "lampi"}`;
    $("#lock").textContent = settings.mode === "beat" && (locked || bpm) ? (locked ? " · 🔒 a tempo" : " · aggancio il ritmo…") : "";
  }
}

function outputLatencyMs() {
  return ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000;
}

function torchLeadMs() {
  return hasTorch ? torch.latency || DEFAULT_TORCH_LEAD_MS : 0;
}

// Anticipo necessario perché flash e schermo si accendano all'istante voluto
function leadMs() {
  return Math.max(torchLeadMs(), settings.screen !== "off" || !hasTorch ? SCREEN_LEAD_MS : 0);
}

// ---------------------------------------------------------------------------
// Lampi programmati: ogni comando parte in anticipo del tempo che serve
// a flash e schermo per accendersi, così la luce arriva sul colpo.
// ---------------------------------------------------------------------------
function flashAt(T) {
  const now = performance.now();
  T += settings.sync;
  // Se è già troppo tardi per anticipare, accende il prima possibile
  T = Math.max(T, now + leadMs());
  const dur = settings.duration;
  const tl = torchLeadMs();
  flashes++;
  if (hasTorch) {
    at(T - tl, () => setTorch(true, T));
    at(T + dur - tl, () => lastOn.torch === T && setTorch(false));
  }
  at(T - SCREEN_LEAD_MS, () => setVisual(true, T));
  at(T + dur - SCREEN_LEAD_MS, () => lastOn.visual === T && setVisual(false));
}

function lightAt(T, on) {
  T += settings.sync;
  if (hasTorch) at(T - torchLeadMs(), () => setTorch(on, T));
  at(T - SCREEN_LEAD_MS, () => setVisual(on, T));
}

function at(t, fn) {
  const d = t - performance.now();
  if (d <= 1) return fn();
  const id = setTimeout(() => {
    pending.delete(id);
    if (running) fn();
  }, d);
  pending.add(id);
}

function setTorch(on, id) {
  if (on) lastOn.torch = id;
  torch.set(on);
}

function setVisual(on, id) {
  if (on) {
    if (lastOn.visual !== id && settings.screen === "color") {
      hue = (hue + 90 + Math.random() * 180) % 360;
      screenEl.style.background = `hsl(${Math.round(hue)} 100% 55%)`;
    }
    lastOn.visual = id;
  }
  if (settings.screen !== "color") screenEl.style.background = "#fff";
  power.classList.toggle("on", on);
  screenEl.classList.toggle("on", on && settings.screen !== "off");
}

function allOff() {
  for (const t of pending) clearTimeout(t);
  pending.clear();
  lastOn.torch = lastOn.visual = NaN;
  volumeWant = false;
  if (hasTorch) torch.set(false);
  setVisual(false);
}

// ---------------------------------------------------------------------------
// Brani dal telefono
// ---------------------------------------------------------------------------
$("#file").addEventListener("change", (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  queue = files;
  loadTrack(0);
  if (running && settings.source === "file") player.play().catch(() => {});
});

function loadTrack(i) {
  queueIndex = i;
  if (player.src.startsWith("blob:")) URL.revokeObjectURL(player.src);
  player.src = URL.createObjectURL(queue[i]);
  player.hidden = false;
  $("#drop").classList.add("has-file");
  const count = queue.length > 1 ? ` (${i + 1}/${queue.length})` : "";
  $("#drop-label").textContent = `🎵 ${queue[i].name}${count}`;
}

player.addEventListener("ended", () => {
  if (queueIndex < queue.length - 1) {
    loadTrack(queueIndex + 1);
    player.play().catch(() => {});
  }
});

// Premere ▶ sul lettore avvia anche il flash
player.addEventListener("play", () => {
  if (!running && !starting && settings.source === "file") start();
});

// ---------------------------------------------------------------------------
// Schermo acceso e ritorno in primo piano
// ---------------------------------------------------------------------------
async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {}
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !running) return;
  keepAwake();
  ctx?.resume();
  if (hasTorch) {
    // Quando l'app va in secondo piano il telefono spegne la fotocamera
    if (!torch.live) hasTorch = await torch.open().catch(() => false);
    if (hasTorch) torch.resync();
  }
});

// ---------------------------------------------------------------------------
// Prova del flash
// ---------------------------------------------------------------------------
$("#test").addEventListener("click", async () => {
  if (running) return flashAt(performance.now());
  const btn = $("#test");
  btn.disabled = true;
  status("Provo il flash…");
  try {
    if (!(await torch.open())) return status("Questo telefono o browser non permette di comandare il flash.", true);
    for (let i = 0; i < 3; i++) {
      await torch.set(true);
      await sleep(250);
      await torch.set(false);
      await sleep(250);
    }
    saveTorchLatency();
    status(`Il flash funziona ✔ (risponde in circa ${Math.round(torch.latency)} ms, ne tengo conto per anticiparlo)`);
  } catch {
    status("Serve il permesso della fotocamera per usare il flash.", true);
  } finally {
    if (!running) torch.close();
    btn.disabled = false;
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function status(text, isError = false) {
  const el = $("#status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

power.addEventListener("click", () => (running ? stop() : start()));

bindControls();
render();
renderPower();
if (!window.isSecureContext) status("Apri l'app da un indirizzo https:// per usare flash e microfono.", true);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
