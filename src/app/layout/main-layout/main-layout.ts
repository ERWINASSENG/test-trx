import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs/operators';
import { MatIconModule } from '@angular/material/icon';
import { ROLE_DEFINITIONS, UserRole } from '../../core/models/auth.model';
import { AccessControlService } from '../../core/services/access-control.service';
import { AuthService } from '../../core/services/auth.service';
import { CashierService } from '../../core/services/cashier.service';
import { ThemeService } from '../../core/services/theme.service';
import { NotificationService } from '../../core/services/notification.service';
import { CashierImportModal } from '../../features/cashier/import-modal/cashier-import-modal.component';
import { ParsedImportRow } from '../../core/services/import.service';
import { JournalService } from '../../core/services/journal.service';

export interface NavOption {
  id: string;
  label: string;
  route: string;
  icon?: string;
  permissionKey: string;
}

type CrmView = 'pipeline' | 'clients' | 'activities' | 'campaigns';

@Component({
  selector: 'app-main-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule, CashierImportModal],
  templateUrl: './main-layout.html',
  styleUrl: './main-layout.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'onEscape()',
  },
})
export class MainLayout {
  public readonly authService = inject(AuthService);
  public readonly accessControl = inject(AccessControlService);
  public readonly cashierService = inject(CashierService);
  public readonly themeService = inject(ThemeService);
  public readonly notificationService = inject(NotificationService);
  public readonly journalService = inject(JournalService);
  public readonly router = inject(Router);

  public readonly currentUser = this.authService.currentUser;
  public readonly isMenuOpen = signal<boolean>(false);
  public readonly isUserDropdownOpen = signal<boolean>(false);
  public readonly isConfigDropdownOpen = signal<boolean>(false);

  // Thème actuel
  public readonly currentTheme = this.themeService.currentTheme;
  public readonly isDarkMode = computed(() => this.themeService.isDarkMode());

