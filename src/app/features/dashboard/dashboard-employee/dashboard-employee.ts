import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { AuthService } from '../../../core/services/auth.service';
import { CashierService } from '../../../core/services/cashier.service';

@Component({
  selector: 'app-dashboard-employee',
  imports: [MatIconModule],
  templateUrl: './dashboard-employee.html',
  styleUrl: './dashboard-employee.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardEmployee {
  private readonly authService = inject(AuthService);
  private readonly cashierService = inject(CashierService);

  public readonly currentUser = this.authService.currentUser;
  public readonly currentBalance = this.cashierService.currentBalance;
  public readonly totalDisbursements = computed(() =>
    this.cashierService.allTransactions()
      .filter((transaction) => transaction.category === 'sortie' || transaction.montant < 0)
      .reduce((total, transaction) => total + Math.abs(transaction.montant), 0),
  );
  public readonly isCashier = computed(() => {
    const role = this.currentUser()?.role;
    return role === 'caissiere';
  });

  public formatAmount(amount: number): string {
    return amount.toLocaleString('fr-FR').replace(/\u202F/g, ' ');
  }
}
