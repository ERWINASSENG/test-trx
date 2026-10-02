import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { AccessControlService } from '../services/access-control.service';

/**
 * Guard de route piloté par une permission calculée côté serveur et rôles canoniques.
 * 1. Attend que la session soit initialisée (await authService.waitForSession()).
 * 2. Accorde immédiatement l'accès aux modules fondamentaux (apps.view, dashboard.view, profile.read) à tout utilisateur connecté.
 * 3. Charge et évalue les permissions effectives avec dérogation administrateur et repli par rôle métier.
 * 4. Redirige vers /forbidden en cas de refus avéré.
 */
export const roleGuard: CanActivateFn = async (route) => {
  const authService = inject(AuthService);
  const router = inject(Router);
  const permissionService = inject(AccessControlService);

  // Attendre que la session soit chargée
  await authService.waitForSession();

  const requiredPermission = route.data?.['permission'];
  if (typeof requiredPermission !== 'string' || !requiredPermission) {
    return true;
  }

  const currentUser = authService.currentUser();

  // 1. Accès universel garanti aux espaces partagés pour tout collaborateur connecté
  if (currentUser && ['apps.view', 'dashboard.view', 'profile.read'].includes(requiredPermission)) {
    return true;
  }

  // 2. Chargement et évaluation des permissions
  await permissionService.loadMyPermissions();
  if (permissionService.hasPermission(requiredPermission)) {
    return true;
  }

  return router.createUrlTree(['/forbidden'], {
    queryParams: { permission: requiredPermission },
  });
};
