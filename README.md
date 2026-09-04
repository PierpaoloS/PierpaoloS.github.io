# Retro Cam 📸

Mini web-app statica (super leggera) per fare foto con tre filtri vintage:

- **🎮 UI Retro** — lo screenshot dell'interfaccia stile gioco AR, con lo sfondo
  bianco reso trasparente: al centro si vede la fotocamera.
- **🐶 Filtro cane** — rileva il volto di una o più persone e ci mette orecchie,
  naso e lingua.
- **😎 Mazz2016** — la tua immagine con sfondo trasparente sovrapposta allo scatto.

Funziona interamente nel browser: **nessuna foto lascia il telefono**.
Scegli fotocamera frontale/posteriore, scatti alla massima risoluzione e salvi nel rullino.

## File del progetto

```
retro-cam/
├── index.html      → la pagina
├── styles.css      → lo stile
├── app.js          → tutta la logica (camera, filtri, salvataggio)
├── assets/
│   ├── dog.png         ← filtro cane (vedi assets/LEGGIMI.txt)
│   ├── ui.png          ← screenshot interfaccia Pokémon
│   └── mazz2016.png    ← terzo filtro
├── .nojekyll
└── README.md
```

> Il filtro cane usa **MediaPipe FaceDetector**, caricato da CDN solo quando serve:
> il repository resta leggerissimo (poche decine di KB + le tue immagini).

## Le tre immagini da mettere in `assets/`

Salva in `assets/` (nomi esatti):

- **`dog.png`** — orecchie in alto, naso al centro, lingua in basso, sfondo trasparente.
  L'app ritaglia e posiziona da sola. Se manca → cane di ripiego disegnato.
- **`ui.png`** — lo screenshot dell'UI così com'è: l'app rende trasparente lo sfondo
  bianco automaticamente. Se manca → UI di ripiego disegnata.
- **`mazz2016.png`** — immagine con sfondo trasparente. Se manca → avviso a schermo.

## Diagnostica

Aggiungi `?debug` all'URL (es. `.../index.html?debug`) per vedere in basso:
risoluzione camera, stato del rilevatore, numero di volti rilevati ed eventuali errori.

## Pubblicare su GitHub Pages

1. Crea un repository nuovo su GitHub (es. `retro-cam`).
2. Carica **tutti** i file di questa cartella (mantenendo `assets/dog.png`).
3. Su GitHub: **Settings → Pages → Build and deployment**
   - *Source*: **Deploy from a branch**
   - *Branch*: `main` / **root** → **Save**.
4. Dopo ~1 minuto il sito è online su
   `https://TUO-UTENTE.github.io/retro-cam/`

⚠️ La fotocamera funziona **solo su HTTPS** (GitHub Pages lo è già) o su `localhost`.

## Provarlo in locale

```bash
# dentro la cartella retro-cam
python -m http.server 8000
```
Poi apri `http://localhost:8000` (su desktop la webcam va bene per provare).
Per il test da telefono usa direttamente il link di GitHub Pages.

## Uso

- In alto: 🔄 cambia fotocamera, e lo switch **UI Retro / Cane** (o **swipe** a sinistra/destra).
- In basso: il pulsante grande **scatta**.
- Dopo lo scatto: **Salva** (usa la condivisione del telefono → *Salva immagine*) o **Rifai**.
