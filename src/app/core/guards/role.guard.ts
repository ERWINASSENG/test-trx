import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { AccessControlService } from '../services/access-control.service';

/**
 * Guard de route piloté par une permission calculée côté serveur.
 * 1. Attend que la session soit initialisée (await authService.waitForSession()).
 * 2. Récupère la clé data.permission de la route.
 * 3. Charge les permissions effectives par l’API serveur.
 * 4. Redirige vers 403 en cas d'absence ou d'échec.
 */
export const roleGuard: CanActivateFn = async (route) => {
  const authService = inject(AuthService);
  const router = inject(Router);
  const permissionService = inject(AccessControlService);

  // Attendre que la session soit chargée depuis le localStorage / Supabase
  await authService.waitForSession();

  const requiredPermission = route.data?.['permission'];
  if (typeof requiredPermission !== 'string' || !requiredPermission) return true;

  await permissionService.loadMyPermissions();
  if (permissionService.hasPermission(requiredPermission)) return true;

  return router.createUrlTree(['/forbidden'], {
    queryParams: { permission: requiredPermission },
  });
};

