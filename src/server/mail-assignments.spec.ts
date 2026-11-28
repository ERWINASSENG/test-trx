import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  buildForwardedAssignTextBody,
  isInternalCompanyEmail,
  markMailAssignmentOpenedByMessageId,
  validateForwardAssignPayload,
} from './mail-assignments.handlers';

const VALID_COMMERCIAL_ID = '11111111-2222-4333-8444-555555555555';

describe('mail-assignments.handlers', () => {
  it('valide un payload de transfert suivi valide et normalise clientEmail', () => {
    const res = validateForwardAssignPayload({
      assignedTo: VALID_COMMERCIAL_ID,
      clientEmail: '  Client@Exemple.CM ',
      clientName: '  Société Exemple  ',
      note: 'Merci de traiter avant 16h.',
    });

    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.data.assignedTo).toBe(VALID_COMMERCIAL_ID);
      expect(res.data.clientEmail).toBe('client@exemple.cm');
      expect(res.data.clientName).toBe('Société Exemple');
      expect(res.data.note).toBe('Merci de traiter avant 16h.');
    }
  });

  it('rejette un assignedTo non UUID, un clientEmail avec CRLF et une note trop longue', () => {
    expect(validateForwardAssignPayload({ assignedTo: 'not-a-uuid' }).valid).toBe(false);
    expect(
      validateForwardAssignPayload({
        assignedTo: VALID_COMMERCIAL_ID,
        clientEmail: 'client@exemple.cm\r\nBcc: evil@attacker.com',
      }).valid
    ).toBe(false);
    expect(
      validateForwardAssignPayload({
        assignedTo: VALID_COMMERCIAL_ID,
        note: 'x'.repeat(1001),
      }).valid
    ).toBe(false);
    expect(
      validateForwardAssignPayload({
        assignedTo: VALID_COMMERCIAL_ID,
        note: 'Texte\0injecté',
      }).valid
    ).toBe(false);
  });

  it('construit un corps transféré en texte simple avec consigne et client d’origine', () => {
    const body = buildForwardedAssignTextBody({
      note: 'Prioritaire pour Douala',
      clientEmail: 'achats@client.cm',
      clientName: 'Client SA',
      originalDate: '2026-11-28T09:15:00.000Z',
      originalSubject: 'Demande de cotation 2x40HC',
      originalTextBody: 'Bonjour, merci de nous transmettre votre tarif.',
    });

    expect(body).toContain('Prioritaire pour Douala');
    expect(body).toContain('Client : Client SA <achats@client.cm>');
    expect(body).toContain('Objet : Demande de cotation 2x40HC');
    expect(body).toContain('Bonjour, merci de nous transmettre votre tarif.');
  });

  it('marque ouvert un transfert uniquement pour le commercial assigné (anti-falsification)', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'assign-1' }, error: null });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eqStatus = vi.fn().mockReturnValue({ select });
    const isOpenedNull = vi.fn().mockReturnValue({ eq: eqStatus });
    const eqMsgId = vi.fn().mockReturnValue({ is: isOpenedNull });
    const eqAssignedTo = vi.fn().mockReturnValue({ eq: eqMsgId });
    const update = vi.fn().mockReturnValue({ eq: eqAssignedTo });
    const from = vi.fn().mockReturnValue({ update });
    const mockClient = { from } as unknown as SupabaseClient;

    const result = await markMailAssignmentOpenedByMessageId(mockClient, {
      assignedTo: VALID_COMMERCIAL_ID,
      messageId: '<fwd-123@transimex-cm.com>',
      channel: 'webmail',
      imapUid: 42,
    });

    expect(result).toEqual({ updated: true, assignmentId: 'assign-1' });
    expect(from).toHaveBeenCalledWith('mail_assignments');
    expect(eqAssignedTo).toHaveBeenCalledWith('assigned_to', VALID_COMMERCIAL_ID);
    expect(eqMsgId).toHaveBeenCalledWith('forwarded_message_id', '<fwd-123@transimex-cm.com>');
    expect(isOpenedNull).toHaveBeenCalledWith('opened_at', null);

    // Refuse sans interroger la DB si UUID invalide
    const invalidResult = await markMailAssignmentOpenedByMessageId(mockClient, {
      assignedTo: 'invalid-id',
      messageId: '<fwd-123@transimex-cm.com>',
      channel: 'webmail',
    });
    expect(invalidResult).toEqual({ updated: false });
  });

  it('identifie correctement une adresse interne active et neutralise % et _', async () => {
    const profileLimit = vi.fn().mockResolvedValue({
      data: [{ email: 'manager@transimex-cm.com' }],
      error: null,
    });
    const profileIlike = vi.fn().mockReturnValue({ limit: profileLimit });
    const profileEq = vi.fn().mockReturnValue({ ilike: profileIlike });
    const profileSelect = vi.fn().mockReturnValue({ eq: profileEq });

    const mailboxLimit = vi.fn().mockResolvedValue({ data: [], error: null });
    const mailboxIlike = vi.fn().mockReturnValue({ limit: mailboxLimit });
    const mailboxEq = vi.fn().mockReturnValue({ ilike: mailboxIlike });
    const mailboxSelect = vi.fn().mockReturnValue({ eq: mailboxEq });

    const from = vi.fn((table: string) =>
      table === 'profiles' ? { select: profileSelect } : { select: mailboxSelect }
    );
    const mockClient = { from } as unknown as SupabaseClient;

    expect(await isInternalCompanyEmail(mockClient, 'Manager@Transimex-cm.com')).toBe(true);
    expect(await isInternalCompanyEmail(mockClient, 'client@externe.com')).toBe(false);
  });
});
