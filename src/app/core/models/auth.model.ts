export type UserRole = 'admin' | 'manager' | 'caissiere' | 'employe' | 'tresorier' | 'comptable';

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

export const ROLE_DEFINITIONS: Record<UserRole, RoleDefinition> = {
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
};
