import { getSupabaseAdmin } from './auth';

export type JournalWriteAuthorization =
  | { authorized: true }
  | { authorized: false; status: number; error: string };

export const authorizeJournalOwnerWrite = async (
  adminClient: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  journalId: string,
  userRole: string | undefined,
  userId: string | undefined
): Promise<JournalWriteAuthorization> => {
  if (!userId) {
    return { authorized: false, status: 401, error: 'Utilisateur non identifié.' };
  }
  if (userRole === 'admin') return { authorized: true };
  if (userRole !== 'tresorier') {
    return { authorized: false, status: 403, error: 'Écriture non autorisée dans ce journal.' };
  }

  try {
    const { data: journal, error } = await adminClient
      .from('journals')
      .select('created_by, sequence_prefix')
      .eq('id', journalId)
      .maybeSingle();

    if (error) {
      return { authorized: false, status: 500, error: 'Impossible de vérifier le propriétaire du journal.' };
    }
    if (!journal) {
      return { authorized: false, status: 404, error: 'Journal comptable introuvable.' };
    }
    if (journal.sequence_prefix?.toUpperCase() === 'CSH1' || journal.created_by !== userId) {
      return { authorized: false, status: 403, error: 'Le trésorier ne peut écrire que dans ses propres journaux.' };
    }

    return { authorized: true };
  } catch {
    return { authorized: false, status: 500, error: 'Impossible de vérifier le propriétaire du journal.' };
  }
};