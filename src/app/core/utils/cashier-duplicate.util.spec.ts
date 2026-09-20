import { describe, it, expect } from 'vitest';
import {
  findDuplicatePieceComptable,
  findDuplicateTransaction,
  formatIsoToDisplayDate,
  generateTransactionFingerprint,
  normalizeDateForComparison,
  normalizeMontant,
  normalizePieceComptable,
  toStandardIsoDateString,
} from './cashier-duplicate.util';

describe('CashierDuplicateUtil', () => {
  describe('toStandardIsoDateString', () => {
    it('devrait convertir une date DD/MM/YYYY en ISO standard sans décalage', () => {
      const res = toStandardIsoDateString('16/09/2026');
      expect(res).toBe('2026-09-16T00:00:00.000Z');
    });
  });

  describe('generateTransactionFingerprint', () => {
    it('devrait produire une empreinte reproductible', () => {
      const fp = generateTransactionFingerprint({
        date: '16/09/2026',
        montant: -78000,
        libelle: 'Carburant',
        noDossier: 'D1',
        service: 'COMMERCIAL',
      });
      expect(fp).toBe('2026-09-16|-78000|carburant|d1|commercial');
    });
  });

  describe('formatIsoToDisplayDate', () => {
    it('devrait convertir une chaîne ISO UTC en JJ/MM/AAAA sans décalage horaire (Cas nominal)', () => {
      const result = formatIsoToDisplayDate('2026-09-16T00:00:00.000Z');
      expect(result).toBe('16/09/2026');
    });

    it('devrait préserver une date déjà au format JJ/MM/AAAA', () => {
      const result = formatIsoToDisplayDate('16/09/2026');
      expect(result).toBe('16/09/2026');
    });

    it('devrait gérer les valeurs nulles ou vides sans planter (Cas limite)', () => {
      expect(formatIsoToDisplayDate(null)).toBe('');
      expect(formatIsoToDisplayDate('')).toBe('');
      expect(formatIsoToDisplayDate(undefined)).toBe('');
    });
  });

  describe('normalizeDateForComparison', () => {
    it('devrait normaliser JJ/MM/AAAA en YYYY-MM-DD', () => {
      expect(normalizeDateForComparison('16/09/2026')).toBe('2026-09-16');
    });

    it('devrait extraire YYYY-MM-DD d’une chaîne ISO sans décalage UTC', () => {
      expect(normalizeDateForComparison('2026-09-16T00:00:00.000Z')).toBe('2026-09-16');
    });
  });

  describe('normalizeMontant', () => {
    it('devrait convertir un nombre ou une chaîne avec virgule en nombre normalisé', () => {
      expect(normalizeMontant('78 000,50')).toBe(78000.5);
      expect(normalizeMontant(-50000)).toBe(-50000);
    });

    it('devrait retourner 0 pour une valeur invalide (Cas d’erreur)', () => {
      expect(normalizeMontant('invalide')).toBe(0);
      expect(normalizeMontant(null)).toBe(0);
    });
  });

  describe('normalizePieceComptable', () => {
    it('devrait normaliser un numéro de pièce comptable en majuscules et sans espaces (Cas nominal)', () => {
      expect(normalizePieceComptable(' csh1 / 2026 / 00001 ')).toBe('CSH1/2026/00001');
      expect(normalizePieceComptable('CSH1/2026/00042')).toBe('CSH1/2026/00042');
    });

    it('devrait renvoyer une chaîne vide pour les valeurs nulles, indéfinies ou vides (Cas limite)', () => {
      expect(normalizePieceComptable(null)).toBe('');
      expect(normalizePieceComptable(undefined)).toBe('');
      expect(normalizePieceComptable('   ')).toBe('');
    });
  });

  describe('findDuplicatePieceComptable', () => {
    const existingList = [
      { id: 'tx-1', pieceComptable: 'CSH1/2026/00001' },
      { id: 'tx-2', pieceComptable: 'CSH1/2026/00002' },
    ];

    it('devrait détecter un doublon de pièce même avec casse et espaces différents (Cas nominal)', () => {
      const duplicate = findDuplicatePieceComptable(
        { pieceComptable: '  csh1 / 2026 / 00001 ' },
        existingList
      );
      expect(duplicate).toBeDefined();
      expect(duplicate?.id).toBe('tx-1');
    });

    it('devrait supporter les propriétés snake_case piece_comptable (Compatibilité base)', () => {
      const dbList = [{ id: 'tx-99', piece_comptable: 'CSH1/2026/00099' }];
      const duplicate = findDuplicatePieceComptable(
        { piece_comptable: 'CSH1/2026/00099' },
        dbList
      );
      expect(duplicate).toBeDefined();
      expect(duplicate?.id).toBe('tx-99');
    });

    it('ne devrait pas détecter de doublon si la pièce est différente (Cas nominal négatif)', () => {
      const duplicate = findDuplicatePieceComptable(
        { pieceComptable: 'CSH1/2026/00003' },
        existingList
      );
      expect(duplicate).toBeUndefined();
    });

    it('devrait ignorer la ligne courante lors de la modification avec le même ID (Cas limite mise à jour)', () => {
      const duplicate = findDuplicatePieceComptable(
        { id: 'tx-1', pieceComptable: 'CSH1/2026/00001' },
        existingList
      );
      expect(duplicate).toBeUndefined();
    });

    it('devrait retourner undefined si la pièce candidate est vide', () => {
      expect(findDuplicatePieceComptable({ pieceComptable: '' }, existingList)).toBeUndefined();
      expect(findDuplicatePieceComptable({ pieceComptable: null }, existingList)).toBeUndefined();
    });
  });

  describe('findDuplicateTransaction', () => {
    const existingList = [
      {
        id: 'tx-1',
        date: '16/09/2026',
        montant: -78000,
        category: 'sortie',
        libelle: 'Carburant Véhicule',
        noDossier: 'DOS-2026-001',
        service: 'COMMERCIAL',
        pieceComptable: 'CSH1/2026/00001',
      },
    ];

    it('devrait détecter un doublon immédiatement par numéro de pièce comptable même avec libellé distinct (Priorité pièce)', () => {
      const candidate = {
        date: '20/09/2026',
        montant: -10000,
        category: 'sortie',
        libelle: 'Fournitures de bureau',
        noDossier: 'DOS-AUTRE',
        service: 'ADMINISTRATION',
        pieceComptable: 'CSH1/2026/00001',
      };

      const duplicate = findDuplicateTransaction(candidate, existingList);
      expect(duplicate).toBeDefined();
      expect(duplicate?.id).toBe('tx-1');
    });

    it('devrait détecter un doublon identique même si le format de date ou de texte varie légèrement (Cas nominal)', () => {
      const candidate = {
        date: '2026-09-16T00:00:00.000Z',
        montant: 78000,
        category: 'sortie',
        libelle: '  carburant véhicule  ',
        noDossier: 'dos-2026-001',
        service: 'commercial',
      };

      const duplicate = findDuplicateTransaction(candidate, existingList);
      expect(duplicate).toBeDefined();
      expect(duplicate?.id).toBe('tx-1');
    });

    it('ne devrait pas considérer comme doublon une opération ayant un montant ou libellé distinct (Cas nominal négatif)', () => {
      const candidate = {
        date: '16/09/2026',
        montant: -50000,
        category: 'sortie',
        libelle: 'Carburant Véhicule',
        noDossier: 'DOS-2026-001',
        service: 'COMMERCIAL',
      };

      const duplicate = findDuplicateTransaction(candidate, existingList);
      expect(duplicate).toBeUndefined();
    });

    it('devrait ignorer la ligne courante lors de la modification de son propre ID', () => {
      const candidate = {
        id: 'tx-1',
        date: '16/09/2026',
        montant: -78000,
        category: 'sortie',
        libelle: 'Carburant Véhicule',
        noDossier: 'DOS-2026-001',
        service: 'COMMERCIAL',
        pieceComptable: 'CSH1/2026/00001',
      };

      const duplicate = findDuplicateTransaction(candidate, existingList);
      expect(duplicate).toBeUndefined();
    });

    it('devrait gérer une liste vide sans erreur (Cas limite)', () => {
      const duplicate = findDuplicateTransaction(
        { date: '16/09/2026', montant: 1000, libelle: 'Test' },
        []
      );
      expect(duplicate).toBeUndefined();
    });
  });
});
