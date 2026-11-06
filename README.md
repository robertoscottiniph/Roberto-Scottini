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

## Pubblicazione in un clic

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/robertoscottiniph/Roberto-Scottini)

Premi il pulsante, entra con GitHub, incolla le due chiavi (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) e premi *Deploy*. La configurazione è in `render.yaml`.

## Avvio in locale

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

## 🔦 Flash Ritmo

Seconda app nello stesso progetto, in `public/flash/`: **il flash del telefono si accende e si spegne a tempo di musica**. Non usa il server né chiavi: funziona tutta nel telefono, anche senza connessione una volta installata.

### Come aprirla

**Pagina GitHub gratuita** (la via più semplice: non servono server né chiavi):

1. Apri https://github.com/robertoscottiniph/Roberto-Scottini/settings/pages
2. In *Build and deployment* → *Source* scegli **Deploy from a branch**.
3. Come *Branch* scegli quello che contiene `public/flash/` (ora `claude/beautiful-euler-9nkmkp`), cartella **/ (root)**, poi **Save**.
4. Dopo un paio di minuti l'app è su **https://robertoscottiniph.github.io/Roberto-Scottini/public/flash/**

In alternativa, se il server è pubblicato (Render ecc.), l'app è all'indirizzo del servizio seguito da `/flash/`: per esempio l'indirizzo `.onrender.com` che ti mostra Render, più `/flash/`. In locale: `http://localhost:3000/flash/`.

Con **Chrome su Android** → menu ⋮ → **Installa app** compare come app separata.

- **Musica da**:
  - **🎤 Microfono**: ascolta la musica che suona vicino (cassa, TV, un altro telefono, oppure Spotify su questo stesso telefono con l'altoparlante).
  - **🎵 Brano**: scegli uno o più brani dal telefono e l'app li riproduce lei stessa (analisi più precisa).
- **Effetto**:
  - **⚡ Lampo sul battito**: un lampo per ogni colpo (cassa, rullante…). Puoi regolare la durata del lampo.
  - **🔊 Segue il volume**: il flash resta acceso quando la musica è forte.
- **Sensibilità**: più alta = più lampi. **Reagisci a → Solo i bassi** segue solo la cassa (meglio con casse potenti; con l'altoparlante del telefono lascia *Tutta la musica*, perché i bassi non escono).
- **Schermo**: fa lampeggiare anche lo schermo, in bianco o a colori.
- **Senza ritardo**: il flash ha bisogno di qualche centesimo di secondo per accendersi, quindi l'app lo comanda **in anticipo**:
  - con un **brano dal telefono** analizza la musica 0,3 s prima di fartela sentire, così ogni lampo cade esattamente sul colpo;
  - con il **microfono** impara il ritmo (BPM e posizione dei battiti) e prevede il battito successivo: dopo 4-5 secondi compare **🔒 a tempo** e il lampo cade sul battito invece che dopo.
- **Avanzate → Regola sincronia**: ritocco fine se su un telefono il lampo arriva ancora un po' prima (sposta a destra, utile con le casse Bluetooth) o dopo (a sinistra). **Prova il flash** misura quanto ci mette il flash ad accendersi e l'app se lo ricorda.
- Mostra i **BPM** stimati e tiene lo schermo acceso mentre è attiva.

Note:

- Il flash si comanda dal browser solo con **Chrome su Android**, e serve **HTTPS** (o `localhost`). Il permesso della fotocamera serve solo per accendere il flash: non viene registrata nessuna immagine.
- **iPhone**: Safari di solito non permette alle pagine web di comandare il flash; in quel caso l'app lo dice e fa lampeggiare lo schermo.
- L'app deve restare aperta e in primo piano: quando va in secondo piano Android spegne la fotocamera, e con lei il flash.
- Con il microfono, nei primi secondi (prima di **🔒 a tempo**) e nella modalità *Segue il volume* il lampo arriva qualche centesimo di secondo dopo il colpo: l'app deve prima sentirlo. Funziona meglio con musica dal tempo regolare.
- ⚠️ Le luci lampeggianti possono essere pericolose per chi soffre di epilessia fotosensibile.

## Struttura

```
server.js            Server Express: share target, trascrizione, chiamate a Claude
public/index.html    Interfaccia
public/app.js        Logica della pagina
public/style.css     Stile (chiaro/scuro, stile WhatsApp)
public/manifest.json Manifest PWA con "share_target" per ricevere gli audio
public/sw.js         Service worker (necessario per l'installazione)

public/flash/        Flash Ritmo (solo lato browser)
  index.html         Interfaccia
  app.js             Avvio, impostazioni, lampi, brani, schermo acceso
  beat.js            Rilevamento dei battiti e previsione del ritmo
  torch.js           Accensione del flash tramite la fotocamera posteriore
  sw.js              Service worker con copia offline
```

Endpoint: `POST /share-target`, `GET /api/shared/:id`, `POST /api/transcribe`, `POST /api/analyze`, `POST /api/ask`.

## Privacy

Gli audio condivisi restano in memoria sul server per al massimo 10 minuti e non vengono salvati su disco. La trascrizione dell'audio passa da OpenAI, l'analisi del testo da Anthropic.
