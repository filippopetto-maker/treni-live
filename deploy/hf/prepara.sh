#!/bin/zsh
# Prepara la cartella da caricare sullo Space di Hugging Face: codice + dati compressi.
# Uso:  zsh deploy/hf/prepara.sh   →  crea ~/treni-live-hf
set -e
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$HOME/treni-live-hf"
rm -rf "$OUT"
mkdir -p "$OUT/seed"
cp -R "$SRC/src" "$SRC/public" "$SRC/certs" "$OUT/"
cp "$SRC/server.js" "$SRC/feeds.json" "$SRC/package.json" "$OUT/"
cp "$SRC/deploy/hf/Dockerfile" "$OUT/Dockerfile"
cp "$SRC/deploy/hf/README-space.md" "$OUT/README.md"
# File grandi compressi (Hugging Face accetta file normali fino a 10 MB).
for f in rail.bin astral-rail.bin paths-v2.json; do
  [ -f "$SRC/data/$f" ] && gzip -9 -c "$SRC/data/$f" > "$OUT/seed/$f.gz"
done
for f in stations.json astral.json osm-stations.json station-fixes.json; do
  [ -f "$SRC/data/$f" ] && cp "$SRC/data/$f" "$OUT/seed/"
done
echo ".git" > "$OUT/.dockerignore"
echo "Pronto in $OUT"
du -sh "$OUT" "$OUT"/seed/*
