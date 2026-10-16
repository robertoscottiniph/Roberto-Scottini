# 🎙️ Audio Risposte

App web (installabile sul telefono) che prende un **vocale di WhatsApp**, lo trascrive, capisce **di cosa parla** e ti aiuta a **rispondere alle domande** che contiene.

## Cosa fa

1. **Ricevi il vocale**: da WhatsApp tieni premuto il vocale → *Condividi* → **Audio Risposte** (Android), oppure scegli il file dall'app.
2. **Trascrizione** automatica dell'audio.
3. **Analisi** con Claude: argomento, riassunto, elenco delle domande che ti vengono fatte, ognuna con una risposta proposta, più una risposta completa al vocale.
4. **Chat libera** sul vocale: "Rispondi che accetto ma dopo le 18", "Cosa mi sta chiedendo?", "Fammela più corta"… (puoi anche dettare la domanda con il 🎤).
5. Ogni risposta ha i pulsanti **Copia** e **Invia su WhatsApp**.

Puoi scegliere il tono (naturale, amichevole, formale, breve). Se manca un'informazione che solo tu conosci, la risposta usa un segnaposto tipo `[orario]` invece di inventare.

## Avvio

Serve Node.js 20 o più recente.

```bash
npm install
cp .env.example .env   # poi inserisci le chiavi
npm start              # http://localhost:3000
```

Chiavi in `.env`:

| Variabile | A cosa serve |
|---|---|
| `ANTHROPIC_API_KEY` | Claude: analisi del vocale e risposte |
| `OPENAI_API_KEY` | Trascrizione dell'audio (Whisper). Claude non accetta audio in input |
| `TRANSCRIBE_MODEL` | Opzionale, predefinito `whisper-1` |

## Usarla dal telefono con WhatsApp

Per comparire nel menu *Condividi* l'app deve essere **installata** e servita in **HTTPS**:

1. Pubblica il server su un hosting Node (Render, Railway, Fly.io, un VPS…) oppure, per provare, esponi il PC con `cloudflared tunnel --url http://localhost:3000`.
2. Apri l'indirizzo HTTPS con **Chrome su Android** → menu ⋮ → **Installa app** / *Aggiungi a schermata Home*.
3. In WhatsApp tieni premuto un vocale → icona *Condividi* → **Audio Risposte**. L'app si apre e parte subito la trascrizione.

**iPhone**: iOS non permette alle web app di ricevere file da *Condividi*. Da WhatsApp salva il vocale in *File* (Condividi → Salva su File), poi aprilo dall'app con "Tocca per scegliere un audio".

## Struttura

```
server.js            Server Express: share target, trascrizione, chiamate a Claude
public/index.html    Interfaccia
public/app.js        Logica della pagina
public/style.css     Stile (chiaro/scuro, stile WhatsApp)
public/manifest.json Manifest PWA con "share_target" per ricevere gli audio
public/sw.js         Service worker (necessario per l'installazione)
```

Endpoint: `POST /share-target`, `GET /api/shared/:id`, `POST /api/transcribe`, `POST /api/analyze`, `POST /api/ask`.

## Privacy

Gli audio condivisi restano in memoria sul server per al massimo 10 minuti e non vengono salvati su disco. La trascrizione dell'audio passa da OpenAI, l'analisi del testo da Anthropic.
