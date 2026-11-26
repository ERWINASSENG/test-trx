import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptMailSecret,
  encryptMailSecret,
  isPrivateOrReservedIp,
  resolveMailEncryptionKey,
  validatePublicMailHostFormat,
} from './mail-crypto';

const TEST_HEX_KEY = crypto.randomBytes(32).toString('hex');

describe('mail-crypto — AES-256-GCM & anti-SSRF', () => {
  it('échoue de manière fermée si MAIL_ENCRYPTION_KEY est absente ou invalide', () => {
    expect(() => resolveMailEncryptionKey('')).toThrow();
    expect(() => resolveMailEncryptionKey('short-key')).toThrow();
  });

  it('chiffre et déchiffre fidèlement un mot de passe avec un IV aléatoire par appel', () => {
    const secret = 'Outlook!Secret#2026';
    const c1 = encryptMailSecret(secret, TEST_HEX_KEY);
    const c2 = encryptMailSecret(secret, TEST_HEX_KEY);

    expect(c1).not.toBe(c2);
    expect(c1.startsWith('v1:')).toBe(true);
    expect(decryptMailSecret(c1, TEST_HEX_KEY)).toBe(secret);
    expect(decryptMailSecret(c2, TEST_HEX_KEY)).toBe(secret);
  });

  it('rejette toute altération du texte chiffré ou du tag GCM (intégrité authentifiée)', () => {
    const encrypted = encryptMailSecret('MonMotDePasseMail', TEST_HEX_KEY);
    const parts = encrypted.split(':');
    const tamperedTag = Buffer.alloc(16, 0xff).toString('base64');
    const tampered = [parts[0], parts[1], tamperedTag, parts[3]].join(':');

    expect(() => decryptMailSecret(tampered, TEST_HEX_KEY)).toThrow();
    const otherKey = crypto.randomBytes(32).toString('hex');
    expect(() => decryptMailSecret(encrypted, otherKey)).toThrow();
  });

  it('bloque toutes les adresses IP privées, loopback, link-local et IPv6 internes (anti-SSRF)', () => {
    expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('10.0.0.5')).toBe(true);
    expect(isPrivateOrReservedIp('172.16.4.2')).toBe(true);
    expect(isPrivateOrReservedIp('192.168.1.1')).toBe(true);
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('100.64.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('::1')).toBe(true);
    expect(isPrivateOrReservedIp('fe80::1')).toBe(true);
    expect(isPrivateOrReservedIp('fc00::1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('93.184.216.34')).toBe(false);
  });

  it('valide uniquement les noms de domaine publics FQDN et rejette localhost / IP directes', () => {
    expect(validatePublicMailHostFormat('localhost').valid).toBe(false);
    expect(validatePublicMailHostFormat('mail.local').valid).toBe(false);
    expect(validatePublicMailHostFormat('192.168.1.10').valid).toBe(false);
    expect(validatePublicMailHostFormat('93.184.216.34').valid).toBe(false);
    expect(validatePublicMailHostFormat('https://imap.example.com').valid).toBe(false);
    expect(validatePublicMailHostFormat('ssl0.ovh.net')).toEqual({
      valid: true,
      host: 'ssl0.ovh.net',
    });
  });
});
