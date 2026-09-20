import express from 'express';
import { UserRole } from '../app/core/models/auth.model';
import { normalizeUserRole } from '../app/core/utils/role.utils';
import { getSupabaseAdmin } from './auth';

export const createCollaboratorHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const {
    email,
    password,
    firstName,
    lastName,
    displayName,
    role,
    department,
    phone,
    isActive,
    sites,
  } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'Email et mot de passe initial obligatoires' });
    return;
  }

  if (typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'Le mot de passe initial doit comporter au moins 8 caractères' });
    return;
  }
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  if (!hasLetter || !hasDigit) {
    res.status(400).json({ error: 'Le mot de passe initial doit comporter au moins une lettre et un chiffre' });
    return;
  }

  const validRoles: UserRole[] = ['admin', 'manager', 'tresorier', 'caissiere', 'comptable', 'employe'];
  if (!role || !validRoles.includes(role)) {
    res.status(400).json({ error: 'Le rôle Transmex est obligatoire et doit être défini explicitement (admin, manager, tresorier, caissiere, comptable, employe)' });
    return;
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY non configurée' });
    return;
  }

  try {
    const computedDisplayName = displayName || `${firstName || ''} ${lastName || ''}`.trim() || email;
    const computedRole = normalizeUserRole(role);
    const sitesList = Array.isArray(sites) ? sites : (department ? [department] : []);

    const { data: adminAuthData, error: adminAuthError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: {
        role: computedRole,
        assignedSiteNames: sitesList,
      },
      user_metadata: {
        display_name: computedDisplayName,
        first_name: firstName || '',
        last_name: lastName || '',
        phone: phone || '',
      },
    });

    if (adminAuthError) {
      console.error('Échec création utilisateur auth:', adminAuthError.message);
      const isDuplicate = adminAuthError.message?.toLowerCase().includes('already') || adminAuthError.message?.toLowerCase().includes('exists');
      if (isDuplicate) {
        res.status(409).json({ error: 'Un compte utilisateur avec cette adresse email existe déjà.' });
        return;
      }
      res.status(400).json({ error: 'Échec de la création du compte d’authentification du collaborateur.' });
      return;
    }
    const authUserId = adminAuthData.user.id;

    const profilePayload = {
      id: authUserId,
      email,
      first_name: firstName || '',
      last_name: lastName || '',
      role: computedRole,
      department: department || 'Direction Générale',
      phone: phone || '',
      is_active: isActive !== undefined ? isActive : true,
      updated_at: new Date().toISOString(),
    };

    const { error: profileError } = await adminClient
      .from('profiles')
      .upsert(profilePayload, { onConflict: 'id' });

    if (profileError) {
      console.error('Échec synchronisation profiles:', profileError.message);
      res.status(207).json({
        user: {
          id: authUserId,
          email,
          firstName: firstName || '',
          lastName: lastName || '',
          displayName: computedDisplayName,
          role: computedRole,
          department: department || 'Direction Générale',
          phone: phone || '',
          isActive: isActive !== undefined ? isActive : true,
          createdAt: new Date().toISOString(),
        },
        warning: 'Compte créé mais la synchronisation du profil public a rencontré une erreur interne.',
      });
      return;
    }

    res.status(201).json({
      user: {
        id: authUserId,
        email,
        firstName: firstName || '',
        lastName: lastName || '',
        displayName: computedDisplayName,
        role: computedRole,
        department: department || 'Direction Générale',
        phone: phone || '',
        isActive: isActive !== undefined ? isActive : true,
        createdAt: new Date().toISOString(),
      },
      message: 'Collaborateur créé avec succès (droits scellés dans app_metadata et synchronisés)',
    });
  } catch (err: unknown) {
    console.error('Erreur createCollaboratorHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de la création du collaborateur.' });
  }
};
