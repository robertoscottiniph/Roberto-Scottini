import { BeatDetector } from "./beat.js";
import { Torch } from "./torch.js";

const $ = (s) => document.querySelector(s);
const STORE = "flash-ritmo:impostazioni";
const DEFAULTS = { source: "mic", mode: "beat", sensitivity: 50, duration: 90, focus: "all", screen: "off", delay: 0 };
const settings = { ...DEFAULTS, ...loadSettings() };

const power = $("#power");
const powerLabel = $("#power-label");
const screenEl = $("#screen-flash");
const player = $("#player");
const meterBar = $("#meter-bar");
const meterThr = $("#meter-thr");
const torch = new Torch($("#cam"));

let ctx, analyser, freq, detector, micStream, micNode, mediaNode;
let running = false;
let starting = false;
let hasTorch = false;
let raf = 0;
let offTimer = 0;
let lightOn = false;
let volumeWant = false;
let flashes = 0;
let hue = 0;
let lastReadout = 0;
let wakeLock = null;
let queue = [];
let queueIndex = 0;
const pending = new Set();

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
  const prev = settings[key];
  if (prev === value) return;
  settings[key] = value;
  saveSettings();
  render();
  if (key === "source" && running) restart();
  if (key === "mode" || key === "screen") setLight(false);
  if (key === "mode") volumeWant = false;
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
  for (const id of ["sensitivity", "duration", "delay", "focus", "screen"]) $("#" + id).value = settings[id];
  $("#sensitivity-out").textContent = `${settings.sensitivity}%`;
  $("#duration-out").textContent = `${settings.duration} ms`;
  $("#delay-out").textContent = `${settings.delay} ms`;
  meterThr.style.display = settings.mode === "volume" ? "block" : "none";
  meterThr.style.left = `${volumeThreshold() * 100}%`;
}

function bindControls() {
  for (const seg of document.querySelectorAll(".seg")) {
    for (const b of seg.querySelectorAll("button")) {
      b.addEventListener("click", () => setSetting(seg.dataset.setting, b.dataset.value));
    }
  }
  for (const id of ["sensitivity", "duration", "delay"]) {
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
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (err) {
        throw new Error(err.name === "NotFoundError" ? "Nessun microfono trovato." : "Serve il permesso per il microfono.");
      }
      micNode = ctx.createMediaStreamSource(micStream);
      micNode.connect(analyser);
    } else {
      connectPlayer();
    }

    detector = new BeatDetector(ctx.sampleRate, analyser.fftSize);
    applyDetectorSettings();
    running = true;
    flashes = 0;
    volumeWant = false;
    keepAwake();
    raf = requestAnimationFrame(frame);

    let msg = settings.source === "mic" ? "Ti ascolto: fai partire la musica 🎶" : "In riproduzione 🎶";
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
  for (const t of pending) clearTimeout(t);
  pending.clear();
  clearTimeout(offTimer);
  setLight(false);
  volumeWant = false;
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
    mediaNode.connect(ctx.destination);
  }
  try {
    mediaNode.disconnect(analyser);
  } catch {}
  mediaNode.connect(analyser);
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
  analyser.getFloatFrequencyData(freq);
  const r = detector.process(freq, now);

  if (settings.mode === "beat") {
    if (r.beat) later(pulse);
  } else {
    const thr = volumeThreshold();
    const want = r.level > (volumeWant ? thr - 0.12 : thr);
    if (want !== volumeWant) {
      volumeWant = want;
      if (want) flashes++;
      later(() => setLight(want));
    }
  }

  meterBar.style.width = `${Math.round(r.level * 100)}%`;
  if (now - lastReadout > 300) {
    lastReadout = now;
    const bpm = detector.bpm(now);
    $("#bpm").textContent = bpm ? `≈ ${bpm} BPM` : "— BPM";
    $("#count").textContent = `${flashes} ${flashes === 1 ? "lampo" : "lampi"}`;
  }
}

// Esegue fn dopo il ritardo scelto. Con un brano riprodotto dall'app l'audio
// esce dall'altoparlante un po' dopo essere stato analizzato: compensiamo.
function later(fn) {
  let d = settings.delay;
  if (settings.source === "file" && ctx) {
    const out = ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000;
    d += Math.max(0, out - (hasTorch ? torch.latency : 0));
  }
  if (d < 5) return fn();
  const t = setTimeout(() => {
    pending.delete(t);
    if (running) fn();
  }, d);
  pending.add(t);
}

function pulse() {
  flashes++;
  setLight(true);
  clearTimeout(offTimer);
  offTimer = setTimeout(() => setLight(false), settings.duration);
}

function setLight(on) {
  if (on && !lightOn && settings.screen === "color") {
    hue = (hue + 90 + Math.random() * 180) % 360;
    screenEl.style.background = `hsl(${Math.round(hue)} 100% 55%)`;
  } else if (settings.screen !== "color") {
    screenEl.style.background = "#fff";
  }
  lightOn = on;
  if (hasTorch) torch.set(on);
  power.classList.toggle("on", on);
  screenEl.classList.toggle("on", on && settings.screen !== "off");
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
  } else {
    setLight(false);
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
  if (running) return pulse();
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
    status(`Il flash funziona ✔ (risponde in circa ${Math.round(torch.latency)} ms)`);
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
