import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { roleGuard } from './core/guards/role.guard';
import { MainLayout } from './layout/main-layout/main-layout';

export const routes: Routes = [
  // Redirection racine vers le lanceur d'applications
  {
    path: '',
    redirectTo: 'apps',
    pathMatch: 'full',
  },
  // Route d'authentification publique
  {
    path: 'auth/login',
    loadComponent: () =>
      import('./features/auth/login/login').then((m) => m.Login),
    title: 'Transmex - Connexion Sécurisée',
  },
  // Alias /login vers /auth/login
  {
    path: 'login',
    redirectTo: 'auth/login',
    pathMatch: 'full',
  },
  // Page 403 Forbidden
  {
    path: 'forbidden',
    loadComponent: () =>
      import('./features/forbidden/forbidden').then((m) => m.Forbidden),
    title: 'Transmex - Accès Refusé',
  },
  // Routes protégées sous le Layout Principal Transmex
  {
    path: '',
    component: MainLayout,
    canActivate: [authGuard],
    children: [
      {
        path: 'apps',
        loadComponent: () =>
          import('./features/app-launcher/app-launcher').then((m) => m.AppLauncher),
        canActivate: [roleGuard],
        data: { permission: 'apps.view' },
        title: 'Transmex - Applications',
      },
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./features/dashboard/dashboard').then((m) => m.Dashboard),
        canActivate: [roleGuard],
        data: { permission: 'dashboard.view' },
        title: 'Transmex - Tableau de Bord',
      },
      {
        path: 'prospects',
        loadComponent: () =>
          import('./features/prospects/prospects').then((m) => m.ProspectsComponent),
        canActivate: [roleGuard],
        data: { permission: 'prospects.read' },
        title: 'Transmex - Prospects',
      },
      {
        path: 'dossiers',
        loadComponent: () =>
          import('./features/dossiers/dossier-management').then((m) => m.DossierManagementComponent),
        canActivate: [roleGuard],
        data: { permission: 'cashier.read' },
        title: 'Transmex - Dossiers',
      },
      {
        path: 'admin/users',
        loadComponent: () =>
          import('./features/admin/access-control/access-control').then(
            (m) => m.AccessControlCenter
          ),
        canActivate: [roleGuard],
        data: { permission: 'access.users.read' },
        title: 'Transmex - Gestion des accès',
      },
      {
        path: 'admin/view',
        loadComponent: () =>
          import('./features/admin/access-control/access-control').then(
            (m) => m.AccessControlCenter
          ),
        canActivate: [roleGuard],
        data: { permission: 'access.roles.read' },
        title: 'Transmex - Gestion des accès',
      },
      {
        path: 'admin/access-control',
        loadComponent: () =>
          import('./features/admin/access-control/access-control').then(
            (m) => m.AccessControlCenter
          ),
        canActivate: [roleGuard],
        data: { permission: 'access.roles.read' },
        title: 'Transmex - Gestion des accès',
      },
      {
        path: 'admin',
        redirectTo: 'admin/view',
        pathMatch: 'full',
      },
      {
        path: 'administration',
        redirectTo: 'admin/view',
        pathMatch: 'full',
      },
      {
        path: 'hr',
        loadComponent: () =>
          import('./features/hr/hr-management').then((m) => m.HrManagement),
        canActivate: [roleGuard],
        data: { permission: 'hr.read' },
        title: 'Transmex - Ressources Humaines',
      },
      {
        path: 'personnel',
        redirectTo: 'hr',
        pathMatch: 'full',
      },
      {
        path: 'caisse',
        loadComponent: () =>
          import('./features/cashier/cashier-management').then(
            (m) => m.CashierManagement
          ),
        canActivate: [roleGuard],
        data: { permission: 'cashier.read' },
        title: 'Transmex - Caisse',
      },
      {
        path: 'configuration',
        redirectTo: 'configuration/parametres',
        pathMatch: 'full',
      },
      {
        path: 'configuration/parametres',
        loadComponent: () =>
          import('./features/configuration/parametres/configuration-parametres').then(
            (m) => m.ConfigurationParametresComponent
          ),
        canActivate: [roleGuard],
        data: { permission: 'configuration.read' },
        title: 'Transmex - Paramètres',
      },
      {
        path: 'configuration/journal',
        loadComponent: () =>
          import('./features/configuration/journal/configuration-journal').then(
            (m) => m.ConfigurationJournalComponent
          ),
        canActivate: [roleGuard],
        data: { permission: 'journals.read' },
        title: 'Transmex - Journaux',
      },
      {
        path: 'settings',
        redirectTo: 'configuration/parametres',
        pathMatch: 'full',
      },
      {
        path: 'profile',
        loadComponent: () =>
          import('./features/profile/profile').then((m) => m.Profile),
        canActivate: [roleGuard],
        data: { permission: 'profile.read' },
        title: 'Transmex - Mon Profil & Sécurité',
      },
    ],
  },
  // Wildcard
  {
    path: '**',
    redirectTo: 'dashboard',
  },
];
