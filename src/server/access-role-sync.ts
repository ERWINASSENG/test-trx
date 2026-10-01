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

export async function syncUserAccessRole(
  adminClient: SupabaseClient,
  userId: string,
  roleKey: string,
  assignedBy: string | null,
  assignmentSource: 'admin' | 'legacy_profile'
): Promise<void> {
  if (!isCanonicalAccessRoleKey(roleKey)) {
    throw new Error(`Le rôle « ${roleKey} » ne peut pas être synchronisé avec profiles.role.`);
  }

  const { data: role, error: roleError } = await adminClient
    .from('access_roles')
    .select('id')
    .eq('role_key', roleKey)
    .eq('is_active', true)
    .maybeSingle();

  if (roleError || !role) {
    throw new Error(`Le rôle d’accès « ${roleKey} » est introuvable ou inactif.`);
  }

  const { error: deleteError } = await adminClient
    .from('access_user_roles')
    .delete()
    .eq('user_id', userId);
  if (deleteError) throw deleteError;

  const { error: insertError } = await adminClient
    .from('access_user_roles')
    .insert({
      user_id: userId,
      role_id: role.id,
      assigned_by: assignedBy,
      assignment_source: assignmentSource,
      expires_at: null,
    });
  if (insertError) throw insertError;
}
