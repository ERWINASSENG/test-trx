import { describe, expect, it } from 'vitest';
import {
  validateCrmClientPayload,
  validateCrmOpportunityPayload,
} from './crm';

describe('CRM payload validation', () => {
  it('normalizes company details before inserting a shared client record', () => {
    const result = validateCrmClientPayload({
      companyName: '  Transmex  ',
      email: '  SALES@TRANSMEX.CM ',
      country: ' Cameroun ',
    });

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({
      name: 'Transmex',
      company_name: 'Transmex',
      email: 'sales@transmex.cm',
      country: 'Cameroun',
      status: 'new',
    });
  });

  it('rejects fields outside the CRM client contract', () => {
    expect(validateCrmClientPayload({ companyName: 'Transmex', owner: 'another-user' }).error)
      .toBe('La demande contient un champ non autorisé.');
  });

  it('normalizes valid opportunity enums, amounts, and currency', () => {
    const result = validateCrmOpportunityPayload({
      prospectId: '123e4567-e89b-42d3-a456-426614174000',
      title: '  Import de pièces  ',
      transportMode: 'sea',
      direction: 'import',
      estimatedValue: '1250.50',
      currency: 'xaf',
      expectedCloseDate: '2026-11-15',
    });

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({
      title: 'Import de pièces',
      transport_mode: 'sea',
      direction: 'import',
      estimated_value: 1250.5,
      currency: 'XAF',
      expected_close_date: '2026-11-15',
    });
  });

  it('rejects invalid opportunity stages, transport modes, and negative values', () => {
    expect(validateCrmOpportunityPayload({
      prospectId: '123e4567-e89b-42d3-a456-426614174000',
      title: 'Import',
      stage: 'unknown',
    }).error).toBe('L’étape commerciale sélectionnée est invalide.');
    expect(validateCrmOpportunityPayload({
      prospectId: '123e4567-e89b-42d3-a456-426614174000',
      title: 'Import',
      transportMode: 'road',
    }).error).toBe('Le mode de transport doit être aérien ou maritime.');
    expect(validateCrmOpportunityPayload({
      prospectId: '123e4567-e89b-42d3-a456-426614174000',
      title: 'Import',
      estimatedValue: -1,
    }).error).toBe('La valeur estimatedValue doit être un nombre positif valide.');
  });
});
