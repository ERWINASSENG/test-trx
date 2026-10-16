import { SupabaseClient } from '@supabase/supabase-js';

export type AppNotificationSource = 'prospect' | 'quote' | 'dossier' | 'sales_activity';

export interface CreateAppNotificationInput {
  recipientId: string;
  actorId: string | null;
  notificationType: 'assignment' | 'reminder';
  title: string;
  message: string;
  href: string;
  sourceType: AppNotificationSource;
  sourceId: string;
  dedupeKey: string;
}

export async function createAppNotification(
  adminClient: SupabaseClient,
  input: CreateAppNotificationInput
): Promise<boolean> {
  const { error } = await adminClient
    .from('app_notifications')
    .upsert(
      {
        recipient_id: input.recipientId,
        actor_id: input.actorId,
        notification_type: input.notificationType,
        title: input.title,
        message: input.message,
        href: input.href,
        source_type: input.sourceType,
        source_id: input.sourceId,
        dedupe_key: input.dedupeKey,
      },
      { onConflict: 'recipient_id,dedupe_key', ignoreDuplicates: true }
    );

  if (error) {
    console.error('[NOTIFICATIONS] Échec de création de la notification:', error.message);
    return false;
  }
  return true;
}
