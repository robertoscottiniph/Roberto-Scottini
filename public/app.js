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
