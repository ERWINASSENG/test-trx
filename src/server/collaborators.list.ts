import express from 'express';
import { normalizeUserRole } from '../app/core/utils/role.utils';
import { getSupabaseAdmin } from './auth';

export const getCollaboratorsHandler = async (_req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();

  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY non configurée' });
    return;
  }

  try {
    interface AuthUserRecord {
      id: string;
      email?: string;
      phone?: string;
      created_at?: string;
      last_sign_in_at?: string;
      updated_at?: string;
      user_metadata?: Record<string, unknown>;
      app_metadata?: Record<string, unknown>;
    }

    const authUsers: AuthUserRecord[] = [];
    const perPage = 1000;
    let currentPage = 1;
    let hasMoreAuth = true;
    const MAX_AUTH_PAGES = 50;

    while (hasMoreAuth && currentPage <= MAX_AUTH_PAGES) {
      try {
        const { data: authData, error: authErr } = await adminClient.auth.admin.listUsers({
          page: currentPage,
          perPage,
        });

        if (authErr || !authData?.users || authData.users.length === 0) {
          hasMoreAuth = false;
          break;
        }

        authUsers.push(...(authData.users as AuthUserRecord[]));
        if (authData.nextPage && authData.nextPage > currentPage) {
          currentPage = authData.nextPage;
        } else if (authData.users.length === perPage) {
          currentPage += 1;
        } else {
          hasMoreAuth = false;
        }
      } catch (authFetchError) {
        console.warn(`Erreur lors de la pagination listUsers page ${currentPage}:`, authFetchError);
        hasMoreAuth = false;
      }
    }

    interface ProfileDbRecord {
      id: string;
      email?: string;
      first_name?: string;
      last_name?: string;
      role?: string;
      department?: string;
      phone?: string;
      is_active?: boolean;
      avatar_url?: string;
      created_at?: string;
      last_login_at?: string;
      updated_at?: string;
      [key: string]: unknown;
    }

    const allProfiles: ProfileDbRecord[] = [];
    let profileOffset = 0;
    const profilePageSize = 1000;
    let profilesHasMore = true;
    const MAX_PROFILE_PAGES = 50;
    let profilePageCount = 0;

    while (profilesHasMore && profilePageCount < MAX_PROFILE_PAGES) {
      profilePageCount++;
      const { data: pageProfiles, error: profileErr } = await adminClient
        .from('profiles')
        .select('*')
        .range(profileOffset, profileOffset + profilePageSize - 1);

      if (profileErr || !pageProfiles || pageProfiles.length === 0) {
        profilesHasMore = false;
        break;
      }

      allProfiles.push(...(pageProfiles as ProfileDbRecord[]));
      if (pageProfiles.length < profilePageSize) {
        profilesHasMore = false;
      } else {
        profileOffset += profilePageSize;
      }
    }

    const profileMap = new Map(allProfiles.map((profile) => [profile.id, profile]));
    const processedIds = new Set<string>();
    const users: Record<string, unknown>[] = [];

    for (const authUser of authUsers) {
      processedIds.add(authUser.id);
      const profile = profileMap.get(authUser.id);
      const firstName = profile?.first_name || (authUser.user_metadata?.['first_name'] as string) || (authUser.user_metadata?.['firstName'] as string) || '';
      const lastName = profile?.last_name || (authUser.user_metadata?.['last_name'] as string) || (authUser.user_metadata?.['lastName'] as string) || '';
      const email = authUser.email || profile?.email || '';
      const displayName = `${firstName} ${lastName}`.trim() || (authUser.user_metadata?.['display_name'] as string) || email || 'Utilisateur';
      const rawRole = (authUser.app_metadata?.['role'] as string) || profile?.role || (authUser.user_metadata?.['role'] as string) || 'employe';

      users.push({
        id: authUser.id,
        email,
        firstName,
        lastName,
        displayName,
        role: normalizeUserRole(rawRole),
        department: profile?.department || 'Services Généraux',
        phone: profile?.phone || authUser.phone || '',
        isActive: profile?.is_active ?? true,
        avatarUrl: profile?.avatar_url,
        createdAt: profile?.created_at || authUser.created_at || new Date().toISOString(),
        lastLoginAt: authUser.last_sign_in_at || profile?.last_login_at,
        updatedAt: profile?.updated_at || authUser.updated_at,
      });
    }

    for (const profile of allProfiles) {
      if (processedIds.has(profile.id)) continue;
      processedIds.add(profile.id);
      users.push({
        id: profile.id,
        email: profile.email || '',
        firstName: profile.first_name || '',
        lastName: profile.last_name || '',
        displayName: `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || profile.email || 'Utilisateur',
        role: normalizeUserRole(profile.role),
        department: profile.department || 'Services Généraux',
        phone: profile.phone || '',
        isActive: profile.is_active ?? true,
        avatarUrl: profile.avatar_url,
        createdAt: profile.created_at || new Date().toISOString(),
        updatedAt: profile.updated_at,
      });
    }

    res.json({ users, total: users.length });
  } catch (err: unknown) {
    console.error('Erreur getCollaboratorsHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de la récupération des collaborateurs.' });
  }
};
