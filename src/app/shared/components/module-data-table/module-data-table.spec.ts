import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ModuleDataTable } from './module-data-table';

@Component({
  selector: 'app-module-data-table-test-host',
  imports: [ModuleDataTable],
  templateUrl: './module-data-table.spec.html',
})
class ModuleDataTableTestHost {}

describe('ModuleDataTable', () => {
  let fixture: ComponentFixture<ModuleDataTableTestHost>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ModuleDataTableTestHost],
    }).compileComponents();

    fixture = TestBed.createComponent(ModuleDataTableTestHost);
    fixture.detectChanges();
  });

  it('projette thead et tbody natifs avec le libellé accessible et les options du module', () => {
    const table = fixture.nativeElement.querySelector('table.module-data-table') as HTMLTableElement | null;

    expect(table).not.toBeNull();
    expect(table?.id).toBe('cashier-transactions-table');
    expect(table?.getAttribute('aria-label')).toBe('Journaux comptables');
    expect(table?.classList.contains('journals-table')).toBe(true);
    expect(table?.style.minWidth).toBe('720px');
    expect(table?.querySelector('thead th')?.textContent).toContain('Nom du journal');
    expect(table?.querySelector('tbody td')?.textContent).toContain('Journal de test');
    expect([...table!.children].map((element) => element.tagName)).toEqual(['THEAD', 'TBODY']);
  });
});