import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { MailComposerDraft, SendMailRequestDto } from '../../../core/models/mail.model';
import { MailComposerComponent } from './mail-composer';

describe('MailComposerComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MailComposerComponent],
    });
  });

  function createFixture(draft: MailComposerDraft) {
    const fixture = TestBed.createComponent(MailComposerComponent);
    fixture.componentRef.setInput('draft', draft);
    fixture.componentRef.setInput('senderEmail', 'erwinalberic@transimex-cm.com');
    fixture.detectChanges();
    return fixture;
  }

  it('pré-remplit le formulaire en mode réponse et affiche l’expéditeur en lecture seule', () => {
    const fixture = createFixture({
      mode: 'reply',
      to: ['client@example.com'],
      cc: ['manager@transimex-cm.com'],
      bcc: [],
      subject: 'Re: Cotation Douala',
      textBody: '\n\n--- Message d’origine ---\nBonjour',
      inReplyTo: '<msg-1@example.com>',
      references: ['<msg-1@example.com>'],
    });

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#mail-composer-title')?.textContent?.trim()).toBe('Répondre');
    expect(el.querySelector('#mail-composer-from')?.textContent?.trim()).toBe(
      'erwinalberic@transimex-cm.com'
    );
    expect(fixture.componentInstance.showCc()).toBe(true);
    expect(fixture.componentInstance.form.controls.toText.value).toBe('client@example.com');
  });

  it('bloque l’envoi si une adresse destinataire est invalide', () => {
    const fixture = createFixture({
      mode: 'new',
      to: [],
      cc: [],
      bcc: [],
      subject: 'Test',
      textBody: 'Contenu',
      inReplyTo: null,
      references: [],
    });

    const emitted: SendMailRequestDto[] = [];
    fixture.componentInstance.send.subscribe((payload) => emitted.push(payload));

    fixture.componentInstance.form.patchValue({
      toText: 'adresse-invalide',
      subject: 'Objet test',
      textBody: 'Corps du message',
    });
    fixture.componentInstance.onSubmit();
    fixture.detectChanges();

    expect(emitted.length).toBe(0);
    expect(fixture.componentInstance.validationError()).toContain('Adresse email invalide');
  });

  it('bloque l’envoi au-delà de 50 destinataires cumulés', () => {
    const fixture = createFixture({
      mode: 'new',
      to: [],
      cc: [],
      bcc: [],
      subject: 'Test',
      textBody: 'Contenu',
      inReplyTo: null,
      references: [],
    });

    const emitted: SendMailRequestDto[] = [];
    fixture.componentInstance.send.subscribe((payload) => emitted.push(payload));

    const fiftyOne = Array.from({ length: 51 }, (_, i) => `user${i}@example.com`).join(', ');
    fixture.componentInstance.form.patchValue({
      toText: fiftyOne,
      subject: 'Diffusion',
      textBody: 'Contenu',
    });
    fixture.componentInstance.onSubmit();

    expect(emitted.length).toBe(0);
    expect(fixture.componentInstance.validationError()).toContain('50');
  });

  it('émet un payload texte simple dédupliqué avec inReplyTo et references', () => {
    const fixture = createFixture({
      mode: 'reply_all',
      to: ['client@example.com'],
      cc: ['copie@example.com'],
      bcc: [],
      subject: 'Re: Offre 40HC',
      textBody: 'Merci pour votre retour.',
      inReplyTo: '<orig-42@example.com>',
      references: ['<root@example.com>', '<orig-42@example.com>'],
    });

    const spy = vi.fn();
    fixture.componentInstance.send.subscribe(spy);

    fixture.componentInstance.form.patchValue({
      toText: 'client@example.com; CLIENT@example.com',
      ccText: 'copie@example.com',
      subject: 'Re: Offre 40HC',
      textBody: 'Merci pour votre retour.',
    });
    fixture.componentInstance.onSubmit();

    expect(spy).toHaveBeenCalledWith({
      to: ['client@example.com'],
      cc: ['copie@example.com'],
      bcc: [],
      subject: 'Re: Offre 40HC',
      textBody: 'Merci pour votre retour.',
      inReplyTo: '<orig-42@example.com>',
      references: ['<root@example.com>', '<orig-42@example.com>'],
    });
  });
});
