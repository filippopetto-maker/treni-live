#!/usr/bin/env bash
# Installa Treni Live su un server Linux (Ubuntu/Debian, ARM o x86) come servizio sempre attivo.
#
# Uso, da root sul server:
#   curl -fsSL <url di questo file> | bash -s -- <url-repo-git> <dominio> <password>
# oppure, dopo aver clonato il repo:
#   sudo bash deploy/install.sh <url-repo-git> <dominio> <password>
#
# Esempio:
#   sudo bash deploy/install.sh https://github.com/utente/treni-live.git miotreno.duckdns.org 'una-password-lunga'
#
# Cosa fa:
#   - installa Node.js 22, git, unzip e Caddy (HTTPS automatico con Let's Encrypt)
#   - crea l'utente di sistema "treni" e clona il progetto in /opt/treni-live
#   - avvia il server come servizio systemd che riparte da solo se cade o al riavvio
#   - ogni 10 minuti controlla se su git ci sono aggiornamenti e, se sì, li applica e riavvia
set -euo pipefail

REPO="${1:?manca URL del repository git}"
DOMAIN="${2:?manca il dominio (es. miotreno.duckdns.org)}"
PASSWORD="${3:?manca la password per la mappa}"
DIR=/opt/treni-live

if [ "$(id -u)" -ne 0 ]; then echo "Esegui come root (sudo)"; exit 1; fi

echo "==> Pacchetti di base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git curl unzip ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "==> Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

echo "==> Utente e codice"
id treni >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/treni --shell /usr/sbin/nologin treni
if [ ! -d "$DIR/.git" ]; then
  git clone "$REPO" "$DIR"
fi
mkdir -p "$DIR/data"
chown -R treni:treni "$DIR"

echo "==> Configurazione"
cat > /etc/treni-live.env <<EOF
HOST=127.0.0.1
PORT=8787
TRENI_PASSWORD=$PASSWORD
EOF
chmod 600 /etc/treni-live.env

cp "$DIR/deploy/treni-live.service" /etc/systemd/system/
cp "$DIR/deploy/treni-live-update.service" /etc/systemd/system/
cp "$DIR/deploy/treni-live-update.timer" /etc/systemd/system/
chmod +x "$DIR/deploy/update.sh"

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:8787
}
EOF

# Le immagini Ubuntu di Oracle Cloud bloccano le porte con iptables anche se aperte nella console.
if iptables -L INPUT -n 2>/dev/null | grep -q REJECT; then
  echo "==> Apro le porte 80 e 443 nel firewall locale"
  for p in 80 443; do
    iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -p tcp --dport $p -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null && netfilter-persistent save || true
fi

echo "==> Avvio"
systemctl daemon-reload
systemctl enable --now treni-live.service
systemctl enable --now treni-live-update.timer
systemctl restart caddy

echo
echo "Fatto. Tra un minuto la mappa sarà su https://$DOMAIN (password: quella che hai scelto)."
echo "Log del server:  journalctl -u treni-live -f"
echo "Nota: al primo avvio il server scarica la rete ferroviaria (~25 min); intanto i treni vanno in linea retta."
