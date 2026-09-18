import { describe, it, expect, beforeEach } from 'vitest';
import { ImportService } from './import.service';

describe('ImportService', () => {
  let service: ImportService;

  beforeEach(() => {
    service = new ImportService();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('validateAndTransformRow', () => {
    it('should validate a nominal row with separate Sortie column', () => {
      const row = {
        'Date': '15/09/2026',
        'Libellé': 'Achat fournitures de bureau',
        'Entrée': '',
        'Sortie': '15000',
        'Service': 'TRANSIT',
        'Partenaire': 'Fournisseur Papeterie',
        'N° Dossier': 'DOS-100',
        'Quantité': '2',
      };

      const result = service.validateAndTransformRow(row, 2);

      expect(result.error).toBeUndefined();
      expect(result.data).toBeDefined();
      expect(result.data?.libelle).toBe('Achat fournitures de bureau');
      expect(result.data?.montant).toBe(-15000);
      expect(result.data?.category).toBe('sortie');
      expect(result.data?.service).toBe('TRANSIT');
      expect(result.data?.quantity).toBe(2);
      expect(result.data?.date).toBe('15/09/2026');
    });

    it('should validate a nominal row with separate Entrée column and native Date object', () => {
      // Simulation d'une cellule Excel parsée en Date UTC à minuit
      const nativeUtcDate = new Date(Date.UTC(2026, 8, 15, 0, 0, 0));
      const row = {
        'Date': nativeUtcDate,
        'Libellé': 'Approvisionnement caisse principale',
        'Entrée (FCFA)': '500 000',
        'Sortie (FCFA)': '',
        'Service': 'DG',
        'Partenaire': 'Directeur Financier',
      };

      const result = service.validateAndTransformRow(row, 3);

      expect(result.error).toBeUndefined();
      expect(result.data).toBeDefined();
      expect(result.data?.category).toBe('entree');
      expect(result.data?.montant).toBe(500000);
      expect(result.data?.service).toBe('DG');
      expect(result.data?.date).toBe('15/09/2026');
    });

    it('should validate an imported row with Excel serial date number (e.g. 45549)', () => {
      const row = {
        'Date': 45549, // 14 septembre 2024
        'Libellé': 'Achat cartouches imprimante',
        'Sortie': '45000',
        'Service': 'TRANSIT',
      };

      const result = service.validateAndTransformRow(row, 4);

      expect(result.error).toBeUndefined();
      expect(result.data).toBeDefined();
      expect(result.data?.date).toBe('14/09/2024');
    });

    it('should reject row when both Entrée and Sortie are filled simultaneously', () => {
      const row = {
        'Date': '15/09/2026',
        'Libellé': 'Erreur double saisie',
        'Entrée': '20000',
        'Sortie': '10000',
      };

      const result = service.validateAndTransformRow(row, 5);

      expect(result.data).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Une même opération ne peut pas être à la fois une Entrée et une Sortie');
    });

    it('should reject row when neither Entrée nor Sortie is filled', () => {
      const row = {
        'Date': '15/09/2026',
        'Libellé': 'Montants vides',
        'Entrée': '',
        'Sortie': '0',
      };

      const result = service.validateAndTransformRow(row, 6);

      expect(result.data).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Veuillez saisir un montant valide');
    });

    it('should return error when libelle is missing', () => {
      const row = {
        'Date': '15/09/2026',
        'Libellé': '',
        'Sortie': '5000',
      };

      const result = service.validateAndTransformRow(row, 7);
      expect(result.data).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error?.column).toBe('Libellé');
    });

    it('should preserve backward compatibility with legacy Sens and Montant columns', () => {
      const legacyRow = {
        'Date': '15/09/2026',
        'Libellé': 'Ancien fichier format classique',
        'Sens': 'Entrée',
        'Montant': '75000',
      };

      const result = service.validateAndTransformRow(legacyRow, 8);
      expect(result.error).toBeUndefined();
      expect(result.data?.category).toBe('entree');
      expect(result.data?.montant).toBe(75000);
    });
  });

  describe('normalizeDate', () => {
    it('should format ISO YYYY-MM-DD into DD/MM/YYYY', () => {
      expect(service.normalizeDate('2026-09-15')).toBe('15/09/2026');
    });

    it('should keep valid DD/MM/YYYY dates intact', () => {
      expect(service.normalizeDate('15/09/2026')).toBe('15/09/2026');
    });

    it('should handle dates with dash separator DD-MM-YYYY', () => {
      expect(service.normalizeDate('15-09-2026')).toBe('15/09/2026');
    });

    it('should convert two-digit years DD/MM/YY into DD/MM/20YY', () => {
      expect(service.normalizeDate('15/09/26')).toBe('15/09/2026');
      expect(service.normalizeDate('02-03-25')).toBe('02/03/2025');
    });

    it('should convert French text month names (e.g. 15 sept. 2026)', () => {
      expect(service.normalizeDate('15 sept. 2026')).toBe('15/09/2026');
      expect(service.normalizeDate('02 janvier 2026')).toBe('02/01/2026');
      expect(service.normalizeDate('10 décembre 2025')).toBe('10/12/2025');
    });

    it('should convert Excel numerical serial dates without day shift', () => {
      // 45549 correspond au 14/09/2024
      expect(service.normalizeDate(45549)).toBe('14/09/2024');
      // En chaîne de caractères aussi
      expect(service.normalizeDate('45549')).toBe('14/09/2024');
    });

    it('should handle Date instances without shifting one day before UTC', () => {
      const utcMidnight = new Date(Date.UTC(2026, 8, 15, 0, 0, 0));
      expect(service.normalizeDate(utcMidnight)).toBe('15/09/2026');
    });

    it('should return current date when rawDate is empty or null', () => {
      const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
      const now = new Date();
      const expected = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;

      expect(service.normalizeDate('')).toBe(expected);
      expect(service.normalizeDate(null)).toBe(expected);
      expect(service.normalizeDate(undefined)).toBe(expected);
    });
  });

  describe('normalizeDateToIso', () => {
    it('devrait convertir une date JJ/MM/AAAA en format ISO AAAA-MM-JJ (Cas nominal)', () => {
      expect(service.normalizeDateToIso('15/09/2026')).toBe('2026-09-15');
      expect(service.normalizeDateToIso('01/01/2026')).toBe('2026-01-01');
    });

    it('devrait convertir une date textuelle française ou objet Date en ISO (Cas étendu)', () => {
      expect(service.normalizeDateToIso('15 sept. 2026')).toBe('2026-09-15');
      const utcMidnight = new Date(Date.UTC(2026, 8, 15, 0, 0, 0));
      expect(service.normalizeDateToIso(utcMidnight)).toBe('2026-09-15');
    });

    it('devrait gérer les valeurs vides sans planter (Cas limite)', () => {
      const result = service.normalizeDateToIso('');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
