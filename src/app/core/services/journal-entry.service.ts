import { Injectable, computed, inject, signal } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';
import { NotificationService } from './notification.service';
import {
  CreateJournalEntryDto,
  JournalChartData,
  JournalEntry,
} from '../models/journal-entry.model';
import { getApiErrorMessage } from '../utils/api-error.util';

@Injectable({
  providedIn: 'root',
})
export class JournalEntryService {
  private readonly supabaseService = inject(SupabaseService);
  private readonly authService = inject(AuthService);
  private readonly notificationService = inject(NotificationService);

  private readonly _activeJournalId = signal<string | null>(null);
  private readonly _entries = signal<JournalEntry[]>([]);
  private readonly _isLoading = signal<boolean>(false);
  private readonly _isSubmitting = signal<boolean>(false);
  private readonly _searchQuery = signal<string>('');

  // Signaux publics
  public readonly activeJournalId = computed(() => this._activeJournalId());
  public readonly entries = computed(() => this._entries());
  public readonly isLoading = computed(() => this._isLoading());
  public readonly isSubmitting = computed(() => this._isSubmitting());
  public readonly searchQuery = computed(() => this._searchQuery());

  // Écritures filtrées par la recherche
  public readonly filteredEntries = computed(() => {
    const q = this._searchQuery().trim().toLowerCase();
    const list = this._entries();
    if (!q) return list;
    return list.filter(
      (e) =>
        e.piece_comptable.toLowerCase().includes(q) ||
        e.libelle.toLowerCase().includes(q) ||
        (e.partenaire && e.partenaire.toLowerCase().includes(q)) ||
        (e.employee && e.employee.toLowerCase().includes(q)) ||
        (e.service && e.service.toLowerCase().includes(q)) ||
        (e.no_dossier && e.no_dossier.toLowerCase().includes(q))
    );
  });

  // Calcul du solde en temps réel strictement isolé pour le journal actif
  public readonly currentBalance = computed(() => {
    return this._entries().reduce((acc, e) => acc + (Number(e.montant) || 0), 0);
  });

  public readonly totalEntriesCount = computed(() => this._entries().length);

  public readonly entreesTotal = computed(() => {
    return this._entries()
      .filter((e) => e.category === 'entree')
      .reduce((acc, e) => acc + (Number(e.montant) || 0), 0);
  });

  public readonly sortiesTotal = computed(() => {
    return this._entries()
      .filter((e) => e.category === 'sortie')
      .reduce((acc, e) => acc + Math.abs(Number(e.montant) || 0), 0);
  });

  public setSearchQuery(query: string): void {
    this._searchQuery.set(query);
  }

