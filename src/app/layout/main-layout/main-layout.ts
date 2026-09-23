import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs/operators';
import { MatIconModule } from '@angular/material/icon';
import { ROLE_DEFINITIONS, UserRole } from '../../core/models/auth.model';
import { AuthService } from '../../core/services/auth.service';
import { CashierService } from '../../core/services/cashier.service';
import { ThemeService } from '../../core/services/theme.service';
import { NotificationService } from '../../core/services/notification.service';
import { CashierImportModal } from '../../features/cashier/import-modal/cashier-import-modal.component';
import { ParsedImportRow } from '../../core/services/import.service';

export interface NavOption {
  id: string;
  label: string;
  route: string;
  icon: string;
  allowedRoles: UserRole[];
}

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
  public readonly cashierService = inject(CashierService);
  public readonly themeService = inject(ThemeService);
  public readonly notificationService = inject(NotificationService);
  public readonly router = inject(Router);

  public readonly currentUser = this.authService.currentUser;
  public readonly isMenuOpen = signal<boolean>(false);
  public readonly isUserDropdownOpen = signal<boolean>(false);
  public readonly isActionsMenuOpen = signal<boolean>(false);
  public readonly isDeleting = signal<boolean>(false);
  public readonly searchQuery = signal<string>('');
  public readonly activeView = signal<'graph' | 'list'>('list');

  public readonly selectedTransactionsCount = computed(() => {
    return this.cashierService.allTransactions().filter((t) => t.selected).length;
  });

  // Thème actuel
  public readonly currentTheme = this.themeService.currentTheme;
  public readonly isDarkMode = computed(() => this.themeService.isDarkMode());

  // Suivi réactif de l'URL pour déterminer si nous sommes dans le module Caisse
  public readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects || e.url)
    ),
    { initialValue: this.router.url }
  );

  // Le Control Panel s'affiche exclusivement dans le module Caisse (et pas dans le tableau de bord)
  public readonly isCashierRoute = computed(() => {
    const url = this.currentUrl();
    return url ? url.includes('/caisse') : false;
  });

  // Droit d'édition en caisse (uniquement admin et caissière, pas le manager)
  public readonly canEditCaisse = computed(() => {
    const role = this.authService.currentRole();
    return role === 'admin' || role === 'caissiere';
  });

  // Synchronisation pagination et état avec le module Caisse
  public readonly paginationLabel = computed(() => this.cashierService.paginationLabel());
  public readonly hasPrevPage = computed(() => this.cashierService.hasPrevPage());
  public readonly hasNextPage = computed(() => this.cashierService.hasNextPage());

  // Pour rétrocompatibilité
  public readonly isSidebarOpen = this.isMenuOpen;

  // Menu de navigation principal Transimex avec contrôle d'accès RBAC
  private readonly allMenuItems: NavOption[] = [
    {
      id: 'dashboard',
      label: 'Tableau de bord',
      route: '/dashboard',
      icon: 'dashboard',
      allowedRoles: ['admin', 'manager', 'caissiere', 'employe', 'tresorier', 'comptable'],
    },
    {
      id: 'caisse',
      label: 'Caisse',
      route: '/caisse',
      icon: 'point_of_sale',
      allowedRoles: ['admin', 'caissiere', 'comptable'],
    },
    {
      id: 'personnel',
      label: 'Personnel & RH',
      route: '/personnel',
      icon: 'badge',
      allowedRoles: ['admin'],
    },
    
    {
      id: 'administration',
      label: 'Paramètres Système',
      route: '/administration',
      icon: 'admin_panel_settings',
      allowedRoles: ['admin'],
    },
  ];

  public readonly visibleMenuItems = computed<NavOption[]>(() => {
    const user = this.currentUser();
    if (!user) return [];
    return this.allMenuItems.filter((item) =>
      item.allowedRoles.includes(user.role) ||
      (user.role === 'tresorier' && item.allowedRoles.includes('manager'))
    );
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

  public onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    // Si le clic s'est produit en dehors du dropdown utilisateur, on le ferme
    if (!target.closest('#user-dropdown-container')) {
      this.closeUserDropdown();
    }
    // Si le clic s'est produit en dehors du menu d'actions de caisse, on le ferme
    if (!target.closest('#cp-actions-dropdown-container')) {
      this.closeActionsMenu();
    }
  }

  public onEscape(): void {
    this.closeUserDropdown();
    this.closeActionsMenu();
    this.closeMenu();
  }

  public toggleActionsMenu(event?: Event): void {
    if (event) {
      event.stopPropagation();
    }
    this.isActionsMenuOpen.update((open) => !open);
  }

  public closeActionsMenu(): void {
    this.isActionsMenuOpen.set(false);
  }

  public async onDeleteSelectedAction(): Promise<void> {
    const count = this.selectedTransactionsCount();
    if (count === 0 || this.isDeleting()) return;

    this.isDeleting.set(true);
    this.closeActionsMenu();

    try {
      const success = await this.cashierService.deleteSelected();
      if (!success) {
        const err = this.cashierService.error();
        if (err) {
          // Affichage non intrusif de l'erreur
          console.warn('Avertissement suppression:', err);
        }
      }
    } finally {
      this.isDeleting.set(false);
    }
  }

  public onExportAction(): void {
    const hasSelection = this.selectedTransactionsCount() > 0;
    this.cashierService.exportTransactions(hasSelection);
    this.closeActionsMenu();
  }

  public clearSelection(): void {
    this.cashierService.toggleSelectAll(false);
    this.closeActionsMenu();
  }

  public async onDuplicateAction(): Promise<void> {
    if (this.selectedTransactionsCount() === 0) return;
    this.closeActionsMenu();
    await this.cashierService.duplicateSelected();
  }

  public async onResetToDraftAction(): Promise<void> {
    if (this.selectedTransactionsCount() === 0) return;
    this.closeActionsMenu();
    await this.cashierService.resetSelectedToDraft();
  }

  public onExportSpreadsheetAction(): void {
    this.cashierService.exportSpreadsheet();
    this.closeActionsMenu();
  }

  public onDownloadAttachmentsAction(): void {
    this.cashierService.downloadAttachments();
    this.closeActionsMenu();
  }

  public onSearchInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = input?.value ?? '';
    this.searchQuery.set(value);
    this.cashierService.setSearchQuery(value);
  }

  public onNouveau(): void {
    // Si nous ne sommes pas déjà sur la page caisse, y naviguer
    if (!this.router.url.includes('/caisse')) {
      void this.router.navigate(['/caisse']);
    }
    this.cashierService.startAddTransaction();
  }

  public onOpenImportModal(): void {
    if (!this.router.url.includes('/caisse')) {
      void this.router.navigate(['/caisse']);
    }
    this.cashierService.openImportModal();
  }

  public async onImportConfirmed(rows: ParsedImportRow[]): Promise<void> {
    this.cashierService.closeImportModal();
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

  public prevPage(): void {
    this.cashierService.prevPage();
  }

  public nextPage(): void {
    this.cashierService.nextPage();
  }

  public async logout(): Promise<void> {
    this.closeUserDropdown();
    await this.authService.logout();
  }
}
