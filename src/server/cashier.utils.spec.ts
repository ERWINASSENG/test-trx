import { describe, it, expect } from 'vitest';
import {
  formatPersistedPieceComptable,
  normalizeDateToDay,
  requiresCashierDraftBeforeEdit,
} from './cashier.utils';

describe('cashier.utils', () => {
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
});
