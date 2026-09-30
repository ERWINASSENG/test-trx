import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { APP_MODULES, AppModule, isAppModuleVisibleToPermissions } from '../../core/models/app-module.model';
import { AccessControlService } from '../../core/services/access-control.service';

@Component({
  selector: 'app-launcher',
  imports: [RouterLink],
  templateUrl: './app-launcher.html',
  styleUrl: './app-launcher.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppLauncher implements OnInit {
  public readonly accessControl = inject(AccessControlService);

  public readonly searchQuery = signal('');
  public readonly visibleModules = computed<readonly AppModule[]>(() => {
    const permissions = this.accessControl.effectivePermissions();

    const query = this.normalizeSearchValue(this.searchQuery());
    return APP_MODULES.filter((module) => {
      if (!isAppModuleVisibleToPermissions(module, permissions)) return false;
      if (!query) return true;

      return this.normalizeSearchValue(`${module.label} ${module.description}`).includes(query);
    });
  });

  public ngOnInit(): void {
    void this.accessControl.loadMyPermissions();
  }

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
