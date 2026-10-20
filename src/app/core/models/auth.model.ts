export type CanonicalUserRole =
  | 'admin'
  | 'manager'
  | 'caissiere'
  | 'employe'
  | 'tresorier'
  | 'comptable'
  | 'commercial';

export type UserRole = CanonicalUserRole | (string & {});

export interface RoleDefinition {
  id: UserRole;
  label: string;
  description: string;
  badgeClass: string;
}

export interface UserProfile {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  roles?: UserRole[];
  customRole?: string | null;
  roleLabel?: string | null;
  department?: string;
  phone?: string;
  isActive: boolean;
  mustChangePassword?: boolean;
  avatarUrl?: string;
  createdAt: string;
  updatedAt?: string;
  lastLoginAt?: string;
}

export interface AuthSession {
  user: UserProfile | null;
  token: string | null;
  expiresAt?: number;
}

export interface LoginCredentials {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface CreateUserPayload {
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  department?: string;
  phone?: string;
  tempPassword?: string;
  sendInviteEmail?: boolean;
}

export interface UpdateUserPayload {
  firstName?: string;
  lastName?: string;
  role?: UserRole;
  department?: string;
  phone?: string;
  isActive?: boolean;
  avatarUrl?: string;
}

export interface NavMenuItem {
  id: string;
  label: string;
  route: string;
  allowedRoles: UserRole[];
  badge?: string;
  badgeVariant?: 'primary' | 'success' | 'warning' | 'neutral';
}

export const ROLE_DEFINITIONS: Record<string, RoleDefinition> = {
  admin: {
    id: 'admin',
    label: 'Administrateur',
    description: 'Accès complet, gestion des utilisateurs, rôles et sécurité',
    badgeClass: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  },
  manager: {
    id: 'manager',
    label: 'Manager',
    description: 'Supervision des opérations, validation et suivi global',
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  caissiere: {
    id: 'caissiere',
    label: 'Caissière',
    description: 'Opérations de caisse, encaissements et distribution analytique',
    badgeClass: 'bg-sky-50 text-sky-700 border-sky-200',
  },
  comptable: {
    id: 'comptable',
    label: 'Comptable',
    description: 'Tenue comptable, validation des écritures, export et audits financiers',
    badgeClass: 'bg-purple-50 text-purple-700 border-purple-200',
  },
  tresorier: {
    id: 'tresorier',
    label: 'Trésorier',
    description: 'Gestion de la trésorerie, validation financière et supervision analytique',
    badgeClass: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  employe: {
    id: 'employe',
    label: 'Employé',
    description: 'Consultation et suivi des activités opérationnelles',
    badgeClass: 'bg-slate-100 text-slate-700 border-slate-200',
  },
  commercial: {
    id: 'commercial',
    label: 'Commercial',
    description: 'Gestion du pipeline des ventes, prospection, cotations et suivi client',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
  },
};

export function getRoleDefinition(role: UserRole | undefined | null, roleLabel?: string | null): RoleDefinition {
  if (!role) {
    return {
      id: 'employe',
      label: 'Non défini',
      description: 'Rôle non attribué',
      badgeClass: 'bg-slate-100 text-slate-700 border-slate-200',
    };
  }

  const existing = ROLE_DEFINITIONS[role as CanonicalUserRole];
  if (existing) {
    return roleLabel ? { ...existing, label: roleLabel } : existing;
  }

  const label = roleLabel || (role.charAt(0).toUpperCase() + role.slice(1));
  return {
    id: role,
    label,
    description: `Rôle personnalisé : ${label}`,
    badgeClass: 'bg-teal-50 text-teal-700 border-teal-200',
  };
}
