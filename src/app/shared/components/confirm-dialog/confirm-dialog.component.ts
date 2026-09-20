import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

export type DialogVariant = 'danger' | 'warning' | 'info';

@Component({
  selector: 'app-confirm-dialog',
  imports: [MatIconModule],
  templateUrl: './confirm-dialog.component.html',
  styleUrl: './confirm-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialogComponent {
  public readonly isOpen = input<boolean>(false);
  public readonly title = input<string>('Confirmation');
  public readonly message = input<string>('Êtes-vous sûr de vouloir effectuer cette action ?');
  public readonly confirmLabel = input<string>('Confirmer');
  public readonly cancelLabel = input<string>('Annuler');
  public readonly confirmText = input<string | null>(null);
  public readonly cancelText = input<string | null>(null);
  public readonly variant = input<DialogVariant>('danger');
  public readonly type = input<DialogVariant | null>(null);

  public readonly effectiveConfirmLabel = computed(
    () => this.confirmText() ?? this.confirmLabel()
  );
  public readonly effectiveCancelLabel = computed(
    () => this.cancelText() ?? this.cancelLabel()
  );
  public readonly effectiveVariant = computed(
    () => this.type() ?? this.variant()
  );

  public readonly confirmed = output<void>();
  public readonly cancelled = output<void>();

  public onConfirm(): void {
    this.confirmed.emit();
  }

  public onCancel(): void {
    this.cancelled.emit();
  }

  public onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.cancelled.emit();
    }
  }

  public onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.cancelled.emit();
    }
  }
}
