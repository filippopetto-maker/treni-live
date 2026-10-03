# Treni Live Italia su Hugging Face Spaces (hardware gratuito "CPU basic": 2 vCPU, 16 GB RAM).
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node . .

# Dati già pronti (binari OSM, stazioni, percorsi): il disco dello Space non è permanente,
# così a ogni avvio non si riscarica tutto da Overpass.
RUN mkdir -p data \
 && for f in seed/*.gz; do gunzip -c "$f" > "data/$(basename "$f" .gz)"; done \
 && cp seed/*.json data/ \
 && chown -R node:node /app

USER node
ENV HOST=0.0.0.0 PORT=7860 TZ=Europe/Rome NODE_OPTIONS=--max-old-space-size=4096
EXPOSE 7860
CMD ["node", "server.js"]
