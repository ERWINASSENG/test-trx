import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AuthService } from '../../core/services/auth.service';
import { AccessControlService } from '../../core/services/access-control.service';
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
  private readonly accessControl = inject(AccessControlService);

  public readonly currentUser = this.authService.currentUser;
  public readonly manualViewOverride = signal<DashboardViewType | null>(null);

  public readonly isPrivileged = computed(() => {
    const role = this.currentUser()?.role;
    return role === 'admin' || role === 'manager';
  });

  public readonly dashboardView = computed<DashboardViewType>(() => {
    const override = this.manualViewOverride();
    if (override) {
      return override;
    }

    const user = this.currentUser();
    const role = user?.role;
    const customRole = user?.customRole;

    if (customRole === 'commercial' || (role as string) === 'commercial') {
      return 'commercial';
    }

    if (role === 'commercial') {
      return 'commercial';
    }

    if (role === 'admin') {
      return 'admin';
    }

    if (role === 'manager' || role === 'tresorier') {
      return 'manager';
    }

    if (this.accessControl.hasPermission('module.crm.view') || this.accessControl.hasPermission('crm.read')) {
      return 'commercial';
    }

    // Tous les autres profils basculent sur la vue collaborateur
    return 'employee';
  });

  public setManualView(view: DashboardViewType | null): void {
    this.manualViewOverride.set(view);
  }
}
