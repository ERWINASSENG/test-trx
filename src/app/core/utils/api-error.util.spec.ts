import { describe, expect, it } from 'vitest';
import { getApiErrorMessage } from './api-error.util';

describe('getApiErrorMessage', () => {
  it('retourne le message d’erreur fourni par l’API', () => {
    expect(getApiErrorMessage({ error: 'Opération déjà annulée.' }, 'Erreur inconnue.'))
      .toBe('Opération déjà annulée.');
  });

  it('utilise le champ message si le champ error est absent', () => {
    expect(getApiErrorMessage({ message: 'Accès refusé.' }, 'Erreur inconnue.'))
      .toBe('Accès refusé.');
  });

  it('retourne le message de repli pour une réponse vide ou invalide', () => {
    expect(getApiErrorMessage({ error: '  ' }, 'Impossible de terminer l’action.'))
      .toBe('Impossible de terminer l’action.');
    expect(getApiErrorMessage(null, 'Réponse invalide.')).toBe('Réponse invalide.');
  });
});
