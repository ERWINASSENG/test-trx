import { describe, it, expect, vi } from 'vitest';
import {
  formatPersistedPieceComptable,
  computeNextPieceComptable,
  normalizeDateToDay,
} from './cashier.utils';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('cashier.utils', () => {
  describe('formatPersistedPieceComptable', () => {
    it('normalise et conserve une piece_comptable existante', () => {
      const row = { id: 'tx-1', piece_comptable: ' csh1 / 2026 / 00042 ' };
      const res = formatPersistedPieceComptable(row);
      expect(res['piece_comptable']).toBe('CSH1/2026/00042');
    });

    it('ne force plus de faux 00001 si piece_comptable est null ou manquant', () => {
      const rowWithNull = { id: 'tx-2', piece_comptable: null, date: '2026-03-15' };
      const resNull = formatPersistedPieceComptable(rowWithNull);
      expect(resNull['piece_comptable']).toBeNull();

      const rowEmpty = { id: 'tx-3', piece_comptable: '   ' };
      const resEmpty = formatPersistedPieceComptable(rowEmpty);
      expect(resEmpty['piece_comptable']).toBeNull();

      const rowMissing = { id: 'tx-4' };
      const resMissing = formatPersistedPieceComptable(rowMissing);
      expect(resMissing['piece_comptable']).toBeNull();
    });
  });

  describe('computeNextPieceComptable', () => {
    it('calcule CSH1/{year}/00001 si aucune transaction n existe pour l annee', async () => {
      const mockClient = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            ilike: vi.fn().mockResolvedValue({
              data: [],
              error: null,
            }),
          }),
        }),
      } as unknown as SupabaseClient;

      const nextPiece = await computeNextPieceComptable(mockClient, '2026-05-10');
      expect(nextPiece).toBe('CSH1/2026/00001');
    });

    it('incremente le numero maximal existant de maniere deterministe', async () => {
      const mockClient = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            ilike: vi.fn().mockResolvedValue({
              data: [
                { piece_comptable: 'CSH1/2026/00001' },
                { piece_comptable: 'CSH1/2026/00015' },
                { piece_comptable: 'CSH1/2026/00007' },
              ],
              error: null,
            }),
          }),
        }),
      } as unknown as SupabaseClient;

      const nextPiece = await computeNextPieceComptable(mockClient, '10/05/2026');
      expect(nextPiece).toBe('CSH1/2026/00016');
    });

    it('gere correctement l offset pour les duplications en masse', async () => {
      const mockClient = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            ilike: vi.fn().mockResolvedValue({
              data: [{ piece_comptable: 'CSH1/2026/00003' }],
              error: null,
            }),
          }),
        }),
      } as unknown as SupabaseClient;

      const piece0 = await computeNextPieceComptable(mockClient, '2026-01-01', 0);
      const piece1 = await computeNextPieceComptable(mockClient, '2026-01-01', 1);
      const piece2 = await computeNextPieceComptable(mockClient, '2026-01-01', 2);

      expect(piece0).toBe('CSH1/2026/00004');
      expect(piece1).toBe('CSH1/2026/00005');
      expect(piece2).toBe('CSH1/2026/00006');
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
});
