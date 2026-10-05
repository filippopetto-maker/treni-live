# Treni Live Italia in un container (Render, o qualsiasi hosting Docker).
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node . .

# Orari statici scaricati con ADD: Docker controlla il file a ogni costruzione e, se l'azienda ne ha
# pubblicato uno nuovo, rifà la preparazione qui sotto invece di riusare la cache. Senza questo, un
# riavvio di Render ripartiva con l'orario vecchio e il server provava a ricostruirlo da solo
# (memoria esaurita il 5/10 alle 20:50). Il deploy hook (RENDER_DEPLOY_HOOK) rifà l'immagine quando
# il controllo orario trova orari nuovi.
ADD https://romamobilita.it/wp-content/uploads/shared/rome_static_gtfs.zip data/gtfs/roma/gtfs.zip
ADD https://dati.comune.milano.it/gtfs.zip data/gtfs/milano/gtfs.zip

# Dati già pronti (binari OSM, stazioni, percorsi) dalla cartella seed/: il disco dei servizi
# gratuiti non è permanente, così a ogni avvio non si riscarica tutto da Overpass.
RUN mkdir -p data \
 && for f in seed/*.gz; do gunzip -c "$f" > "data/$(basename "$f" .gz)"; done \
 && cp seed/*.json data/ \
 && node deploy/prebuild.mjs \
 && chown -R node:node /app

USER node
# PORT lo imposta l'hosting (Render usa 10000). Il navigatore tiene in memoria Roma e Milano,
# solo le corse di ieri/oggi/domani; ogni notte alle 3 controlla orari nuovi e prepara il giorno dopo.
ENV HOST=0.0.0.0 PORT=8787 TZ=Europe/Rome GTFS_MAX_AGE_DAYS=21 NODE_OPTIONS="--max-old-space-size=280 --expose-gc"
EXPOSE 8787
CMD ["node", "server.js"]
