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
   * Conforme au modèle officiel "FICHE DE DEMANDE DE COTATION MARITIME / SEA FREIGHT QUOTATION REQUEST FORM" (2 pages)
   */
  private renderQuotePdfPage(doc: jsPDF, quote: SalesQuote): void {
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 14;
    const contentWidth = pageWidth - margin * 2;

    // ==========================================
    // PAGE 1 : EN-TÊTE, SECTIONS 1, 2, 3, 4 & 5
    // ==========================================

    // 1. En-tête officiel TRANSIMEX centré
    this.drawTransimexHeader(doc, pageWidth, 18);

    // Titre principal centré
    this.drawMainTitle(doc, pageWidth, 33);

    // Référence cotation discrète à droite si présente
    if (quote.quoteNumber) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(100, 116, 139);
      doc.text(`Réf : ${quote.quoteNumber}`, pageWidth - margin, 33, { align: 'right' });
    }

    // ------------------------------------------
    // SECTION 1 : Informations sur le client
    // ------------------------------------------
    const sec1Y = 38;
    this.drawSectionBanner(doc, '1. Informations sur le client / Client Information', margin, sec1Y, contentWidth);

    let currentY = sec1Y + 10;
    const lineSpacing = 5.2;

    this.drawFieldLine(doc, margin + 2, currentY, "Nom de l'entreprise / Company Name :", quote.prospectName || '', contentWidth);
    currentY += lineSpacing;

    const contactName = quote.seaFreight?.contactName || quote.contactName || '';
    this.drawFieldLine(doc, margin + 2, currentY, 'Nom du contact / Contact Name :', contactName, contentWidth);
    currentY += lineSpacing;

    this.drawFieldLine(doc, margin + 2, currentY, 'Téléphone / Phone :', quote.seaFreight?.phone || '', contentWidth);
    currentY += lineSpacing;

    this.drawFieldLine(doc, margin + 2, currentY, 'Email :', quote.seaFreight?.email || '', contentWidth);
    currentY += lineSpacing;

    this.drawFieldLine(doc, margin + 2, currentY, 'Adresse / Address :', quote.seaFreight?.address || '', contentWidth);

    // ------------------------------------------
    // SECTION 2 : Détails de l'expédition
    // ------------------------------------------
    const sec2Y = currentY + 7;
    this.drawSectionBanner(doc, "2. Détails de l'expédition / Shipment Details", margin, sec2Y, contentWidth);

    currentY = sec2Y + 10;
    this.drawFieldLine(doc, margin + 2, currentY, 'Type de marchandise / Type of Goods :', quote.seaFreight?.goodsType || '', contentWidth);
    currentY += lineSpacing;

    const goodsDesc = quote.seaFreight?.goodsDescription || quote.title || '';
    this.drawFieldLine(doc, margin + 2, currentY, 'Description :', goodsDesc, contentWidth);
    currentY += lineSpacing;

    const grossWeight = quote.seaFreight?.grossWeightKg != null ? `${this.formatQuoteAmount(quote.seaFreight.grossWeightKg)} kg` : '';
    this.drawFieldLine(doc, margin + 2, currentY, 'Poids brut (kg) / Gross Weight (kg) :', grossWeight, contentWidth);
    currentY += lineSpacing;

    const volume = quote.seaFreight?.totalVolumeM3 != null ? `${quote.seaFreight.totalVolumeM3} m³` : '';
    this.drawFieldLine(doc, margin + 2, currentY, 'Volume (m³) / Volume (cbm) :', volume, contentWidth);
    currentY += lineSpacing;

    const packages = quote.seaFreight?.packagesCount != null ? String(quote.seaFreight.packagesCount) : '';
    this.drawFieldLine(doc, margin + 2, currentY, 'Nombre de colis / Number of Packages :', packages, contentWidth);
    currentY += lineSpacing;

    this.drawFieldLine(doc, margin + 2, currentY, "Type d'emballage / Packaging Type :", quote.seaFreight?.packagingType || '', contentWidth);

    // ------------------------------------------
    // SECTION 3 : Itinéraire souhaité
    // ------------------------------------------
    const sec3Y = currentY + 7;
    this.drawSectionBanner(doc, '3. Itinéraire souhaité / Preferred Route', margin, sec3Y, contentWidth);

    currentY = sec3Y + 10;
    this.drawFieldLine(doc, margin + 2, currentY, 'Port de chargement / Port of Loading :', quote.seaFreight?.portOfLoading || '', contentWidth);
    currentY += lineSpacing;

    this.drawFieldLine(doc, margin + 2, currentY, 'Port de déchargement / Port of Discharge :', quote.seaFreight?.portOfDischarge || '', contentWidth);
    currentY += lineSpacing;

    this.drawFieldLine(doc, margin + 2, currentY, 'Incoterm souhaité / Preferred Incoterm :', (quote.seaFreight?.incoterm || '').toUpperCase(), contentWidth);
    currentY += lineSpacing;

    this.drawFieldLine(doc, margin + 2, currentY, "Date d'embarquement estimée / Estimated Departure Date :", this.formatDate(quote.seaFreight?.estimatedDepartureDate), contentWidth);
    currentY += lineSpacing;

    this.drawFieldLine(doc, margin + 2, currentY, "Date d'arrivée souhaitée / Estimated Arrival Date :", this.formatDate(quote.seaFreight?.estimatedArrivalDate), contentWidth);
    currentY += lineSpacing;

    const inland = quote.seaFreight?.needInlandTransport === true ? 'Oui / Yes' : (quote.seaFreight?.needInlandTransport === false ? 'Non / No' : '');
    this.drawFieldLine(doc, margin + 2, currentY, 'Transport terrestre nécessaire / Need inland transport? :', inland, contentWidth);

    // ------------------------------------------
    // SECTION 4 : Type de service souhaité
    // ------------------------------------------
    const sec4Y = currentY + 7;
    this.drawSectionBanner(doc, '4. Type de service souhaité / Type of Service Required', margin, sec4Y, contentWidth);

    currentY = sec4Y + 10;
    const services = quote.seaFreight?.serviceTypes;
    this.drawCheckbox(doc, margin + 2, currentY, !!services?.fcl, 'FCL (Conteneur complet / Full Container Load)');
    currentY += lineSpacing;

    this.drawCheckbox(doc, margin + 2, currentY, !!services?.lcl, 'LCL (Groupage / Less than Container Load)');
    currentY += lineSpacing;

    this.drawCheckbox(doc, margin + 2, currentY, !!services?.roro, 'RO/RO (Roulier / Roll-on/Roll-off)');
    currentY += lineSpacing;

    this.drawCheckbox(doc, margin + 2, currentY, !!services?.breakBulk, 'Break Bulk (Conventionnel / Conventional Cargo)');
    currentY += lineSpacing;

    const otherServiceLabel = services?.other ? `Autre / Other : ${services.other}` : 'Autre / Other';
    this.drawCheckbox(doc, margin + 2, currentY, !!services?.other, otherServiceLabel);

    // ------------------------------------------
    // SECTION 5 : Bandeau Documents disponibles au bas de la page 1
    // ------------------------------------------
    const sec5Y = currentY + 7;
    this.drawSectionBanner(doc, '5. Documents disponibles / Available Documents', margin, sec5Y, contentWidth);

    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text('(Suite des documents et services requis au verso / Continued on next page)', margin + 3.5, sec5Y + 11);

    // ==========================================
    // PAGE 2 : TITRE, SUITE SEC 5, SEC 6, DETAILS CHIFFRAGE & FOOTER
    // ==========================================
    doc.addPage();

    // Titre de rappel en haut de la page 2
    this.drawMainTitle(doc, pageWidth, 16);

    // Suite Section 5 (Cases à cocher documents disponibles)
    currentY = 24;
    const docs = quote.seaFreight?.availableDocuments;
    this.drawCheckbox(doc, margin + 2, currentY, !!docs?.commercialInvoice, 'Facture commerciale / Commercial Invoice');
    currentY += lineSpacing;

    this.drawCheckbox(doc, margin + 2, currentY, !!docs?.packingList, 'Liste de colisage / Packing List');
    currentY += lineSpacing;

    this.drawCheckbox(doc, margin + 2, currentY, !!docs?.certificateOfOrigin, "Certificat d'origine / Certificate of Origin");
    currentY += lineSpacing;

    this.drawCheckbox(doc, margin + 2, currentY, !!docs?.msdsTechnicalSheet, 'Fiche de données de sécurité (MSDS) / Material Safety Data Sheet');
    currentY += lineSpacing;

    const otherDocLabel = docs?.other ? `Autre / Other : ${docs.other}` : 'Autre / Other';
    this.drawCheckbox(doc, margin + 2, currentY, !!docs?.other, otherDocLabel);

    // ------------------------------------------
    // SECTION 6 : Services additionnels requis
    // ------------------------------------------
    const sec6Y = currentY + 7;
    this.drawSectionBanner(doc, '6. Services additionnels requis / Additional Services Needed', margin, sec6Y, contentWidth);

    currentY = sec6Y + 10;
    const addons = quote.seaFreight?.additionalServices;
    this.drawCheckbox(doc, margin + 2, currentY, !!addons?.customsClearance, 'Dédouanement / Customs Clearance');
    currentY += lineSpacing;

    this.drawCheckbox(doc, margin + 2, currentY, !!addons?.cargoInsurance, 'Assurance marchandise / Cargo Insurance');
    currentY += lineSpacing;

    this.drawCheckbox(doc, margin + 2, currentY, !!addons?.warehousing, 'Entreposage / Warehousing');
    currentY += lineSpacing;

    this.drawCheckbox(doc, margin + 2, currentY, !!addons?.portHandling, 'Manutention portuaire / Port Handling');
    currentY += lineSpacing;

    this.drawCheckbox(doc, margin + 2, currentY, !!addons?.tracking, 'Suivi et traçabilité / Cargo Tracking');
    currentY += lineSpacing;

    // ------------------------------------------
    // SECTION 7 (Optionnelle) : Détails du chiffrage si des lignes existent
    // ------------------------------------------
    if (quote.rows && quote.rows.length > 0) {
      const sec7Y = currentY + 5;
      this.drawSectionBanner(doc, '7. Détails du chiffrage / Cost Breakdown & Quotation Lines', margin, sec7Y, contentWidth);

      const tableHeaders = this.extractTableHeaders(quote.columns);
      const tableBody = this.extractTableBody(quote.columns, quote.rows, quote.currency);
      const currencySymbol = quote.currency || 'FCFA';
      const totalAmountFormatted = `${this.formatQuoteAmount(quote.totalAmount || 0)} ${currencySymbol}`;

      autoTable(doc, {
        startY: sec7Y + 8,
        margin: { left: margin, right: margin },
        head: [tableHeaders],
        body: tableBody,
        theme: 'grid',
        styles: {
          fontSize: 8,
          cellPadding: 2,
          textColor: [30, 41, 59],
          lineColor: [209, 213, 219],
          lineWidth: 0.1,
        },
        headStyles: {
          fillColor: [26, 54, 115], // Transimex navy blue
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
                textColor: [26, 54, 115],
                fontSize: 8.5,
              },
            },
            {
              content: totalAmountFormatted,
              styles: {
                halign: 'right',
                fontStyle: 'bold',
                fillColor: [26, 54, 115],
                textColor: [255, 255, 255],
                fontSize: 8.5,
              },
            },
          ],
        ],
      });
    }

    // Pied de page officiel TRANSIMEX
    const footerY = pageHeight - 24;
    this.drawTransimexFooter(doc, pageWidth, footerY, margin);
  }

  /**
   * En-tête officiel TRANSIMEX (Logo serif, barre rouge, slogan)
   */
  private drawTransimexHeader(doc: jsPDF, pageWidth: number, startY: number): void {
    const centerX = pageWidth / 2;

    // TRANSIMEX (Serif, bleu marine officiel #1A3673)
    doc.setFont('times', 'bold');
    doc.setFontSize(22);
    doc.setTextColor(26, 54, 115);
    doc.text('TRANSIMEX', centerX, startY, { align: 'center' });

    // Ligne rouge séparatrice
    const lineWidth = 74;
    doc.setDrawColor(211, 47, 47); // Rouge #D32F2F
    doc.setLineWidth(0.65);
    doc.line(centerX - lineWidth / 2, startY + 2.5, centerX + lineWidth / 2, startY + 2.5);

    // Global Logistics Provider (Sans-serif, rouge)
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(211, 47, 47);
    doc.text('Global Logistics Provider', centerX, startY + 6.5, { align: 'center' });
  }

  /**
   * Titre principal officiel de la fiche
   */
  private drawMainTitle(doc: jsPDF, pageWidth: number, y: number): void {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(20, 20, 20);
    doc.text(
      'FICHE DE DEMANDE DE COTATION MARITIME / SEA FREIGHT QUOTATION REQUEST FORM',
      pageWidth / 2,
      y,
      { align: 'center' }
    );
  }

  /**
   * Bannière grise délimitant une section
   */
  private drawSectionBanner(
    doc: jsPDF,
    title: string,
    x: number,
    y: number,
    width: number,
    height: number = 6
  ): void {
    doc.setFillColor(217, 221, 226); // Gris clair officiel #D9DDE2
    doc.rect(x, y, width, height, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(20, 20, 20);
    doc.text(title, x + 3, y + height - 1.8);
  }

  /**
   * Ligne de champ avec libellé en gras et valeur renseignée
   */
  private drawFieldLine(
    doc: jsPDF,
    x: number,
    y: number,
    label: string,
    value: string,
    maxWidth: number
  ): void {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(20, 20, 20);
    doc.text(label, x, y);

    const labelWidth = doc.getTextWidth(label);
    const valueX = x + labelWidth + 2;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(40, 50, 65);
    const truncatedValue = this.truncateText(value || '', Math.floor((maxWidth - labelWidth) / 1.7));
    doc.text(truncatedValue, valueX, y);
  }

  /**
   * Rendu graphique d'une case à cocher conforme au formulaire officiel
   */
  private drawCheckbox(
    doc: jsPDF,
    x: number,
    y: number,
    checked: boolean,
    label: string
  ): void {
    const boxSize = 3.6;
    doc.setDrawColor(75, 85, 99);
    doc.setLineWidth(0.25);
    doc.setFillColor(255, 255, 255);
    doc.rect(x, y - boxSize + 0.8, boxSize, boxSize, 'FD');

    if (checked) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(26, 54, 115);
      doc.text('X', x + 0.8, y + 0.2);
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(20, 20, 20);
    doc.text(label, x + boxSize + 2.5, y);
  }

  /**
   * Pied de fiche officiel TRANSIMEX avec coordonnées
   */
  private drawTransimexFooter(
    doc: jsPDF,
    pageWidth: number,
    y: number,
    margin: number
  ): void {
    doc.setDrawColor(209, 213, 219);
    doc.setLineWidth(0.25);
    doc.line(margin, y, pageWidth - margin, y);

    const centerX = pageWidth / 2;
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(75, 85, 99);
    doc.text('Merci de retourner cette fiche complétée à :', centerX, y + 4.5, { align: 'center' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(20, 20, 20);
    doc.text('Email : info@transimex-cm.com | Téléphone : +237 620 363 043', centerX, y + 9, { align: 'center' });

    doc.setFont('helvetica', 'normal');
    doc.setTextColor(26, 54, 115);
    doc.text('Site web : http://www.transimex-cm.com', centerX, y + 13.5, { align: 'center' });
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
          const num = typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue).replace(/[/ ,]/g, '')) || 0;
          return {
            content: `${this.formatQuoteAmount(num)} ${currency || 'FCFA'}`,
            styles: { halign: 'right' },
          };
        }

        if (col.type === 'number') {
          const num = typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue).replace(/[/ ,]/g, '')) || 0;
          return {
            content: this.formatQuoteAmount(num),
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

  private formatQuoteAmount(amount: number): string {
    if (typeof amount !== 'number' || isNaN(amount)) {
      return '0';
    }
    return amount.toLocaleString('en-US');
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
    if (!isoDate) return '';
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
