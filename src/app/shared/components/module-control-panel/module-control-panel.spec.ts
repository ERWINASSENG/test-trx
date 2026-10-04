import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ModuleControlPanel } from './module-control-panel';

@Component({
  selector: 'app-control-panel-test-host',
  imports: [ModuleControlPanel],
  template: `
    <app-module-control-panel>
      <button type="button" controlPanelStart id="projected-start">Nouveau</button>
      <input controlPanelCenter id="projected-center" aria-label="Recherche" />
      <button type="button" controlPanelEnd id="projected-end">Page suivante</button>
    </app-module-control-panel>
  `,
})
class ControlPanelTestHost {}

describe('ModuleControlPanel', () => {
  let fixture: ComponentFixture<ControlPanelTestHost>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ControlPanelTestHost],
    }).compileComponents();

    fixture = TestBed.createComponent(ControlPanelTestHost);
    fixture.detectChanges();
  });

  it('projette les commandes dans les zones début, centre et fin', () => {
    const panel = fixture.nativeElement.querySelector('app-module-control-panel');

    expect(panel.querySelector('.control-panel-start #projected-start')?.textContent).toContain('Nouveau');
    expect(panel.querySelector('.control-panel-center #projected-center')).not.toBeNull();
    expect(panel.querySelector('.control-panel-end #projected-end')?.textContent).toContain('Page suivante');
  });
});