import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { NotificationService } from './core/services/notification.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [RouterOutlet, MatIconModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  public readonly notificationService = inject(NotificationService);
  public readonly notifications = this.notificationService.notifications;

  public dismissNotification(id: string): void {
    this.notificationService.dismiss(id);
  }
}
