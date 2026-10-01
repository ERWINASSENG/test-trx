import { describe, expect, it } from 'vitest';
import { validateProspectPayload } from './prospects';

describe('validateProspectPayload', () => {
  it('accepte un prospect valide et conserve les champs autorisés', () => {
    const result = validateProspectPayload({
      name: 'Transimex Cameroun',
      companyName: 'Transimex',
      contactName: 'Amina Njoya',
      email: 'amina@example.cm',
      phone: '+237 600 000 000',
      source: 'Salon professionnel',
      status: 'qualified',
      estimatedValue: 120000,
      currency: 'xaf',
      nextFollowUp: '2026-10-20',
      notes: 'Rappeler après la démonstration.',
    });

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({
      name: 'Transimex Cameroun',
      company_name: 'Transimex',
      contact_name: 'Amina Njoya',
      status: 'qualified',
      estimated_value: 120000,
      currency: 'XAF',
      next_follow_up: '2026-10-20',
    });
  });

  it('rejette un nom absent, un statut inconnu et un e-mail invalide', () => {
    expect(validateProspectPayload({}).error).toContain('nom du prospect');
    expect(validateProspectPayload({ name: 'Acme', status: 'pending' }).error).toContain('statut');
    expect(validateProspectPayload({ name: 'Acme', email: 'invalid' }).error).toContain('e-mail');
  });

  it('rejette les champs hors liste blanche et les valeurs négatives', () => {
    expect(validateProspectPayload({ name: 'Acme', isAdmin: true }).error).toContain('non autorisé');
    expect(validateProspectPayload({ name: 'Acme', estimatedValue: -1 }).error).toContain('positif');
  });

  it('accepte les champs facultatifs explicitement définis à null', () => {
    const result = validateProspectPayload({
      name: 'Acme', companyName: null, contactName: null, email: null,
      phone: null, source: null,
    });

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({
      company_name: null, contact_name: null, email: null, phone: null, source: null,
    });
  });

  it('accepte une mise à jour partielle et refuse un corps vide', () => {
    expect(validateProspectPayload({ status: 'contacted' }, true).data).toEqual({ status: 'contacted' });
    expect(validateProspectPayload({}, true).error).toContain('Aucun champ');
  });

  it('valide la date et le format du responsable', () => {
    expect(validateProspectPayload({ name: 'Acme', nextFollowUp: '2026-02-30' }).error).toContain('date');
    expect(validateProspectPayload({ name: 'Acme', assignedTo: 'not-a-uuid' }).error).toContain('responsable');
  });
});
