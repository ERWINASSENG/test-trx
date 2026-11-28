import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import {
  MailDetailDto,
  MailErrorCode,
  MailFolderDto,
  MailSummaryDto,
} from '../../core/models/mail.model';
import { AccessControlService } from '../../core/services/access-control.service';
import { MailService } from '../../core/services/mail.service';
import { MailClientComponent } from './mail-client';

function createMockMailService() {
  const mailboxEmail = signal<string | null>('erwinalberic@transimex-cm.com');
  const folders = signal<MailFolderDto[]>([
    {
      path: 'INBOX',
      name: 'INBOX',
      specialUse: 'inbox',
      totalMessages: 2,
      unreadMessages: 1,
      selectable: true,
    },
  ]);
  const selectedFolder = signal<string>('INBOX');
  const searchQuery = signal<string>('');
  const messages = signal<MailSummaryDto[]>([]);
  const page = signal<number>(1);
  const limit = signal<number>(25);
  const totalMessages = signal<number>(0);
  const hasNextPage = signal<boolean>(false);
  const selectedMessage = signal<MailDetailDto | null>(null);
  const selectedMessageRef = signal<string | null>(null);
  const unreadCount = signal<number>(1);
  const isMailboxConnected = signal<boolean>(true);
  const isLoadingFolders = signal<boolean>(false);
  const isLoadingMessages = signal<boolean>(false);
  const isLoadingDetail = signal<boolean>(false);
  const isSending = signal<boolean>(false);
  const isMutating = signal<boolean>(false);
  const errorCode = signal<MailErrorCode | null>(null);
  const errorMessage = signal<string | null>(null);

  return {
    mailboxEmail,
    folders,
    selectedFolder,
    searchQuery,
    messages,
    page,
    limit,
    totalMessages,
    hasNextPage,
    selectedMessage,
    selectedMessageRef,
    unreadCount,
    isMailboxConnected,
    isLoadingFolders,
    isLoadingMessages,
    isLoadingDetail,
    isSending,
    isMutating,
    errorCode,
    errorMessage,
    loadFolders: vi.fn().mockResolvedValue({
      success: true,
      data: { mailboxEmail: 'erwinalberic@transimex-cm.com', folders: folders() },
    }),
    loadMessages: vi.fn().mockResolvedValue({
      success: true,
      data: {
        folder: 'INBOX',
        uidValidity: 12,
        page: 1,
        limit: 25,
        total: 0,
        hasNextPage: false,
        messages: [],
      },
    }),
    loadMessageDetail: vi.fn().mockResolvedValue({ success: true }),
    updateFlags: vi.fn().mockResolvedValue({ success: true, data: { updated: true } }),
    moveMessage: vi.fn().mockResolvedValue({ success: true, data: { moved: true } }),
    deleteMessage: vi.fn().mockResolvedValue({ success: true, data: { deleted: true } }),
    downloadAttachment: vi.fn().mockResolvedValue({ success: true, data: { downloaded: true } }),
    createQuoteFromMessage: vi.fn().mockResolvedValue({
      success: true,
      data: { created: true, quoteId: 'quote-123' },
    }),
    sendMessage: vi.fn().mockResolvedValue({
      success: true,
      data: { sent: true, messageId: '<sent@transimex-cm.com>', acceptedCount: 1, rejectedCount: 0, sentFolderAppended: true },
    }),
    clearSelectedMessage: vi.fn(() => {
      selectedMessageRef.set(null);
      selectedMessage.set(null);
    }),
  };
}

