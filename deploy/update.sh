#!/usr/bin/env bash
# Scarica le novità dal repository git; se il codice è cambiato, lo applica e riavvia il server.
# Lanciato ogni 10 minuti dal timer systemd treni-live-update.timer.
set -euo pipefail
cd /opt/treni-live
sudo -u treni git fetch --quiet origin
LOCAL=$(sudo -u treni git rev-parse HEAD)
REMOTE=$(sudo -u treni git rev-parse '@{u}')
if [ "$LOCAL" != "$REMOTE" ]; then
  sudo -u treni git reset --quiet --hard '@{u}'
  # Se sono cambiati i file di servizio, li aggiorna
  cp deploy/treni-live.service deploy/treni-live-update.service deploy/treni-live-update.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl restart treni-live.service
  echo "Aggiornato a $(git log -1 --format='%h %s')"
fi
