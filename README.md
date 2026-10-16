# 🎙️ Audio Risposte

App web (installabile sul telefono) che prende un **vocale di WhatsApp**, lo trascrive, capisce **di cosa parla** e ti aiuta a **rispondere alle domande** che contiene.

## Cosa fa

1. **Ricevi il vocale**, in tre modi:
   - **Ascolta mentre lo senti**: metti WhatsApp e l'app a schermo diviso, tocca **🎧 Ascolta**, fai partire il vocale con l'altoparlante. L'app registra dal microfono e si ferma da sola quando il vocale finisce.
   - **Condividi**: da WhatsApp tieni premuto il vocale → *Condividi* → **Audio Risposte** (Android).
   - **File**: scegli il file audio dall'app.
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

### Modalità "Ascolta"

- Funziona con l'**altoparlante**, non con le cuffie: il microfono deve sentire l'audio. Tieni il volume alto e l'ambiente silenzioso.
- Su Android usa lo **schermo diviso** (app recenti → tieni premuta l'icona → *Schermo diviso*), così l'app resta attiva mentre WhatsApp riproduce il vocale.
- Si ferma da sola dopo circa 3,5 secondi di silenzio (o con **⏹️ Ferma**), poi trascrive e analizza.
- Il microfono richiede HTTPS (o `localhost`).
- **iPhone**: lo schermo diviso non esiste e Safari smette di registrare quando passi a WhatsApp. Funziona solo se il vocale suona da un altro dispositivo.

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
