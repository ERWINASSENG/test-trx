import { EffectivePermission } from './access-control.model';

export interface AppModule {
  id: string;
  label: string;
  description: string;
  route: string;
  icon: string;
  accent: string;
  visibilityPermissionKey: string;
}

export const APP_MODULES: readonly AppModule[] = [
  {
    id: 'dashboard',
    label: 'Tableaux de bord',
    description: 'Indicateurs et suivi des opérations',
    route: '/dashboard',
    icon: '/assets/module-icons/board.svg',
    accent: '#714b67',
    visibilityPermissionKey: 'module.dashboard.view',
  },
  {
    id: 'comptabilite',
    label: 'Comptabilité',
    description: 'Opérations de caisse et pièces comptables',
    route: '/caisse',
    icon: '/assets/module-icons/accountant.svg',
    accent: '#008f8c',
    visibilityPermissionKey: 'module.accounting.view',
  },
  {
    id: 'personnel',
    label: 'Personnel & RH',
    description: 'Gestion des collaborateurs',
    route: '/personnel',
    icon: '/assets/module-icons/hr.svg',
    accent: '#b45309',
    visibilityPermissionKey: 'module.hr.view',
  },
  {
    id: 'prospects',
    label: 'Contacts',
    description: 'Suivi des contacts et opportunités commerciales',
    route: '/prospects',
    icon: '/assets/module-icons/contacts.svg',
    accent: '#0b5ed7',
    visibilityPermissionKey: 'module.prospects.view',
  },
  {
    id: 'quotes',
    label: 'Cotations',
    description: 'Créer, personnaliser et suivre les offres commerciales',
    route: '/quotes',
    icon: '/assets/module-icons/quotes.svg',
    accent: '#2563eb',
    visibilityPermissionKey: 'module.quotes.view',
  },
  {
    id: 'crm-commercial',
    label: 'CRM Commercial',
    description: 'Suivre les opportunités, clients, relances et campagnes',
    route: '/crm-commercial',
    icon: '/assets/module-icons/crm-commercial.svg',
    accent: '#0b5ed7',
    visibilityPermissionKey: 'module.crm.view',
  },
  {
    id: 'dossiers',
    label: 'Dossiers',
    description: 'Suivi des dossiers et dépenses liées aux prospects',
    route: '/dossiers',
    icon: '/assets/module-icons/dossier.svg',
    accent: '#008f8c',
    visibilityPermissionKey: 'module.dossiers.view',
  },
  {
    id: 'administration',
    label: 'Paramètres',
    description: 'Configuration générale de l’application',
    route: '/configuration/parametres',
    icon: '/assets/module-icons/settings.svg',
    accent: '#475569',
    visibilityPermissionKey: 'module.configuration.view',
  },
  {
    id: 'access-control',
    label: 'Gestion des accès',
    description: 'Gérer les rôles, permissions et accès utilisateurs',
    route: '/admin/access-control',
    icon: '/assets/module-icons/access-control.svg',
    accent: '#b42336',
    visibilityPermissionKey: 'module.access_control.view',
  },
];

export function isAppModuleVisibleToPermissions(
  module: AppModule,
  permissions: readonly EffectivePermission[]
): boolean {
  const matchingPermissions = permissions.filter(
    (permission) => permission.permissionKey === module.visibilityPermissionKey
  );
  if (matchingPermissions.some((permission) => permission.effect === 'deny')) return false;
  return matchingPermissions.some((permission) => permission.effect === 'allow');
}