describe('MailClientComponent', () => {
  let mockMailService: ReturnType<typeof createMockMailService>;
  let grantedPermissions: Set<string>;

  beforeEach(() => {
    mockMailService = createMockMailService();
    grantedPermissions = new Set(['module.mail.view', 'mail.read', 'mail.self.connect']);

    TestBed.configureTestingModule({
      imports: [MailClientComponent],
      providers: [
        provideRouter([]),
        { provide: MailService, useValue: mockMailService },
        {
          provide: AccessControlService,
          useValue: {
            hasPermission: (key: string) => grantedPermissions.has(key),
            loadMyPermissions: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    });
  });

  it('affiche un état de refus lorsque mail.read est absent', async () => {
    grantedPermissions.delete('mail.read');
    const fixture = TestBed.createComponent(MailClientComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#mail-no-permission-state')).not.toBeNull();
    expect(mockMailService.loadFolders).not.toHaveBeenCalled();
  });

  it('affiche l’écran de connexion vers /profile lorsque la boîte n’est pas connectée', async () => {
    mockMailService.isMailboxConnected.set(false);
    mockMailService.errorCode.set('MAILBOX_NOT_CONNECTED');
    mockMailService.errorMessage.set('Votre boîte mail professionnelle n’est pas encore connectée.');

    const fixture = TestBed.createComponent(MailClientComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#mail-not-connected-state')).not.toBeNull();
    expect(el.querySelector('#mail-go-connect-btn')).not.toBeNull();
  });

  it('rend le corps HTML assaini dans une iframe sandboxée sans allow-scripts ni allow-same-origin', async () => {
    const detail: MailDetailDto = {
      ref: 'SU5CT1g:12:42',
      folder: 'INBOX',
      uid: 42,
      uidValidity: 12,
      messageId: '<msg-42@transimex-cm.com>',
      subject: 'Demande de cotation Douala',
      from: { name: 'Client Test', address: 'client@example.com' },
      to: [{ name: 'Erwin', address: 'erwinalberic@transimex-cm.com' }],
      cc: [],
      replyTo: [],
      date: '2026-11-27T10:00:00.000Z',
      snippet: 'Bonjour, merci pour votre offre.',
      isRead: false,
      isFlagged: false,
      hasAttachments: false,
      sizeBytes: 1200,
      inReplyTo: null,
      references: [],
      textBody: 'Bonjour, merci pour votre offre.',
      sanitizedHtml: '<p>Bonjour, merci pour votre offre.</p>',
      hasBlockedRemoteImages: true,
      blockedRemoteImagesCount: 2,
      attachments: [],
    };
    mockMailService.selectedMessageRef.set(detail.ref);
    mockMailService.selectedMessage.set(detail);

    const fixture = TestBed.createComponent(MailClientComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const iframe = el.querySelector('#mail-detail-iframe') as HTMLIFrameElement | null;
    expect(iframe).not.toBeNull();

    const sandboxAttr = iframe?.getAttribute('sandbox') ?? '';
    expect(sandboxAttr).not.toContain('allow-scripts');
    expect(sandboxAttr).not.toContain('allow-same-origin');
    expect(sandboxAttr).not.toContain('allow-forms');

    const allowImagesBtn = el.querySelector('#mail-allow-remote-images-btn') as HTMLButtonElement | null;
    expect(allowImagesBtn).not.toBeNull();
    allowImagesBtn?.click();
    expect(mockMailService.loadMessageDetail).toHaveBeenCalledWith('SU5CT1g:12:42', true);
  });

  it('permet de basculer entre la vue HTML isolée et la vue texte brut', async () => {
    const detail: MailDetailDto = {
      ref: 'SU5CT1g:12:99',
      folder: 'INBOX',
      uid: 99,
      uidValidity: 12,
      messageId: null,
      subject: 'Suivi dossier',
      from: { name: 'Partenaire', address: 'partenaire@example.com' },
      to: [{ name: 'Erwin', address: 'erwinalberic@transimex-cm.com' }],
      cc: [],
      replyTo: [],
      date: '2026-11-27T11:30:00.000Z',
      snippet: 'Texte brut de suivi',
      isRead: true,
      isFlagged: false,
      hasAttachments: false,
      sizeBytes: 512,
      inReplyTo: null,
      references: [],
      textBody: 'Texte brut de suivi',
      sanitizedHtml: '<p>Texte brut de suivi</p>',
      hasBlockedRemoteImages: false,
      blockedRemoteImagesCount: 0,
      attachments: [],
    };
    mockMailService.selectedMessageRef.set(detail.ref);
    mockMailService.selectedMessage.set(detail);

    const fixture = TestBed.createComponent(MailClientComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const toggleBtn = el.querySelector('#mail-toggle-plain-text-btn') as HTMLButtonElement | null;
    expect(toggleBtn).not.toBeNull();

    toggleBtn?.click();
    fixture.detectChanges();

    const pre = el.querySelector('#mail-detail-plain-text');
    expect(pre?.textContent).toContain('Texte brut de suivi');
    expect(el.querySelector('#mail-detail-iframe')).toBeNull();
  });

  it('déclenche la recherche serveur IMAP et les actions de flags / cotation selon les permissions', async () => {
    const detail: MailDetailDto = {
      ref: 'SU5CT1g:12:77',
      folder: 'INBOX',
      uid: 77,
      uidValidity: 12,
      messageId: '<msg-77@example.com>',
      subject: 'Cotation Douala',
      from: { name: 'Client', address: 'client@example.com' },
      to: [{ name: 'Erwin', address: 'erwinalberic@transimex-cm.com' }],
      cc: [],
      replyTo: [],
      date: '2026-11-28T09:00:00.000Z',
      snippet: 'Demande de tarif',
      isRead: false,
      isFlagged: false,
      hasAttachments: false,
      sizeBytes: 900,
      inReplyTo: null,
      references: [],
      textBody: 'Demande de tarif',
      sanitizedHtml: '<p>Demande de tarif</p>',
      hasBlockedRemoteImages: false,
      blockedRemoteImagesCount: 0,
      attachments: [],
      linkedQuoteId: null,
    };
    mockMailService.selectedMessageRef.set(detail.ref);
    mockMailService.selectedMessage.set(detail);

    const fixture = TestBed.createComponent(MailClientComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;

    // Sans quotes.create, le bouton Créer cotation est masqué
    expect(el.querySelector('#mail-create-quote-btn')).toBeNull();

    // Recherche serveur
    fixture.componentInstance.searchDraft.set('  douala  ');
    await fixture.componentInstance.onSearchSubmit();
    expect(mockMailService.loadMessages).toHaveBeenCalledWith('INBOX', 1, 25, 'douala');

    // Action Lu / Non lu
    const readBtn = el.querySelector('#mail-toggle-read-btn') as HTMLButtonElement | null;
    expect(readBtn).not.toBeNull();
    readBtn?.click();
    expect(mockMailService.updateFlags).toHaveBeenCalledWith('SU5CT1g:12:77', { isRead: true });
  });
});
