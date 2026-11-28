import { ImapFlow, type ListResponse, type MessageStructureObject } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import { resolveSafePublicMailHost } from './mail-crypto';
import {
  encodeMailMessageRef,
  type MailAddress,
  type MailAttachmentMeta,
  type MailConnectionContext,
  type MailDetail,
  type MailFolder,
  type MailFolderSpecialUse,
  type MailPageResult,
  type MailProvider,
  type MailSummary,
  type MailUnreadSummary,
} from './mail-provider';
import {
  plainTextToSafeHtml,
  sanitizeEmailHtml,
  type InlineCidResource,
} from './mail-sanitize';
import { withMailboxLock } from './mail-sync';

const MAX_PAGE_LIMIT = 50;
const MAX_DETAIL_SOURCE_BYTES = 5 * 1024 * 1024; // 5 Mo max par message consulté

const FOLDER_SORT_ORDER: Record<MailFolderSpecialUse, number> = {
  inbox: 0,
  sent: 1,
  drafts: 2,
  archive: 3,
  junk: 4,
  trash: 5,
  custom: 6,
};

function mapSpecialUse(folder: ListResponse): MailFolderSpecialUse {
  const raw = (folder.specialUse || '').toLowerCase();
  const pathLower = folder.path.toLowerCase();
  const nameLower = folder.name.toLowerCase();

  if (raw === '\\inbox' || pathLower === 'inbox') return 'inbox';
  if (raw === '\\sent' || nameLower === 'sent' || nameLower === 'envoyés' || nameLower === 'éléments envoyés') {
    return 'sent';
  }
  if (raw === '\\drafts' || nameLower === 'drafts' || nameLower === 'brouillons') return 'drafts';
  if (raw === '\\trash' || nameLower === 'trash' || nameLower === 'corbeille' || nameLower === 'éléments supprimés') {
    return 'trash';
  }
  if (raw === '\\junk' || nameLower === 'junk' || nameLower === 'spam' || nameLower === 'indésirables') {
    return 'junk';
  }
  if (raw === '\\archive' || nameLower === 'archive' || nameLower === 'archives') return 'archive';
  return 'custom';
}

function mapEnvelopeAddresses(
  list: { name?: string; address?: string }[] | undefined
): MailAddress[] {
  if (!Array.isArray(list)) return [];
  const results: MailAddress[] = [];
  for (const item of list) {
    const address = typeof item?.address === 'string' ? item.address.trim() : '';
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!address && !name) continue;
    results.push({ name: name || address, address });
  }
  return results;
}

function mapMailparserAddresses(
  field: AddressObject | AddressObject[] | undefined
): MailAddress[] {
  if (!field) return [];
  const objects = Array.isArray(field) ? field : [field];
  const results: MailAddress[] = [];
  for (const obj of objects) {
    for (const item of obj.value || []) {
      const address = typeof item?.address === 'string' ? item.address.trim() : '';
      const name = typeof item?.name === 'string' ? item.name.trim() : '';
      if (!address && !name) continue;
      results.push({ name: name || address, address });
    }
  }
  return results;
}

function hasAttachmentInStructure(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  const disposition = typeof node.disposition === 'string' ? node.disposition.toLowerCase() : '';
  if (disposition === 'attachment') return true;
  if (node.dispositionParameters && typeof node.dispositionParameters['filename'] === 'string') {
    return true;
  }
  if (Array.isArray(node.childNodes)) {
    return node.childNodes.some((child) => hasAttachmentInStructure(child));
  }
  return false;
}

function toIsoDate(value: Date | string | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 180);
}

async function withImapClient<T>(
  ctx: MailConnectionContext,
  task: (client: ImapFlow) => Promise<T>
): Promise<T> {
  return withMailboxLock(ctx.accountId, async () => {
    const resolved = await resolveSafePublicMailHost(ctx.imapHost);

    const client = new ImapFlow({
      host: resolved.resolvedIp,
      servername: resolved.host,
      port: ctx.imapPort,
      secure: ctx.imapTls,
      tls: {
        rejectUnauthorized: true,
        servername: resolved.host,
      },
      disableAutoIdle: true,
      auth: {
        user: ctx.emailAddress,
        pass: ctx.password,
      },
      logger: false,
      connectionTimeout: 10_000,
      greetingTimeout: 8_000,
      socketTimeout: 15_000,
    });

    client.on('error', () => {
      // Évite toute exception non interceptée sur socket IMAP
    });

    try {
      await client.connect();
      return await task(client);
    } finally {
      try {
        await client.logout();
      } catch {
        // Ignoré lors de la fermeture de session courte
      }
      client.close();
    }
  });
}

