import { describe, expect, it } from 'vitest';
import {
  MAX_SMTP_RECIPIENTS,
  MAX_SMTP_SUBJECT_LENGTH,
  validateSendMailPayload,
} from './mail-smtp';

describe('mail-smtp — validation stricte, anti-CRLF & plafond destinataires', () => {
  it('accepte un message texte simple valide avec To, Cc, Bcc et en-têtes de réponse', () => {
    const res = validateSendMailPayload({
      to: ['client@example.com', 'CLIENT@example.com'],
      cc: ['manager@transimex-cm.com'],
      bcc: ['audit@transimex-cm.com'],
      subject: 'Re: Cotation Douala 40HC',
      textBody: 'Bonjour,\nVeuillez trouver notre proposition tarifaire.\nCordialement.',
      inReplyTo: '<orig-123@example.com>',
      references: ['<root-1@example.com>', '<orig-123@example.com>'],
      // Champs hostiles supplémentaires : doivent être totalement ignorés
      from: 'ceo@evil.example',
      html: '<script>alert(1)</script>',
      accountId: '00000000-0000-0000-0000-000000000000',
    });

    expect(res.valid).toBe(true);
    if (!res.valid) return;

    expect(res.data.to).toEqual(['client@example.com']);
    expect(res.data.cc).toEqual(['manager@transimex-cm.com']);
    expect(res.data.bcc).toEqual(['audit@transimex-cm.com']);
    expect(res.data.totalRecipients).toBe(3);
    expect(res.data.inReplyTo).toBe('<orig-123@example.com>');
    expect(res.data.references).toEqual(['<root-1@example.com>', '<orig-123@example.com>']);
    expect('from' in res.data).toBe(false);
    expect('html' in res.data).toBe(false);
  });

  it('rejette toute tentative d’injection d’en-têtes SMTP (CRLF / NUL) dans subject, adresses ou In-Reply-To', () => {
    const crlfSubject = validateSendMailPayload({
      to: ['client@example.com'],
      subject: 'Objet\r\nBcc: attacker@evil.com',
      textBody: 'Contenu',
    });
    expect(crlfSubject.valid).toBe(false);

    const crlfRecipient = validateSendMailPayload({
      to: ['client@example.com\r\nBcc: attacker@evil.com'],
      subject: 'Objet',
      textBody: 'Contenu',
    });
    expect(crlfRecipient.valid).toBe(false);

    const crlfInReplyTo = validateSendMailPayload({
      to: ['client@example.com'],
      subject: 'Objet',
      textBody: 'Contenu',
      inReplyTo: '<id@example.com>\nX-Injected: 1',
    });
    expect(crlfInReplyTo.valid).toBe(false);

    const nullBody = validateSendMailPayload({
      to: ['client@example.com'],
      subject: 'Objet',
      textBody: 'Bonjour\u0000secret',
    });
    expect(nullBody.valid).toBe(false);
  });

  it('rejette les messages dépassant le plafond de 50 destinataires cumulés', () => {
    const tooManyTo = Array.from(
      { length: MAX_SMTP_RECIPIENTS - 1 },
      (_, idx) => `dest${idx}@example.com`
    );
    const res = validateSendMailPayload({
      to: tooManyTo,
      cc: ['extra1@example.com', 'extra2@example.com'],
      subject: 'Campagne',
      textBody: 'Contenu',
    });
    expect(res.valid).toBe(false);
  });

  it('rejette les adresses invalides, un champ À vide, un objet trop long ou un corps vide', () => {
    expect(
      validateSendMailPayload({ to: [], subject: 'Test', textBody: 'Corps' }).valid
    ).toBe(false);

    expect(
      validateSendMailPayload({ to: ['not-an-email'], subject: 'Test', textBody: 'Corps' }).valid
    ).toBe(false);

    expect(
      validateSendMailPayload({
        to: ['client@example.com'],
        subject: 'A'.repeat(MAX_SMTP_SUBJECT_LENGTH + 1),
        textBody: 'Corps',
      }).valid
    ).toBe(false);

    expect(
      validateSendMailPayload({
        to: ['client@example.com'],
        subject: 'Test',
        textBody: '   \n  ',
      }).valid
    ).toBe(false);
  });
});
