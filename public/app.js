const $ = (id) => document.getElementById(id);

const state = {
  file: null,
  transcript: "",
  history: [], // conversazione con Claude: [{role, content}]
};

// --- Utility ---------------------------------------------------------------
function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}

async function api(path, options) {
  const r = await fetch(path, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Errore ${r.status}`);
  return data;
}

function postJSON(path, body) {
  return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function replyBubble(text) {
  const node = $("reply-tpl").content.firstElementChild.cloneNode(true);
  node.querySelector(".text").textContent = text;
  node.querySelector(".wa").href = `https://wa.me/?text=${encodeURIComponent(text)}`;
  node.querySelector(".copy").addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(text);
      e.target.textContent = "Copiato ✓";
    } catch {
      e.target.textContent = "Copia non riuscita";
    }
    setTimeout(() => (e.target.textContent = "Copia"), 1500);
  });
  return node;
}

// --- Scelta del file -------------------------------------------------------
function useFile(file) {
  state.file = file;
  $("drop").classList.add("has-file");
  $("drop-label").textContent = `🎧 ${file.name || "vocale"} (${(file.size / 1024).toFixed(0)} KB) — tocca per cambiare`;
  const player = $("player");
  player.src = URL.createObjectURL(file);
  player.hidden = false;
  $("go").disabled = false;
  setStatus("");
}

$("file").addEventListener("change", (e) => {
  if (e.target.files[0]) useFile(e.target.files[0]);
});

