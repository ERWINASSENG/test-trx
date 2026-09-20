import { UserRole } from '../models/auth.model';

/**
 * Normalise et assainit le rôle pour s'assurer qu'il s'agit strictement d'un rôle valide de l'application.
 * Mappe les rôles legacy (caissier, manager_stock, agent, rh) vers les nouveaux rôles canoniques.
 * Applique le principe de moindre privilège : tout rôle non reconnu ou vide retombe sur 'employe'.
 */
export function normalizeUserRole(rawRole: unknown): UserRole {
  if (typeof rawRole === 'string') {
    const clean = rawRole.trim().toLowerCase();
    if (clean === 'admin') return 'admin';
    if (clean === 'manager' || clean === 'manager_stock') return 'manager';
    if (clean === 'comptable' || clean === 'compta' || clean === 'accountant') return 'comptable';
    if (clean === 'tresorier' || clean === 'trésorier' || clean === 'treasurer') return 'tresorier';
    if (clean === 'caissiere' || clean === 'caissier') return 'caissiere';
    if (clean === 'employe' || clean === 'employee' || clean === 'agent' || clean === 'rh') return 'employe';
  }
  return 'employe';
}
