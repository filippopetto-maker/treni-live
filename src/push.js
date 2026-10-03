// Notifiche Web Push senza librerie esterne: firma VAPID (RFC 8292) e cifratura aes128gcm (RFC 8291).
// Funziona con i servizi di Google (Android/Chrome), Apple (iPhone con il sito aggiunto alla Home) e Mozilla.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './util.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// HKDF con una sola iterazione di "expand" (bastano al massimo 32 byte).
const expand = (prk, info, len) => hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len);

/** Cifra il contenuto per un abbonamento (chiavi p256dh e auth del browser). */
export function encrypt(subKeys, payload, { salt = crypto.randomBytes(16), ecdh = null } = {}) {
  const uaPub = Buffer.from(subKeys.p256dh, 'base64url');
  const auth = Buffer.from(subKeys.auth, 'base64url');
  if (uaPub.length !== 65 || auth.length < 16) throw new Error('chiavi abbonamento non valide');
  if (!ecdh) {
    ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
  }
  const asPub = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPub);
  const ikm = expand(hmac(auth, secret), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const prk = hmac(salt, ikm);
  const cek = expand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = expand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head[20] = asPub.length;
  return Buffer.concat([head, asPub, body]);
}

export class WebPush {
  /**
   * Chiavi VAPID: dalle variabili VAPID_PUBLIC / VAPID_PRIVATE, altrimenti create e salvate in data/vapid.json.
   * Se cambiano (nuovo server), il telefono si riabbona da solo alla partenza della guida successiva.
   */
  constructor({ dataDir, subject = process.env.VAPID_SUBJECT || 'https://treni-live.onrender.com' }) {
    this.subject = subject;
    let keys = process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE ? { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE } : null;
    const file = path.join(dataDir, 'vapid.json');
    if (!keys) {
      try {
        keys = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        const e = crypto.createECDH('prime256v1');
        e.generateKeys();
        keys = { publicKey: b64u(e.getPublicKey()), privateKey: b64u(e.getPrivateKey()) };
        try {
          fs.writeFileSync(file, JSON.stringify(keys));
        } catch {}
        log('Notifiche: create nuove chiavi VAPID');
      }
    }
    this.publicKey = keys.publicKey;
    const pub = Buffer.from(keys.publicKey, 'base64url');
    this.key = crypto.createPrivateKey({
      key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)), d: keys.privateKey },
      format: 'jwk',
    });
    this.jwts = new Map();
    this.stats = { inviate: 0, errori: 0, ultimoErrore: null };
  }

  jwt(aud) {
    const c = this.jwts.get(aud);
    if (c && c.exp - Date.now() / 1000 > 3600) return c.token;
    const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
    const data = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify({ aud, exp, sub: this.subject }))}`;
    const sig = crypto.sign('sha256', Buffer.from(data), { key: this.key, dsaEncoding: 'ieee-p1363' });
    const token = `${data}.${b64u(sig)}`;
    this.jwts.set(aud, { token, exp });
    return token;
  }

  /** Invia; restituisce lo stato HTTP (201 ok, 404/410 abbonamento scaduto). */
  async send(sub, message, { ttl = 300, urgency = 'high' } = {}) {
    const url = new URL(sub.endpoint);
    const body = encrypt(sub.keys, JSON.stringify(message));
    try {
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          TTL: String(ttl),
          Urgency: urgency,
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          Authorization: `vapid t=${this.jwt(url.origin)}, k=${this.publicKey}`,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) this.stats.inviate++;
      else {
        this.stats.errori++;
        this.stats.ultimoErrore = `${res.status} ${(await res.text()).slice(0, 200)}`;
        log(`Notifiche: ${url.host} ha risposto ${this.stats.ultimoErrore}`);
      }
      return res.status;
    } catch (e) {
      this.stats.errori++;
      this.stats.ultimoErrore = e.message;
      log(`Notifiche: invio non riuscito (${e.message})`);
      return 0;
    }
  }
}
