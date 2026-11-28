import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import {
  MailAddressDto,
  MailComposerDraft,
  MailDetailDto,
  MailFolderDto,
  MailFolderSpecialUse,
  MailSummaryDto,
  SendMailRequestDto,
} from '../../core/models/mail.model';
import { AccessControlService } from '../../core/services/access-control.service';
import { MailService } from '../../core/services/mail.service';
import { MailComposerComponent } from './mail-composer/mail-composer';

@Component({
  selector: 'app-mail-client',
  imports: [DatePipe, RouterLink, MatIconModule, MailComposerComponent],
  templateUrl: './mail-client.html',
  styleUrl: './mail-client.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MailClientComponent implements OnInit {
  public readonly mailService = inject(MailService);
  public readonly accessControl = inject(AccessControlService);

  public readonly remoteImagesAllowed = signal<boolean>(false);
  public readonly showPlainText = signal<boolean>(false);
  public readonly isMobileFoldersOpen = signal<boolean>(false);
  public readonly activeComposerDraft = signal<MailComposerDraft | null>(null);
  public readonly composerError = signal<string | null>(null);
  public readonly sendFeedback = signal<string | null>(null);

  public readonly canReadMail = computed(() =>
    this.accessControl.hasPermission('mail.read')
  );
  public readonly canSendMail = computed(() =>
    this.accessControl.hasPermission('mail.send')
  );
  public readonly canConnectMail = computed(() =>
    this.accessControl.hasPermission('mail.self.connect')
  );

  public readonly isMailboxMissing = computed(() => {
    const code = this.mailService.errorCode();
    return code === 'MAILBOX_NOT_CONNECTED' || code === 'MAIL_SERVER_NOT_CONFIGURED';
  });

  public readonly isAuthExpired = computed(
    () => this.mailService.errorCode() === 'MAILBOX_AUTH_FAILED'
  );

  public readonly activeFolderMeta = computed<MailFolderDto | null>(() => {
    const selected = this.mailService.selectedFolder();
    return this.mailService.folders().find((f) => f.path === selected) ?? null;
  });

  public readonly totalPages = computed(() => {
    const total = this.mailService.totalMessages();
    const limit = this.mailService.limit();
    if (total <= 0 || limit <= 0) return 1;
    return Math.max(1, Math.ceil(total / limit));
  });

  /**
   * Corps HTML déjà assaini côté serveur (sanitize-html) et passé directement à
   * <iframe [srcdoc]> sans bypassSecurityTrustHtml (double validation Angular SecurityContext.HTML
   * + isolation iframe sandbox sans allow-scripts ni allow-same-origin).
   */
  public readonly sandboxedEmailHtml = computed<string>(() => {
    const detail = this.mailService.selectedMessage();
    if (!detail) return '';
    return `<div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.6; color: #0f172a; padding: 8px; word-break: break-word;">${detail.sanitizedHtml}</div>`;
  });

  public ngOnInit(): void {
    void this.initializeMailbox();
  }

  public async initializeMailbox(): Promise<void> {
    await this.accessControl.loadMyPermissions();
    if (!this.canReadMail()) {
      return;
    }

    const folderRes = await this.mailService.loadFolders();
    if (!folderRes.success || !folderRes.data) {
      return;
    }

    const inbox =
      folderRes.data.folders.find((f) => f.specialUse === 'inbox') ??
      folderRes.data.folders[0];
    const targetFolder = inbox?.path || 'INBOX';
    await this.mailService.loadMessages(targetFolder, 1);
  }

  public async onSelectFolder(folder: MailFolderDto): Promise<void> {
    this.isMobileFoldersOpen.set(false);
    this.remoteImagesAllowed.set(false);
    this.showPlainText.set(false);
    this.mailService.clearSelectedMessage();
    await this.mailService.loadMessages(folder.path, 1);
  }

  public async onRefresh(): Promise<void> {
    const currentFolder = this.mailService.selectedFolder();
    const currentPage = this.mailService.page();
    const foldersRes = await this.mailService.loadFolders();
    if (foldersRes.success) {
      await this.mailService.loadMessages(currentFolder, currentPage);
    }
  }

  public async onPreviousPage(): Promise<void> {
    const currentPage = this.mailService.page();
    if (currentPage <= 1 || this.mailService.isLoadingMessages()) return;
    this.mailService.clearSelectedMessage();
    await this.mailService.loadMessages(this.mailService.selectedFolder(), currentPage - 1);
  }

  public async onNextPage(): Promise<void> {
    if (!this.mailService.hasNextPage() || this.mailService.isLoadingMessages()) return;
    this.mailService.clearSelectedMessage();
    await this.mailService.loadMessages(
      this.mailService.selectedFolder(),
      this.mailService.page() + 1
    );
  }

  public async onSelectMessage(summary: MailSummaryDto): Promise<void> {
    this.remoteImagesAllowed.set(false);
    this.showPlainText.set(false);
    await this.mailService.loadMessageDetail(summary.ref, false);
  }

  public async onAllowRemoteImages(): Promise<void> {
    const ref = this.mailService.selectedMessageRef();
    if (!ref || this.mailService.isLoadingDetail()) return;
    const res = await this.mailService.loadMessageDetail(ref, true);
    if (res.success) {
      this.remoteImagesAllowed.set(true);
    }
  }

  public onCloseMobileDetail(): void {
    this.mailService.clearSelectedMessage();
  }

  public togglePlainTextView(): void {
    this.showPlainText.update((v) => !v);
  }

  public toggleMobileFolders(): void {
    this.isMobileFoldersOpen.update((v) => !v);
  }

  public onOpenNewMessage(): void {
    if (!this.canSendMail()) return;
    this.composerError.set(null);
    this.sendFeedback.set(null);
    this.activeComposerDraft.set({
      mode: 'new',
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      textBody: '',
      inReplyTo: null,
      references: [],
    });
  }

  public onReply(detail: MailDetailDto, replyAll = false): void {
    if (!this.canSendMail()) return;
    this.composerError.set(null);
    this.sendFeedback.set(null);

    const ownEmailLower = (this.mailService.mailboxEmail() || '').trim().toLowerCase();
    const replyPrimary =
      detail.replyTo.map((a) => a.address).filter(Boolean)[0] ||
      detail.from?.address ||
      '';
    const toList = replyPrimary ? [replyPrimary] : [];
    const seen = new Set<string>(toList.map((e) => e.toLowerCase()));
    if (ownEmailLower) seen.add(ownEmailLower);

    const ccList: string[] = [];
    if (replyAll) {
      for (const addr of [...detail.to, ...detail.cc]) {
        const clean = (addr.address || '').trim();
        if (!clean) continue;
        const lower = clean.toLowerCase();
        if (!seen.has(lower)) {
          seen.add(lower);
          ccList.push(clean);
        }
      }
    }

    const baseSubject = detail.subject.trim();
    const replySubject = /^re\s*:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`;
    const references = [...detail.references];
    if (detail.messageId && !references.includes(detail.messageId)) {
      references.push(detail.messageId);
    }

    this.activeComposerDraft.set({
      mode: replyAll ? 'reply_all' : 'reply',
      to: toList,
      cc: ccList,
      bcc: [],
      subject: replySubject.slice(0, 250),
      textBody: this.buildQuotedReplyBody(detail, false),
      inReplyTo: detail.messageId,
      references,
    });
  }

  public onForward(detail: MailDetailDto): void {
    if (!this.canSendMail()) return;
    this.composerError.set(null);
    this.sendFeedback.set(null);

    const baseSubject = detail.subject.trim();
    const fwdSubject = /^(?:tr|fwd)\s*:/i.test(baseSubject) ? baseSubject : `Tr: ${baseSubject}`;

    this.activeComposerDraft.set({
      mode: 'forward',
      to: [],
      cc: [],
      bcc: [],
      subject: fwdSubject.slice(0, 250),
      textBody: this.buildQuotedReplyBody(detail, true),
      inReplyTo: null,
      references: [],
    });
  }

  public onCloseComposer(): void {
    this.composerError.set(null);
    this.activeComposerDraft.set(null);
  }

  public dismissSendFeedback(): void {
    this.sendFeedback.set(null);
  }

  public async onSendMail(payload: SendMailRequestDto): Promise<void> {
    this.composerError.set(null);
    const res = await this.mailService.sendMessage(payload);
    if (!res.success || !res.data?.sent) {
      this.composerError.set(res.error || 'Impossible d’envoyer votre message.');
      return;
    }

    this.activeComposerDraft.set(null);
    this.sendFeedback.set(
      res.data.sentFolderAppended
        ? 'Message envoyé et enregistré dans vos éléments envoyés.'
        : 'Message envoyé avec succès.'
    );

    if (this.activeFolderMeta()?.specialUse === 'sent') {
      await this.mailService.loadMessages(this.mailService.selectedFolder(), 1);
    }
  }

  private buildQuotedReplyBody(detail: MailDetailDto, isForward: boolean): string {
    const senderLabel = detail.from
      ? this.formatAddressList([detail.from])
      : 'Expéditeur inconnu';
    const dateLabel = detail.date
      ? new Date(detail.date).toLocaleString('fr-FR')
      : '';
    const originalText = (detail.textBody || '').trim().slice(0, 20_000);

    if (isForward) {
      return [
        '',
        '',
        '---------- Message transféré ----------',
        `De : ${senderLabel}`,
        ...(dateLabel ? [`Date : ${dateLabel}`] : []),
        `Objet : ${detail.subject}`,
        `À : ${this.formatAddressList(detail.to)}`,
        '',
        originalText,
      ].join('\n');
    }

    const quotedLines = originalText
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');

    return [
      '',
      '',
      `Le ${dateLabel || 'récemment'}, ${senderLabel} a écrit :`,
      quotedLines,
    ].join('\n');
  }

  public folderIcon(specialUse: MailFolderSpecialUse): string {
    switch (specialUse) {
      case 'inbox':
        return 'inbox';
      case 'sent':
        return 'send';
      case 'drafts':
        return 'drafts';
      case 'trash':
        return 'delete';
      case 'junk':
        return 'report';
      case 'archive':
        return 'archive';
      default:
        return 'folder';
    }
  }

  public folderDisplayName(folder: MailFolderDto): string {
    switch (folder.specialUse) {
      case 'inbox':
        return 'Boîte de réception';
      case 'sent':
        return 'Envoyés';
      case 'drafts':
        return 'Brouillons';
      case 'trash':
        return 'Corbeille';
      case 'junk':
        return 'Indésirables';
      case 'archive':
        return 'Archives';
      default:
        return folder.name;
    }
  }

  public formatSender(summary: MailSummaryDto): string {
    if (!summary.from) return 'Expéditeur inconnu';
    return summary.from.name || summary.from.address || 'Expéditeur inconnu';
  }

  public formatAddressList(list: readonly MailAddressDto[]): string {
    if (!list || list.length === 0) return '—';
    return list
      .map((item) =>
        item.name && item.address && item.name !== item.address
          ? `${item.name} <${item.address}>`
          : item.address || item.name
      )
      .join(', ');
  }

  public formatFileSize(bytes: number): string {
    if (!bytes || bytes < 1024) return `${Math.max(0, bytes)} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  }
}
