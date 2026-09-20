import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * Guard fonctionnel Angular 19 vérifiant l'état de la session.
 * Attend la restauration initiale de la session (waitForSession) avant d'autoriser l'accès.
 */
export const authGuard: CanActivateFn = async (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // Attente impérative de la résolution initiale de la session
  if (typeof authService.waitForSession === 'function') {
    await authService.waitForSession();
  } else if (typeof authService.ensureSessionRestored === 'function') {
    await authService.ensureSessionRestored();
  }

  const user = authService.currentUser();

  // Si l'utilisateur est authentifié et actif -> Accès autorisé
  if (authService.isAuthenticated() && user && user.isActive) {
    return true;
  }

  // Si le compte utilisateur est explicitement désactivé
  if (authService.isAuthenticated() && user && !user.isActive) {
    await authService.logout();
    return router.createUrlTree(['/auth/login'], {
      queryParams: { error: 'account_disabled' },
    });
  }

  // Redirection vers l'écran de connexion avec conservation de la route d'origine
  return router.createUrlTree(['/auth/login'], {
    queryParams: { returnUrl: state.url },
  });
};
