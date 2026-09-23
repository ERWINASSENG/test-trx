import type { SupabaseClient } from '@supabase/supabase-js';

export interface AuditLogEntry {
  userId?: string | null;
  userEmail?: string | null;
  userRole?: string | null;
  action: 'CREATE_OPERATION' | 'UPDATE_OPERATION' | 'DELETE_OPERATION';
  entityType?: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
}

/**
 * Écrit une ligne dans public.audit_logs. Ne doit jamais faire échouer la
 * requête principale : une erreur d'audit est loggée mais avalée.
 */
export async function writeAuditLog(adminClient: SupabaseClient, entry: AuditLogEntry): Promise<void> {
  try {
    const { error } = await adminClient.from('audit_logs').insert([
      {
        user_id: entry.userId ?? null,
        user_email: entry.userEmail ?? null,
        user_role: entry.userRole ?? null,
        action: entry.action,
        entity_type: entry.entityType ?? 'cashier_transaction',
        entity_id: entry.entityId ?? null,
        details: entry.details ?? {},
        ip_address: entry.ipAddress ?? null,
      },
    ]);
    if (error) {
      console.error('[AUDIT_LOGS] Échec écriture audit_logs:', error.message);
    }
  } catch (err) {
    console.error('[AUDIT_LOGS] Exception écriture audit_logs:', err);
  }
}
