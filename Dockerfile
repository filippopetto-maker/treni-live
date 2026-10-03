# Treni Live Italia in un container (Render, o qualsiasi hosting Docker).
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node . .

# Dati già pronti (binari OSM, stazioni, percorsi) dalla cartella seed/: il disco dei servizi
# gratuiti non è permanente, così a ogni avvio non si riscarica tutto da Overpass.
RUN mkdir -p data \
 && for f in seed/*.gz; do gunzip -c "$f" > "data/$(basename "$f" .gz)"; done \
 && cp seed/*.json data/ \
 && chown -R node:node /app

USER node
# PORT lo imposta l'hosting (Render usa 10000). Con 512 MB di RAM il navigatore tiene una città alla volta.
ENV HOST=0.0.0.0 PORT=8787 TZ=Europe/Rome NAV_MAX_NETS=1 NAV_UNLOAD_MIN=10 NODE_OPTIONS="--max-old-space-size=380 --expose-gc"
EXPOSE 8787
CMD ["node", "server.js"]
