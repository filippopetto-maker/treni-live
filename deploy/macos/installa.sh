#!/bin/zsh
# Installa Treni Live sul Mac come servizio che parte da solo al login (LaunchAgent)
# e crea l'app "Treni Live" in ~/Applications che apre la mappa nel browser.
#
#   zsh deploy/macos/installa.sh            installa o reinstalla
#   zsh deploy/macos/installa.sh rimuovi    toglie servizio e app (i file del progetto restano)
set -e

LABEL="it.trenilive.server"
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP="$HOME/Applications/Treni Live.app"
LOG="$HOME/Library/Logs/treni-live.log"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

if [ "$1" = "rimuovi" ]; then
  rm -f "$PLIST"
  rm -rf "$APP"
  echo "Servizio e app rimossi."
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Applications" "$HOME/Library/Logs"

# Percorso di node al momento dell'installazione (Homebrew, nvm, conda…).
# Se in futuro sposti node, basta rilanciare questo script.
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "node non trovato: installalo o aprilo in un terminale dove funziona"; exit 1; fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootstrap "$DOMAIN" "$PLIST"

# App che apre la mappa nel browser predefinito.
rm -rf "$APP"
osacompile -o "$APP" -e 'open location "http://localhost:8787"' >/dev/null

echo "Servizio installato: parte da solo a ogni login e riparte se si blocca."
echo "Mappa:  http://localhost:8787   (oppure l'app \"Treni Live\" in Applicazioni)"
echo "Log:    $LOG"
