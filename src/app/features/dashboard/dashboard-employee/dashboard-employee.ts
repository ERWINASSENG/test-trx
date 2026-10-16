import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { CashierService } from '../../../core/services/cashier.service';

@Component({
  selector: 'app-dashboard-employee',
  imports: [MatIconModule, RouterLink],
  templateUrl: './dashboard-employee.html',
  styleUrl: './dashboard-employee.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardEmployee implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly cashierService = inject(CashierService);

  public readonly currentUser = this.authService.currentUser;
  public readonly currentBalance = this.cashierService.currentBalance;
  public readonly totalDisbursements = this.cashierService.caisseTotalSorties;
  public readonly isCashier = computed(() => {
    const role = this.currentUser()?.role;
    return role === 'caissiere';
  });

  public ngOnInit(): void {
    if (this.isCashier()) {
      void this.cashierService.loadTransactions();
      void this.cashierService.loadCashierSummary();
    }
  }

  public formatAmount(amount: number): string {
    return amount.toLocaleString('fr-FR').replace(/\u202F/g, ' ');
  }
}
