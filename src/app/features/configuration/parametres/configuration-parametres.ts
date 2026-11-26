import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { AccessControlService } from '../../../core/services/access-control.service';
import { MailAccountService } from '../../../core/services/mail-account.service';

@Component({
  selector: 'app-configuration-parametres',
  imports: [ReactiveFormsModule, DatePipe],
  templateUrl: './configuration-parametres.html',
  styleUrl: './configuration-parametres.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfigurationParametresComponent implements OnInit {
  private readonly accessControl = inject(AccessControlService, { optional: true });
  private readonly mailAccountService = inject(MailAccountService, { optional: true });

  public readonly canReadConfig = computed(() =>
    Boolean(this.accessControl?.hasPermission('configuration.read'))
  );
  public readonly canManageConfig = computed(() =>
    Boolean(this.accessControl?.hasPermission('configuration.manage'))
  );

  public readonly encryptionReady = computed(() =>
    Boolean(this.mailAccountService?.encryptionReady())
  );
  public readonly teamMailboxes = computed(() =>
    this.mailAccountService?.teamMailboxes() ?? []
  );
  public readonly isLoading = computed(() =>
    Boolean(this.mailAccountService?.isLoadingAdmin())
  );

  public readonly isSaving = signal<boolean>(false);
  public readonly feedback = signal<string | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  public readonly settingsForm = new FormGroup({
    imapHost: new FormControl<string>('', { nonNullable: true }),
    imapPort: new FormControl<number>(993, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(1), Validators.max(65535)],
    }),
    imapTls: new FormControl<boolean>(true, { nonNullable: true }),
    smtpHost: new FormControl<string>('', { nonNullable: true }),
    smtpPort: new FormControl<number>(465, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(1), Validators.max(65535)],
    }),
    smtpTls: new FormControl<boolean>(true, { nonNullable: true }),
    watchedFolder: new FormControl<string>('INBOX', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(128)],
    }),
    subjectKeywordsText: new FormControl<string>(
      'cotation, devis, rfq, tarif, fret, quotation, quote, conteneur, fcl, lcl, dédouanement, transit',
      { nonNullable: true }
    ),
    excludedSendersText: new FormControl<string>('noreply@, no-reply@, newsletter@', {
      nonNullable: true,
    }),
    isEnabled: new FormControl<boolean>(true, { nonNullable: true }),
  });

  public ngOnInit(): void {
    if (this.canReadConfig() && this.mailAccountService) {
      void this.reloadSettings();
    }
  }

  public async reloadSettings(): Promise<void> {
    if (!this.mailAccountService) return;
    this.errorMessage.set(null);
    const res = await this.mailAccountService.loadAdminMailSettings();
    if (!res.success) {
      this.errorMessage.set(res.error || 'Impossible de charger les paramètres serveur mail.');
      return;
    }

    const s = res.data?.settings;
    if (s) {
      this.settingsForm.patchValue({
        imapHost: s.imapHost,
        imapPort: s.imapPort,
        imapTls: s.imapTls,
        smtpHost: s.smtpHost,
        smtpPort: s.smtpPort,
        smtpTls: s.smtpTls,
        watchedFolder: s.watchedFolder,
        subjectKeywordsText: s.subjectKeywords.join(', '),
        excludedSendersText: s.excludedSenders.join(', '),
        isEnabled: s.isEnabled,
      });
    }
  }

  public async onSaveSettings(): Promise<void> {
    if (!this.canManageConfig() || !this.mailAccountService || this.isSaving()) return;
    if (this.settingsForm.invalid) {
      this.settingsForm.markAllAsTouched();
      return;
    }

    const val = this.settingsForm.getRawValue();
    const parseList = (raw: string): string[] =>
      raw
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);

    const subjectKeywords = parseList(val.subjectKeywordsText);
    const excludedSenders = parseList(val.excludedSendersText);

    if (val.watchedFolder.trim().toUpperCase() === 'INBOX' && subjectKeywords.length === 0) {
      this.errorMessage.set(
        'Veuillez définir au moins un mot-clé de cotation lorsque le dossier surveillé est INBOX.'
      );
      return;
    }

    this.isSaving.set(true);
    this.errorMessage.set(null);
    this.feedback.set(null);

    try {
      const res = await this.mailAccountService.saveAdminMailSettings({
        imapHost: val.imapHost.trim().toLowerCase(),
        imapPort: Number(val.imapPort),
        imapTls: Boolean(val.imapTls),
        smtpHost: val.smtpHost.trim().toLowerCase(),
        smtpPort: Number(val.smtpPort),
        smtpTls: Boolean(val.smtpTls),
        watchedFolder: val.watchedFolder.trim(),
        subjectKeywords,
        excludedSenders,
        isEnabled: Boolean(val.isEnabled),
      });

      if (!res.success) {
        this.errorMessage.set(res.error || 'Échec de l’enregistrement des paramètres mail.');
        return;
      }

      this.feedback.set('Paramètres du serveur mail Outlook / IMAP enregistrés avec succès.');
    } finally {
      this.isSaving.set(false);
    }
  }
}