export class ImapSmtpProvider implements MailProvider {
  public async listFolders(ctx: MailConnectionContext): Promise<MailFolder[]> {
    return withImapClient(ctx, async (client) => {
      const listed = await client.list({
        statusQuery: {
          messages: true,
          unseen: true,
        },
      });

      const folders: MailFolder[] = listed
        .filter((entry) => !entry.flags?.has('\\Noselect'))
        .map((entry) => {
          const specialUse = mapSpecialUse(entry);
          return {
            path: entry.path,
            name: entry.name || entry.path,
            specialUse,
            totalMessages: Number(entry.status?.messages ?? 0),
            unreadMessages: Number(entry.status?.unseen ?? 0),
            selectable: !entry.flags?.has('\\Noselect'),
          };
        });

      folders.sort((a, b) => {
        const rankDiff = FOLDER_SORT_ORDER[a.specialUse] - FOLDER_SORT_ORDER[b.specialUse];
        if (rankDiff !== 0) return rankDiff;
        return a.name.localeCompare(b.name, 'fr');
      });

      return folders;
    });
  }

  public async listMessages(
    ctx: MailConnectionContext,
    options: { folder: string; page: number; limit: number }
  ): Promise<MailPageResult> {
    const safePage = Math.max(1, Math.floor(options.page || 1));
    const safeLimit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(options.limit || 25)));

    return withImapClient(ctx, async (client) => {
      const lock = await client.getMailboxLock(options.folder, { readOnly: true });
      try {
        const mailbox = client.mailbox && typeof client.mailbox === 'object' ? client.mailbox : null;
        const total = Number(mailbox?.exists ?? 0);
        const uidValidity = Number(mailbox?.uidValidity ?? 0n);

        if (total <= 0) {
          return {
            folder: options.folder,
            uidValidity,
            page: safePage,
            limit: safeLimit,
            total: 0,
            hasNextPage: false,
            messages: [],
          };
        }

        const endSeq = total - (safePage - 1) * safeLimit;
        if (endSeq <= 0) {
          return {
            folder: options.folder,
            uidValidity,
            page: safePage,
            limit: safeLimit,
            total,
            hasNextPage: false,
            messages: [],
          };
        }

        const startSeq = Math.max(1, endSeq - safeLimit + 1);
        const fetchedRows: { seq: number; summary: MailSummary }[] = [];

        for await (const msg of client.fetch(`${startSeq}:${endSeq}`, {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          size: true,
          internalDate: true,
        })) {
          const fromList = mapEnvelopeAddresses(msg.envelope?.from);
          const toList = mapEnvelopeAddresses(msg.envelope?.to);
          const subject = (msg.envelope?.subject || '').trim() || '(Sans objet)';
          const dateIso = toIsoDate(msg.envelope?.date ?? msg.internalDate);

          fetchedRows.push({
            seq: msg.seq,
            summary: {
              ref: encodeMailMessageRef(options.folder, uidValidity, msg.uid),
              folder: options.folder,
              uid: msg.uid,
              uidValidity,
              messageId: msg.envelope?.messageId ? String(msg.envelope.messageId).trim() : null,
              subject,
              from: fromList[0] ?? null,
              to: toList,
              date: dateIso,
              snippet: '',
              isRead: Boolean(msg.flags?.has('\\Seen')),
              isFlagged: Boolean(msg.flags?.has('\\Flagged')),
              hasAttachments: hasAttachmentInStructure(msg.bodyStructure),
              sizeBytes: Number(msg.size ?? 0),
            },
          });
        }

        fetchedRows.sort((a, b) => b.seq - a.seq);

        return {
          folder: options.folder,
          uidValidity,
          page: safePage,
          limit: safeLimit,
          total,
          hasNextPage: startSeq > 1,
          messages: fetchedRows.map((row) => row.summary),
        };
      } finally {
        lock.release();
      }
    });
  }

  public async getMessage(
    ctx: MailConnectionContext,
    options: {
      folder: string;
      uidValidity: number;
      uid: number;
      allowRemoteImages: boolean;
    }
  ): Promise<MailDetail | null> {
    return withImapClient(ctx, async (client) => {
      const lock = await client.getMailboxLock(options.folder, { readOnly: true });
      try {
        const mailbox = client.mailbox && typeof client.mailbox === 'object' ? client.mailbox : null;
        const currentUidValidity = Number(mailbox?.uidValidity ?? 0n);

        if (
          options.uidValidity > 0 &&
          currentUidValidity > 0 &&
          options.uidValidity !== currentUidValidity
        ) {
          return null;
        }

        let matchedMsg:
          | {
              uid: number;
              flags?: Set<string>;
              size?: number;
              internalDate?: Date | string;
              source?: Buffer;
            }
          | null = null;

        for await (const msg of client.fetch(
          String(options.uid),
          {
            uid: true,
            flags: true,
            size: true,
            internalDate: true,
            source: { maxLength: MAX_DETAIL_SOURCE_BYTES },
          },
          { uid: true }
        )) {
          if (msg.uid === options.uid) {
            matchedMsg = msg;
            break;
          }
        }

        if (!matchedMsg?.source) {
          return null;
        }

        const parsed = await simpleParser(matchedMsg.source);
        const inlineCidMap = new Map<string, InlineCidResource>();
        const attachments: MailAttachmentMeta[] = [];

        (parsed.attachments || []).forEach((att, idx) => {
          const cid = (att.cid || att.contentId || '').trim().replace(/^<|>$/g, '');
          const isInline = Boolean(att.contentDisposition === 'inline' || cid);
          if (cid && Buffer.isBuffer(att.content)) {
            inlineCidMap.set(cid.toLowerCase(), {
              contentType: att.contentType || 'application/octet-stream',
              content: att.content,
            });
          }
          attachments.push({
            id: `${options.uid}-${idx + 1}`,
            filename: (att.filename || `piece-jointe-${idx + 1}`).slice(0, 200),
            contentType: att.contentType || 'application/octet-stream',
            sizeBytes: Number(att.size ?? att.content?.length ?? 0),
            contentId: cid || null,
            isInline,
          });
        });

        const textBody = typeof parsed.text === 'string' ? parsed.text : '';
        const rawHtml = typeof parsed.html === 'string' ? parsed.html : '';

        let sanitizedHtml: string;
        let hasBlockedRemoteImages = false;
        let blockedRemoteImagesCount = 0;

        if (rawHtml.trim()) {
          const sanitized = sanitizeEmailHtml(rawHtml, {
            allowRemoteImages: options.allowRemoteImages,
            inlineCidMap,
          });
          sanitizedHtml = sanitized.html;
          hasBlockedRemoteImages = sanitized.hasBlockedRemoteImages;
          blockedRemoteImagesCount = sanitized.blockedRemoteImagesCount;
        } else {
          sanitizedHtml = plainTextToSafeHtml(textBody);
        }

        const fromList = mapMailparserAddresses(parsed.from);
        const toList = mapMailparserAddresses(parsed.to);
        const ccList = mapMailparserAddresses(parsed.cc);
        const replyToList = mapMailparserAddresses(parsed.replyTo);
        const references = Array.isArray(parsed.references)
          ? parsed.references.map((r) => String(r).trim()).filter(Boolean)
          : typeof parsed.references === 'string' && parsed.references.trim()
            ? [parsed.references.trim()]
            : [];

        const effectiveUidValidity = currentUidValidity || options.uidValidity;

        return {
          ref: encodeMailMessageRef(options.folder, effectiveUidValidity, matchedMsg.uid),
          folder: options.folder,
          uid: matchedMsg.uid,
          uidValidity: effectiveUidValidity,
          messageId: parsed.messageId ? String(parsed.messageId).trim() : null,
          subject: (parsed.subject || '').trim() || '(Sans objet)',
          from: fromList[0] ?? null,
          to: toList,
          cc: ccList,
          replyTo: replyToList,
          date: toIsoDate(parsed.date ?? matchedMsg.internalDate),
          snippet: buildSnippet(textBody),
          isRead: Boolean(matchedMsg.flags?.has('\\Seen')),
          isFlagged: Boolean(matchedMsg.flags?.has('\\Flagged')),
          hasAttachments: attachments.some((a) => !a.isInline),
          sizeBytes: Number(matchedMsg.size ?? matchedMsg.source.length),
          inReplyTo: parsed.inReplyTo ? String(parsed.inReplyTo).trim() : null,
          references,
          textBody,
          sanitizedHtml,
          hasBlockedRemoteImages,
          blockedRemoteImagesCount,
          attachments: attachments.filter((a) => !a.isInline),
        };
      } finally {
        lock.release();
      }
    });
  }

  public async getUnreadCount(
    ctx: MailConnectionContext,
    folder = 'INBOX'
  ): Promise<MailUnreadSummary> {
    return withImapClient(ctx, async (client) => {
      const status = await client.status(folder, {
        messages: true,
        unseen: true,
      });

      return {
        folder,
        unreadCount: status ? Number(status.unseen ?? 0) : 0,
        totalCount: status ? Number(status.messages ?? 0) : 0,
      };
    });
  }
}

export const mailProvider: MailProvider = new ImapSmtpProvider();
