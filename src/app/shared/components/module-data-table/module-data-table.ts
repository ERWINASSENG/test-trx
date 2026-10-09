import { ChangeDetectionStrategy, Component, ViewEncapsulation, input } from '@angular/core';

@Component({
  selector: 'app-module-data-table',
  templateUrl: './module-data-table.html',
  styleUrl: './module-data-table.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModuleDataTable {
  public readonly ariaLabel = input.required<string>();
  public readonly minWidth = input<string>('640px');
  public readonly tableId = input<string>('');
  public readonly tableClass = input<string>('');
}
