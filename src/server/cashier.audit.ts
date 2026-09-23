import express from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from './auth';

export interface PieceComptableAnomaly {
  type: 'FORMAT_INVALIDE' | 'PIECE_MANQUANTE' | 'DOUBLON' | 'TROU_DE_SEQUENCE' | 'ANOMALIE_CHRONOLOGIQUE';
  description: string;
  pieceComptable?: string | null;
  transactionId?: string;
  date?: string;
  expectedSequence?: number;
  foundSequence?: number;
}

export interface PieceComptableAuditResult {
  year: number;
  totalTransactions: number;
  valid: boolean;
  minSequence: number | null;
  maxSequence: number | null;
  missingSequences: number[];
  duplicatePieces: string[];
  anomalies: PieceComptableAnomaly[];
  summary: {
    totalChecked: number;
    validCount: number;
    gapsCount: number;
    duplicatesCount: number;
    chronologicalErrorsCount: number;
    invalidFormatCount: number;
  };
}

export interface RawAuditRow {
  id: string;
  piece_comptable: string | null;
  date: string;
  created_at?: string;
}

/**
 * Fonction pure analysant une liste brute de transactions de caisse pour une année donnée
 * et retournant un rapport complet d'audit d'intégrité de la séquence des pièces comptables.
 */
export function auditPiecesComptables(rows: RawAuditRow[], targetYear: number): PieceComptableAuditResult {
  const anomalies: PieceComptableAnomaly[] = [];
  const validRegex = new RegExp(`^CSH1\\/${targetYear}\\/(\\d{5})$`, 'i');

  const validEntries: {
    seq: number;
    piece: string;
    id: string;
    date: string;
    created_at?: string;
  }[] = [];

  const pieceCountMap = new Map<string, string[]>();

  // 1. Analyse préliminaire des formats et doublons
  for (const row of rows) {
    const rawPiece = row.piece_comptable;
    const pieceClean = typeof rawPiece === 'string' ? rawPiece.trim().toUpperCase().replace(/\s+/g, '') : null;

    if (!pieceClean) {
      anomalies.push({
        type: 'PIECE_MANQUANTE',
        description: `L'opération ID "${row.id}" du ${row.date || 'date inconnue'} n'a aucun numéro de pièce comptable attribué.`,
        transactionId: row.id,
        date: row.date,
      });
      continue;
    }

    const match = pieceClean.match(validRegex);
    if (!match) {
      anomalies.push({
        type: 'FORMAT_INVALIDE',
        description: `Le numéro de pièce "${pieceClean}" (ID ${row.id}) ne respecte pas le format attendu CSH1/${targetYear}/XXXXX.`,
        pieceComptable: pieceClean,
        transactionId: row.id,
        date: row.date,
      });
      continue;
    }

    const seq = parseInt(match[1], 10);
    validEntries.push({
      seq,
      piece: pieceClean,
      id: row.id,
      date: row.date,
      created_at: row.created_at,
    });

    const existingList = pieceCountMap.get(pieceClean) || [];
    existingList.push(row.id);
    pieceCountMap.set(pieceClean, existingList);
  }

  // 2. Détection des doublons
  const duplicatePieces: string[] = [];
  for (const [piece, ids] of pieceCountMap.entries()) {
    if (ids.length > 1) {
      duplicatePieces.push(piece);
      anomalies.push({
        type: 'DOUBLON',
        description: `Le numéro de pièce "${piece}" est attribué ${ids.length} fois (IDs: ${ids.join(', ')}).`,
        pieceComptable: piece,
      });
    }
  }

  // 3. Détection des trous de numérotation (gaps)
  const missingSequences: number[] = [];
  let minSeq: number | null = null;
  let maxSeq: number | null = null;

  if (validEntries.length > 0) {
    const uniqueSeqs = Array.from(new Set(validEntries.map((e) => e.seq))).sort((a, b) => a - b);
    minSeq = uniqueSeqs[0];
    maxSeq = uniqueSeqs[uniqueSeqs.length - 1];

    // Vérifier les trous entre 1 (ou le minSeq si attendu à 1) et maxSeq
    const expectedStart = 1;
    for (let current = expectedStart; current <= maxSeq; current++) {
      if (!uniqueSeqs.includes(current)) {
        missingSequences.push(current);
        const formattedMissing = `CSH1/${targetYear}/${String(current).padStart(5, '0')}`;
        anomalies.push({
          type: 'TROU_DE_SEQUENCE',
          description: `Rupture de séquence détectée : la pièce "${formattedMissing}" (numéro ${current}) est manquante.`,
          pieceComptable: formattedMissing,
          expectedSequence: current,
        });
      }
    }
  }

  // 4. Détection des ruptures de cohérence chronologique (date)
  // Une pièce N+1 ne devrait généralement pas avoir une date comptable antérieure à la pièce N
  const sortedBySeq = [...validEntries].sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < sortedBySeq.length; i++) {
    const prev = sortedBySeq[i - 1];
    const curr = sortedBySeq[i];

    if (prev.seq < curr.seq && prev.date && curr.date) {
      const prevDate = new Date(prev.date).getTime();
      const currDate = new Date(curr.date).getTime();
      if (!isNaN(prevDate) && !isNaN(currDate) && currDate < prevDate) {
        anomalies.push({
          type: 'ANOMALIE_CHRONOLOGIQUE',
          description: `Incohérence chronologique : la pièce "${curr.piece}" (${curr.date}) a une date antérieure à la pièce précédente "${prev.piece}" (${prev.date}).`,
          pieceComptable: curr.piece,
          transactionId: curr.id,
          date: curr.date,
        });
      }
    }
  }

  const duplicatesCount = duplicatePieces.length;
  const gapsCount = missingSequences.length;
  const invalidFormatCount = anomalies.filter((a) => a.type === 'FORMAT_INVALIDE' || a.type === 'PIECE_MANQUANTE').length;
  const chronologicalErrorsCount = anomalies.filter((a) => a.type === 'ANOMALIE_CHRONOLOGIQUE').length;

  return {
    year: targetYear,
    totalTransactions: rows.length,
    valid: anomalies.length === 0,
    minSequence: minSeq,
    maxSequence: maxSeq,
    missingSequences,
    duplicatePieces,
    anomalies,
    summary: {
      totalChecked: rows.length,
      validCount: validEntries.length,
      gapsCount,
      duplicatesCount,
      chronologicalErrorsCount,
      invalidFormatCount,
    },
  };
}

