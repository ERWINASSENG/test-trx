import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createAppNotification } from './app-notifications';
import { writeAuditLog } from './audit-log';
import { getSupabaseAdmin } from './auth';
import {
  assertSafePublicMailHost,
  decryptMailSecret,
  isMailEncryptionConfigured,
} from './mail-crypto';
import { recordQuoteEvent } from './quotes';

const MAX_NEW_MESSAGES_PER_CYCLE = 25;
const MAX_RAW_EMAIL_BYTES = 2 * 1024 * 1024; // 2 Mo max pour le parsing texte
const WORKER_INTERVAL_MS = 60_000;

const activeAccountSyncs = new Set<string>();
let isGlobalSweepRunning = false;
let workerTimer: ReturnType<typeof setInterval> | null = null;

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
  let safeHost: string;
  try {
    safeHost = await assertSafePublicMailHost(params.host);
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Serveur IMAP invalide ou non autorisé.',
    };
  }

  const client = new ImapFlow({
    host: safeHost,
    port: params.port,
    secure: params.secure,
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
        ? 'Identifiants refusés par le serveur mail (vérifiez votre email et mot de passe Outlook).'
        : isFolderErr
          ? `Le dossier IMAP « ${params.watchedFolder} » est introuvable dans cette boîte.`
          : 'Impossible de joindre le serveur IMAP configuré. Vérifiez les paramètres serveur.',
    };
  } finally {
    client.close();
  }
}

