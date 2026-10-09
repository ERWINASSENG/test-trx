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
    });
    expect(result.data?.rows).toHaveLength(2);
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