/**
 * Handler Express effectuant l'audit complet des pièces comptables d'une année en interrogeant Supabase.
 */
export async function auditPiecesComptablesHandler(req: express.Request, res: express.Response): Promise<void> {
  const adminClient: SupabaseClient | null = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service Supabase non configuré sur le serveur' });
    return;
  }

  try {
    const rawYear = req.query['year'];
    let year = rawYear ? parseInt(String(rawYear), 10) : new Date().getFullYear();
    if (isNaN(year) || year < 2000 || year > 2100) {
      year = new Date().getFullYear();
    }

    // Récupère toutes les opérations de l'année concernée
    const prefix = `CSH1/${year}/`;
    const { data, error } = await adminClient
      .from('cashier_transactions')
      .select('id, piece_comptable, date, created_at')
      .or(`piece_comptable.ilike.${prefix}%,date.gte.${year}-01-01,date.lte.${year}-12-31`)
      .order('date', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Erreur SQL lors de la récupération des pièces pour audit:', error.message);
      res.status(500).json({ error: 'Erreur lors de la lecture des données pour audit.' });
      return;
    }

    const auditResult = auditPiecesComptables((data || []) as RawAuditRow[], year);
    res.json(auditResult);
  } catch (err: unknown) {
    console.error('Erreur auditPiecesComptablesHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de l\'audit des pièces comptables.' });
  }
}
