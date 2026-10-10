import { EffectivePermission } from './access-control.model';

export interface AppModule {
  id: string;
  label: string;
  description: string;
  route: string;
  icon: string;
  accent: string;
  permissionKey: string;
}

export const APP_MODULES: readonly AppModule[] = [
  {
    id: 'dashboard',
    label: 'Tableaux de bord',
    description: 'Indicateurs et suivi des opérations',
    route: '/dashboard',
    icon: '/assets/module-icons/board.svg',
    accent: '#714b67',
    permissionKey: 'dashboard.view',
  },
  {
    id: 'comptabilite',
    label: 'Comptabilité',
    description: 'Opérations de caisse et pièces comptables',
    route: '/caisse',
    icon: '/assets/module-icons/accountant.svg',
    accent: '#008f8c',
    permissionKey: 'cashier.read',
  },
  {
    id: 'personnel',
    label: 'Personnel & RH',
    description: 'Gestion des collaborateurs',
    route: '/personnel',
    icon: '/assets/module-icons/hr.svg',
    accent: '#b45309',
    permissionKey: 'hr.read',
  },
  {
    id: 'prospects',
    label: 'Contacts',
    description: 'Suivi des contacts et opportunités commerciales',
    route: '/prospects',
    icon: '/assets/module-icons/contacts.svg',
    accent: '#0b5ed7',
    permissionKey: 'prospects.read',
  },
  {
    id: 'quotes',
    label: 'Cotations',
    description: 'Créer, personnaliser et suivre les offres commerciales',
    route: '/quotes',
    icon: '/assets/module-icons/quotes.svg',
    accent: '#2563eb',
    permissionKey: 'quotes.read',
  },
  {
    id: 'crm-commercial',
    label: 'CRM Commercial',
    description: 'Suivre les opportunités, clients, relances et campagnes',
    route: '/crm-commercial',
    icon: '/assets/module-icons/crm-commercial.svg',
    accent: '#0b5ed7',
    permissionKey: 'crm.read',
  },
  {
    id: 'dossiers',
    label: 'Dossiers',
    description: 'Suivi des dossiers et dépenses liées aux prospects',
    route: '/dossiers',
    icon: '/assets/module-icons/dossier.svg',
    accent: '#008f8c',
    permissionKey: 'cashier.read',
  },
  {
    id: 'administration',
    label: 'Paramètres',
    description: 'Configuration générale de l’application',
    route: '/configuration/parametres',
    icon: '/assets/module-icons/settings.svg',
    accent: '#475569',
    permissionKey: 'configuration.read',
  },
  {
    id: 'access-control',
    label: 'Gestion des accès',
    description: 'Gérer les rôles, permissions et accès utilisateurs',
    route: '/admin/access-control',
    icon: '/assets/module-icons/access-control.svg',
    accent: '#b42336',
    permissionKey: 'access.roles.read',
  },
];

export function isAppModuleVisibleToPermissions(
  module: AppModule,
  permissions: readonly EffectivePermission[]
): boolean {
  const matchingPermissions = permissions.filter((permission) => permission.permissionKey === module.permissionKey);
  if (matchingPermissions.some((permission) => permission.effect === 'deny')) return false;
  return matchingPermissions.some((permission) => permission.effect === 'allow');
}