import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const PAYLOAD_VERSION = 'v1';

const FQDN_PATTERN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const FORBIDDEN_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

export function resolveMailEncryptionKey(rawKey = process.env['MAIL_ENCRYPTION_KEY']): Buffer {
  const trimmed = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!trimmed) {
    throw new Error('MAIL_ENCRYPTION_KEY manquante : chiffrement des boîtes mail indisponible.');
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  const base64Buf = Buffer.from(trimmed, 'base64');
  if (base64Buf.length === 32) {
    return base64Buf;
  }

  throw new Error('MAIL_ENCRYPTION_KEY invalide : une clé de 32 octets (64 hex ou base64) est requise.');
}

export function isMailEncryptionConfigured(): boolean {
  try {
    resolveMailEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptMailSecret(plainText: string, rawKey?: string): string {
  if (!plainText) {
    throw new Error('Secret vide refusé.');
  }
  const key = resolveMailEncryptionKey(rawKey);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    PAYLOAD_VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

export function decryptMailSecret(payload: string, rawKey?: string): string {
  const key = resolveMailEncryptionKey(rawKey);
  if (typeof payload !== 'string') {
    throw new Error('Format de secret chiffré invalide.');
  }

  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== PAYLOAD_VERSION) {
    throw new Error('Version ou structure de secret chiffré non reconnue.');
  }

  const iv = Buffer.from(parts[1], 'base64');
  const authTag = Buffer.from(parts[2], 'base64');
  const ciphertext = Buffer.from(parts[3], 'base64');

  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES || ciphertext.length === 0) {
    throw new Error('Paramètres cryptographiques invalides.');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase();
  const family = net.isIP(trimmed);
  if (family === 0) return true;

  if (family === 4) {
    const octets = trimmed.split('.').map((part) => Number(part));
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 169 && b === 254) return true; // Link-local / Cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true; // Multicast & réservées
    return false;
  }

  // IPv6
  if (trimmed === '::' || trimmed === '::1') return true;
  if (trimmed.startsWith('fc') || trimmed.startsWith('fd')) return true; // Unique local fc00::/7
  if (/^fe[89ab]/.test(trimmed)) return true; // Link-local fe80::/10
  if (trimmed.startsWith('ff')) return true; // Multicast
  if (trimmed.startsWith('::ffff:')) {
    const mappedV4 = trimmed.slice('::ffff:'.length);
    if (net.isIP(mappedV4) === 4) {
      return isPrivateOrReservedIp(mappedV4);
    }
    return true;
  }
  return false;
}

export function validatePublicMailHostFormat(rawHost: unknown): { valid: boolean; host?: string; error?: string } {
  if (typeof rawHost !== 'string') {
    return { valid: false, error: 'Nom de serveur mail requis.' };
  }
  const host = rawHost.trim().toLowerCase();
  if (!host) {
    return { valid: false, error: 'Nom de serveur mail requis.' };
  }
  if (net.isIP(host) !== 0) {
    return { valid: false, error: 'Les adresses IP directes ne sont pas autorisées ; utilisez un nom de domaine (ex. imap.domaine.com).' };
  }
  if (host === 'localhost' || FORBIDDEN_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { valid: false, error: 'Les hôtes locaux ou internes ne sont pas autorisés.' };
  }
  if (!FQDN_PATTERN.test(host)) {
    return { valid: false, error: 'Format de nom de domaine du serveur mail invalide.' };
  }
  return { valid: true, host };
}

export async function assertSafePublicMailHost(rawHost: string): Promise<string> {
  const check = validatePublicMailHostFormat(rawHost);
  if (!check.valid || !check.host) {
    throw new Error(check.error || 'Serveur mail non autorisé.');
  }

  const records = await dns.lookup(check.host, { all: true });
  if (!records || records.length === 0) {
    throw new Error('Impossible de résoudre le nom du serveur mail.');
  }

  for (const record of records) {
    if (isPrivateOrReservedIp(record.address)) {
      throw new Error('Connexion refusée : le serveur mail résout vers une adresse interne ou réservée.');
    }
  }

  return check.host;
}
