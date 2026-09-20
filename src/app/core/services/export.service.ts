import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { CashierTransaction } from '../models/cashier-transaction.model';

export interface CsvExportOptions {
  filename?: string;
  isComptable?: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class ExportService {
  private readonly authService = inject(AuthService);

  /**
   * Génère et télécharge le fichier CSV des écritures de caisse
   * - Encodage BOM UTF-8 (\uFEFF) pour compatibilité native Excel
   * - Séparateur point-virgule (;)
   * - Échappement des guillemets et caractères spéciaux
   * - Masquage automatique du solde pour le rôle 'comptable'
   */
  public exportCashierTransactionsCsv(
    transactions: CashierTransaction[],
    options?: CsvExportOptions
  ): boolean {
    if (!transactions || transactions.length === 0) {
      return false;
    }

    const isComptable =
      options?.isComptable ?? (this.authService.currentUser()?.role === 'comptable');

    // 1. Définition des en-têtes selon le rôle
    const headers = isComptable
      ? [
          'Date',
          'Pièce comptable',
          'Libellé',
          'Partenaire / Employé',
          'N° Dossier',
          'Service',
          'Quantité',
          'Montant (FCFA)',
          'Statut',
        ]
      : [
          'Date',
          'Pièce comptable',
          'Libellé',
          'Partenaire / Employé',
          'N° Dossier',
          'Service',
          'Quantité',
          'Montant (FCFA)',
          'Solde courant (FCFA)',
          'Statut',
        ];

    const csvRows: string[] = [headers.join(';')];

    // 2. Transformation des lignes de données
    for (const tx of transactions) {
      const statusLabel =
        tx.status === 'posted'
          ? 'Comptabilisé'
          : tx.status === 'cancelled'
          ? 'Annulé'
          : 'Brouillon';

      const row = isComptable
        ? [
            this.escapeCsv(tx.date || ''),
            this.escapeCsv(tx.pieceComptable || ''),
            this.escapeCsv(tx.libelle || ''),
            this.escapeCsv(tx.employee || tx.partenaire || ''),
            this.escapeCsv(tx.noDossier || ''),
            this.escapeCsv(tx.service || ''),
            tx.quantity !== undefined && tx.quantity !== null ? String(tx.quantity) : '',
            String(tx.montant ?? 0),
            this.escapeCsv(statusLabel),
          ]
        : [
            this.escapeCsv(tx.date || ''),
            this.escapeCsv(tx.pieceComptable || ''),
            this.escapeCsv(tx.libelle || ''),
            this.escapeCsv(tx.employee || tx.partenaire || ''),
            this.escapeCsv(tx.noDossier || ''),
            this.escapeCsv(tx.service || ''),
            tx.quantity !== undefined && tx.quantity !== null ? String(tx.quantity) : '',
            String(tx.montant ?? 0),
            tx.soldeApres !== undefined && tx.soldeApres !== null ? String(tx.soldeApres) : '',
            this.escapeCsv(statusLabel),
          ];

      csvRows.push(row.join(';'));
    }

    // 3. Construction du fichier et déclenchement du téléchargement navigateur
    const today = new Date().toISOString().slice(0, 10);
    const filename = options?.filename || `ecritures_caisse_${today}.csv`;
    this.downloadCsvFile(csvRows.join('\r\n'), filename);

    return true;
  }

  /**
   * Échappe une chaîne pour le format CSV (doublement des guillemets et encapsulation)
   */
  public escapeCsv(value: string): string {
    if (!value) return '""';
    const stringValue = String(value);
    const safeValue = /^[=+\-@]/.test(stringValue) ? `'${stringValue}` : stringValue;
    const clean = safeValue.replace(/"/g, '""');
    return `"${clean}"`;
  }

  /**
   * Télécharge une chaîne CSV sous forme de Blob avec BOM UTF-8
   */
  public downloadCsvFile(csvContent: string, filename: string): void {
    const blob = new Blob(['\uFEFF' + csvContent], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}
