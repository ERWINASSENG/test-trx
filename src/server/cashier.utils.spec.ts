import { describe, it, expect } from 'vitest';
import {
  aggregateDossierExpenses,
  formatPersistedPieceComptable,
  isDuplicateCashierCandidate,
  normalizeDateToDay,
  requiresCashierDraftBeforeEdit,
} from './cashier.utils';

describe('cashier.utils', () => {
  describe('aggregateDossierExpenses', () => {
    it('agrège les dépenses comptabilisées par dossier sans inclure les autres états', () => {
      expect(aggregateDossierExpenses([
        { dossier_id: 'dossier-1', status: 'posted', category: 'sortie', montant: -125 },
        { dossier_id: 'dossier-1', status: 'posted', category: 'sortie', montant: 75 },
        { dossier_id: 'dossier-1', status: 'draft', category: 'sortie', montant: -900 },
        { dossier_id: 'dossier-1', status: 'posted', category: 'entree', montant: 500 },
        { dossier_id: null, status: 'posted', category: 'sortie', montant: -50 },
      ])).toEqual([{ dossierId: 'dossier-1', expenseCount: 2, totalExpenses: 200 }]);
    });

    it('ignore les montants vides ou nuls et retourne une liste vide sans dépense', () => {
      expect(aggregateDossierExpenses([
        { dossier_id: 'dossier-1', status: 'posted', category: 'sortie', montant: 0 },
        { dossier_id: 'dossier-2', status: 'posted', category: 'sortie', montant: 'invalide' },
      ])).toEqual([]);
      expect(aggregateDossierExpenses([])).toEqual([]);
    });
  });

  describe('formatPersistedPieceComptable', () => {
    it('normalise une pièce existante sans inventer de numéro', () => {
      expect(formatPersistedPieceComptable({ piece_comptable: ' csh1 / 2026 / 00042 ' })['piece_comptable'])
        .toBe('CSH1/2026/00042');
    });

    it('conserve une pièce absente comme null', () => {
      expect(formatPersistedPieceComptable({ piece_comptable: null })['piece_comptable']).toBeNull();
      expect(formatPersistedPieceComptable({})['piece_comptable']).toBeNull();
    });
  });

  describe('normalizeDateToDay', () => {
    it('convertit les formats JJ/MM/AAAA en AAAA-MM-JJ', () => {
      expect(normalizeDateToDay('15/09/2026')).toBe('2026-09-15');
    });

    it('conserve les formats ISO AAAA-MM-JJ', () => {
      expect(normalizeDateToDay('2026-09-15T10:00:00.000Z')).toBe('2026-09-15');
    });
  });

  describe('requiresCashierDraftBeforeEdit', () => {
    it('exige un retour en brouillon pour une caissière sur une opération comptabilisée', () => {
      expect(requiresCashierDraftBeforeEdit('posted', 'caissiere')).toBe(true);
    });

    it('n’empêche pas l’admin de modifier une opération comptabilisée', () => {
      expect(requiresCashierDraftBeforeEdit('posted', 'admin')).toBe(false);
    });

    it('permet à une caissière de modifier une opération en brouillon', () => {
      expect(requiresCashierDraftBeforeEdit('draft', 'caissiere')).toBe(false);
    });
  });

  describe('isDuplicateCashierCandidate', () => {
    const candidate = {
      date: '2026-09-15',
      montant: -25000,
      libelle: 'ras 1',
      service: 'COMMERCIAL',
      noDossier: 'DOS-2026-001',
    };

    it('ne doit pas considérer comme doublon une opération existante au statut cancelled', () => {
      const cancelledRow = {
        id: 'op-cancelled',
        date: '2026-09-15',
        montant: -25000,
        libelle: 'ras 1',
        service: 'COMMERCIAL',
        no_dossier: 'DOS-2026-001',
        status: 'cancelled',
      };

      expect(isDuplicateCashierCandidate(candidate, cancelledRow)).toBe(false);
    });

    it('doit bloquer comme doublon une opération existante au statut draft', () => {
      const draftRow = {
        id: 'op-draft',
        date: '2026-09-15',
        montant: -25000,
        libelle: 'ras 1',
        service: 'COMMERCIAL',
        no_dossier: 'DOS-2026-001',
        status: 'draft',
      };

      expect(isDuplicateCashierCandidate(candidate, draftRow)).toBe(true);
    });

    it('doit bloquer comme doublon une opération existante au statut posted', () => {
      const postedRow = {
        id: 'op-posted',
        date: '2026-09-15',
        montant: -25000,
        libelle: 'ras 1',
        service: 'COMMERCIAL',
        no_dossier: 'DOS-2026-001',
        status: 'posted',
      };

      expect(isDuplicateCashierCandidate(candidate, postedRow)).toBe(true);
    });

    it('ignore la comparaison avec le même id lors d’une mise à jour', () => {
      const selfRow = {
        id: 'op-self',
        date: '2026-09-15',
        montant: -25000,
        libelle: 'ras 1',
        service: 'COMMERCIAL',
        no_dossier: 'DOS-2026-001',
        status: 'draft',
      };

      expect(isDuplicateCashierCandidate({ ...candidate, idToExclude: 'op-self' }, selfRow)).toBe(false);
    });
  });
});
