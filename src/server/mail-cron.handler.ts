import crypto from 'node:crypto';
import express from 'express';
import { syncAllActiveMailAccounts } from './mail-sync';

const MIN_CRON_SECRET_LENGTH = 16;

export function verifyCronBearerToken(
  authHeader: string | undefined,
  expectedSecret: string | undefined
): { ok: true } | { ok: false; reason: 'NOT_CONFIGURED' | 'UNAUTHORIZED' } {
  const secret = typeof expectedSecret === 'string' ? expectedSecret.trim() : '';
  if (secret.length < MIN_CRON_SECRET_LENGTH) {
    return { ok: false, reason: 'NOT_CONFIGURED' };
  }

  const header = typeof authHeader === 'string' ? authHeader.trim() : '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) {
    return { ok: false, reason: 'UNAUTHORIZED' };
  }

  const providedHash = crypto.createHash('sha256').update(match[1], 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(secret, 'utf8').digest();

  if (!crypto.timingSafeEqual(providedHash, expectedHash)) {
    return { ok: false, reason: 'UNAUTHORIZED' };
  }

  return { ok: true };
}

/**
 * Endpoint Cron Vercel : GET /api/cron/mail-sync
 * Protégé exclusivement par Authorization: Bearer <CRON_SECRET> (échec fermé si absent).
 * Remplace le worker setInterval() en production serverless Vercel.
 */
export const cronMailSyncHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');

  const authCheck = verifyCronBearerToken(
    typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : undefined,
    process.env['CRON_SECRET']
  );

  if (!authCheck.ok) {
    if (authCheck.reason === 'NOT_CONFIGURED') {
      res.status(503).json({ error: 'CRON_SECRET non configuré sur le serveur.' });
      return;
    }
    res.status(401).json({ error: 'Accès Cron non autorisé.' });
    return;
  }

  try {
    await syncAllActiveMailAccounts();
    res.json({
      ok: true,
      completedAt: new Date().toISOString(),
    });
  } catch {
    res.status(500).json({ error: 'Échec de la synchronisation planifiée des boîtes mail.' });
  }
};
