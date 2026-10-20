import { UserRole } from '../models/auth.model';

/**
 * Normalise et assainit le rôle pour s'assurer qu'il s'agit d'un rôle valide de l'application.
 * Mappe les alias et rôles legacy (caissier, manager_stock, agent, rh, etc.) vers les rôles canoniques.
 * Préserve intégralement tous les rôles personnalisés (présents et futurs, ex. daf, logisticien, etc.)
 * en tant que rôles à part entière, sans rétrogradation forcée.
 * Applique le principe de moindre privilège : retombe sur 'employe' uniquement en cas de valeur vide, nulle ou invalide.
 */
export function normalizeUserRole(rawRole: unknown): UserRole {
  if (typeof rawRole === 'string') {
    const clean = rawRole.trim().toLowerCase();
    if (!clean) return 'employe';
    if (clean === 'admin') return 'admin';
    if (clean === 'manager' || clean === 'manager_stock') return 'manager';
    if (clean === 'comptable' || clean === 'compta' || clean === 'accountant') return 'comptable';
    if (clean === 'tresorier' || clean === 'trésorier' || clean === 'treasurer') return 'tresorier';
    if (clean === 'caissiere' || clean === 'caissier') return 'caissiere';
    if (clean === 'commercial' || clean === 'commerciale' || clean === 'sales') return 'commercial';
    if (clean === 'employe' || clean === 'employee' || clean === 'agent' || clean === 'rh') return 'employe';
    return clean as UserRole;
  }
  return 'employe';
}
