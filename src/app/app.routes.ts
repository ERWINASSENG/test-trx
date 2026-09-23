import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { roleGuard } from './core/guards/role.guard';
import { MainLayout } from './layout/main-layout/main-layout';

export const routes: Routes = [
  // Redirection racine vers le tableau de bord
  {
    path: '',
    redirectTo: 'dashboard',
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
        path: 'dashboard',
        loadComponent: () =>
          import('./features/dashboard/dashboard').then((m) => m.Dashboard),
        title: 'Transmex - Tableau de Bord',
      },
      {
        path: 'admin/users',
        loadComponent: () =>
          import('./features/admin/users/users-management').then(
            (m) => m.UsersManagement
          ),
        canActivate: [roleGuard],
        data: { roles: ['admin'] },
        title: 'Transmex - Administration & Rôles',
      },
      {
        path: 'admin/view',
        loadComponent: () =>
          import('./features/admin/users/users-management').then(
            (m) => m.UsersManagement
          ),
        canActivate: [roleGuard],
        data: { roles: ['admin'] },
        title: 'Transmex - Administration',
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
        data: { roles: ['admin'] },
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
        data: { roles: ['admin', 'manager', 'caissiere', 'comptable'] },
        title: 'Transmex - Caisse',
      },
      {
        path: 'profile',
        loadComponent: () =>
          import('./features/profile/profile').then((m) => m.Profile),
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