function buildEmptyQuoteColumns(): {
  columns: { id: string; label: string; type: 'text' | 'amount' }[];
  totalColumnId: string;
} {
  const descColId = crypto.randomUUID();
  const amountColId = crypto.randomUUID();
  return {
    columns: [
      { id: descColId, label: 'Désignation', type: 'text' },
      { id: amountColId, label: 'Montant HT', type: 'amount' },
    ],
    totalColumnId: amountColId,
  };
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

function matchesQuoteKeywords(subject: string, watchedFolder: string, keywords: string[]): boolean {
  if (watchedFolder.trim().toUpperCase() !== 'INBOX') {
    // Dossier dédié (ex. Cotations) : tout mail déposé est volontairement à coter
    return true;
  }
  const normalizedSubject = subject.toLowerCase();
  if (keywords.length === 0) {
    return false;
  }
  return keywords.some((kw) => kw.length >= 2 && normalizedSubject.includes(kw));
}

function extractHeaderMessageIds(headersBuf: Buffer | undefined): string[] {
  if (!headersBuf) return [];
  const raw = headersBuf.toString('utf8');
  const matches = raw.match(/<[^>]+>/g) || [];
  return [...new Set(matches.map((m) => m.trim()))];
}

async function resolveOrCreateMinimalProspect(
  adminClient: SupabaseClient,
  senderEmail: string,
  senderDisplayName: string | null,
  assignedTo: string | null,
  actorUserId: string
): Promise<string | null> {
  const cleanEmail = senderEmail.trim().toLowerCase();
  const safeIlikeEmail = cleanEmail.replace(/[%_]/g, '');

  const { data: existing } = await adminClient
    .from('prospects')
    .select('id')
    .ilike('email', safeIlikeEmail)
    .limit(1)
    .maybeSingle();

  if (existing?.id) {
    return String(existing.id);
  }

  // Règle stricte : ZÉRO donnée devinée — uniquement l'email réel et le nom affiché s'il existe
  const cleanDisplayName = senderDisplayName?.trim().slice(0, 160) || null;
  const { data: created, error } = await adminClient
    .from('prospects')
    .insert({
      name: cleanDisplayName || cleanEmail,
      company_name: null,
      contact_name: cleanDisplayName,
      email: cleanEmail,
      phone: null,
      country: null,
      sector: null,
      contact_role: null,
      estimated_value: null,
      source: 'outlook_imap',
      status: 'new',
      assigned_to: assignedTo,
      created_by: actorUserId,
    })
    .select('id')
    .single();

  if (error || !created?.id) {
    console.error('[MAIL-SYNC] Échec création prospect minimal:', error?.message || 'inconnu');
    return null;
  }

  return String(created.id);
}

export async function syncMailInboxAccount(
  adminClient: SupabaseClient,
  accountId: string
): Promise<MailSyncSummary> {
  const nowIso = new Date().toISOString();
  if (activeAccountSyncs.has(accountId)) {
    return {
      accountId,
      ingestedCount: 0,
      repliesLinkedCount: 0,
      seenUpdatedCount: 0,
      lastSyncedAt: nowIso,
    };
  }

  activeAccountSyncs.add(accountId);
  try {
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

    const safeHost = await assertSafePublicMailHost(settings.imap_host);
    const password = decryptMailSecret(String(account.encrypted_password));

    const client = new ImapFlow({
      host: safeHost,
      port: settings.imap_port,
      secure: settings.imap_tls,
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

    let ingestedCount = 0;
    let repliesLinkedCount = 0;
    let seenUpdatedCount = 0;
    let maxProcessedUid = Number(account.last_synced_uid || 0);

    try {
      await client.connect();
      const lock = await client.getMailboxLock(settings.watched_folder, { readOnly: true });

      try {
        // 1. Vérification du flag \Seen dans Outlook sur les cotations non lues de cette boîte
        const { data: unseenRows } = await adminClient
          .from('mail_ingested_messages')
          .select('id, imap_uid, quote_id')
          .eq('account_id', accountId)
          .eq('status', 'ingested')
          .eq('is_seen_in_outlook', false)
          .not('quote_id', 'is', null)
          .limit(50);

        if (unseenRows && unseenRows.length > 0) {
          const uidMap = new Map<number, { rowId: string; quoteId: string }>();
          for (const row of unseenRows) {
            uidMap.set(Number(row.imap_uid), {
              rowId: String(row.id),
              quoteId: String(row.quote_id),
            });
          }
          const uidSequence = [...uidMap.keys()].join(',');
          for await (const msg of client.fetch(uidSequence, { uid: true, flags: true }, { uid: true })) {
            if (msg.flags?.has('\\Seen')) {
              const target = uidMap.get(msg.uid);
              if (!target) continue;

              const seenIso = new Date().toISOString();
              await adminClient
                .from('mail_ingested_messages')
                .update({ is_seen_in_outlook: true, seen_detected_at: seenIso })
                .eq('id', target.rowId);

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
              }
              seenUpdatedCount++;
            }
          }
        }

        // 2. Détermination de la plage de nouveaux UID à inspecter (en-têtes uniquement d'abord)
        const uidNext = Number(client.mailbox && typeof client.mailbox === 'object' ? client.mailbox.uidNext || 1 : 1);
        let startUid = maxProcessedUid + 1;
        if (maxProcessedUid === 0) {
          // 1re connexion : n'examine que les 15 derniers messages pour éviter d'importer tout l'historique ancien
          startUid = Math.max(1, uidNext - 15);
        }

        if (startUid < uidNext) {
          const range = `${startUid}:*`;
          const candidateMessages: {
            uid: number;
            messageId: string | null;
            subject: string;
            senderEmail: string;
            senderName: string | null;
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
            const senderName = fromEntry?.name ? String(fromEntry.name).trim() : null;
            const subject = String(msg.envelope?.subject || '').trim();
            const messageId = msg.envelope?.messageId ? String(msg.envelope.messageId).trim() : null;
            const isSeen = Boolean(msg.flags?.has('\\Seen'));
            const referencedIds = extractHeaderMessageIds(msg.headers);

            candidateMessages.push({
              uid: msg.uid,
              messageId,
              subject,
              senderEmail,
              senderName,
              isSeen,
              referencedIds,
            });
          }

          candidateMessages.sort((a, b) => a.uid - b.uid);
          const boundedCandidates = candidateMessages.slice(0, MAX_NEW_MESSAGES_PER_CYCLE);

          // Chargement unique des superviseurs pour les notifications
          const { data: supervisors } = await adminClient
            .from('profiles')
            .select('id')
            .in('role', ['manager', 'admin'])
            .eq('is_active', true)
            .limit(20);
          const supervisorIds = (supervisors || []).map((s) => String(s.id));

          const { data: ownerProfile } = await adminClient
            .from('profiles')
            .select('first_name, last_name, email')
            .eq('id', String(account.user_id))
            .maybeSingle();
          const ownerLabel = ownerProfile
            ? `${ownerProfile.first_name || ''} ${ownerProfile.last_name || ''}`.trim() || String(ownerProfile.email || '')
            : String(account.email_address);

          for (const candidate of boundedCandidates) {
            maxProcessedUid = Math.max(maxProcessedUid, candidate.uid);

            // Ignorer immédiatement les mails sans expéditeur valide ou provenant d'expéditeurs exclus (sans rien stocker)
            if (isExcludedSender(candidate.senderEmail, String(account.email_address), settings.excluded_senders)) {
              continue;
            }

            // Cas A : Réponse client à une cotation existante connue (In-Reply-To / References)
            if (candidate.referencedIds.length > 0) {
              const { data: parentMsg } = await adminClient
                .from('mail_ingested_messages')
                .select('quote_id')
                .in('internet_message_id', candidate.referencedIds.slice(0, 10))
                .not('quote_id', 'is', null)
                .limit(1)
                .maybeSingle();

              if (parentMsg?.quote_id) {
                const linkedQuoteId = String(parentMsg.quote_id);
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
                continue;
              }
            }

            // Cas B : Filtrage anti-bruit — tous les autres mails hors cotation sont ignorés sans téléchargement ni stockage
            if (!matchesQuoteKeywords(candidate.subject, settings.watched_folder, settings.subject_keywords)) {
              continue;
            }

            // Déduplication inter-boîtes par Message-ID (ex. client ayant mis manager + commercial en copie)
            if (candidate.messageId) {
              const { data: duplicateMsg } = await adminClient
                .from('mail_ingested_messages')
                .select('id, quote_id')
                .eq('internet_message_id', candidate.messageId)
                .not('quote_id', 'is', null)
                .limit(1)
                .maybeSingle();

              if (duplicateMsg?.quote_id) {
                const existingQuoteId = String(duplicateMsg.quote_id);
                // Si la cotation existante n'était pas encore assignée et que ce mail arrive chez un commercial, on l'attribue
                if (account.account_role === 'commercial') {
                  const assignIso = new Date().toISOString();
                  const { data: assignedNow } = await adminClient
                    .from('sales_quotes')
                    .update({
                      assigned_to: String(account.user_id),
                      assigned_at: assignIso,
                      ...(candidate.isSeen ? { outlook_read_at: assignIso } : {}),
                      updated_at: assignIso,
                    })
                    .eq('id', existingQuoteId)
                    .is('assigned_to', null)
                    .select('id')
                    .maybeSingle();

                  if (assignedNow?.id) {
                    await recordQuoteEvent(adminClient, {
                      quoteId: existingQuoteId,
                      eventType: 'assigned',
                      actorUserId: null,
                      metadata: { assignedTo: String(account.user_id), reason: 'cc_commercial_mailbox' },
                    });
                  }
                }

                await adminClient.from('mail_ingested_messages').upsert(
                  {
                    account_id: accountId,
                    imap_uid: candidate.uid,
                    internet_message_id: candidate.messageId,
                    quote_id: existingQuoteId,
                    sender_email: candidate.senderEmail,
                    subject: candidate.subject.slice(0, 250),
                    status: 'ingested',
                    is_seen_in_outlook: candidate.isSeen,
                    seen_detected_at: candidate.isSeen ? new Date().toISOString() : null,
                  },
                  { onConflict: 'account_id,imap_uid' }
                );
                continue;
              }
            }

            // Téléchargement borné du message uniquement pour extraire le texte brut (zéro HTML conservé — S5)
            let plainBodyText = '';
            try {
              const downloadObj = await client.download(String(candidate.uid), undefined, {
                uid: true,
                maxBytes: MAX_RAW_EMAIL_BYTES,
              });
              if (downloadObj?.content) {
                const parsed = await simpleParser(downloadObj.content);
                plainBodyText = String(parsed.text || '').trim().slice(0, 10_000);
              }
            } catch {
              plainBodyText = '';
            }

            const assignedTo = account.account_role === 'commercial' ? String(account.user_id) : null;
            const prospectId = await resolveOrCreateMinimalProspect(
              adminClient,
              candidate.senderEmail,
              candidate.senderName,
              assignedTo,
              String(account.user_id)
            );
            if (!prospectId) continue;

            const { columns, totalColumnId } = buildEmptyQuoteColumns();
            const createdIso = new Date().toISOString();
            const cleanSubject = candidate.subject.slice(0, 480) || 'Demande de cotation (sans objet)';
            const senderDisplay = candidate.senderName
              ? `${candidate.senderName} <${candidate.senderEmail}>`.slice(0, 310)
              : candidate.senderEmail.slice(0, 310);

            // Création de la cotation brouillon strictement vide (le commercial remplira tous les éléments manquants)
            const { data: createdQuote, error: quoteErr } = await adminClient
              .from('sales_quotes')
              .insert({
                prospect_id: prospectId,
                opportunity_id: null,
                contact_id: null,
                assigned_to: assignedTo,
                assigned_at: assignedTo ? createdIso : null,
                created_by: String(account.user_id),
                title: cleanSubject,
                currency: 'XAF',
                columns,
                rows: [],
                total_column_id: totalColumnId,
                total_amount: 0,
                status: 'draft',
                valid_until: null,
                sea_freight: {},
                source_channel: 'outlook_imap',
                source_mailbox_account_id: accountId,
                source_email_sender: senderDisplay,
                source_email_subject: cleanSubject,
                source_email_body_text: plainBodyText || null,
                outlook_read_at: candidate.isSeen ? createdIso : null,
              })
              .select('id, quote_number')
              .single();

            if (quoteErr || !createdQuote?.id) {
              console.error('[MAIL-SYNC] Échec création cotation IMAP:', quoteErr?.message || 'inconnu');
              continue;
            }

            const quoteId = String(createdQuote.id);
            const quoteNumber = String(createdQuote.quote_number);

            await adminClient.from('mail_ingested_messages').upsert(
              {
                account_id: accountId,
                imap_uid: candidate.uid,
                internet_message_id: candidate.messageId,
                quote_id: quoteId,
                sender_email: candidate.senderEmail,
                subject: cleanSubject.slice(0, 250),
                status: 'ingested',
                is_seen_in_outlook: candidate.isSeen,
                seen_detected_at: candidate.isSeen ? createdIso : null,
              },
              { onConflict: 'account_id,imap_uid' }
            );

            await recordQuoteEvent(adminClient, {
              quoteId,
              eventType: 'email_received',
              actorUserId: null,
              metadata: {
                senderEmail: candidate.senderEmail,
                subject: cleanSubject.slice(0, 200),
                mailboxEmail: String(account.email_address),
              },
            });

            if (assignedTo) {
              await recordQuoteEvent(adminClient, {
                quoteId,
                eventType: 'assigned',
                actorUserId: null,
                metadata: { assignedTo, source: 'commercial_mailbox' },
              });
            }

            if (candidate.isSeen) {
              await recordQuoteEvent(adminClient, {
                quoteId,
                eventType: 'email_seen_in_outlook',
                actorUserId: String(account.user_id),
                metadata: { mailboxEmail: String(account.email_address) },
              });
            }

            // Notifications temps réel Manager & Commercial + Audit
            for (const supId of supervisorIds) {
              await createAppNotification(adminClient, {
                recipientId: supId,
                actorId: String(account.user_id),
                notificationType: 'quote_email_received',
                title: assignedTo
                  ? `Nouvelle demande reçue par ${ownerLabel}`
                  : `Nouvelle demande de cotation à attribuer`,
                message: `${quoteNumber} — ${senderDisplay} : ${cleanSubject.slice(0, 110)}`,
                href: '/dashboard/crm',
                sourceType: 'quote',
                sourceId: quoteId,
                dedupeKey: `quote:${quoteId}:imap:${supId}`,
              });
            }

            if (assignedTo && !supervisorIds.includes(assignedTo)) {
              await createAppNotification(adminClient, {
                recipientId: assignedTo,
                actorId: assignedTo,
                notificationType: 'assignment',
                title: `Demande Outlook synchronisée : ${quoteNumber}`,
                message: `Complétez les informations manquantes pour « ${cleanSubject.slice(0, 100)} ».`,
                href: `/quotes?quoteId=${quoteId}`,
                sourceType: 'quote',
                sourceId: quoteId,
                dedupeKey: `quote:${quoteId}:imap_rep:${assignedTo}`,
              });
            }

            await writeAuditLog(adminClient, {
              userId: String(account.user_id),
              action: 'INGEST_OUTLOOK_QUOTE',
              entityType: 'sales_quote',
              entityId: quoteId,
              details: {
                quote_number: quoteNumber,
                mailbox_role: account.account_role,
                sender_email: candidate.senderEmail,
              },
              ipAddress: null,
            });

            ingestedCount++;
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
        ingestedCount,
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
  } finally {
    activeAccountSyncs.delete(accountId);
  }
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
