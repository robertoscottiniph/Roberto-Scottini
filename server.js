import express from "express";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

// Carica .env se presente (senza dipendenze esterne)
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const PORT = process.env.PORT || 3000;
const MODEL = "claude-opus-5-5";
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "whisper-1";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // limite dell'API di trascrizione

const anthropic = new Anthropic();
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES } });

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

// ---------------------------------------------------------------------------
// Audio condivisi da WhatsApp (Web Share Target): teniamo il file in memoria
// per qualche minuto e reindirizziamo la pagina, che lo recupera tramite id.
// ---------------------------------------------------------------------------
const sharedAudio = new Map();
const SHARED_TTL_MS = 10 * 60 * 1000;

app.post("/share-target", upload.any(), (req, res) => {
  const file = (req.files || []).find((f) => /^(audio|video)\//.test(f.mimetype) || /\.(opus|ogg|m4a|mp3|wav|aac|webm|mp4)$/i.test(f.originalname));
  if (!file) return res.redirect(303, "/?errore=nessun-audio");
  const id = randomUUID();
  sharedAudio.set(id, file);
  setTimeout(() => sharedAudio.delete(id), SHARED_TTL_MS).unref();
  res.redirect(303, `/?condiviso=${id}`);
});

app.get("/api/shared/:id", (req, res) => {
  const file = sharedAudio.get(req.params.id);
  if (!file) return res.status(404).json({ error: "Audio scaduto o non trovato. Condividilo di nuovo." });
  res.set("Content-Type", file.mimetype || "audio/ogg");
  res.set("X-Filename", encodeURIComponent(file.originalname || "vocale.ogg"));
  res.send(file.buffer);
});

// ---------------------------------------------------------------------------
// Trascrizione
// ---------------------------------------------------------------------------
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Nessun file audio ricevuto." });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY non configurata sul server." });

  // WhatsApp invia i vocali come .opus (Ogg/Opus): l'API li accetta con estensione .ogg
  let name = req.file.originalname || "vocale.ogg";
  if (/\.opus$/i.test(name) || !/\.[a-z0-9]+$/i.test(name)) name = name.replace(/\.opus$/i, "") + ".ogg";

  const form = new FormData();
  form.append("file", new Blob([req.file.buffer], { type: req.file.mimetype || "audio/ogg" }), name);
  form.append("model", TRANSCRIBE_MODEL);
  if (req.body.language) form.append("language", req.body.language);

  try {
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data?.error?.message || "Trascrizione fallita." });
    res.json({ transcript: (data.text || "").trim() });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Impossibile contattare il servizio di trascrizione." });
  }
});

// ---------------------------------------------------------------------------
// Claude: analisi del vocale e risposte alle domande
// ---------------------------------------------------------------------------
const SYSTEM = `Sei un assistente che aiuta l'utente a rispondere ai messaggi vocali ricevuti su WhatsApp.
Ricevi la trascrizione di un vocale (può contenere errori di trascrizione: interpretali con buon senso).
Rispondi sempre nella lingua del vocale, salvo diversa richiesta.
Le risposte che proponi devono essere pronte da incollare su WhatsApp: tono naturale e colloquiale, in prima persona come se scrivesse l'utente, senza markdown, senza preamboli.
Se una domanda richiede informazioni che solo l'utente conosce (orari, impegni, opinioni personali), proponi una risposta con un segnaposto tra parentesi quadre, es. [orario], invece di inventare.`;

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    argomento: { type: "string", description: "L'argomento principale in poche parole" },
    riassunto: { type: "string", description: "Riassunto breve del vocale (2-4 frasi)" },
    domande: {
      type: "array",
      description: "Domande o richieste rivolte all'utente nel vocale, ciascuna con una risposta proposta",
      items: {
        type: "object",
        properties: {
          domanda: { type: "string" },
          risposta: { type: "string" },
        },
        required: ["domanda", "risposta"],
        additionalProperties: false,
      },
    },
    risposta_completa: { type: "string", description: "Un unico messaggio di risposta al vocale, pronto da inviare" },
  },
  required: ["argomento", "riassunto", "domande", "risposta_completa"],
  additionalProperties: false,
};

function claudeRequest(params) {
  return anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low", ...(params.output_config || {}) },
    // Se i filtri di sicurezza rifiutano la richiesta, l'API la ripete su un modello alternativo
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: params.messages,
  });
}

function textOf(response) {
  if (response.stop_reason === "refusal") throw Object.assign(new Error("Richiesta rifiutata dal modello."), { status: 422 });
  return response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

function sendError(res, err) {
  console.error(err);
  if (/authentication/i.test(err.message) || err instanceof Anthropic.AuthenticationError) {
    return res.status(500).json({ error: "Chiave Claude (ANTHROPIC_API_KEY) mancante o non valida sul server." });
  }
  const status = err instanceof Anthropic.APIError ? 502 : err.status || 500;
  res.status(status).json({ error: err.message || "Errore imprevisto." });
}

app.post("/api/analyze", async (req, res) => {
  const { transcript, tone } = req.body || {};
  if (!transcript) return res.status(400).json({ error: "Trascrizione mancante." });
  try {
    const response = await claudeRequest({
      output_config: { format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
      messages: [{
        role: "user",
        content: `<vocale>\n${transcript}\n</vocale>\n\nAnalizza il vocale. Tono desiderato per le risposte: ${tone || "naturale"}.`,
      }],
    });
    res.json(JSON.parse(textOf(response)));
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/ask", async (req, res) => {
  const { transcript, question, history = [], tone } = req.body || {};
  if (!transcript || !question) return res.status(400).json({ error: "Trascrizione o domanda mancante." });
  const messages = [
    {
      role: "user",
      content: `<vocale>\n${transcript}\n</vocale>\n\nTono desiderato: ${tone || "naturale"}. Ora ti farò delle domande o ti chiederò di scrivere risposte su questo vocale.`,
    },
    { role: "assistant", content: "Ok, ho letto il vocale. Dimmi pure." },
    ...history
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-20),
    { role: "user", content: question },
  ];
  try {
    const response = await claudeRequest({ messages });
    res.json({ answer: textOf(response) });
  } catch (err) {
    sendError(res, err);
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File troppo grande (max 25 MB)." });
  }
  next(err);
});

app.listen(PORT, () => console.log(`Audio Risposte attivo su http://localhost:${PORT}`));
