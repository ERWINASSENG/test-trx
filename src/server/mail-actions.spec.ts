import { describe, expect, it } from 'vitest';
import {
  resolveSafeDownloadContentType,
  sanitizeAttachmentFilename,
} from './mail-actions.handlers';
import { verifyCronBearerToken } from './mail-cron.handler';
import { sanitizeSearchQuery } from './mail-provider';

describe('mail-actions & cron — sécurité pièces jointes, recherche & CRON_SECRET', () => {
  it('assainit les noms de pièces jointes contre le path traversal et les injections d’en-têtes', () => {
    expect(sanitizeAttachmentFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeAttachmentFilename('C:\\temp\\facture;evil="1".pdf\r\nX: y')).toBe(
      'facture_evil=_1_.pdfX_ y'
    );
    expect(sanitizeAttachmentFilename('...htaccess')).toBe('htaccess');
    expect(sanitizeAttachmentFilename('   ')).toBe('piece-jointe');
  });

  it('neutralise les types exécutables, HTML et SVG vers application/octet-stream (S9)', () => {
    expect(resolveSafeDownloadContentType('text/html', 'devis.html')).toBe(
      'application/octet-stream'
    );
    expect(resolveSafeDownloadContentType('image/svg+xml', 'logo.svg')).toBe(
      'application/octet-stream'
    );
    expect(resolveSafeDownloadContentType('application/pdf', 'payload.html')).toBe(
      'application/octet-stream'
    );
    expect(resolveSafeDownloadContentType('application/x-msdownload', 'run.exe')).toBe(
      'application/octet-stream'
    );
    expect(resolveSafeDownloadContentType('application/pdf', 'cotation-2026.pdf')).toBe(
      'application/pdf'
    );
    expect(resolveSafeDownloadContentType('image/png', 'bordereau.png')).toBe('image/png');
  });

  it('valide les requêtes de recherche IMAP et rejette les caractères de contrôle ou chaînes > 100 car.', () => {
    expect(sanitizeSearchQuery('  cotation douala  ')).toBe('cotation douala');
    expect(sanitizeSearchQuery('')).toBeNull();
    expect(sanitizeSearchQuery('test\r\nLOGOUT')).toBe('INVALID');
    expect(sanitizeSearchQuery('a'.repeat(101))).toBe('INVALID');
  });

  it('vérifie CRON_SECRET en échec fermé et temps constant', () => {
    const secret = 'transimex-cron-secret-2026-prod-ok';
    expect(verifyCronBearerToken(`Bearer ${secret}`, undefined)).toEqual({
      ok: false,
      reason: 'NOT_CONFIGURED',
    });
    expect(verifyCronBearerToken(`Bearer ${secret}`, 'short')).toEqual({
      ok: false,
      reason: 'NOT_CONFIGURED',
    });
    expect(verifyCronBearerToken(undefined, secret)).toEqual({
      ok: false,
      reason: 'UNAUTHORIZED',
    });
    expect(verifyCronBearerToken('Bearer wrong-token', secret)).toEqual({
      ok: false,
      reason: 'UNAUTHORIZED',
    });
    expect(verifyCronBearerToken(`Bearer ${secret}`, secret)).toEqual({ ok: true });
  });
});
