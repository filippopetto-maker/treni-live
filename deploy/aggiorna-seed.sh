#!/bin/zsh
# Copia nella cartella seed/ (inclusa nel repository) i dati pesanti già pronti, compressi.
# Da rilanciare ogni tanto, poi commit + push: l'hosting li usa all'avvio.
set -e
cd "$(dirname "$0")/.."
mkdir -p seed
for f in rail.bin astral-rail.bin paths-v2.json; do
  [ -f "data/$f" ] && gzip -9 -c "data/$f" > "seed/$f.gz"
done
for f in stations.json astral.json osm-stations.json station-fixes.json; do
  [ -f "data/$f" ] && cp "data/$f" seed/
done
du -sh seed seed/*
