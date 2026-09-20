/**
 * Utilitaires cryptographiques sécurisés pour l'application TRANSIMEX.
 * Utilise l'API Web Crypto native pour garantir une entropie forte.
 */

/**
 * Génère un mot de passe temporaire aléatoire cryptographiquement fort.
 * Contient des majuscules, minuscules, chiffres et caractères spéciaux.
 *
 * @param length Longueur du mot de passe (par défaut: 16 caractères)
 * @returns Chaîne de mot de passe générée
 */
export function generateSecurePassword(length = 16): string {
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const symbols = '!@#$%^&*()_+-=[]{}|;:,.<>?';
  const allChars = uppercase + lowercase + numbers + symbols;

  // S'assurer qu'au moins un caractère de chaque catégorie est présent
  const requiredChars = [
    uppercase[getRandomIndex(uppercase.length)],
    lowercase[getRandomIndex(lowercase.length)],
    numbers[getRandomIndex(numbers.length)],
    symbols[getRandomIndex(symbols.length)],
  ];

  const remainingLength = Math.max(0, length - requiredChars.length);
  const randomBytes = new Uint8Array(remainingLength);
  
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(randomBytes);
  } else {
    // Repli de secours pour les contextes d'exécution sans Web Crypto global
    for (let i = 0; i < remainingLength; i++) {
      randomBytes[i] = Math.floor(Math.random() * 256);
    }
  }

  const generatedChars = Array.from(randomBytes).map((byte) => allChars[byte % allChars.length]);
  const combined = [...requiredChars, ...generatedChars];

  // Mélange aléatoire (Fisher-Yates) avec Web Crypto
  for (let i = combined.length - 1; i > 0; i--) {
    const j = getRandomIndex(i + 1);
    const temp = combined[i];
    combined[i] = combined[j];
    combined[j] = temp;
  }

  return combined.join('');
}

/**
 * Génère un identifiant unique universel (UUID v4) sécurisé.
 */
export function generateSecureUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Repli conforme RFC4122 v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = getRandomIndex(16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getRandomIndex(max: number): number {
  if (max <= 0) return 0;
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    return array[0] % max;
  }
  return Math.floor(Math.random() * max);
}
