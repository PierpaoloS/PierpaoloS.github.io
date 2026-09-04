# Retro Cam 📸

Mini web-app statica (super leggera) per fare foto con due filtri vintage:

- **🐶 Filtro cane** — rileva il volto di una o più persone e ci mette orecchie, naso e lingua.
- **🎮 UI Retro** — un'interfaccia stile gioco AR trasparente, con la fotocamera al centro.

Funziona interamente nel browser: **nessuna foto lascia il telefono**.
Scegli fotocamera frontale/posteriore, scatti e salvi direttamente nel rullino.

## File del progetto

```
retro-cam/
├── index.html      → la pagina
├── styles.css      → lo stile
├── app.js          → tutta la logica (camera, filtri, salvataggio)
├── assets/
│   └── dog.png     ← METTI QUI la tua PNG del cane (vedi assets/LEGGIMI.txt)
├── .nojekyll
└── README.md
```

> Il filtro cane usa **MediaPipe FaceDetector**, caricato da CDN solo quando serve:
> il repository resta leggerissimo (poche decine di KB + la tua `dog.png`).

## Come metti la tua immagine del cane

1. Salva la tua PNG (sfondo trasparente, con orecchie in alto, naso al centro,
   lingua in basso) dentro la cartella `assets/` con nome **`dog.png`**.
2. Fatto: l'app la ritaglia e la posiziona da sola.

Se non la metti, l'app disegna comunque un cane di ripiego.

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
