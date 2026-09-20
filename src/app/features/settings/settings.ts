import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-settings',
  template: `
    <main class="min-h-full p-6" aria-labelledby="settings-title">
      <h1 id="settings-title" class="text-xl font-semibold text-slate-900 dark:text-white">Paramètres</h1>
    </main>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Settings {}
