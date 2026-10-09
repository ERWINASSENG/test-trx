import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-module-control-panel',
  templateUrl: './module-control-panel.html',
  styleUrl: './module-control-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModuleControlPanel {}
