import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
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

  public readonly dashboardView = computed<DashboardViewType>(() => {
    if (this.accessControl.hasPermission('dashboard.admin.view')) {
      return 'admin';
    }

    if (this.accessControl.hasPermission('dashboard.manager.view')) {
      return 'manager';
    }

    if (
      this.accessControl.hasPermission('dashboard.commercial.view') ||
      this.accessControl.hasPermission('module.crm.view') ||
      this.accessControl.hasPermission('crm.read')
    ) {
      return 'commercial';
    }

    // Repli fail-safe sur la vue collaborateur la moins privilégiée
    return 'employee';
  });
}
