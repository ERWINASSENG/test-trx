import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import {
  MailAddressDto,
  MailAttachmentMetaDto,
  MailComposerDraft,
  MailDetailDto,
  MailFolderDto,
  MailFolderSpecialUse,
  MailMoveTarget,
  MailSummaryDto,
  SendMailRequestDto,
} from '../../core/models/mail.model';
import { QuoteAssignee } from '../../core/models/quote.model';
import { AccessControlService } from '../../core/services/access-control.service';
import { MailService } from '../../core/services/mail.service';
import { QuoteService } from '../../core/services/quote.service';
import { MailComposerComponent } from './mail-composer/mail-composer';

@Component({
  selector: 'app-mail-client',
  imports: [DatePipe, RouterLink, MatIconModule, MailComposerComponent],
  templateUrl: './mail-client.html',
  styleUrl: './mail-client.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MailClientComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly quoteService = inject(QuoteService, { optional: true });
  public readonly mailService = inject(MailService);
  public readonly accessControl = inject(AccessControlService);

  public readonly remoteImagesAllowed = signal<boolean>(false);
  public readonly showPlainText = signal<boolean>(false);
  public readonly isMobileFoldersOpen = signal<boolean>(false);
  public readonly activeComposerDraft = signal<MailComposerDraft | null>(null);
  public readonly composerError = signal<string | null>(null);
  public readonly sendFeedback = signal<string | null>(null);
  public readonly searchDraft = signal<string>('');
  public readonly actionError = signal<string | null>(null);
  public readonly downloadingAttachmentId = signal<string | null>(null);
  public readonly pendingDeleteConfirmRef = signal<string | null>(null);

  // Modale « Transférer à un commercial (avec suivi) »
  public readonly forwardAssignTarget = signal<MailDetailDto | null>(null);
  public readonly forwardAssignRepId = signal<string>('');
  public readonly forwardAssignClientEmail = signal<string>('');
  public readonly forwardAssignClientName = signal<string>('');
  public readonly forwardAssignNote = signal<string>('');
  public readonly forwardAssignError = signal<string | null>(null);
  public readonly isLoadingAssignees = signal<boolean>(false);

  public readonly canReadMail = computed(() =>
    this.accessControl.hasPermission('mail.read')
  );
  public readonly canSendMail = computed(() =>
    this.accessControl.hasPermission('mail.send')
  );
  public readonly canConnectMail = computed(() =>
    this.accessControl.hasPermission('mail.self.connect')
  );
  public readonly canCreateQuote = computed(() =>
    this.accessControl.hasPermission('quotes.create')
  );
  public readonly canForwardAssign = computed(
    () => this.canSendMail() && this.accessControl.hasPermission('quotes.assign')
  );
  public readonly commercialAssignees = computed<QuoteAssignee[]>(
    () => this.quoteService?.assignees() ?? []
  );
  public readonly isCurrentFolderTrash = computed(
    () => this.activeFolderMeta()?.specialUse === 'trash'
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
    this.searchDraft.set('');
    this.actionError.set(null);
    this.pendingDeleteConfirmRef.set(null);
    this.mailService.clearSelectedMessage();
    await this.mailService.loadMessages(folder.path, 1, this.mailService.limit(), '');
  }

  public onSearchInput(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.searchDraft.set(input?.value ?? '');
  }

  public async onSearchSubmit(event?: Event): Promise<void> {
    event?.preventDefault();
    const cleaned = this.searchDraft().trim().slice(0, 100);
    this.searchDraft.set(cleaned);
    this.actionError.set(null);
    this.pendingDeleteConfirmRef.set(null);
    this.mailService.clearSelectedMessage();
    await this.mailService.loadMessages(
      this.mailService.selectedFolder(),
      1,
      this.mailService.limit(),
      cleaned
    );
  }

  public async onClearSearch(): Promise<void> {
    this.searchDraft.set('');
    this.actionError.set(null);
    this.mailService.clearSelectedMessage();
    await this.mailService.loadMessages(
      this.mailService.selectedFolder(),
      1,
      this.mailService.limit(),
      ''
    );
  }

  public async onRefresh(): Promise<void> {
    const currentFolder = this.mailService.selectedFolder();
    const currentPage = this.mailService.page();
    const currentQuery = this.mailService.searchQuery();
    const foldersRes = await this.mailService.loadFolders();
    if (foldersRes.success) {
      await this.mailService.loadMessages(
        currentFolder,
        currentPage,
        this.mailService.limit(),
        currentQuery
      );
    }
  }

  public async onPreviousPage(): Promise<void> {
    const currentPage = this.mailService.page();
    if (currentPage <= 1 || this.mailService.isLoadingMessages()) return;
    this.mailService.clearSelectedMessage();
    await this.mailService.loadMessages(
      this.mailService.selectedFolder(),
      currentPage - 1,
      this.mailService.limit(),
      this.mailService.searchQuery()
    );
  }

  public async onNextPage(): Promise<void> {
    if (!this.mailService.hasNextPage() || this.mailService.isLoadingMessages()) return;
    this.mailService.clearSelectedMessage();
    await this.mailService.loadMessages(
      this.mailService.selectedFolder(),
      this.mailService.page() + 1,
      this.mailService.limit(),
      this.mailService.searchQuery()
    );
  }

  public async onSelectMessage(summary: MailSummaryDto): Promise<void> {
    this.remoteImagesAllowed.set(false);
    this.showPlainText.set(false);
    this.actionError.set(null);
    this.pendingDeleteConfirmRef.set(null);
    const res = await this.mailService.loadMessageDetail(summary.ref, false);
    if (res.success && res.data && !res.data.isRead) {
      void this.mailService.updateFlags(summary.ref, { isRead: true });
    }
  }

  public async onToggleRead(detail: MailDetailDto): Promise<void> {
    if (this.mailService.isMutating()) return;
    this.actionError.set(null);
    const res = await this.mailService.updateFlags(detail.ref, { isRead: !detail.isRead });
    if (!res.success) {
      this.actionError.set(res.error || 'Impossible de mettre à jour le statut de lecture.');
    }
  }

  public async onToggleFlagged(detail: MailDetailDto): Promise<void> {
    if (this.mailService.isMutating()) return;
    this.actionError.set(null);
    const res = await this.mailService.updateFlags(detail.ref, { isFlagged: !detail.isFlagged });
    if (!res.success) {
      this.actionError.set(res.error || 'Impossible de mettre à jour le suivi du message.');
    }
  }

  public async onMoveMessage(detail: MailDetailDto, target: MailMoveTarget): Promise<void> {
    if (this.mailService.isMutating()) return;
    this.actionError.set(null);
    this.pendingDeleteConfirmRef.set(null);
    const res = await this.mailService.moveMessage(detail.ref, target);
    if (!res.success) {
      this.actionError.set(res.error || 'Impossible de déplacer ce message.');
      return;
    }
    this.sendFeedback.set(
      target === 'trash' ? 'Message déplacé vers la corbeille.' : 'Message archivé.'
    );
  }

  public onRequestPermanentDelete(detail: MailDetailDto): void {
    this.actionError.set(null);
    this.pendingDeleteConfirmRef.set(detail.ref);
  }

  public onCancelPermanentDelete(): void {
    this.pendingDeleteConfirmRef.set(null);
  }

  public async onConfirmPermanentDelete(detail: MailDetailDto): Promise<void> {
    if (this.mailService.isMutating()) return;
    this.actionError.set(null);
    const res = await this.mailService.deleteMessage(detail.ref);
    this.pendingDeleteConfirmRef.set(null);
    if (!res.success) {
      this.actionError.set(res.error || 'Impossible de supprimer définitivement ce message.');
      return;
    }
    this.sendFeedback.set('Message supprimé définitivement.');
  }

  public async onDownloadAttachment(
    detail: MailDetailDto,
    att: MailAttachmentMetaDto
  ): Promise<void> {
    if (this.downloadingAttachmentId()) return;
    this.actionError.set(null);
    this.downloadingAttachmentId.set(att.id);
    try {
      const res = await this.mailService.downloadAttachment(detail.ref, att.id, att.filename);
      if (!res.success) {
        this.actionError.set(res.error || 'Impossible de télécharger cette pièce jointe.');
      }
    } finally {
      this.downloadingAttachmentId.set(null);
    }
  }

  public async onCreateOrOpenQuote(detail: MailDetailDto): Promise<void> {
    if (!this.canCreateQuote()) return;
    this.actionError.set(null);

    if (detail.linkedQuoteId) {
      await this.router.navigate(['/quotes'], {
        queryParams: { quoteId: detail.linkedQuoteId },
      });
      return;
    }

    if (this.mailService.isMutating()) return;
    const res = await this.mailService.createQuoteFromMessage(detail.ref);
    if (!res.success || !res.data?.quoteId) {
      this.actionError.set(res.error || 'Impossible de créer la cotation depuis cet email.');
      return;
    }

    await this.router.navigate(['/quotes'], {
      queryParams: { quoteId: res.data.quoteId },
    });
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

  public async onOpenForwardAssign(detail: MailDetailDto): Promise<void> {
    if (!this.canForwardAssign()) return;
    this.forwardAssignError.set(null);
    this.sendFeedback.set(null);
    this.forwardAssignTarget.set(detail);
    this.forwardAssignRepId.set('');
    this.forwardAssignClientEmail.set((detail.from?.address || '').trim());
    this.forwardAssignClientName.set(
      detail.from?.name && detail.from.name !== detail.from.address
        ? detail.from.name.trim()
        : ''
    );
    this.forwardAssignNote.set('');

    if (this.quoteService && this.quoteService.assignees().length === 0) {
      this.isLoadingAssignees.set(true);
      try {
        await this.quoteService.loadAssignees();
      } finally {
        this.isLoadingAssignees.set(false);
      }
    }
  }

  public onCloseForwardAssign(): void {
    this.forwardAssignError.set(null);
    this.forwardAssignTarget.set(null);
  }

  public onForwardAssignRepChange(event: Event): void {
    this.forwardAssignRepId.set((event.target as HTMLSelectElement).value);
  }

  public onForwardAssignClientEmailChange(event: Event): void {
    this.forwardAssignClientEmail.set((event.target as HTMLInputElement).value);
  }

  public onForwardAssignClientNameChange(event: Event): void {
    this.forwardAssignClientName.set((event.target as HTMLInputElement).value);
  }

  public onForwardAssignNoteChange(event: Event): void {
    this.forwardAssignNote.set((event.target as HTMLTextAreaElement).value);
  }

  public formatAssigneeLabel(assignee: QuoteAssignee): string {
    const full = `${assignee.firstName || ''} ${assignee.lastName || ''}`.trim();
    return full ? `${full} (${assignee.email})` : assignee.email;
  }

  public async onSubmitForwardAssign(event: Event): Promise<void> {
    event.preventDefault();
    const detail = this.forwardAssignTarget();
    if (!detail || !this.canForwardAssign()) return;

    const assignedTo = this.forwardAssignRepId().trim();
    const clientEmail = this.forwardAssignClientEmail().trim();
    const clientName = this.forwardAssignClientName().trim();
    const note = this.forwardAssignNote().trim();

    if (!assignedTo) {
      this.forwardAssignError.set('Sélectionnez le commercial destinataire.');
      return;
    }
    if (!clientEmail) {
      this.forwardAssignError.set('Renseignez l’adresse email du client d’origine.');
      return;
    }

    this.forwardAssignError.set(null);
    const res = await this.mailService.forwardAssignMessage(detail.ref, {
      assignedTo,
      clientEmail,
      clientName: clientName || null,
      note: note || null,
    });

    if (!res.success || !res.data?.assignment) {
      this.forwardAssignError.set(
        res.error || 'Impossible de transférer cette demande au commercial.'
      );
      return;
    }

    this.forwardAssignTarget.set(null);
    this.sendFeedback.set(
      `Demande transférée à ${res.data.assignment.assignedToName} avec suivi d’ouverture (aucune cotation créée automatiquement).`
    );

    if (this.activeFolderMeta()?.specialUse === 'sent') {
      await this.mailService.loadMessages(this.mailService.selectedFolder(), 1);
    }
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
