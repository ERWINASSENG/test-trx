import { generateSecurePassword, generateSecureUUID } from './crypto.utils';

describe('Crypto Utils', () => {
  it('devrait générer un mot de passe fort de 16 caractères par défaut', () => {
    const password = generateSecurePassword();
    expect(password.length).toBe(16);
    // Vérifier la présence d'au moins une majuscule, une minuscule, un chiffre et un caractère spécial
    expect(/[A-Z]/.test(password)).toBe(true);
    expect(/[a-z]/.test(password)).toBe(true);
    expect(/[0-9]/.test(password)).toBe(true);
    expect(/[!@#$%^&*()_+\-=[\]{}|;:,.<>?]/.test(password)).toBe(true);
  });

  it('devrait générer un mot de passe à la longueur spécifiée', () => {
    const password24 = generateSecurePassword(24);
    expect(password24.length).toBe(24);
  });

  it('devrait générer des mots de passe uniques et aléatoires', () => {
    const p1 = generateSecurePassword();
    const p2 = generateSecurePassword();
    expect(p1).not.toEqual(p2);
  });

  it('devrait générer un UUID v4 valide et non prédictible', () => {
    const uuid1 = generateSecureUUID();
    const uuid2 = generateSecureUUID();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(uuidRegex.test(uuid1)).toBe(true);
    expect(uuid1).not.toEqual(uuid2);
  });
});
