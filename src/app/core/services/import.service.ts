import { Injectable } from '@angular/core';
import ExcelJS from 'exceljs';
import {
  CASHIER_SERVICES,
  Service,
  TransactionStatus,
  TransactionTypeCategory,
} from '../models/cashier-transaction.model';
import { generateTransactionFingerprint } from '../utils/cashier-duplicate.util';

export interface ImportError {
  row: number;
  column?: string;
  message: string;
}

export interface ParsedImportRow {
  pieceComptable?: string;
  date: string;
  isoDate?: string;
  libelle: string;
  partenaire?: string;
  employee?: string;
  noDossier?: string;
  service?: Service;
  quantity?: number;
  montant: number;
  category: TransactionTypeCategory;
  status: TransactionStatus;
  isDuplicate?: boolean;
  duplicateReason?: string;
}

export interface ParsedImportResult {
  validRows: ParsedImportRow[];
  errors: ImportError[];
  totalRows: number;
}

@Injectable({
  providedIn: 'root',
})
export class ImportService {
  /**
   * Lit et analyse un fichier Excel (.xlsx, .xls) ou CSV
   */
  public async parseExcelOrCsvFile(file: File): Promise<ParsedImportResult> {
    const dataBuffer = await file.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(dataBuffer);

    if (workbook.worksheets.length === 0) {
      return {
        validRows: [],
        errors: [{ row: 0, message: 'Le fichier ne contient aucune feuille de calcul lisible.' }],
        totalRows: 0,
      };
    }

    const firstSheet = workbook.worksheets[0];
    const headers: string[] = [];
    firstSheet.getRow(1).eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      headers[columnNumber - 1] = String(cell.value ?? '').trim();
    });
    const rawRows: Record<string, unknown>[] = [];
    firstSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const values: Record<string, unknown> = {};
      row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
        const header = headers[columnNumber - 1];
        if (header) values[header] = this.extractExcelCellValue(cell.value);
      });
      rawRows.push(values);
    });

    const validRows: ParsedImportRow[] = [];
    const errors: ImportError[] = [];
    const seenFingerprints = new Map<string, number>();

    rawRows.forEach((row, index) => {
      const rowIndex = index + 2; // +2 en comptant la ligne d'en-tête (1-indexed)
      const parsed = this.validateAndTransformRow(row, rowIndex);

      if (parsed.error) {
        errors.push(parsed.error);
      } else if (parsed.data) {
        const fp = generateTransactionFingerprint({
          date: parsed.data.date,
          montant: parsed.data.montant,
          libelle: parsed.data.libelle,
          noDossier: parsed.data.noDossier,
          service: parsed.data.service,
        });

        if (seenFingerprints.has(fp)) {
          const firstRow = seenFingerprints.get(fp);
          errors.push({
            row: rowIndex,
            message: `Ligne en double dans le fichier : identique à la ligne ${firstRow} (Date: ${parsed.data.date}, Montant: ${parsed.data.montant} FCFA, Service: ${parsed.data.service || 'N/A'}, Libellé: "${parsed.data.libelle}").`,
          });
        } else {
          seenFingerprints.set(fp, rowIndex);
          validRows.push(parsed.data);
        }
      }
    });

    return {
      validRows,
      errors,
      totalRows: rawRows.length,
    };
  }

  private extractExcelCellValue(value: ExcelJS.CellValue): unknown {
    if (value instanceof Date) return value;
    if (value && typeof value === 'object' && 'result' in value) {
      return value.result;
    }
    if (value && typeof value === 'object' && 'richText' in value) {
      return value.richText.map((part) => part.text).join('');
    }
    return value ?? '';
  }

  /**
   * Valide et normalise une ligne brute issue du fichier
   */
  public validateAndTransformRow(
    row: Record<string, unknown>,
    rowIndex: number
  ): { data?: ParsedImportRow; error?: ImportError } {
    // Recherche tolérante des valeurs brutes de colonnes
    const findRawValue = (keys: string[]): unknown => {
      for (const key of Object.keys(row)) {
        const cleanKey = key.trim().toLowerCase();
        if (keys.some((k) => cleanKey.includes(k.toLowerCase()))) {
          const val = row[key];
          if (val !== null && val !== undefined && val !== '') {
            return val;
          }
        }
      }
      return undefined;
    };

    // Recherche tolérante des colonnes sous forme de chaîne nettoyée
    const findValue = (keys: string[]): string => {
      const val = findRawValue(keys);
      return val !== null && val !== undefined ? String(val).trim() : '';
    };

    // 1. Libellé (Obligatoire)
    const libelle = findValue(['libellé', 'libelle', 'description', 'motif', 'operation']);
    if (!libelle) {
      return {
        error: {
          row: rowIndex,
          column: 'Libellé',
          message: 'Le libellé de l’opération est obligatoire.',
        },
      };
    }

    // Helper pour parser un montant numérique propre
    const parseAmount = (raw: string): number | null => {
      if (!raw) return null;
      const clean = raw.replace(/\s/g, '').replace(/,/g, '.');
      const num = parseFloat(clean);
      return isNaN(num) ? null : num;
    };

    // 2. Détection des colonnes distinctes Entrée et Sortie
    const rawEntree = findValue(['entrée', 'entree', 'recette', 'recettes', 'credit']);
    const rawSortie = findValue(['sortie', 'sorties', 'dépense', 'depense', 'dépenses', 'depenses', 'debit']);

    const entreeAmount = parseAmount(rawEntree);
    const sortieAmount = parseAmount(rawSortie);

    let category: TransactionTypeCategory = 'sortie';
    let finalMontant: number;

    const hasEntree = entreeAmount !== null && entreeAmount > 0;
    const hasSortie = sortieAmount !== null && sortieAmount > 0;

    if (hasEntree && hasSortie) {
      return {
        error: {
          row: rowIndex,
          column: 'Montant',
          message: 'Une même opération ne peut pas être à la fois une Entrée et une Sortie. Veuillez renseigner une seule des deux colonnes.',
        },
      };
    } else if (hasEntree) {
      category = 'entree';
      finalMontant = Math.abs(entreeAmount);
    } else if (hasSortie) {
      category = 'sortie';
      finalMontant = -Math.abs(sortieAmount);
    } else {
      // Repli rétrocompatible : colonne unique "Montant" + colonne "Sens"
      const rawMontantStr = findValue(['montant', 'somme', 'valeur', 'total']);
      const legacyAmount = parseAmount(rawMontantStr);

      if (legacyAmount === null || legacyAmount === 0) {
        return {
          error: {
            row: rowIndex,
            column: 'Montant',
            message: 'Veuillez saisir un montant valide dans la colonne "Entrée" ou dans la colonne "Sortie".',
          },
        };
      }

      const sensValue = findValue(['sens', 'type', 'catégorie', 'categorie', 'nature']).toLowerCase();
      if (sensValue.includes('entree') || sensValue.includes('entrée') || sensValue.includes('credit') || sensValue.includes('appro')) {
        category = 'entree';
        finalMontant = Math.abs(legacyAmount);
      } else {
        category = 'sortie';
        finalMontant = -Math.abs(legacyAmount);
      }
    }

    // 4. Date (Normalisation tolérante et sans décalage de fuseau horaire)
    const rawDateValue = findRawValue(['date', 'jour', 'période', 'periode']);
    const dateFormatted = this.normalizeDate(rawDateValue);
    const dateIso = this.normalizeDateToIso(rawDateValue);

    // 5. Service
    const rawService = findValue(['service', 'departement', 'département']).toUpperCase();
    let matchedService: Service | undefined = undefined;
    for (const srv of CASHIER_SERVICES) {
      if (rawService.includes(srv) || srv.includes(rawService)) {
        matchedService = srv;
        break;
      }
    }

    // 6. Partenaire / Employé
    const partenaire = findValue(['partenaire', 'tiers', 'client', 'fournisseur', 'bénéficiaire', 'beneficiaire', 'employé', 'employe', 'agent']);

    // 7. N° Dossier
    const noDossier = findValue(['dossier', 'n° dossier', 'no dossier', 'ref', 'reference', 'numéro dossier']);

    // 8. Quantité
    const rawQty = findValue(['quantité', 'quantite', 'qte', 'qty']);
    const parsedQty = rawQty ? parseInt(rawQty, 10) : undefined;
    const quantity = isNaN(Number(parsedQty)) ? undefined : parsedQty;

    return {
      data: {
        date: dateFormatted,
        isoDate: dateIso,
        libelle,
        partenaire: partenaire || undefined,
        employee: partenaire || undefined,
        noDossier: noDossier || undefined,
        service: matchedService,
        quantity,
        montant: finalMontant,
        category,
        status: 'draft',
      },
    };
  }

  /**
   * Normalise une valeur de date (Date, nombre sériel Excel, chaîne) en format standard JJ/MM/AAAA.
   * Empêche strictement les décalages de fuseau horaire (UTC vs local).
   */
  public normalizeDate(rawDate: unknown): string {
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

    if (rawDate === null || rawDate === undefined || rawDate === '') {
      const now = new Date();
      return `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
    }

    // Cas 1 : Objet Date natif produit par ExcelJS
    if (rawDate instanceof Date) {
      if (!isNaN(rawDate.getTime())) {
        // Si l'heure UTC est proche de minuit (ex: 23:00 ou 00:00), privilégier la date locale ou UTC sans décalage
        // Pour les dates pures créées par Excel, le fuseau horaire UTC est utilisé
        const hours = rawDate.getUTCHours();
        // Si la date a été importée à minuit UTC, on extrait les composantes UTC pour ne pas décaler au jour d'avant/d'après
        const year = hours >= 12 ? rawDate.getFullYear() : rawDate.getUTCFullYear();
        const month = hours >= 12 ? rawDate.getMonth() + 1 : rawDate.getUTCMonth() + 1;
        const day = hours >= 12 ? rawDate.getDate() : rawDate.getUTCDate();
        return `${pad(day)}/${pad(month)}/${year}`;
      }
    }

    // Cas 2 : Numéro de série Excel (ex. 45549 pour le 15/09/2024)
    if (typeof rawDate === 'number' && !isNaN(rawDate) && rawDate > 0) {
      // 25569 = jours entre 1er janvier 1900 (avec le bug de l'année bissextile 1900 d'Excel) et 1er janvier 1970 UTC
      // Pour éviter les décalages d'heure d'été/fuseau, on ajoute un offset de midi (12h = 0.5 jour)
      const dateFromSerial = new Date(Math.round((rawDate - 25569) * 86400 * 1000) + 12 * 3600 * 1000);
      if (!isNaN(dateFromSerial.getTime())) {
        return `${pad(dateFromSerial.getUTCDate())}/${pad(dateFromSerial.getUTCMonth() + 1)}/${dateFromSerial.getUTCFullYear()}`;
      }
    }

    const dateStr = String(rawDate).trim();
    if (!dateStr) {
      const now = new Date();
      return `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
    }

    // Cas 2bis : Nombre représenté sous forme de chaîne numérique (ex. "45549")
    if (/^\d{4,5}(\.\d+)?$/.test(dateStr)) {
      const serialNum = parseFloat(dateStr);
      if (serialNum > 20000 && serialNum < 100000) {
        return this.normalizeDate(serialNum);
      }
    }

    // Cas 3 : Format JJ/MM/AAAA ou JJ-MM-AAAA ou JJ.MM.AAAA (avec ou sans heure supplémentaire)
    const dmyMatch = dateStr.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{2,4})/);
    if (dmyMatch) {
      const day = pad(parseInt(dmyMatch[1], 10));
      const month = pad(parseInt(dmyMatch[2], 10));
      let year = dmyMatch[3];
      if (year.length === 2) {
        const yNum = parseInt(year, 10);
        year = yNum < 70 ? `20${year}` : `19${year}`;
      }
      return `${day}/${month}/${year}`;
    }

    // Cas 4 : Format AAAA-MM-JJ ou AAAA/MM/JJ (ISO)
    const isoMatch = dateStr.match(/^(\d{4})[/. -](\d{1,2})[/. -](\d{1,2})/);
    if (isoMatch) {
      const year = isoMatch[1];
      const month = pad(parseInt(isoMatch[2], 10));
      const day = pad(parseInt(isoMatch[3], 10));
      return `${day}/${month}/${year}`;
    }

    // Cas 5 : Format textuel français (ex: "15 sept. 2026", "15 septembre 2026", "15-Sep-2026")
    const frenchMonthMap: Record<string, string> = {
      janv: '01', janvier: '01', jan: '01',
      fevr: '02', 'févr': '02', fevrier: '02', 'février': '02', feb: '02',
      mars: '03', mar: '03',
      avril: '04', avr: '04', apr: '04',
      mai: '05', may: '05',
      juin: '06', jun: '06',
      juil: '07', juillet: '07', jul: '07',
      aout: '08', 'août': '08', aug: '08',
      sept: '09', septembre: '09', sep: '09',
      oct: '10', octobre: '10',
      nov: '11', novembre: '11',
      dec: '12', 'déc': '12', decembre: '12', 'décembre': '12',
    };

    const textMonthMatch = dateStr.match(/^(\d{1,2})\s+([a-zA-Zàâéèêîôùûç.]+)\s+(\d{2,4})/i);
    if (textMonthMatch) {
      const day = pad(parseInt(textMonthMatch[1], 10));
      const monthKey = textMonthMatch[2].toLowerCase().replace('.', '').trim();
      let matchedMonth = '';
      for (const [key, num] of Object.entries(frenchMonthMap)) {
        if (monthKey.startsWith(key)) {
          matchedMonth = num;
          break;
        }
      }
      if (matchedMonth) {
        let year = textMonthMatch[3];
        if (year.length === 2) {
          const yNum = parseInt(year, 10);
          year = yNum < 70 ? `20${year}` : `19${year}`;
        }
        return `${day}/${matchedMonth}/${year}`;
      }
    }

    // Cas 6 : Tentative de parsing via Date.parse si format standard reconnu
    const parsedTimestamp = Date.parse(dateStr);
    if (!isNaN(parsedTimestamp)) {
      const d = new Date(parsedTimestamp);
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    }

    return dateStr;
  }

  /**
   * Normalise une valeur de date (Date, nombre sériel Excel, chaîne) en format standard ISO AAAA-MM-JJ (YYYY-MM-DD).
   * Assure la conformité pour la persistance en base de données PostgreSQL afin de garantir un tri chronologique strict.
   */
  public normalizeDateToIso(rawDate: unknown): string {
    const dmy = this.normalizeDate(rawDate);
    if (!dmy) return '';
    const parts = dmy.split('/');
    if (parts.length === 3) {
      const day = parts[0].padStart(2, '0');
      const month = parts[1].padStart(2, '0');
      const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
      return `${year}-${month}-${day}`;
    }
    return dmy;
  }

  /**
   * Génère et télécharge le fichier modèle Excel vierge pour la caissière
   */
  public async downloadExcelTemplate(): Promise<void> {
    const headers = [
      'Date (JJ/MM/AAAA)',
      'Libellé de l\'opération',
      'Entrée (FCFA)',
      'Sortie (FCFA)',
      'Service',
      'Partenaire / Employé',
      'N° Dossier',
      'Quantité',
    ];

    // Modèle vierge sans données de démonstration (uniquement les en-têtes)
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Modèle Caisse');
    worksheet.addRow(headers);
    [18, 35, 18, 18, 16, 26, 16, 10].forEach((width, index) => {
      worksheet.getColumn(index + 1).width = width;
    });
    const fileName = 'modele_import_caisse.xlsx';
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }
}
