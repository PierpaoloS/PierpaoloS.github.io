# Kotoba Swipe

Flashcard da swipare per ripassare parole, kana e kanji giapponesi (corso Duolingo fino a circa Sezione 2 · Unità 23).

- **Parole**: divise in 13 blocchi che seguono l'ordine del corso (circa 2–3 unità ciascuno), con la percentuale appresa per ogni blocco.
- **Kana & Kanji**: hiragana + katakana insieme, oppure kanji.
- Scorri a destra = *La so*, a sinistra = *Da imparare*. Tocca la carta per girarla.
- Tema automatico / chiaro / scuro (pulsante in alto a destra).

## Dove finiscono i progressi

È un sito statico: i progressi restano salvati **nel browser** del dispositivo che usi (localStorage), non su GitHub.
Da *Elenco e backup* puoi esportare un file `.json` e reimportarlo su un altro dispositivo.

## Modificare le parole

Le liste sono in `index.html`, nelle costanti `RAW_WORDS` e `RAW_KANJI`:

```
@Nome blocco
#Argomento
giapponese|kana|italiano
```

Il romaji viene calcolato in automatico dai kana.

## Provarlo in locale

```bash
python -m http.server 5173
```
