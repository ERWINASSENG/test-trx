import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AuthService } from '../../core/services/auth.service';
import { DashboardAdmin } from './dashboard-admin/dashboard-admin';
import { DashboardManager } from './dashboard-manager/dashboard-manager';
import { DashboardEmployee } from './dashboard-employee/dashboard-employee';
import { DashboardCommercial } from './dashboard-commercial/dashboard-commercial';

export type DashboardViewType = 'admin' | 'manager' | 'employee' | 'commercial';

@Component({
  selector: 'app-dashboard',
  imports: [DashboardAdmin, DashboardManager, DashboardEmployee, DashboardCommercial],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Dashboard {
  private readonly authService = inject(AuthService);

  public readonly currentUser = this.authService.currentUser;
  public readonly manualViewOverride = signal<DashboardViewType | null>(null);

  public readonly isPrivileged = computed(() => {
    const role = this.currentUser()?.role;
    return role === 'admin' || role === 'manager';
  });

  public readonly dashboardView = computed<DashboardViewType>(() => {
    if (this.manualViewOverride()) {
      return this.manualViewOverride()!;
    }

    const role = this.currentUser()?.role;

    if (role === 'commercial') {
      return 'commercial';
    }

    if (role === 'admin') {
      return 'admin';
    }

    if (role === 'manager' || role === 'tresorier') {
      return 'manager';
    }

    // Tous les autres profils (caissiere, employe) basculent sur la vue collaborateur
    return 'employee';
  });

  public setManualView(view: DashboardViewType | null): void {
    this.manualViewOverride.set(view);
  }
}
