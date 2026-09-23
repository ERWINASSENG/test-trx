import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-configuration',
  standalone: true,
  imports: [],
  templateUrl: './configuration.html',
  styleUrl: './configuration.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfigurationComponent {}
