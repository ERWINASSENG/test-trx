import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import {
  MailComposerDraft,
  MailComposerMode,
  SendMailRequestDto,
} from '../../../core/models/mail.model';

const EMAIL_ITEM_PATTERN =
  /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[^\s@<>(),;:"\\[\]]{2,}$/;
const MAX_RECIPIENTS = 50;

@Component({
  selector: 'app-mail-composer',
  imports: [ReactiveFormsModule, MatIconModule],
  templateUrl: './mail-composer.html',
  styleUrl: './mail-composer.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'onEscapeKey()',
  },
})
export class MailComposerComponent {
  public readonly draft = input.required<MailComposerDraft>();
  public readonly senderEmail = input<string | null>(null);
  public readonly isSending = input<boolean>(false);
  public readonly serverError = input<string | null>(null);

  public readonly send = output<SendMailRequestDto>();
  public readonly closed = output<void>();

  public readonly showCc = signal<boolean>(false);
  public readonly showBcc = signal<boolean>(false);
  public readonly validationError = signal<string | null>(null);

  public readonly form = new FormGroup({
    toText: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    ccText: new FormControl<string>('', { nonNullable: true }),
    bccText: new FormControl<string>('', { nonNullable: true }),
    subject: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(250)],
    }),
    textBody: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(100_000)],
    }),
  });

  public readonly titleLabel = computed<string>(() => {
    const mode: MailComposerMode = this.draft().mode;
    switch (mode) {
      case 'reply':
        return 'Répondre';
      case 'reply_all':
        return 'Répondre à tous';
      case 'forward':
        return 'Transférer le message';
      default:
        return 'Nouveau message';
    }
  });

  constructor() {
    effect(() => {
      const current = this.draft();
      this.validationError.set(null);
      this.showCc.set(current.cc.length > 0);
      this.showBcc.set(current.bcc.length > 0);
      this.form.reset({
        toText: current.to.join(', '),
        ccText: current.cc.join(', '),
        bccText: current.bcc.join(', '),
        subject: current.subject,
        textBody: current.textBody,
      });
    });
  }

  public toggleCc(): void {
    this.showCc.update((v) => !v);
  }

  public toggleBcc(): void {
    this.showBcc.update((v) => !v);
  }

  public onCancel(): void {
    if (this.isSending()) return;
    this.closed.emit();
  }

  public onEscapeKey(): void {
    this.onCancel();
  }

  public onBodyKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      this.onSubmit();
    }
  }

  public onSubmit(): void {
    if (this.isSending()) return;
    this.validationError.set(null);

    const toParsed = this.parseAddressList(this.form.controls.toText.value, 'À');
    if (!toParsed.ok) {
      this.validationError.set(toParsed.error);
      return;
    }

    const ccParsed = this.parseAddressList(this.form.controls.ccText.value, 'Cc');
    if (!ccParsed.ok) {
      this.validationError.set(ccParsed.error);
      return;
    }

    const bccParsed = this.parseAddressList(this.form.controls.bccText.value, 'Cci');
    if (!bccParsed.ok) {
      this.validationError.set(bccParsed.error);
      return;
    }

    if (toParsed.emails.length === 0) {
      this.validationError.set('Renseignez au moins un destinataire valide dans le champ À.');
      return;
    }

    const totalRecipients =
      toParsed.emails.length + ccParsed.emails.length + bccParsed.emails.length;
    if (totalRecipients > MAX_RECIPIENTS) {
      this.validationError.set(
        `Le nombre total de destinataires ne peut pas dépasser ${MAX_RECIPIENTS} (actuellement ${totalRecipients}).`
      );
      return;
    }

    const subject = this.form.controls.subject.value.trim();
    if (!subject) {
      this.validationError.set('L’objet du message est obligatoire.');
      return;
    }
    if (subject.length > 250) {
      this.validationError.set('L’objet ne peut pas dépasser 250 caractères.');
      return;
    }

    const textBody = this.form.controls.textBody.value;
    if (!textBody.trim()) {
      this.validationError.set('Le message ne peut pas être vide.');
      return;
    }

    const currentDraft = this.draft();
    this.send.emit({
      to: toParsed.emails,
      cc: ccParsed.emails,
      bcc: bccParsed.emails,
      subject,
      textBody,
      inReplyTo: currentDraft.inReplyTo,
      references: currentDraft.references,
    });
  }

  private parseAddressList(
    raw: string,
    fieldLabel: string
  ): { ok: true; emails: string[] } | { ok: false; error: string } {
    const tokens = raw
      .split(/[,;\n]+/)
      .map((part) => part.trim())
      .filter(Boolean);

    const seen = new Set<string>();
    const emails: string[] = [];

    for (const token of tokens) {
      if (token.length > 254 || !EMAIL_ITEM_PATTERN.test(token)) {
        return {
          ok: false,
          error: `Adresse email invalide dans ${fieldLabel} : « ${token.slice(0, 60)} ».`,
        };
      }
      const lower = token.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        emails.push(token);
      }
    }

    return { ok: true, emails };
  }
}
