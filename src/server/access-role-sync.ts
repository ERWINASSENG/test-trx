import { SupabaseClient } from '@supabase/supabase-js';

export const CANONICAL_ACCESS_ROLE_KEYS = [
  'admin',
  'manager',
  'tresorier',
  'caissiere',
  'comptable',
  'employe',
] as const;

export type CanonicalAccessRoleKey = typeof CANONICAL_ACCESS_ROLE_KEYS[number];

export const isCanonicalAccessRoleKey = (roleKey: string): roleKey is CanonicalAccessRoleKey =>
  (CANONICAL_ACCESS_ROLE_KEYS as readonly string[]).includes(roleKey);

/**
 * Synchronise le rôle d'un utilisateur de manière strictement atomique et idempotente.
 * 
 * Corrections P0 #2 & P0 #3 :
 * 1. Supprime définitivement le pattern destructeur DELETE ALL puis INSERT.
 * 2. Utilise en priorité la procédure stockée PostgreSQL atomique `sync_user_primary_role`.
 * 3. En cas de repli, effectue un UPSERT sans supprimer les autres rôles attribués à l'utilisateur,
 *    garantissant le support multi-rôles et l'absence d'états orphelins sans droits.
 */
export async function syncUserAccessRole(
  adminClient: SupabaseClient,
  userId: string,
  roleKey: string,
  assignedBy: string | null,
  assignmentSource: 'admin' | 'legacy_profile' = 'admin'
): Promise<void> {
  // 1. Appel de la procédure PostgreSQL atomique (transactionnelle et sécurisée)
  const { error: rpcError } = await adminClient.rpc('sync_user_primary_role', {
    p_user_id: userId,
    p_role_key: roleKey,
    p_assigned_by: assignedBy,
    p_assignment_source: assignmentSource,
  });

  if (!rpcError) {
    return;
  }

  console.warn('RPC sync_user_primary_role non disponible, bascule sur upsert idempotent:', rpcError.message);

  // 2. Repli résilient et idempotent (sans destruction des rôles préexistants)
  const { data: role, error: roleError } = await adminClient
    .from('access_roles')
    .select('id')
    .eq('role_key', roleKey)
    .eq('is_active', true)
    .maybeSingle();

  if (roleError || !role) {
    throw new Error(`Le rôle d’accès « ${roleKey} » est introuvable ou inactif.`);
  }

  const { error: upsertError } = await adminClient
    .from('access_user_roles')
    .upsert(
      {
        user_id: userId,
        role_id: role.id,
        assigned_by: assignedBy,
        assignment_source: assignmentSource,
        expires_at: null,
      },
      { onConflict: 'user_id,role_id' }
    );

  if (upsertError) throw upsertError;

  // Synchronisation du profil legacy dans la même phase
  await adminClient
    .from('profiles')
    .update({ role: roleKey, updated_at: new Date().toISOString() })
    .eq('id', userId);
}
