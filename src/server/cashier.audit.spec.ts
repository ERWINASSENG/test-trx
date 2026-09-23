import { auditPiecesComptables, RawAuditRow } from './cashier.audit';

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
