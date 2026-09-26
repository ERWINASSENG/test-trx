import { UserRole } from './auth.model';

export interface AppModule {
  id: string;
  label: string;
  description: string;
  route: string;
  icon: string;
  accent: string;
  allowedRoles: readonly UserRole[];
}

export const APP_MODULES: readonly AppModule[] = [
  {
    id: 'dashboard',
    label: 'Tableaux de bord',
    description: 'Indicateurs et suivi des opérations',
    route: '/dashboard',
    icon: 'dashboard',
    accent: '#714b67',
    allowedRoles: ['admin', 'manager', 'caissiere', 'employe', 'tresorier', 'comptable'],
  },
  {
    id: 'comptabilite',
    label: 'Comptabilité',
    description: 'Opérations de caisse et pièces comptables',
    route: '/caisse',
    icon: 'account_balance',
    accent: '#008f8c',
    allowedRoles: ['admin', 'manager', 'caissiere', 'comptable'],
  },
  {
    id: 'personnel',
    label: 'Personnel & RH',
    description: 'Gestion des collaborateurs',
    route: '/personnel',
    icon: 'badge',
    accent: '#b45309',
    allowedRoles: ['admin'],
  },
  {
    id: 'administration',
    label: 'Paramètres',
    description: 'Utilisateurs, rôles et configuration',
    route: '/admin/view',
    icon: 'admin_panel_settings',
    accent: '#475569',
    allowedRoles: ['admin'],
  },
];

export function isAppModuleVisibleToRole(module: AppModule, role: UserRole): boolean {
  return (
    role === 'admin' ||
    module.allowedRoles.includes(role) ||
    (role === 'tresorier' && module.allowedRoles.includes('manager'))
  );
}