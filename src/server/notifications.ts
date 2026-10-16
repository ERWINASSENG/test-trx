import express from 'express';
import { getSupabaseAdmin } from './auth';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const getUserId = (req: express.Request): string | null => {
  const user = (req as unknown as Record<string, unknown>)['user'] as { id?: string } | undefined;
  return typeof user?.id === 'string' ? user.id : null;
};

export const listAppNotificationsHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  const userId = getUserId(req);
  const admin = getSupabaseAdmin();
  if (!userId) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  if (!admin) {
    res.status(503).json({ error: 'Le service de notifications est indisponible.' });
    return;
  }

  const [notificationsResult, countResult] = await Promise.all([
    admin.from('app_notifications')
      .select('id, notification_type, title, message, href, source_type, source_id, read_at, created_at')
      .eq('recipient_id', userId)
      .order('created_at', { ascending: false })
      .limit(50),
    admin.from('app_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('recipient_id', userId)
      .is('read_at', null),
  ]);

  const error = notificationsResult.error || countResult.error;
  if (error) {
    console.error('[NOTIFICATIONS] Échec de lecture:', error.message);
    res.status(500).json({ error: 'Impossible de charger les notifications.' });
    return;
  }

  res.json({
    notifications: notificationsResult.data || [],
    unreadCount: countResult.count || 0,
  });
};

export const markAppNotificationReadHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  const userId = getUserId(req);
  const rawId = req.params['id'];
  const admin = getSupabaseAdmin();
  if (!userId) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  if (!admin) {
    res.status(503).json({ error: 'Le service de notifications est indisponible.' });
    return;
  }
  if (typeof rawId !== 'string' || !UUID_PATTERN.test(rawId)) {
    res.status(400).json({ error: 'Identifiant de notification invalide.' });
    return;
  }

  const { error } = await admin.from('app_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', rawId)
    .eq('recipient_id', userId)
    .is('read_at', null);
  if (error) {
    console.error('[NOTIFICATIONS] Échec du marquage comme lu:', error.message);
    res.status(500).json({ error: 'Impossible de mettre à jour la notification.' });
    return;
  }
  res.json({ success: true });
};

export const markAllAppNotificationsReadHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  const userId = getUserId(req);
  const admin = getSupabaseAdmin();
  if (!userId) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  if (!admin) {
    res.status(503).json({ error: 'Le service de notifications est indisponible.' });
    return;
  }

  const { error } = await admin.from('app_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('recipient_id', userId)
    .is('read_at', null);
  if (error) {
    console.error('[NOTIFICATIONS] Échec du marquage global comme lu:', error.message);
    res.status(500).json({ error: 'Impossible de mettre à jour les notifications.' });
    return;
  }
  res.json({ success: true });
};
