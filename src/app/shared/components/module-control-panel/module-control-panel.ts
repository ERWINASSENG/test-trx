import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-module-control-panel',
  template: `
    <section class="module-control-panel" aria-label="Commandes du module">
      <div class="control-panel-row">
        <div class="control-panel-start">
          <ng-content select="[controlPanelStart]"></ng-content>
        </div>
        <div class="control-panel-center">
          <ng-content select="[controlPanelCenter]"></ng-content>
        </div>
        <div class="control-panel-end">
          <ng-content select="[controlPanelEnd]"></ng-content>
        </div>
      </div>
    </section>
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
    }

    .module-control-panel {
      position: sticky;
      top: 50px;
      z-index: 30;
      width: 100%;
      border-bottom: 1px solid var(--app-border, #bfd3ee);
      background: var(--app-surface-muted, #e4efff);
      color: var(--app-text, #123c6d);
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.04);
      transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
    }

    .control-panel-row {
      display: flex;
      min-height: 48px;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 12px;
    }

    .control-panel-start,
    .control-panel-center,
    .control-panel-end {
      display: flex;
      min-width: 0;
      align-items: center;
    }

    .control-panel-start {
      flex: 0 1 auto;
      gap: 8px;
    }

    .control-panel-center {
      flex: 1 1 320px;
      max-width: 560px;
      justify-content: center;
    }

    .control-panel-end {
      flex: 0 0 auto;
      justify-content: flex-end;
      gap: 12px;
    }

    .control-panel-start:empty,
    .control-panel-center:empty,
    .control-panel-end:empty {
      display: none;
    }

    @media (min-width: 640px) {
      .control-panel-row {
        padding-inline: 20px;
      }
    }

    @media (max-width: 1023px) {
      .control-panel-row {
        flex-wrap: wrap;
      }

      .control-panel-center {
        order: 3;
        flex-basis: 100%;
        max-width: none;
      }

      .control-panel-end {
        margin-left: auto;
      }
    }

    :host-context(html.dark) .module-control-panel,
    :host-context([data-theme='dark']) .module-control-panel {
      background: var(--app-surface-muted, #123c6d);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModuleControlPanel {}