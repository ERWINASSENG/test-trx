import type { SupabaseClient } from '@supabase/supabase-js';
import { ImapFlow } from 'imapflow';
import { getSupabaseAdmin } from './auth';
import {
  decryptMailSecret,
  isMailEncryptionConfigured,
  resolveSafePublicMailHost,
} from './mail-crypto';
import { recordQuoteEvent } from './quotes';

const MAX_NEW_MESSAGES_PER_CYCLE = 25;
const WORKER_INTERVAL_MS = 60_000;

const mailboxLockQueue = new Map<string, Promise<void>>();
let isGlobalSweepRunning = false;
let workerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Sérialise les accès IMAP sur une même boîte (suivi cotations + webmail)
 * afin d'éviter les collisions de verrous et dépassements de connexions simultanées.
 */
export async function withMailboxLock<T>(
  accountId: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = mailboxLockQueue.get(accountId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const currentGate = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const chained = previous.then(() => currentGate);
  mailboxLockQueue.set(accountId, chained);

  await previous;
  try {
    return await task();
  } finally {
    releaseCurrent();
    if (mailboxLockQueue.get(accountId) === chained) {
      mailboxLockQueue.delete(accountId);
    }
  }
}

export interface GlobalMailSettingsRow {
  id: number;
  imap_host: string;
  imap_port: number;
  imap_tls: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: boolean;
  watched_folder: string;
  subject_keywords: string[];
  excluded_senders: string[];
  is_enabled: boolean;
  updated_at: string;
}

export interface MailSyncSummary {
  accountId: string;
  ingestedCount: number;
  repliesLinkedCount: number;
  seenUpdatedCount: number;
  lastSyncedAt: string;
}

export async function loadGlobalMailSettings(
  adminClient: SupabaseClient
): Promise<GlobalMailSettingsRow | null> {
  const { data, error } = await adminClient
    .from('mail_global_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return {
    id: 1,
    imap_host: String(data.imap_host || '').trim(),
    imap_port: Number(data.imap_port || 993),
    imap_tls: Boolean(data.imap_tls ?? true),
    smtp_host: String(data.smtp_host || '').trim(),
    smtp_port: Number(data.smtp_port || 465),
    smtp_tls: Boolean(data.smtp_tls ?? true),
    watched_folder: String(data.watched_folder || 'INBOX').trim() || 'INBOX',
    subject_keywords: Array.isArray(data.subject_keywords)
      ? data.subject_keywords.map((k: unknown) => String(k).trim().toLowerCase()).filter(Boolean)
      : [],
    excluded_senders: Array.isArray(data.excluded_senders)
      ? data.excluded_senders.map((s: unknown) => String(s).trim().toLowerCase()).filter(Boolean)
      : [],
    is_enabled: Boolean(data.is_enabled ?? true),
    updated_at: String(data.updated_at || new Date().toISOString()),
  };
}

export async function verifyImapCredentials(params: {
  host: string;
  port: number;
  secure: boolean;
  email: string;
  password: string;
  watchedFolder: string;
}): Promise<{ ok: boolean; error?: string }> {
  let resolvedHost: { host: string; resolvedIp: string };
  try {
    resolvedHost = await resolveSafePublicMailHost(params.host);
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Serveur IMAP invalide ou non autorisé.',
    };
  }

  const client = new ImapFlow({
    host: resolvedHost.resolvedIp,
    servername: resolvedHost.host,
    port: params.port,
    secure: params.secure,
    tls: {
      rejectUnauthorized: true,
      servername: resolvedHost.host,
    },
    disableAutoIdle: true,
    auth: {
      user: params.email,
      pass: params.password,
    },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  client.on('error', () => {
    // Empêche tout crash d'événement non intercepté sur socket IMAP
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(params.watchedFolder || 'INBOX', { readOnly: true });
    lock.release();
    await client.logout().catch(() => undefined);
    return { ok: true };
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message.toLowerCase() : '';
    const isAuthErr =
      rawMsg.includes('auth') ||
      rawMsg.includes('credentials') ||
      rawMsg.includes('login') ||
      rawMsg.includes('invalid');
    const isFolderErr = rawMsg.includes('mailbox') || rawMsg.includes('nonexistent');
    return {
      ok: false,
      error: isAuthErr
        ? 'Identifiants refusés par le serveur mail (vérifiez votre email et mot de passe).'
        : isFolderErr
          ? `Le dossier IMAP « ${params.watchedFolder} » est introuvable dans cette boîte.`
          : 'Impossible de joindre le serveur IMAP configuré. Vérifiez les paramètres serveur.',
    };
  } finally {
    client.close();
  }
}

function isExcludedSender(senderEmail: string, mailboxEmail: string, excludedPatterns: string[]): boolean {
  const lower = senderEmail.trim().toLowerCase();
  if (!lower || lower === mailboxEmail.trim().toLowerCase()) {
    return true;
  }
  return excludedPatterns.some((pattern) => {
    if (!pattern) return false;
    return lower.includes(pattern);
  });
}

function extractHeaderMessageIds(headersBuf: Buffer | undefined): string[] {
  if (!headersBuf) return [];
  const raw = headersBuf.toString('utf8');
  const matches = raw.match(/<[^>]+>/g) || [];
  return [...new Set(matches.map((m) => m.trim()))];
}

/**
 * Synchronisation passive en lecture seule (aucune création automatique de prospect ni de cotation).
 * Règle métier stricte : rien ne se crée sans l'action explicite du commercial.
 * - Met à jour outlook_read_at (\Seen) sur les cotations déjà créées et reliées à un mail.
 * - Rattache les réponses clients (In-Reply-To / References) aux cotations existantes.
 */
export async function syncMailInboxAccount(
  adminClient: SupabaseClient,
  accountId: string
): Promise<MailSyncSummary> {
  const nowIso = new Date().toISOString();
  if (mailboxLockQueue.has(accountId)) {
    return {
      accountId,
      ingestedCount: 0,
      repliesLinkedCount: 0,
      seenUpdatedCount: 0,
      lastSyncedAt: nowIso,
    };
  }

  return withMailboxLock(accountId, async () => {
    if (!isMailEncryptionConfigured()) {
      throw new Error('Service de chiffrement mail non configuré sur le serveur.');
    }

    const [settings, accountRes] = await Promise.all([
      loadGlobalMailSettings(adminClient),
      adminClient
        .from('mail_inbox_accounts')
        .select('id, user_id, email_address, account_role, encrypted_password, last_synced_uid, is_active')
        .eq('id', accountId)
        .maybeSingle(),
    ]);

    const account = accountRes.data;
    if (!account || !account.is_active) {
      return { accountId, ingestedCount: 0, repliesLinkedCount: 0, seenUpdatedCount: 0, lastSyncedAt: nowIso };
    }
    if (!settings || !settings.is_enabled || !settings.imap_host) {
      throw new Error('Le serveur IMAP global n’est pas encore configuré ou est désactivé.');
    }

    const resolvedHost = await resolveSafePublicMailHost(settings.imap_host);
    const password = decryptMailSecret(String(account.encrypted_password));

    const client = new ImapFlow({
      host: resolvedHost.resolvedIp,
      servername: resolvedHost.host,
      port: settings.imap_port,
      secure: settings.imap_tls,
      tls: {
        rejectUnauthorized: true,
        servername: resolvedHost.host,
      },
      disableAutoIdle: true,
      auth: {
        user: String(account.email_address),
        pass: password,
      },
      logger: false,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 25_000,
    });

    client.on('error', () => undefined);

    let repliesLinkedCount = 0;
    let seenUpdatedCount = 0;
    let maxProcessedUid = Number(account.last_synced_uid || 0);

    try {
      await client.connect();
      const lock = await client.getMailboxLock(settings.watched_folder, { readOnly: true });

      try {
        // 1. Vérification du flag \Seen sur les cotations DÉJÀ créées et les mails transférés suivis
        const [unseenIngestedRes, linkedQuotesRes, pendingAssignmentsRes] = await Promise.all([
          adminClient
            .from('mail_ingested_messages')
            .select('id, imap_uid, quote_id')
            .eq('account_id', accountId)
            .eq('status', 'ingested')
            .eq('is_seen_in_outlook', false)
            .not('quote_id', 'is', null)
            .limit(50),
          adminClient
            .from('mail_links')
            .select('imap_uid, entity_id')
            .eq('account_id', accountId)
            .eq('folder', settings.watched_folder)
            .eq('entity_type', 'quote')
            .limit(50),
          adminClient
            .from('mail_assignments')
            .select('id, forwarded_message_id, assigned_imap_uid, status')
            .eq('assigned_to', String(account.user_id))
            .is('opened_at', null)
            .limit(50),
        ]);

        const uidMap = new Map<
          number,
          { ingestedRowId?: string; quoteId?: string; assignmentId?: string; assignmentStatus?: string }
        >();
        const pendingAssignmentByMsgId = new Map<string, { id: string; status: string }>();

        for (const row of unseenIngestedRes.data || []) {
          uidMap.set(Number(row.imap_uid), {
            ingestedRowId: String(row.id),
            quoteId: String(row.quote_id),
          });
        }
        for (const link of linkedQuotesRes.data || []) {
          const uid = Number(link.imap_uid);
          const existing = uidMap.get(uid);
          if (!existing) {
            uidMap.set(uid, { quoteId: String(link.entity_id) });
          } else if (!existing.quoteId) {
            existing.quoteId = String(link.entity_id);
          }
        }
        for (const assign of pendingAssignmentsRes.data || []) {
          const assignId = String(assign.id);
          const assignStatus = String(assign.status || 'sent');
          const msgId = String(assign.forwarded_message_id || '').trim();
          const uid = assign.assigned_imap_uid ? Number(assign.assigned_imap_uid) : null;
          if (uid && uid > 0) {
            const existing = uidMap.get(uid) || {};
            uidMap.set(uid, {
              ...existing,
              assignmentId: assignId,
              assignmentStatus: assignStatus,
            });
          } else if (msgId) {
            pendingAssignmentByMsgId.set(msgId, { id: assignId, status: assignStatus });
          }
        }

        if (uidMap.size > 0) {
          const uidSequence = [...uidMap.keys()].join(',');
          for await (const msg of client.fetch(uidSequence, { uid: true, flags: true }, { uid: true })) {
            if (msg.flags?.has('\\Seen')) {
              const target = uidMap.get(msg.uid);
              if (!target) continue;

              const seenIso = new Date().toISOString();
              if (target.ingestedRowId) {
                await adminClient
                  .from('mail_ingested_messages')
                  .update({ is_seen_in_outlook: true, seen_detected_at: seenIso })
                  .eq('id', target.ingestedRowId);
              }

              if (target.quoteId) {
                const { data: updatedQuote } = await adminClient
                  .from('sales_quotes')
                  .update({ outlook_read_at: seenIso, updated_at: seenIso })
                  .eq('id', target.quoteId)
                  .is('outlook_read_at', null)
                  .select('id')
                  .maybeSingle();

                if (updatedQuote?.id) {
                  await recordQuoteEvent(adminClient, {
                    quoteId: target.quoteId,
                    eventType: 'email_seen_in_outlook',
                    actorUserId: String(account.user_id),
                    metadata: { mailboxEmail: String(account.email_address) },
                  });
                  seenUpdatedCount++;
                }
              }

              if (target.assignmentId) {
                const assignmentUpdate: Record<string, unknown> = {
                  opened_at: seenIso,
                  opened_channel: 'imap_seen',
                  updated_at: seenIso,
                };
                if (target.assignmentStatus === 'sent') {
                  assignmentUpdate['status'] = 'opened';
                }
                const { data: updatedAssign } = await adminClient
                  .from('mail_assignments')
                  .update(assignmentUpdate)
                  .eq('id', target.assignmentId)
                  .eq('assigned_to', String(account.user_id))
                  .is('opened_at', null)
                  .select('id')
                  .maybeSingle();
                if (updatedAssign?.id) {
                  seenUpdatedCount++;
                }
              }
            }
          }
        }

        // 2. Suivi des mails transférés (Message-ID) et des réponses clients (In-Reply-To / References)
        const uidNext = Number(client.mailbox && typeof client.mailbox === 'object' ? client.mailbox.uidNext || 1 : 1);
        let startUid = maxProcessedUid + 1;
        if (maxProcessedUid === 0) {
          startUid = Math.max(1, uidNext - 15);
        }

        if (startUid < uidNext) {
          const range = `${startUid}:*`;
          const candidateMessages: {
            uid: number;
            messageId: string | null;
            subject: string;
            senderEmail: string;
            isSeen: boolean;
            referencedIds: string[];
          }[] = [];

          for await (const msg of client.fetch(
            range,
            {
              uid: true,
              flags: true,
              envelope: true,
              headers: ['in-reply-to', 'references'],
            },
            { uid: true }
          )) {
            if (msg.uid <= maxProcessedUid) continue;
            const fromEntry = msg.envelope?.from?.[0];
            const senderEmail = fromEntry?.address ? String(fromEntry.address).trim().toLowerCase() : '';
            const subject = String(msg.envelope?.subject || '').trim();
            const messageId = msg.envelope?.messageId ? String(msg.envelope.messageId).trim() : null;
            const isSeen = Boolean(msg.flags?.has('\\Seen'));
            const referencedIds = extractHeaderMessageIds(msg.headers);

            candidateMessages.push({
              uid: msg.uid,
              messageId,
              subject,
              senderEmail,
              isSeen,
              referencedIds,
            });
          }

          candidateMessages.sort((a, b) => a.uid - b.uid);
          const boundedCandidates = candidateMessages.slice(0, MAX_NEW_MESSAGES_PER_CYCLE);

          for (const candidate of boundedCandidates) {
            maxProcessedUid = Math.max(maxProcessedUid, candidate.uid);

            // Rapprochement d'un mail transféré par un manager (avant filtre expéditeurs exclus)
            if (candidate.messageId && pendingAssignmentByMsgId.has(candidate.messageId)) {
              const matchedAssign = pendingAssignmentByMsgId.get(candidate.messageId)!;
              const nowMatchIso = new Date().toISOString();
              const assignUpdate: Record<string, unknown> = {
                assigned_imap_uid: candidate.uid,
                assigned_mailbox_account_id: accountId,
                updated_at: nowMatchIso,
              };
              if (candidate.isSeen) {
                assignUpdate['opened_at'] = nowMatchIso;
                assignUpdate['opened_channel'] = 'imap_seen';
                if (matchedAssign.status === 'sent') {
                  assignUpdate['status'] = 'opened';
                }
              }
              const { data: updatedAssign } = await adminClient
                .from('mail_assignments')
                .update(assignUpdate)
                .eq('id', matchedAssign.id)
                .eq('assigned_to', String(account.user_id))
                .select('id')
                .maybeSingle();
              if (updatedAssign?.id && candidate.isSeen) {
                seenUpdatedCount++;
              }
            }

            if (isExcludedSender(candidate.senderEmail, String(account.email_address), settings.excluded_senders)) {
              continue;
            }

            if (candidate.referencedIds.length === 0) {
              continue;
            }

            const refSlice = candidate.referencedIds.slice(0, 10);
            let linkedQuoteId: string | null = null;

            const { data: parentLink } = await adminClient
              .from('mail_links')
              .select('entity_id')
              .eq('account_id', accountId)
              .eq('entity_type', 'quote')
              .in('internet_message_id', refSlice)
              .limit(1)
              .maybeSingle();

            if (parentLink?.entity_id) {
              linkedQuoteId = String(parentLink.entity_id);
            } else {
              const { data: parentIngested } = await adminClient
                .from('mail_ingested_messages')
                .select('quote_id')
                .eq('account_id', accountId)
                .in('internet_message_id', refSlice)
                .not('quote_id', 'is', null)
                .limit(1)
                .maybeSingle();

              if (parentIngested?.quote_id) {
                linkedQuoteId = String(parentIngested.quote_id);
              }
            }

            if (linkedQuoteId) {
              await adminClient.from('mail_ingested_messages').upsert(
                {
                  account_id: accountId,
                  imap_uid: candidate.uid,
                  internet_message_id: candidate.messageId,
                  in_reply_to: candidate.referencedIds[0] || null,
                  quote_id: linkedQuoteId,
                  sender_email: candidate.senderEmail,
                  subject: candidate.subject.slice(0, 250),
                  status: 'reply_linked',
                  is_seen_in_outlook: candidate.isSeen,
                  seen_detected_at: candidate.isSeen ? new Date().toISOString() : null,
                },
                { onConflict: 'account_id,imap_uid' }
              );

              await recordQuoteEvent(adminClient, {
                quoteId: linkedQuoteId,
                eventType: 'client_replied',
                actorUserId: null,
                metadata: {
                  senderEmail: candidate.senderEmail,
                  subject: candidate.subject.slice(0, 200),
                },
              });
              repliesLinkedCount++;
            }
          }
        }
      } finally {
        lock.release();
      }

      await client.logout().catch(() => undefined);

      const syncedIso = new Date().toISOString();
      await adminClient
        .from('mail_inbox_accounts')
        .update({
          last_synced_uid: maxProcessedUid,
          last_synced_at: syncedIso,
          last_error: null,
          updated_at: syncedIso,
        })
        .eq('id', accountId);

      return {
        accountId,
        ingestedCount: 0,
        repliesLinkedCount,
        seenUpdatedCount,
        lastSyncedAt: syncedIso,
      };
    } catch (imapErr: unknown) {
      const rawMsg = imapErr instanceof Error ? imapErr.message.toLowerCase() : '';
      const safeErrorMsg =
        rawMsg.includes('auth') || rawMsg.includes('credentials') || rawMsg.includes('login')
          ? 'Échec d’authentification IMAP : mettez à jour votre mot de passe mail dans Mon Profil.'
          : 'Synchronisation IMAP temporairement indisponible.';

      await adminClient
        .from('mail_inbox_accounts')
        .update({
          last_error: safeErrorMsg,
          updated_at: new Date().toISOString(),
        })
        .eq('id', accountId);

      throw new Error(safeErrorMsg);
    } finally {
      client.close();
    }
  });
}

export async function syncAllActiveMailAccounts(): Promise<void> {
  if (isGlobalSweepRunning || !isMailEncryptionConfigured()) return;
  const adminClient = getSupabaseAdmin();
  if (!adminClient) return;

  isGlobalSweepRunning = true;
  try {
    const settings = await loadGlobalMailSettings(adminClient);
    if (!settings || !settings.is_enabled || !settings.imap_host) return;

    const { data: accounts } = await adminClient
      .from('mail_inbox_accounts')
      .select('id')
      .eq('is_active', true)
      .limit(100);

    for (const acc of accounts || []) {
      try {
        await syncMailInboxAccount(adminClient, String(acc.id));
      } catch {
        // L'erreur générique est déjà enregistrée sur mail_inbox_accounts.last_error
      }
    }
  } finally {
    isGlobalSweepRunning = false;
  }
}

export function startMailSyncWorker(): void {
  if (workerTimer || !isMailEncryptionConfigured()) return;
  workerTimer = setInterval(() => {
    void syncAllActiveMailAccounts();
  }, WORKER_INTERVAL_MS);
  if (typeof workerTimer.unref === 'function') {
    workerTimer.unref();
  }
}

export function stopMailSyncWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}
