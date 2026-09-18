import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * Guard de Route Angular (roleGuard)
 * Niveau 2 du système RBAC : empêche tout accès direct via URL aux pages réservées.
 * 1. Attend que la session soit initialisée (await authService.waitForSession()).
 * 2. Récupère les rôles autorisés définis dans data.roles de la route.
 * 3. Vérifie le rôle de l'utilisateur actuel via le Signal réactif authService.currentUser().
 * 4. Valide l'accès si le rôle correspond, sinon redirige immédiatement vers /dashboard.
 */
export const roleGuard: CanActivateFn = async (route) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // Attendre que la session soit chargée depuis le localStorage / Supabase
  await authService.waitForSession();

  const allowedRoles = (route.data?.['roles'] as string[]) || [];

  // Si aucun rôle spécifique n'est exigé, accès validé
  if (allowedRoles.length === 0) {
    return true;
  }

  const currentUser = authService.currentUser();

  // Vérification stricte via le Signal réactif
  // L'admin a accès à tout.
  // Le trésorier dispose des mêmes autorisations que le manager.
  if (currentUser) {
    if (currentUser.role === 'admin') {
      return true;
    }
    if (allowedRoles.includes(currentUser.role)) {
      return true;
    }
    if (currentUser.role === 'tresorier' && allowedRoles.includes('manager')) {
      return true;
    }
  }

  // Redirection immédiate vers le tableau de bord de l'utilisateur
  return router.createUrlTree(['/dashboard'], {
    queryParams: { unauthorized: '1' },
  });
};

