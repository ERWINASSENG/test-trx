import { Injectable, inject } from '@angular/core';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { AuthService } from './auth.service';
import {
  CashierTransaction,
  DailyCashierReport,
  DailyCashierReportItem,
} from '../models/cashier-transaction.model';
import { SalesQuote, QuoteColumn, QuoteRow } from '../models/quote.model';

export interface CsvExportOptions {
  filename?: string;
  isComptable?: boolean;
}

export interface PdfExportOptions {
  filename?: string;
}

export interface DailyReportExportOptions {
  filename?: string;
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
   * - Protection contre l'injection de formules (=, +, -, @)
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
   * Génère et télécharge le document PDF pour une cotation individuelle
   */
  public exportQuotePdf(
    quote: SalesQuote,
    options?: PdfExportOptions
  ): boolean {
    if (!quote) {
      return false;
    }
    return this.exportQuotesPdf([quote], options);
  }

  protected createPdfDocument(): jsPDF {
    return new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
    });
  }

  /**
   * Génère et télécharge le dossier PDF pour une ou plusieurs cotations sélectionnées
   * - Mise en page professionnelle A4 Transimex Transit & Maritime
   * - En-tête officiel, coordonnées client, acheminement maritime (POL, POD, Incoterm)
   * - Grille tarifaire détaillée avec totaux et devises
   * - Mentions légales et conditions de validité
   * - Protection contre les données corrompues ou nulles
   */
  public exportQuotesPdf(
    quotes: SalesQuote[],
    options?: PdfExportOptions
  ): boolean {
    if (!quotes || quotes.length === 0) {
      return false;
    }

    const doc = this.createPdfDocument();

    quotes.forEach((quote, index) => {
      if (index > 0) {
        doc.addPage();
      }
      this.renderQuotePdfPage(doc, quote);
    });

    const today = new Date().toISOString().slice(0, 10);
    const filename =
      options?.filename ||
      (quotes.length === 1
        ? `cotation_${this.sanitizeFilename(quotes[0].quoteNumber || quotes[0].id)}.pdf`
        : `cotations_export_${today}.pdf`);

    doc.save(filename);
    return true;
  }

  /**
   * Rendu graphique complet d'une cotation maritime sur le document PDF
   */
  private renderQuotePdfPage(doc: jsPDF, quote: SalesQuote): void {
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 14;

    // 1. Bandeau supérieur d'en-tête (Bleu marine Transimex #0A2540)
    doc.setFillColor(10, 37, 64);
    doc.rect(0, 0, pageWidth, 26, 'F');

    // Logo / Titre Transimex
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('TRANSIMEX S.A.', margin, 11);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(203, 213, 225); // Slate 300
    doc.text('COMMISSIONNAIRE AGRÉÉ EN DOUANE & TRANSIT MARITIME', margin, 17);
    doc.text('Direction Maritime & Affrètement International', margin, 21);

    // Titre de document à droite
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(255, 255, 255);
    doc.text('COTATION COMMERCIALE', pageWidth - margin, 12, { align: 'right' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(254, 215, 170); // Accent ambré
    doc.text(`RÉF : ${quote.quoteNumber || 'N/A'}`, pageWidth - margin, 18, { align: 'right' });

    // 2. Encadré Métadonnées & Statut (sous le bandeau)
    const metaY = 32;
    doc.setDrawColor(226, 232, 240); // Slate 200
    doc.setFillColor(248, 250, 252); // Slate 50
    doc.roundedRect(margin, metaY, pageWidth - margin * 2, 14, 2, 2, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139); // Slate 500
    doc.text('DATE D\'ÉMISSION', margin + 4, metaY + 5);
    doc.text('VALIDITÉ', margin + 45, metaY + 5);
    doc.text('CHARGÉ D\'AFFAIRES', margin + 95, metaY + 5);
    doc.text('STATUT', pageWidth - margin - 4, metaY + 5, { align: 'right' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(30, 41, 59); // Slate 800
    doc.text(this.formatDate(quote.createdAt), margin + 4, metaY + 10);
    doc.text(quote.validUntil ? this.formatDate(quote.validUntil) : '30 jours', margin + 45, metaY + 10);
    doc.text(this.truncateText(quote.assignedToName || 'Direction Commerciale', 28), margin + 95, metaY + 10);

    const statusLabel = this.getQuoteStatusLabel(quote.status);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(10, 37, 64);
    doc.text(statusLabel.toUpperCase(), pageWidth - margin - 4, metaY + 10, { align: 'right' });

    // 3. Deux blocs côte à côte : Coordonnées Client & Acheminement Maritime
    const boxY = 51;
    const boxWidth = (pageWidth - margin * 2 - 8) / 2;
    const boxHeight = 44;

    // Bloc A : Client / Prospect
    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(margin, boxY, boxWidth, boxHeight, 2, 2, 'FD');

    // Header bloc client
    doc.setFillColor(241, 245, 249);
    doc.rect(margin, boxY, boxWidth, 7, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(10, 37, 64);
    doc.text('DONNEUR D\'ORDRE / CLIENT', margin + 4, boxY + 5);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text(this.truncateText(quote.prospectName || 'Client non spécifié', 36), margin + 4, boxY + 14);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(71, 85, 105);
    const contactText = quote.contactName || quote.seaFreight?.contactName || 'Service Achats / Import-Export';
    doc.text(`Contact : ${this.truncateText(contactText, 32)}`, margin + 4, boxY + 20);

    if (quote.seaFreight?.phone) {
      doc.text(`Tél : ${quote.seaFreight.phone}`, margin + 4, boxY + 26);
    }
    if (quote.seaFreight?.email) {
      doc.text(`Email : ${this.truncateText(quote.seaFreight.email, 32)}`, margin + 4, boxY + 32);
    }
    if (quote.title) {
      doc.setFont('helvetica', 'italic');
      doc.text(`Objet : ${this.truncateText(quote.title, 34)}`, margin + 4, boxY + 38);
    }

    // Bloc B : Acheminement & Marchandise Maritime
    const boxBX = margin + boxWidth + 8;
    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(boxBX, boxY, boxWidth, boxHeight, 2, 2, 'FD');

    doc.setFillColor(241, 245, 249);
    doc.rect(boxBX, boxY, boxWidth, 7, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(10, 37, 64);
    doc.text('ACHEMINEMENT & MARCHANDISE MARITIME', boxBX + 4, boxY + 5);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(71, 85, 105);

    const pol = quote.seaFreight?.portOfLoading || 'Non spécifié';
    const pod = quote.seaFreight?.portOfDischarge || 'Douala (Cameroun)';
    const incoterm = quote.seaFreight?.incoterm || 'FOB';

    doc.text(`Port de chargement (POL) : ${this.truncateText(pol, 26)}`, boxBX + 4, boxY + 14);
    doc.text(`Port de déchargement (POD) : ${this.truncateText(pod, 26)}`, boxBX + 4, boxY + 20);
    doc.text(`Incoterm convenu : ${incoterm.toUpperCase()}`, boxBX + 4, boxY + 26);

    const goods = quote.seaFreight?.goodsType || quote.seaFreight?.goodsDescription || 'Marchandise diverse';
    doc.text(`Nature : ${this.truncateText(goods, 28)}`, boxBX + 4, boxY + 32);

    const specs: string[] = [];
    if (quote.seaFreight?.grossWeightKg) {
      specs.push(`${quote.seaFreight.grossWeightKg.toLocaleString('fr-FR')} kg`);
    }
    if (quote.seaFreight?.totalVolumeM3) {
      specs.push(`${quote.seaFreight.totalVolumeM3} m³`);
    }
    if (quote.seaFreight?.packagesCount) {
      specs.push(`${quote.seaFreight.packagesCount} colis`);
    }
    const specsStr = specs.length > 0 ? specs.join(' | ') : 'Conteneurisation standard';
    doc.text(`Détails : ${specsStr}`, boxBX + 4, boxY + 38);

    // 4. Grille des prestations & tarification via autoTable
    const tableY = boxY + boxHeight + 6;
    const tableHeaders = this.extractTableHeaders(quote.columns);
    const tableBody = this.extractTableBody(quote.columns, quote.rows, quote.currency);

    const currencySymbol = quote.currency || 'FCFA';
    const totalAmountFormatted = `${(quote.totalAmount || 0).toLocaleString('fr-FR')} ${currencySymbol}`;

    autoTable(doc, {
      startY: tableY,
      margin: { left: margin, right: margin },
      head: [tableHeaders],
      body: tableBody,
      theme: 'grid',
      styles: {
        fontSize: 8,
        cellPadding: 2.2,
        textColor: [30, 41, 59],
        lineColor: [226, 232, 240],
        lineWidth: 0.1,
      },
      headStyles: {
        fillColor: [10, 37, 64],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        halign: 'left',
      },
      alternateRowStyles: {
        fillColor: [248, 250, 252],
      },
      foot: [
        [
          {
            content: 'TOTAL ESTIMÉ DE LA COTATION',
            colSpan: Math.max(1, tableHeaders.length - 1),
            styles: {
              halign: 'right',
              fontStyle: 'bold',
              fillColor: [241, 245, 249],
              textColor: [10, 37, 64],
              fontSize: 9,
            },
          },
          {
            content: totalAmountFormatted,
            styles: {
              halign: 'right',
              fontStyle: 'bold',
              fillColor: [10, 37, 64],
              textColor: [255, 255, 255],
              fontSize: 9,
            },
          },
        ],
      ],
    });

    // 5. Conditions générales & Cadre de signature
    const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 210;
    const termsY = Math.min(finalY + 8, pageHeight - 48);

    // Bloc mentions légales & validité
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(10, 37, 64);
    doc.text('CONDITIONS & REMARQUES COMMERCIALES', margin, termsY);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(
      '• Cette cotation est établie sur la base des tarifs de fret maritime et des taxes portuaires actuellement en vigueur.',
      margin,
      termsY + 4
    );
    doc.text(
      '• Les prix sont susceptibles de révision en cas de fluctuation des surcharges maritimes (BAF/CAF/PSS) ou du cours des devises.',
      margin,
      termsY + 8
    );
    doc.text(
      '• Sous réserve de disponibilité des conteneurs, d\'espace navire et de faisabilité douanière à destination.',
      margin,
      termsY + 12
    );

    // Cadre Bon pour Accord / Signature
    const signBoxWidth = 65;
    const signBoxHeight = 22;
    const signBoxX = pageWidth - margin - signBoxWidth;
    const signBoxY = termsY - 2;

    doc.setDrawColor(203, 213, 225);
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(signBoxX, signBoxY, signBoxWidth, signBoxHeight, 1.5, 1.5, 'D');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(71, 85, 105);
    doc.text('BON POUR ACCORD DU CLIENT', signBoxX + signBoxWidth / 2, signBoxY + 4, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.text('Date, Signature & Cachet obligatoire', signBoxX + signBoxWidth / 2, signBoxY + 8, { align: 'center' });

    // 6. Pied de page discret
    doc.setDrawColor(226, 232, 240);
    doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(148, 163, 184);
    doc.text(
      'TRANSIMEX S.A. — Direction Générale & Agence Portuaire de Douala — info@transimex-cm.com',
      margin,
      pageHeight - 8
    );
    doc.text(
      `Document généré le ${this.formatDate(new Date().toISOString())}`,
      pageWidth - margin,
      pageHeight - 8,
      { align: 'right' }
    );
  }

  /**
   * Extrait les labels d'en-tête du tableau de prestations
   */
  private extractTableHeaders(columns: QuoteColumn[]): string[] {
    if (columns && columns.length > 0) {
      return columns.map((col) => col.label || col.id);
    }
    return ['Description de la prestation', 'Quantité', 'Prix Unitaire', 'Total'];
  }

  /**
   * Formate les lignes du tableau avec alignements et conversion de montants
   */
  private extractTableBody(
    columns: QuoteColumn[],
    rows: QuoteRow[],
    currency: string
  ): (string | { content: string; styles?: { halign?: 'left' | 'center' | 'right' } })[][] {
    if (!rows || rows.length === 0) {
      const colSpan = Math.max(1, columns?.length || 4);
      return [
        [
          {
            content: 'Aucune ligne de prestation saisie pour cette cotation.',
            styles: { halign: 'center' },
          },
          ...Array(colSpan - 1).fill(''),
        ],
      ];
    }

    const cols = columns && columns.length > 0 ? columns : [
      { id: 'label', label: 'Description', type: 'text' as const },
      { id: 'quantity', label: 'Quantité', type: 'number' as const },
      { id: 'unit_price', label: 'Prix Unitaire', type: 'amount' as const },
      { id: 'total', label: 'Total', type: 'amount' as const },
    ];

    return rows.map((row) => {
      return cols.map((col) => {
        const rawValue = row[col.id];
        if (rawValue === undefined || rawValue === null) {
          return '';
        }

        if (col.type === 'amount') {
          const num = typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue)) || 0;
          return {
            content: `${num.toLocaleString('fr-FR')} ${currency || 'FCFA'}`,
            styles: { halign: 'right' },
          };
        }

        if (col.type === 'number') {
          const num = typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue)) || 0;
          return {
            content: num.toLocaleString('fr-FR'),
            styles: { halign: 'right' },
          };
        }

        if (col.type === 'checkbox') {
          return {
            content: rawValue ? 'OUI' : 'NON',
            styles: { halign: 'center' },
          };
        }

        return String(rawValue);
      });
    });
  }

  /**
   * Traduit le statut de cotation en libellé lisible en français
   */
  private getQuoteStatusLabel(status: string): string {
    switch (status) {
      case 'draft':
        return 'Brouillon';
      case 'sent':
        return 'Envoyée';
      case 'accepted':
        return 'Acceptée';
      case 'rejected':
        return 'Rejetée';
      case 'expired':
        return 'Expirée';
      default:
        return status || 'En cours';
    }
  }

  /**
   * Formate une date ISO en chaîne JJ/MM/AAAA
   */
  private formatDate(isoDate: string | null | undefined): string {
    if (!isoDate) return 'N/A';
    try {
      const date = new Date(isoDate);
      if (isNaN(date.getTime())) return isoDate;
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}/${month}/${year}`;
    } catch {
      return isoDate;
    }
  }

  /**
   * Tronque proprement un texte pour préserver la mise en page PDF
   */
  private truncateText(text: string, maxLength: number): string {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 1) + '…';
  }

  /**
   * Nettoie les caractères spéciaux pour sécuriser le nom de fichier
   */
  private sanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  /**
   * Génère et télécharge le rapport journalier de caisse en PDF
   * Fidèle au modèle officiel "CAISSE TRX du JJ/MM/AAAA"
   */
  public exportDailyCashierReportPdf(
    report: DailyCashierReport,
    options?: DailyReportExportOptions
  ): boolean {
    if (!report || !report.date) {
      return false;
    }

    const doc = this.createPdfDocument();
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 14;

    const titleText = report.title || `CAISSE TRX du ${report.displayDate || report.date}`;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(0, 0, 0);
    doc.text(titleText, pageWidth / 2, 16, { align: 'center' });

    type PdfCell =
      | string
      | {
          content: string;
          styles?: {
            fontStyle?: 'normal' | 'bold' | 'italic' | 'bolditalic';
            fontSize?: number;
            halign?: 'left' | 'center' | 'right';
            valign?: 'top' | 'middle' | 'bottom';
            fillColor?: [number, number, number];
            textColor?: [number, number, number];
          };
        };

    const bodyRows: PdfCell[][] = [];

    // 1. Ligne REPORT SOLDE
    bodyRows.push([
      {
        content: 'REPORT\nSOLDE',
        styles: { fontStyle: 'bold', halign: 'left', valign: 'middle' },
      },
      '',
      {
        content: this.formatReportInteger(report.reportSolde),
        styles: {
          fontStyle: 'bold',
          fontSize: 11,
          halign: 'center',
          valign: 'bottom',
          fillColor: [217, 217, 217],
        },
      },
      '',
    ]);

    // 2. En-tête RECETTES
    bodyRows.push([
      { content: 'RECETTES', styles: { fontStyle: 'bold', halign: 'left' } },
      '',
      '',
      { content: 'N° pièce', styles: { fontStyle: 'bold', halign: 'left' } },
    ]);

    // 3. Lignes des RECETTES du jour
    for (const item of report.recettes || []) {
      bodyRows.push([
        { content: item.date || report.displayDate, styles: { halign: 'right', valign: 'bottom' } },
        { content: this.formatDailyReportLibelle(item), styles: { halign: 'left', valign: 'bottom' } },
        {
          content: this.formatReportAmount(item.montant, false),
          styles: { halign: 'center', valign: 'bottom' },
        },
        {
          content: this.formatDailyReportPieceCol(item),
          styles: { halign: 'center', valign: 'bottom' },
        },
      ]);
    }

    // 2 lignes vides d'espacement comme sur le modèle CAISSE TRX
    bodyRows.push(['', '', '', '']);
    bodyRows.push(['', '', '', '']);

    // 4. Ligne TOTAL RECETTES
    bodyRows.push([
      {
        content: 'TOTAL\nRECETTES',
        styles: { fontStyle: 'bold', halign: 'left', valign: 'middle' },
      },
      '',
      {
        content: this.formatReportInteger(report.totalRecettes),
        styles: { fontStyle: 'bold', halign: 'center', valign: 'bottom' },
      },
      '',
    ]);

    // 5. Ligne TOTAL (REPORT SOLDE + TOTAL RECETTES)
    bodyRows.push([
      { content: 'TOTAL', styles: { fontStyle: 'bold', halign: 'left' } },
      '',
      {
        content: this.formatReportInteger(report.totalApresRecettes),
        styles: { fontStyle: 'bold', halign: 'center', valign: 'middle' },
      },
      '',
    ]);

    // 6. En-tête DEPENSES
    bodyRows.push([
      { content: 'DEPENSES', styles: { fontStyle: 'bold', halign: 'left' } },
      '',
      { content: 'MONTANT', styles: { fontStyle: 'bold', halign: 'left' } },
      '',
    ]);

    // 7. Lignes des DEPENSES du jour (montants sur fond jaune clair #FFFF99, réf en rouge)
    for (const item of report.depenses || []) {
      bodyRows.push([
        { content: item.date || report.displayDate, styles: { halign: 'right', valign: 'bottom' } },
        { content: this.formatDailyReportLibelle(item), styles: { halign: 'left', valign: 'bottom' } },
        {
          content: this.formatReportAmount(item.montant, true),
          styles: {
            halign: 'right',
            valign: 'bottom',
            fillColor: [255, 255, 153],
          },
        },
        {
          content: this.formatDailyReportPieceCol(item),
          styles: {
            halign: 'center',
            valign: 'bottom',
            textColor: [192, 0, 0],
          },
        },
      ]);
    }

    // Lignes vides avant TOTAL DEPENSES
    bodyRows.push(['', '', '', '']);
    bodyRows.push(['', '', '', '']);

    // 8. Ligne TOTAL DEPENSES
    bodyRows.push([
      {
        content: 'TOTAL\nDEPENSES',
        styles: { fontStyle: 'bold', halign: 'left', valign: 'middle' },
      },
      '',
      {
        content: this.formatReportInteger(report.totalDepenses),
        styles: {
          fontStyle: 'bold',
          halign: 'center',
          valign: 'bottom',
          fillColor: [217, 217, 217],
        },
      },
      '',
    ]);

    // 9. Ligne SOLDE final
    bodyRows.push([
      {
        content: 'SOLDE',
        styles: {
          fontStyle: 'bold',
          fontSize: 11,
          halign: 'left',
          valign: 'middle',
          fillColor: [217, 217, 217],
        },
      },
      '',
      {
        content: this.formatReportInteger(report.soldeFinal),
        styles: {
          fontStyle: 'bold',
          fontSize: 12,
          halign: 'center',
          valign: 'middle',
          fillColor: [217, 217, 217],
        },
      },
      '',
    ]);

    autoTable(doc, {
      startY: 19,
      margin: { left: margin, right: margin },
      body: bodyRows,
      theme: 'grid',
      styles: {
        font: 'helvetica',
        fontSize: 9,
        cellPadding: 1.6,
        textColor: [0, 0, 0],
        lineColor: [0, 0, 0],
        lineWidth: 0.25,
        minCellHeight: 6,
      },
      columnStyles: {
        0: { cellWidth: 26 },
        1: { cellWidth: 88 },
        2: { cellWidth: 38 },
        3: { cellWidth: 30 },
      },
    });

    const safeDate = this.sanitizeFilename(report.date);
    const filename = options?.filename || `CAISSE_TRX_${safeDate}.pdf`;
    doc.save(filename);
    return true;
  }

  /**
   * Génère et télécharge le rapport journalier de caisse au format Excel (.xlsx)
   * Fidèle au modèle officiel "CAISSE TRX du JJ/MM/AAAA" avec protection anti-injection de formules (S7)
   */
  public async exportDailyCashierReportExcel(
    report: DailyCashierReport,
    options?: DailyReportExportOptions
  ): Promise<boolean> {
    if (!report || !report.date) {
      return false;
    }

    const excelModule = await import('exceljs');
    const ExcelJS = excelModule.default || excelModule;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TRANSIMEX S.A.';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet('CAISSE TRX');
    worksheet.columns = [
      { key: 'colDate', width: 16 },
      { key: 'colLibelle', width: 54 },
      { key: 'colMontant', width: 20 },
      { key: 'colPiece', width: 18 },
    ];

    const thinBorder = {
      top: { style: 'thin' as const, color: { argb: 'FF000000' } },
      left: { style: 'thin' as const, color: { argb: 'FF000000' } },
      bottom: { style: 'thin' as const, color: { argb: 'FF000000' } },
      right: { style: 'thin' as const, color: { argb: 'FF000000' } },
    };

    const mediumBoxBorder = {
      top: { style: 'medium' as const, color: { argb: 'FF000000' } },
      left: { style: 'medium' as const, color: { argb: 'FF000000' } },
      bottom: { style: 'medium' as const, color: { argb: 'FF000000' } },
      right: { style: 'medium' as const, color: { argb: 'FF000000' } },
    };

    const greyFill = {
      type: 'pattern' as const,
      pattern: 'solid' as const,
      fgColor: { argb: 'FFD9D9D9' },
    };

    const yellowFill = {
      type: 'pattern' as const,
      pattern: 'solid' as const,
      fgColor: { argb: 'FFFFFF99' },
    };

    // 1. Titre centré : CAISSE TRX du JJ/MM/AAAA
    const titleText = this.sanitizeExcelText(
      report.title || `CAISSE TRX du ${report.displayDate || report.date}`
    );
    const titleRow = worksheet.addRow([titleText, '', '', '']);
    worksheet.mergeCells(`A${titleRow.number}:D${titleRow.number}`);
    titleRow.height = 24;
    const titleCell = titleRow.getCell(1);
    titleCell.font = { name: 'Calibri', size: 12, bold: true };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

    const applyRowBorders = (rowNumber: number): void => {
      const row = worksheet.getRow(rowNumber);
      for (let col = 1; col <= 4; col++) {
        row.getCell(col).border = thinBorder;
        row.getCell(col).font = { name: 'Calibri', size: 10 };
      }
    };

    // 2. Ligne REPORT SOLDE
    const reportRow = worksheet.addRow(['REPORT\nSOLDE', '', report.reportSolde, '']);
    reportRow.height = 30;
    applyRowBorders(reportRow.number);
    reportRow.getCell(1).font = { name: 'Calibri', size: 10, bold: true };
    reportRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    reportRow.getCell(3).font = { name: 'Calibri', size: 12, bold: true };
    reportRow.getCell(3).numFmt = '#,##0';
    reportRow.getCell(3).alignment = { horizontal: 'center', vertical: 'bottom' };
    reportRow.getCell(3).fill = greyFill;
    reportRow.getCell(3).border = mediumBoxBorder;

    // 3. En-tête RECETTES
    const recettesHeaderRow = worksheet.addRow(['RECETTES', '', '', 'N° pièce']);
    applyRowBorders(recettesHeaderRow.number);
    recettesHeaderRow.getCell(1).font = { name: 'Calibri', size: 10, bold: true };
    recettesHeaderRow.getCell(4).font = { name: 'Calibri', size: 10, bold: true };

    // 4. Lignes des RECETTES
    for (const item of report.recettes || []) {
      const row = worksheet.addRow([
        this.sanitizeExcelText(item.date || report.displayDate),
        this.sanitizeExcelText(this.formatDailyReportLibelle(item)),
        item.montant,
        this.sanitizeExcelText(this.formatDailyReportPieceCol(item)),
      ]);
      applyRowBorders(row.number);
      row.getCell(1).alignment = { horizontal: 'right', vertical: 'bottom' };
      row.getCell(2).alignment = { horizontal: 'left', vertical: 'bottom', wrapText: true };
      row.getCell(3).numFmt = '#,##0.00';
      row.getCell(3).alignment = { horizontal: 'right', vertical: 'bottom' };
      row.getCell(4).alignment = { horizontal: 'center', vertical: 'bottom' };
    }

    // 2 lignes vides d'espacement
    const emptyRec1 = worksheet.addRow(['', '', '', '']);
    applyRowBorders(emptyRec1.number);
    const emptyRec2 = worksheet.addRow(['', '', '', '']);
    applyRowBorders(emptyRec2.number);

    // 5. Ligne TOTAL RECETTES
    const totalRecettesRow = worksheet.addRow(['TOTAL\nRECETTES', '', report.totalRecettes, '']);
    totalRecettesRow.height = 28;
    applyRowBorders(totalRecettesRow.number);
    totalRecettesRow.getCell(1).font = { name: 'Calibri', size: 10, bold: true };
    totalRecettesRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    totalRecettesRow.getCell(3).font = { name: 'Calibri', size: 10, bold: true };
    totalRecettesRow.getCell(3).numFmt = '#,##0';
    totalRecettesRow.getCell(3).alignment = { horizontal: 'center', vertical: 'bottom' };

    // 6. Ligne TOTAL (REPORT SOLDE + TOTAL RECETTES)
    const totalCumulRow = worksheet.addRow(['TOTAL', '', report.totalApresRecettes, '']);
    applyRowBorders(totalCumulRow.number);
    totalCumulRow.getCell(1).font = { name: 'Calibri', size: 10, bold: true };
    totalCumulRow.getCell(3).font = { name: 'Calibri', size: 10, bold: true };
    totalCumulRow.getCell(3).numFmt = '#,##0';
    totalCumulRow.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };

    // 7. En-tête DEPENSES
    const depensesHeaderRow = worksheet.addRow(['DEPENSES', '', 'MONTANT', '']);
    applyRowBorders(depensesHeaderRow.number);
    depensesHeaderRow.getCell(1).font = { name: 'Calibri', size: 10, bold: true };
    depensesHeaderRow.getCell(3).font = { name: 'Calibri', size: 10, bold: true };

    // 8. Lignes des DEPENSES
    for (const item of report.depenses || []) {
      const row = worksheet.addRow([
        this.sanitizeExcelText(item.date || report.displayDate),
        this.sanitizeExcelText(this.formatDailyReportLibelle(item)),
        item.montant,
        this.sanitizeExcelText(this.formatDailyReportPieceCol(item)),
      ]);
      applyRowBorders(row.number);
      row.getCell(1).alignment = { horizontal: 'right', vertical: 'bottom' };
      row.getCell(2).alignment = { horizontal: 'left', vertical: 'bottom', wrapText: true };
      row.getCell(3).numFmt = '#,##0.0';
      row.getCell(3).alignment = { horizontal: 'right', vertical: 'bottom' };
      row.getCell(3).fill = yellowFill;
      row.getCell(4).alignment = { horizontal: 'center', vertical: 'bottom' };
      row.getCell(4).font = { name: 'Calibri', size: 10, color: { argb: 'FFC00000' } };
    }

    // 2 lignes vides avant TOTAL DEPENSES
    const emptyDep1 = worksheet.addRow(['', '', '', '']);
    applyRowBorders(emptyDep1.number);
    const emptyDep2 = worksheet.addRow(['', '', '', '']);
    applyRowBorders(emptyDep2.number);

    // 9. Ligne TOTAL DEPENSES
    const totalDepensesRow = worksheet.addRow(['TOTAL\nDEPENSES', '', report.totalDepenses, '']);
    totalDepensesRow.height = 28;
    applyRowBorders(totalDepensesRow.number);
    totalDepensesRow.getCell(1).font = { name: 'Calibri', size: 10, bold: true };
    totalDepensesRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    totalDepensesRow.getCell(3).font = { name: 'Calibri', size: 10, bold: true };
    totalDepensesRow.getCell(3).numFmt = '#,##0';
    totalDepensesRow.getCell(3).alignment = { horizontal: 'center', vertical: 'bottom' };
    totalDepensesRow.getCell(3).fill = greyFill;

    // 10. Ligne SOLDE final
    const soldeFinalRow = worksheet.addRow(['SOLDE', '', report.soldeFinal, '']);
    soldeFinalRow.height = 22;
    applyRowBorders(soldeFinalRow.number);
    soldeFinalRow.getCell(1).font = { name: 'Calibri', size: 12, bold: true };
    soldeFinalRow.getCell(1).fill = greyFill;
    soldeFinalRow.getCell(1).border = mediumBoxBorder;
    soldeFinalRow.getCell(3).font = { name: 'Calibri', size: 12, bold: true };
    soldeFinalRow.getCell(3).numFmt = '#,##0';
    soldeFinalRow.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };
    soldeFinalRow.getCell(3).fill = greyFill;
    soldeFinalRow.getCell(3).border = mediumBoxBorder;

    const buffer = await workbook.xlsx.writeBuffer();
    const safeDate = this.sanitizeFilename(report.date);
    const filename = options?.filename || `CAISSE_TRX_${safeDate}.xlsx`;
    this.downloadBinaryFile(
      buffer,
      filename,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    return true;
  }

  /**
   * Neutralise l'injection de formules Excel (S7 : préfixe d'une apostrophe si commence par =, +, -, @, \t, \r)
   */
  public sanitizeExcelText(value: string | null | undefined): string {
    if (!value) return '';
    const str = String(value);
    return /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  }

  public formatDailyReportLibelle(item: DailyCashierReportItem): string {
    const libelle = (item.libelle || '').trim();
    const dossier = (item.noDossier || '').trim();
    if (dossier && !libelle.toLowerCase().includes(dossier.toLowerCase())) {
      return `${dossier} ${libelle}`.trim();
    }
    return libelle;
  }

  public formatDailyReportPieceCol(item: DailyCashierReportItem): string {
    if (item.partenaire && item.partenaire.trim()) {
      return item.partenaire.trim();
    }
    if (item.pieceComptable && item.pieceComptable.trim()) {
      return item.pieceComptable.trim();
    }
    return '';
  }

  public formatReportInteger(amount: number): string {
    const rounded = Math.round(Number(amount) || 0);
    return rounded.toLocaleString('fr-FR').replace(/[\u202F\u00A0]/g, ' ');
  }

  public formatReportAmount(amount: number, withSingleDecimal = false): string {
    const num = Math.abs(Number(amount) || 0);
    if (withSingleDecimal) {
      return num
        .toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        .replace(/[\u202F\u00A0]/g, ' ');
    }
    return num.toLocaleString('fr-FR').replace(/[\u202F\u00A0]/g, ' ');
  }

  protected downloadBinaryFile(
    data: ArrayBuffer | Uint8Array,
    filename: string,
    mimeType: string
  ): void {
    const part: BlobPart = data instanceof Uint8Array ? Uint8Array.from(data) : data;
    const blob = new Blob([part], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /**
   * Échappe une chaîne pour le format CSV (doublement des guillemets et encapsulation)
   * Protection contre l'injection de formules (=, +, -, @)
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