  /**
   * Charge toutes les écritures rattachées à un journal spécifique
   */
  public async loadEntries(journalId: string): Promise<JournalEntry[]> {
    if (!journalId) return [];

    this._activeJournalId.set(journalId);
    this._isLoading.set(true);

    let token = this.authService.token();
    if (!token && this.supabaseService.supabase) {
      try {
        const { data } = await this.supabaseService.supabase.auth.getSession();
        if (data.session?.access_token) {
          token = data.session.access_token;
        }
      } catch {
        // Ignorer
      }
    }

    try {
      const res = await fetch(`/api/journals/${encodeURIComponent(journalId)}/entries`, {
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (res.ok) {
        const json: unknown = await res.json();
        if (
          typeof json !== 'object'
          || json === null
          || !('entries' in json)
          || !Array.isArray(json.entries)
        ) {
          this.notificationService.error('Le serveur a renvoyé une liste d’écritures invalide.', 'Chargement impossible');
          return [];
        }
        const loaded: JournalEntry[] = json.entries.map((row: Record<string, unknown>) => ({
          id: String(row['id']),
          journal_id: String(row['journal_id']),
          sequence_number: Number(row['sequence_number']) || 1,
          piece_comptable: String(row['piece_comptable']),
          date: String(row['date'] || '').split('T')[0],
          libelle: String(row['libelle']),
          service: row['service'] ? String(row['service']) : '',
          type_description: row['type_description'] ? String(row['type_description']) : '',
          category: row['category'] === 'sortie' ? 'sortie' : 'entree',
          status: (row['status'] as JournalEntry['status']) || 'draft',
          no_dossier: row['no_dossier'] ? String(row['no_dossier']) : '',
          partenaire: row['partenaire'] ? String(row['partenaire']) : '',
          employee: row['employee'] ? String(row['employee']) : '',
          quantity: Number(row['quantity']) || 1,
          montant: Number(row['montant']) || 0,
          solde_apres: row['solde_apres'] !== undefined ? Number(row['solde_apres']) : undefined,
          created_by: row['created_by'] ? String(row['created_by']) : undefined,
          employee_id: row['employee_id'] ? String(row['employee_id']) : undefined,
          created_at: String(row['created_at'] || ''),
          updated_at: String(row['updated_at'] || ''),
          selected: false,
        }));

        this._entries.set(loaded);
        return loaded;
      }
      const payload = await res.json().catch(() => null);
      this.notificationService.error(
        getApiErrorMessage(payload, `Impossible de charger les écritures (erreur HTTP ${res.status}).`),
        'Chargement impossible'
      );
    } catch (err) {
      console.warn('Erreur chargement écritures de journal:', err);
      this.notificationService.error(
        err instanceof TypeError
          ? 'Connexion au service des écritures impossible. Vérifiez votre connexion puis réessayez.'
          : 'Une erreur est survenue lors du chargement des écritures.',
        'Chargement impossible'
      );
    } finally {
      this._isLoading.set(false);
    }

    return [];
  }

  /**
   * Enregistre une nouvelle écriture comptable dans le journal
   */
  public async createEntry(dto: CreateJournalEntryDto): Promise<JournalEntry | null> {
    const journalId = dto.journal_id;
    if (!journalId) {
      this.notificationService.error('Identifiant de journal manquant.', 'Erreur');
      return null;
    }

    this._isSubmitting.set(true);

    let token = this.authService.token();
    if (!token && this.supabaseService.supabase) {
      try {
        const { data } = await this.supabaseService.supabase.auth.getSession();
        if (data.session?.access_token) {
          token = data.session.access_token;
        }
      } catch {
        // Ignorer
      }
    }

    try {
      const res = await fetch(`/api/journals/${encodeURIComponent(journalId)}/entries`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(dto),
      });

      const resData = await res.json().catch(() => null);
      if (res.ok && resData?.entry) {
        const row = resData.entry;
        const inserted: JournalEntry = {
          id: String(row.id),
          journal_id: String(row.journal_id),
          sequence_number: Number(row.sequence_number) || 1,
          piece_comptable: String(row.piece_comptable),
          date: String(row.date || '').split('T')[0],
          libelle: String(row.libelle),
          service: row.service ? String(row.service) : '',
          type_description: row.type_description ? String(row.type_description) : '',
          category: row.category === 'sortie' ? 'sortie' : 'entree',
          status: (row.status as JournalEntry['status']) || 'draft',
          no_dossier: row.no_dossier ? String(row.no_dossier) : '',
          partenaire: row.partenaire ? String(row.partenaire) : '',
          employee: row.employee ? String(row.employee) : '',
          quantity: Number(row.quantity) || 1,
          montant: Number(row.montant) || 0,
          created_by: row.created_by ? String(row.created_by) : undefined,
          employee_id: row.employee_id ? String(row.employee_id) : undefined,
          created_at: String(row.created_at || ''),
          updated_at: String(row.updated_at || ''),
          selected: false,
        };

        this._entries.update((list) => [...list, inserted]);
        this.notificationService.success(
          `Écriture ${inserted.piece_comptable} enregistrée avec succès.`,
          'Opération enregistrée'
        );
        return inserted;
      } else {
        const err = getApiErrorMessage(
          resData,
          `Impossible d’enregistrer l’écriture${res.ok ? ' : réponse serveur invalide' : ` (erreur HTTP ${res.status})`}.`
        );
        this.notificationService.error(err, 'Échec de saisie');
        return null;
      }
    } catch (err: unknown) {
      console.error('Erreur réseau saisie écriture:', err);
      this.notificationService.error(
        err instanceof TypeError
          ? 'Connexion au service comptable impossible pour enregistrer l’écriture. Vérifiez votre connexion puis réessayez.'
          : 'Une erreur est survenue lors de l’enregistrement de l’écriture.',
        'Échec de saisie'
      );
      return null;
    } finally {
      this._isSubmitting.set(false);
    }
  }

  /**
   * Récupère les points chronologiques (dates, solde cumulé) pour le graphique Chart.js
   */
  public async getChartData(journalId: string): Promise<JournalChartData | null> {
    if (!journalId) return null;

    let token = this.authService.token();
    if (!token && this.supabaseService.supabase) {
      try {
        const { data } = await this.supabaseService.supabase.auth.getSession();
        if (data.session?.access_token) {
          token = data.session.access_token;
        }
      } catch {
        // Ignorer
      }
    }

    try {
      const res = await fetch(`/api/journals/${encodeURIComponent(journalId)}/chart-data`, {
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (res.ok) {
        const data: unknown = await res.json();
        if (typeof data !== 'object' || data === null || Array.isArray(data)) {
          this.notificationService.error('Le serveur a renvoyé des données de graphique invalides.', 'Chargement impossible');
          return null;
        }
        const chartData = data as Record<string, unknown>;
        return {
          journal_id: String(chartData['journal_id'] ?? journalId),
          current_balance: Number(chartData['current_balance']) || 0,
          labels: Array.isArray(chartData['labels']) ? chartData['labels'] : [],
          balances: Array.isArray(chartData['balances']) ? chartData['balances'].map(Number) : [],
          descriptions: Array.isArray(chartData['descriptions']) ? chartData['descriptions'] : [],
        };
      }
      const payload = await res.json().catch(() => null);
      this.notificationService.error(
        getApiErrorMessage(payload, `Impossible de charger les données du graphique (erreur HTTP ${res.status}).`),
        'Chargement impossible'
      );
    } catch (err) {
      console.warn(`Erreur récupération données graphiques pour ${journalId}:`, err);
      this.notificationService.error(
        err instanceof TypeError
          ? 'Connexion au service des graphiques impossible. Vérifiez votre connexion puis réessayez.'
          : 'Une erreur est survenue lors du chargement des données du graphique.',
        'Chargement impossible'
      );
    }

    return null;
  }
}