// Audio arrivato tramite "Condividi" da WhatsApp
async function loadShared() {
  const params = new URLSearchParams(location.search);
  if (params.get("errore")) setStatus("Nessun audio trovato nella condivisione.", true);
  const id = params.get("condiviso");
  if (!id) return;
  history.replaceState(null, "", "/");
  try {
    setStatus("Carico il vocale condiviso…");
    const r = await fetch(`/api/shared/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error((await r.json()).error);
    const blob = await r.blob();
    const name = decodeURIComponent(r.headers.get("X-Filename") || "vocale.ogg");
    useFile(new File([blob], name, { type: blob.type }));
    run(); // avvia subito trascrizione e analisi
  } catch (err) {
    setStatus(err.message, true);
  }
}

// --- Trascrizione + analisi ------------------------------------------------
async function analyze() {
  const tone = $("tone").value;
  setStatus("Analizzo l'argomento e preparo le risposte…");
  const a = await postJSON("/api/analyze", { transcript: state.transcript, tone });

  $("topic").textContent = a.argomento;
  $("summary").textContent = a.riassunto;
  $("step-result").hidden = false;

  const box = $("questions");
  box.replaceChildren();
  if (!a.domande.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Nel vocale non ci sono domande dirette.";
    box.append(p);
  }
  for (const d of a.domande) {
    const wrap = document.createElement("div");
    wrap.className = "q";
    const q = document.createElement("p");
    q.className = "question";
    q.textContent = `❓ ${d.domanda}`;
    wrap.append(q, replyBubble(d.risposta));
    box.append(wrap);
  }
  $("full-reply").replaceWith(Object.assign(replyBubble(a.risposta_completa), { id: "full-reply" }));
  $("step-questions").hidden = false;
  $("step-chat").hidden = false;
  state.history = [];
  $("chat").replaceChildren();
  setStatus("Fatto ✓");
}

async function run() {
  if (!state.file) return;
  $("go").disabled = true;
  try {
    setStatus("Trascrivo il vocale…");
    const form = new FormData();
    form.append("audio", state.file, state.file.name || "vocale.ogg");
    const { transcript } = await api("/api/transcribe", { method: "POST", body: form });
    if (!transcript) throw new Error("Non ho sentito parole nel vocale.");
    state.transcript = transcript;
    $("transcript").value = transcript;
    await analyze();
    $("step-result").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $("go").disabled = false;
  }
}

$("go").addEventListener("click", run);

$("reanalyze").addEventListener("click", async () => {
  state.transcript = $("transcript").value.trim();
  if (!state.transcript) return;
  try {
    await analyze();
  } catch (err) {
    setStatus(err.message, true);
  }
});

// --- Domande libere --------------------------------------------------------
$("ask-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = $("question").value.trim();
  if (!question || !state.transcript) return;
  $("question").value = "";

  const me = document.createElement("div");
  me.className = "me";
  me.textContent = question;
  const pending = document.createElement("p");
  pending.className = "hint";
  pending.textContent = "Sto pensando…";
  $("chat").append(me, pending);

  try {
    const { answer } = await postJSON("/api/ask", {
      transcript: state.transcript,
      question,
      history: state.history,
      tone: $("tone").value,
    });
    state.history.push({ role: "user", content: question }, { role: "assistant", content: answer });
    pending.replaceWith(replyBubble(answer));
  } catch (err) {
    pending.textContent = `⚠️ ${err.message}`;
  }
});

// --- Modalità "Ascolta": registra dal microfono mentre il vocale suona -----
const SILENCE_STOP_MS = 3500; // silenzio dopo il vocale prima di fermarsi
const MAX_LISTEN_MS = 10 * 60 * 1000;
let listening = null;

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function startListening() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return setStatus("Questo browser non può registrare dal microfono. Usa Chrome.", true);
  }
  let stream;
  try {
    // Niente cancellazione dell'eco/rumore: altrimenti il telefono "toglie"
    // proprio l'audio che esce dall'altoparlante.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
  } catch {
    return setStatus("Serve il permesso per il microfono.", true);
  }

  const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  // Livello audio per il misuratore e per lo stop automatico
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  const started = performance.now();
  let noiseFloor = 0, samples = 0, heard = false, lastSound = started;

  listening = { recorder, stream, ctx, timer: null };
  listening.timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
    const now = performance.now();
    if (now - started < 600) {
      noiseFloor = (noiseFloor * samples + rms) / ++samples; // rumore di fondo iniziale
    } else if (rms > Math.max(0.015, Math.min(noiseFloor * 3, 0.06))) {
      if (!heard) $("listen-hint").textContent = "Sto ascoltando…";
      heard = true;
      lastSound = now;
    }
    $("meter-bar").style.width = `${Math.min(100, rms * 400)}%`;
    $("listen-time").textContent = fmtTime(now - started);
    if ((heard && now - lastSound > SILENCE_STOP_MS) || now - started > MAX_LISTEN_MS) stopListening();
  }, 100);

  recorder.onstop = () => {
    const mime = recorder.mimeType || "audio/webm";
    const ext = mime.includes("mp4") ? "m4a" : "webm";
    const blob = new Blob(chunks, { type: mime });
    resetListenUI();
    if (!heard || blob.size < 2000) return setStatus("Non ho sentito nessun audio. Alza il volume e riprova.", true);
    useFile(new File([blob], `ascoltato.${ext}`, { type: mime }));
    run();
  };

  recorder.start(1000);
  $("listen").textContent = "⏹️ Ferma";
  $("listen").classList.add("recording");
  $("listen-hint").textContent = "Fai partire il vocale su WhatsApp con l'altoparlante";
  $("listen-live").hidden = false;
  setStatus("");
}

function stopListening() {
  if (!listening) return;
  const { recorder, stream, ctx, timer } = listening;
  listening = null;
  clearInterval(timer);
  stream.getTracks().forEach((t) => t.stop());
  ctx.close();
  if (recorder.state !== "inactive") recorder.stop();
}

function resetListenUI() {
  $("listen").textContent = "🎧 Ascolta mentre lo senti";
  $("listen").classList.remove("recording");
  $("listen-live").hidden = true;
  $("meter-bar").style.width = "0";
}

$("listen").addEventListener("click", () => (listening ? stopListening() : startListening()));

// Dettatura della domanda (se il browser la supporta)
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition) {
  const rec = new Recognition();
  rec.lang = navigator.language || "it-IT";
  rec.interimResults = false;
  rec.onresult = (e) => {
    $("question").value = e.results[0][0].transcript;
    $("question").focus();
  };
  rec.onend = () => $("mic").classList.remove("recording");
  $("mic").addEventListener("click", () => {
    $("mic").classList.add("recording");
    rec.start();
  });
} else {
  $("mic").hidden = true;
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
loadShared();
