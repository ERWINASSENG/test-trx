import { describe, expect, it } from 'vitest';
import { validateQuotePayload } from './quotes';

const prospectId = '54a1d1d1-297d-4bad-8c36-4c864c3526dc';
const descriptionId = 'c64db547-5cf7-42e0-aa59-66b100c4a2c1';
const amountId = '91a8723a-f935-45f5-b932-afd16c5d38d7';

const validPayload = () => ({
  prospectId,
  title: 'Transport de marchandises',
  currency: 'XAF',
  columns: [
    { id: descriptionId, label: 'Désignation', type: 'text' },
    { id: amountId, label: 'Montant', type: 'amount' },
  ],
  rows: [
    { [descriptionId]: 'Livraison', [amountId]: 15000 },
    { [descriptionId]: 'Manutention', [amountId]: 5000 },
  ],
  totalColumnId: amountId,
  status: 'draft',
  validUntil: '2026-12-31',
  seaFreight: {
    contactName: 'Jean Nono',
    grossWeightKg: 24000,
    serviceTypes: { fcl: false, lcl: false, roro: false, breakBulk: false },
    availableDocuments: {
      commercialInvoice: false,
      packingList: false,
      certificateOfOrigin: false,
      msdsTechnicalSheet: false,
    },
    additionalServices: {
      customsClearance: false,
      cargoInsurance: false,
      warehousing: false,
      portHandling: false,
      tracking: false,
    },
  },
});

describe('validateQuotePayload', () => {
  it('accepte une cotation avec colonnes personnalisées et une date valide', () => {
    const result = validateQuotePayload(validPayload());

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({
      prospectId,
      title: 'Transport de marchandises',
      currency: 'XAF',
      totalColumnId: amountId,
      status: 'draft',
      validUntil: '2026-12-31',
      seaFreight: {
        contactName: 'Jean Nono',
        grossWeightKg: 24000,
        serviceTypes: { fcl: false, lcl: false, roro: false, breakBulk: false },
        availableDocuments: {
          commercialInvoice: false,
          packingList: false,
          certificateOfOrigin: false,
          msdsTechnicalSheet: false,
        },
        additionalServices: {
          customsClearance: false,
          cargoInsurance: false,
          warehousing: false,
          portHandling: false,
          tracking: false,
        },
      },
    });
    expect(result.data?.rows).toHaveLength(2);
  });

  it('exige et valide les détails maritimes, y compris les cases décochées', () => {
    const missingDetails = validPayload();
    delete (missingDetails as Partial<typeof missingDetails>).seaFreight;
    expect(validateQuotePayload(missingDetails).error).toContain('détails maritimes');

    const invalidDetails = validPayload();
    invalidDetails.seaFreight.grossWeightKg = -1;
    expect(validateQuotePayload(invalidDetails).error).toContain('nombre positif');

    const unsupportedDetails = validPayload();
    (unsupportedDetails.seaFreight as Record<string, unknown>).unexpected = true;
    expect(validateQuotePayload(unsupportedDetails).error).toContain('champ non autorisé');

    const accepted = validateQuotePayload(validPayload());
    expect(accepted.data?.seaFreight?.serviceTypes?.fcl).toBe(false);
    expect(accepted.data?.seaFreight?.availableDocuments?.commercialInvoice).toBe(false);
    expect(accepted.data?.seaFreight?.additionalServices?.tracking).toBe(false);
  });

  it('exige une colonne montant pour calculer le total', () => {
    const payload = validPayload();
    payload.totalColumnId = descriptionId;

    expect(validateQuotePayload(payload).error).toContain('montant');
  });

  it('rejette un montant négatif et une date invalide', () => {
    const negativeAmount = validPayload();
    negativeAmount.rows[0][amountId] = -1;
    expect(validateQuotePayload(negativeAmount).error).toContain('montant');

    const invalidDate = validPayload();
    invalidDate.validUntil = '2026-02-30';
    expect(validateQuotePayload(invalidDate).error).toContain('date');
  });

  it('rejette une structure incomplète lors d’une mise à jour', () => {
    expect(validateQuotePayload({ title: 'Nouvel objet', status: 'sent', columns: [] }, true).error)
      .toContain('colonnes, les lignes');
  });

  it('refuse les champs non autorisés et les colonnes inconnues', () => {
    expect(validateQuotePayload({ ...validPayload(), isAdmin: true }).error).toContain('non autorisé');

    const payload = validPayload();
    expect(validateQuotePayload({
      ...payload,
      rows: [{ ...payload.rows[0], 'unknown-column': 'interdit' }],
    }).error).toContain('colonne inconnue');
  });
});
