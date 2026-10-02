# Treni Live Italia

Mappa interattiva, per uso personale, con le posizioni in tempo reale dei treni in Italia
(Frecce, Intercity, regionali, Trenord, TILO, Italo) e, zoomando su una città coperta, di bus e tram.

Nessuna dipendenza da installare: serve solo Node.js 20 o successivo.

## Avvio

```bash
cd treni-live
node server.js
```

Poi apri <http://localhost:8787>.

Al primo avvio il server scarica l'anagrafica delle stazioni (circa 2.800, una volta al mese).
Nei primi minuti i treni compaiono man mano, mentre il server legge i tabelloni.

## Come funziona

```
browser (MapLibre)  ←→  server.js (proxy locale)  ←→  ViaggiaTreno · Italo in viaggio · feed GTFS-Realtime
```

**Treni RFI (ViaggiaTreno).** Le API non hanno un elenco "treni in circolazione" né coordinate GPS.
Il server quindi:

1. legge a rotazione partenze e arrivi di circa 470 stazioni principali per scoprire i treni;
2. per ogni treno chiama `andamentoTreno` ogni ~2,5 minuti (ritardo, fermate, ultimo rilevamento);
3. calcola il tratto in corso, cioè da quale punto e a che ora è partito e dove e quando arriverà.
   Se l'ultimo rilevamento è una località nota (es. "Melzo Scalo"), il tratto riparte da lì.

Il browser interpola lungo il tratto ogni secondo, quindi i puntini si muovono con continuità.
La posizione è **stimata** e la linea tra due fermate è dritta, non segue i binari.

**Italo.** Stesso schema, con i tabelloni delle 61 stazioni Italo e i dati per singolo treno.

**Bus e tram.** Feed GTFS-Realtime (VehiclePositions) configurati in `feeds.json`.
Il server li scarica solo quando la mappa è zoomata (livello 11 o più) su un'area coperta.
In quel caso usa le posizioni GPS reali, aggiornate ogni 20 secondi.

## Aggiungere una città

Aggiungi una voce a `feeds.json` con l'URL del feed VehiclePositions e il riquadro
`[lon min, lat min, lon max, lat max]`:

```json
{
  "id": "torino",
  "name": "Torino — GTT",
  "url": "https://…/vehicle_position.pb",
  "bbox": [7.55, 44.95, 7.8, 45.15],
  "refreshMs": 20000
}
```

Dove cercare i feed: Mobility Database (mobilitydatabase.org), Transitland, il Punto di Accesso
Nazionale (NAP) e i portali open data delle aziende di trasporto. Molte aziende pubblicano solo
gli orari statici: in quel caso non ci sono posizioni in tempo reale.

## Configurazione

Variabili d'ambiente opzionali:

| Variabile      | Default | Significato                                           |
| -------------- | ------- | ----------------------------------------------------- |
| `PORT`         | 8787    | Porta del server                                      |
| `VT_RPS`       | 8       | Richieste al secondo massime verso ViaggiaTreno       |
| `VT_REFRESH_S` | 150     | Ogni quanti secondi si aggiorna ciascun treno         |

`http://localhost:8787/api/status` mostra quanti treni sono seguiti, quanti visibili e quanti
ne conta RFI in circolazione.

Se nel log compare `Italo: stazione non riconosciuta "…"`, aggiungi il nome ad `ALIAS` in
`src/italo.js`.

## Struttura

```
server.js            server HTTP e API (/api/trains, /api/train, /api/transit, /api/status)
src/stations.js      anagrafica stazioni con coordinate (cache in data/)
src/viaggiatreno.js  scoperta, aggiornamento e stima posizione dei treni RFI
src/italo.js         lo stesso per Italo
src/transit.js       decoder GTFS-Realtime e gestione dei feed urbani
src/util.js          rate limiting, nomi, distanze
public/              mappa (MapLibre + tile OpenFreeMap)
feeds.json           feed bus/tram
```

## Note

Le API di ViaggiaTreno e Italo non sono ufficiali e possono cambiare senza preavviso. Il server
limita le richieste (8/s verso ViaggiaTreno, 3/s verso Italo): non alzare troppo questi valori,
per non farsi bloccare. Progetto per uso personale, non affiliato a Trenitalia, RFI, Italo o alle
aziende di trasporto.