  public readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects || e.url)
    ),
    { initialValue: this.router.url }
  );
  public readonly isCrmRoute = computed(() => this.currentUrl().split(/[?#]/)[0] === '/crm-commercial');
  public readonly crmMenuItems: { id: CrmView; label: string }[] = [
    { id: 'pipeline', label: 'Pipeline' },
    { id: 'clients', label: 'Clients' },
    { id: 'activities', label: 'Tâches & relances' },
    { id: 'campaigns', label: 'Campagnes' },
  ];
  public readonly activeCrmView = computed<CrmView>(() => {
    const view = this.router.parseUrl(this.currentUrl()).queryParams['view'];
    return this.crmMenuItems.find((item) => item.id === view)?.id ?? 'pipeline';
  });

  // Indicateur si la route active est sous Configuration
  public readonly isConfigActive = computed(() => {
    const url = this.currentUrl();
    return url ? url.includes('/configuration') || url.includes('/settings') : false;
  });

  // La caisse native est éditable par admin/caissière; un trésorier ne modifie que ses journaux.
  public readonly canEditCaisse = computed(() => {
    const journalId = this.cashierService.activeJournalId();
    const isNativeCashJournal =
      !journalId ||
      journalId === 'native-caisse-principal' ||
      journalId === 'CSH1' ||
      this.cashierService.activeJournalPrefix() === 'CSH1';

    if (isNativeCashJournal) return this.accessControl.hasPermission('cashier.create');

    const activeJournal = this.journalService.journals().find((journal) => journal.id === journalId);
    return this.accessControl.hasPermissionForResource('journal_entries.create', {
      ownerUserId: activeJournal?.created_by,
    });
  });

  // Pour rétrocompatibilité
  public readonly isSidebarOpen = this.isMenuOpen;

  // Le menu suit les permissions effectives; il ne constitue pas la barrière d’accès serveur.
  private readonly allMenuItems: NavOption[] = [
    {
      id: 'dashboard',
      label: 'Tableau de bord',
      route: '/dashboard',
      icon: 'dashboard',
      permissionKey: 'dashboard.view',
    },
    {
      id: 'caisse',
      label: 'Caisse',
      route: '/caisse',
      icon: 'point_of_sale',
      permissionKey: 'cashier.read',
    },
    {
      id: 'personnel',
      label: 'Personnel & RH',
      route: '/personnel',
      icon: 'badge',
      permissionKey: 'hr.read',
    },
    {
      id: 'access-control',
      label: 'Gestion des accès',
      route: '/admin/access-control',
      icon: 'admin_panel_settings',
      permissionKey: 'access.roles.read',
    },
    {
      id: 'configuration',
      label: 'Configuration',
      route: '/configuration',
      icon: 'settings',
      permissionKey: 'configuration.read',
    },
  ];

  public readonly visibleMenuItems = computed<NavOption[]>(() => {
    const user = this.currentUser();
    if (!user) return [];
    return this.allMenuItems.filter((item) => this.accessControl.hasPermission(item.permissionKey));
  });

  public roleLabel(role: UserRole | undefined): string {
    if (!role) return 'Non défini';
    return ROLE_DEFINITIONS[role]?.label ?? role;
  }

  public roleBadgeColor(role: UserRole | undefined): string {
    if (!role) return 'bg-slate-700 text-slate-300';
    return ROLE_DEFINITIONS[role]?.badgeClass ?? 'bg-slate-700 text-slate-300';
  }

  public toggleMenu(): void {
    this.isMenuOpen.update((open) => !open);
  }

  public closeMenu(): void {
    this.isMenuOpen.set(false);
  }

  public toggleSidebar(): void {
    this.toggleMenu();
  }

  public closeSidebar(): void {
    this.closeMenu();
  }

  // --- Gestion du Menu Déroulant Utilisateur ---
  public toggleUserDropdown(event?: Event): void {
    if (event) {
      event.stopPropagation();
    }
    this.closeConfigDropdown();
    this.isUserDropdownOpen.update((open) => !open);
  }

  public closeUserDropdown(): void {
    this.isUserDropdownOpen.set(false);
  }

  public toggleTheme(event?: Event): void {
    if (event) {
      event.stopPropagation();
    }
    this.themeService.toggleTheme();
  }

  // --- Gestion du Menu Déroulant Configuration (Paramètres & Journal) ---
  public toggleConfigDropdown(event?: Event): void {
    if (event) {
      event.stopPropagation();
    }
    this.closeUserDropdown();
    this.isConfigDropdownOpen.update((open) => !open);
  }

  public closeConfigDropdown(): void {
    this.isConfigDropdownOpen.set(false);
  }

  public onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    // Si le clic s'est produit en dehors du dropdown utilisateur, on le ferme
    if (!target.closest('#user-dropdown-container')) {
      this.closeUserDropdown();
    }
    // Si le clic s'est produit en dehors du menu déroulant Configuration, on le ferme
    if (!target.closest('#config-dropdown-container')) {
      this.closeConfigDropdown();
    }
  }

  public onEscape(): void {
    this.closeUserDropdown();
    this.closeConfigDropdown();
    this.closeMenu();
  }

  public async onImportConfirmed(rows: ParsedImportRow[]): Promise<void> {
    this.cashierService.closeImportModal();
    if (!this.canEditCaisse()) return;
    const result = await this.cashierService.importTransactions(rows);
    if (result.insertedCount > 0) {
      this.notificationService.success(
        `${result.insertedCount} transaction(s) importée(s) avec succès avec numéros de pièce attribués par le serveur.${result.duplicateCount > 0 ? ` (${result.duplicateCount} doublon(s) ignoré(s))` : ''}`,
        'Import réussi'
      );
    } else if (result.duplicateCount > 0 && result.insertedCount === 0) {
      this.notificationService.info(
        `Aucune nouvelle transaction importée : les ${result.duplicateCount} transaction(s) existent déjà en base de données (doublons).`,
        'Transactions existantes'
      );
    }
    if (result.errors.length > 0) {
      console.warn('Importation avec alertes:', result.errors);
      const message = result.errors.slice(0, 3).join(' ');
      const isDuplicate = result.errors.some((error) => error.toLowerCase().includes('doublon'));
      this.notificationService.warning(message, isDuplicate ? 'Doublon détecté' : 'Erreurs lors de l’import');
    }
  }

  public async logout(): Promise<void> {
    this.closeUserDropdown();
    await this.authService.logout();
  }
}
