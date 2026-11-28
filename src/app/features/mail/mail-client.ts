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
  MailFolderDto,
  MailFolderSpecialUse,
  MailSummaryDto,
} from '../../core/models/mail.model';
import { AccessControlService } from '../../core/services/access-control.service';
import { MailService } from '../../core/services/mail.service';

@Component({
  selector: 'app-mail-client',
  imports: [DatePipe, RouterLink, MatIconModule],
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

  public readonly canReadMail = computed(() =>
    this.accessControl.hasPermission('mail.read')
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
