import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { auditPiecesComptables, auditPiecesComptablesHandler, RawAuditRow } from './cashier.audit';
import { writeAuditLog } from './audit-log';

describe('cashier.audit - auditPiecesComptables', () => {
  const currentYear = 2026;

  it('devrait valider une séquence nominale parfaite sans trou ni doublon', () => {
    const nominalRows: RawAuditRow[] = [
      { id: '1', piece_comptable: 'CSH1/2026/00001', date: '2026-09-01T08:00:00Z' },
      { id: '2', piece_comptable: 'CSH1/2026/00002', date: '2026-09-01T09:30:00Z' },
      { id: '3', piece_comptable: 'CSH1/2026/00003', date: '2026-09-02T11:00:00Z' },
      { id: '4', piece_comptable: 'CSH1/2026/00004', date: '2026-09-03T14:00:00Z' },
    ];

    const result = auditPiecesComptables(nominalRows, currentYear);

    expect(result.valid).toBe(true);
    expect(result.anomalies.length).toBe(0);
    expect(result.minSequence).toBe(1);
    expect(result.maxSequence).toBe(4);
    expect(result.missingSequences.length).toBe(0);
    expect(result.duplicatePieces.length).toBe(0);
    expect(result.summary.validCount).toBe(4);
  });

  it('devrait détecter des trous de séquence (gaps)', () => {
    const rowsWithGaps: RawAuditRow[] = [
      { id: '1', piece_comptable: 'CSH1/2026/00001', date: '2026-09-01' },
      { id: '2', piece_comptable: 'CSH1/2026/00002', date: '2026-09-01' },
      // Manque 00003 et 00004
      { id: '5', piece_comptable: 'CSH1/2026/00005', date: '2026-09-02' },
      // Manque 00006
      { id: '7', piece_comptable: 'CSH1/2026/00007', date: '2026-09-03' },
    ];

    const result = auditPiecesComptables(rowsWithGaps, currentYear);

    expect(result.valid).toBe(false);
    expect(result.missingSequences).toEqual([3, 4, 6]);
    expect(result.summary.gapsCount).toBe(3);

    const gapAnomalies = result.anomalies.filter((a) => a.type === 'TROU_DE_SEQUENCE');
    expect(gapAnomalies.length).toBe(3);
    expect(gapAnomalies[0].expectedSequence).toBe(3);
    expect(gapAnomalies[0].pieceComptable).toBe('CSH1/2026/00003');
  });

  it('devrait détecter si la numérotation ne commence pas à 1', () => {
    const rowsStartingAtTen: RawAuditRow[] = [
      { id: '10', piece_comptable: 'CSH1/2026/00010', date: '2026-09-01' },
      { id: '11', piece_comptable: 'CSH1/2026/00011', date: '2026-09-02' },
    ];

    const result = auditPiecesComptables(rowsStartingAtTen, currentYear);

    expect(result.valid).toBe(false);
    expect(result.missingSequences.length).toBe(9); // 1 à 9 manquants
    expect(result.missingSequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('devrait identifier les doublons de numéros de pièces', () => {
    const rowsWithDuplicates: RawAuditRow[] = [
      { id: '1', piece_comptable: 'CSH1/2026/00001', date: '2026-09-01' },
      { id: '2', piece_comptable: 'CSH1/2026/00002', date: '2026-09-02' },
      { id: '2-bis', piece_comptable: 'CSH1/2026/00002', date: '2026-09-02' }, // Doublon
      { id: '3', piece_comptable: 'CSH1/2026/00003', date: '2026-09-03' },
    ];

    const result = auditPiecesComptables(rowsWithDuplicates, currentYear);

    expect(result.valid).toBe(false);
    expect(result.duplicatePieces).toContain('CSH1/2026/00002');
    expect(result.summary.duplicatesCount).toBe(1);

    const dupAnomaly = result.anomalies.find((a) => a.type === 'DOUBLON');
    expect(dupAnomaly).toBeTruthy();
    expect(dupAnomaly?.description).toContain('2 fois');
  });

  it('devrait identifier les pièces manquantes (null ou vides) et les formats invalides', () => {
    const invalidRows: RawAuditRow[] = [
      { id: '1', piece_comptable: null, date: '2026-09-01' },
      { id: '2', piece_comptable: '   ', date: '2026-09-01' },
      { id: '3', piece_comptable: 'FACTURE-99', date: '2026-09-02' },
      { id: '4', piece_comptable: 'CSH1/2025/00001', date: '2026-09-02' }, // Mauvaise année
      { id: '5', piece_comptable: 'CSH1/2026/00001', date: '2026-09-03' }, // Valide
    ];

    const result = auditPiecesComptables(invalidRows, currentYear);

    expect(result.valid).toBe(false);
    expect(result.summary.invalidFormatCount).toBe(4);

    const missingAnomalies = result.anomalies.filter((a) => a.type === 'PIECE_MANQUANTE');
    expect(missingAnomalies.length).toBe(2);

    const formatAnomalies = result.anomalies.filter((a) => a.type === 'FORMAT_INVALIDE');
    expect(formatAnomalies.length).toBe(2);
  });

  it('devrait détecter les anomalies chronologiques (pièce N+1 datée avant pièce N)', () => {
    const chronoRows: RawAuditRow[] = [
      { id: '1', piece_comptable: 'CSH1/2026/00001', date: '2026-09-10' },
      // La pièce 00002 a une date antérieure au 10 septembre
      { id: '2', piece_comptable: 'CSH1/2026/00002', date: '2026-09-05' },
    ];

    const result = auditPiecesComptables(chronoRows, currentYear);

    expect(result.valid).toBe(false);
    expect(result.summary.chronologicalErrorsCount).toBe(1);

    const chronoAnomaly = result.anomalies.find((a) => a.type === 'ANOMALIE_CHRONOLOGIQUE');
    expect(chronoAnomaly).toBeTruthy();
    expect(chronoAnomaly?.pieceComptable).toBe('CSH1/2026/00002');
  });

  it('devrait retourner un rapport vide valide lorsqu’il n’y a aucune transaction', () => {
    const result = auditPiecesComptables([], currentYear);

    expect(result.valid).toBe(true);
    expect(result.totalTransactions).toBe(0);
    expect(result.minSequence).toBeNull();
    expect(result.maxSequence).toBeNull();
    expect(result.missingSequences.length).toBe(0);
    expect(result.anomalies.length).toBe(0);
  });
});

describe('cashier.audit - auditPiecesComptablesHandler & Traçabilité Audit', () => {
  it('retourne HTTP 503 si le client Supabase admin est indisponible', async () => {
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');

    const req = { query: { year: '2026' } } as unknown as Request;
    let statusCode = 0;
    let jsonBody: unknown = null;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: unknown) => {
        jsonBody = body;
        return res;
      },
    } as unknown as Response;

    try {
      await auditPiecesComptablesHandler(req, res);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(statusCode).toBe(503);
    expect(jsonBody).toEqual({ error: 'Service Supabase non configuré sur le serveur' });
  });

  it('journalise correctement un événement POST_OPERATION via writeAuditLog', async () => {
    const mockInsert = vi.fn().mockResolvedValue({ error: null });
    const mockClient = {
      from: vi.fn().mockReturnValue({ insert: mockInsert }),
    } as unknown as SupabaseClient;

    await writeAuditLog(mockClient, {
      userId: 'test-user-uuid',
      userEmail: 'caissiere@transimex.cm',
      userRole: 'caissiere',
      action: 'POST_OPERATION',
      entityId: 'operation-123',
      details: {
        piece_comptable: 'CSH1/2026/00005',
        status: 'posted',
        previous_status: 'draft',
        montant: 45000,
        category: 'entree',
      },
      ipAddress: '127.0.0.1',
    });

    expect(mockClient.from).toHaveBeenCalledWith('audit_logs');
    expect(mockInsert).toHaveBeenCalledWith([
      {
        user_id: 'test-user-uuid',
        user_email: 'caissiere@transimex.cm',
        user_role: 'caissiere',
        action: 'POST_OPERATION',
        entity_type: 'cashier_transaction',
        entity_id: 'operation-123',
        details: {
          piece_comptable: 'CSH1/2026/00005',
          status: 'posted',
          previous_status: 'draft',
          montant: 45000,
          category: 'entree',
        },
        ip_address: '127.0.0.1',
      },
    ]);
  });

  it('génère et vérifie la séquence continue CSH1/AAAA/NNNNN lors de l’attribution', () => {
    const year = 2026;
    const existingPieces = [
      { piece_comptable: 'CSH1/2026/00001' },
      { piece_comptable: 'CSH1/2026/00002' },
      { piece_comptable: 'CSH1/2026/00003' },
    ];

    let maxNum = 0;
    for (const item of existingPieces) {
      const match = String(item.piece_comptable || '').match(/^CSH1\/\d{4}\/(\d{5})$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }

    const nextPiece = `CSH1/${year}/${String(maxNum + 1).padStart(5, '0')}`;
    expect(nextPiece).toBe('CSH1/2026/00004');

    const verified = auditPiecesComptables([
      ...existingPieces.map((p, idx) => ({ id: String(idx + 1), piece_comptable: p.piece_comptable, date: '2026-09-01' })),
      { id: '4', piece_comptable: nextPiece, date: '2026-09-01' },
    ], year);

    expect(verified.valid).toBe(true);
    expect(verified.missingSequences.length).toBe(0);
    expect(verified.maxSequence).toBe(4);
  });
});
