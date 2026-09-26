import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { APP_MODULES, AppModule, isAppModuleVisibleToRole } from '../../core/models/app-module.model';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-launcher',
  imports: [RouterLink, MatIconModule],
  templateUrl: './app-launcher.html',
  styleUrl: './app-launcher.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppLauncher {
  private readonly authService = inject(AuthService);

  public readonly searchQuery = signal('');
  public readonly visibleModules = computed<readonly AppModule[]>(() => {
    const role = this.authService.currentRole();
    if (!role) return [];

    const query = this.normalizeSearchValue(this.searchQuery());
    return APP_MODULES.filter((module) => {
      if (!isAppModuleVisibleToRole(module, role)) return false;
      if (!query) return true;

      return this.normalizeSearchValue(`${module.label} ${module.description}`).includes(query);
    });
  });

  public onSearchInput(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.searchQuery.set(input?.value ?? '');
  }

  private normalizeSearchValue(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLocaleLowerCase();
  }
}