import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AuthService } from '../../core/services/auth.service';
import { DashboardAdmin } from './dashboard-admin/dashboard-admin';
import { DashboardManager } from './dashboard-manager/dashboard-manager';
import { DashboardEmployee } from './dashboard-employee/dashboard-employee';

export type DashboardViewType = 'admin' | 'manager' | 'employee';

@Component({
  selector: 'app-dashboard',
  imports: [DashboardAdmin, DashboardManager, DashboardEmployee],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Dashboard {
  private readonly authService = inject(AuthService);

  public readonly currentUser = this.authService.currentUser;

  public readonly dashboardView = computed<DashboardViewType>(() => {
    const role = this.currentUser()?.role;

    if (role === 'admin') {
      return 'admin';
    }

    if (role === 'manager' || role === 'tresorier') {
      return 'manager';
    }

    // Tous les autres profils (caissiere, employe) basculent sur la vue collaborateur
    return 'employee';
  });
}
