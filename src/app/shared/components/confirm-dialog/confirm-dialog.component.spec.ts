import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ConfirmDialogComponent } from './confirm-dialog.component';

describe('ConfirmDialogComponent', () => {
  let component: ConfirmDialogComponent;
  let fixture: ComponentFixture<ConfirmDialogComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConfirmDialogComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ConfirmDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('devrait être instancié avec succès', () => {
    expect(component).toBeTruthy();
  });

  it('ne devrait pas afficher la modale quand isOpen est false (cas nominal fermé)', () => {
    fixture.componentRef.setInput('isOpen', false);
    fixture.detectChanges();

    const backdrop = fixture.nativeElement.querySelector('#confirm-dialog-backdrop');
    expect(backdrop).toBeNull();
  });

  it('devrait afficher le dialogue avec titre et message personnalisés quand isOpen est true (cas nominal ouvert)', () => {
    fixture.componentRef.setInput('isOpen', true);
    fixture.componentRef.setInput('title', 'Supprimer le compte');
    fixture.componentRef.setInput('message', 'Confirmez-vous cette action irréversible ?');
    fixture.detectChanges();

    const titleEl = fixture.nativeElement.querySelector('#confirm-dialog-title');
    const messageEl = fixture.nativeElement.querySelector('#confirm-dialog-message');

    expect(titleEl?.textContent?.trim()).toBe('Supprimer le compte');
    expect(messageEl?.textContent?.trim()).toBe('Confirmez-vous cette action irréversible ?');
  });

  it('devrait émettre confirmed lors du clic sur le bouton de confirmation', () => {
    fixture.componentRef.setInput('isOpen', true);
    fixture.detectChanges();

    let emitted = false;
    component.confirmed.subscribe(() => {
      emitted = true;
    });

    const submitBtn = fixture.nativeElement.querySelector('#confirm-dialog-submit-btn');
    submitBtn?.click();

    expect(emitted).toBeTrue();
  });

  it('devrait émettre cancelled lors du clic sur le bouton d’annulation', () => {
    fixture.componentRef.setInput('isOpen', true);
    fixture.detectChanges();

    let emitted = false;
    component.cancelled.subscribe(() => {
      emitted = true;
    });

    const cancelBtn = fixture.nativeElement.querySelector('#confirm-dialog-cancel-btn');
    cancelBtn?.click();

    expect(emitted).toBeTrue();
  });

  it('devrait émettre cancelled lors du clic sur le backdrop direct (cas limite extérieur)', () => {
    let emitted = false;
    component.cancelled.subscribe(() => {
      emitted = true;
    });

    const mockTarget = document.createElement('div');
    const mockEvent = {
      target: mockTarget,
      currentTarget: mockTarget,
    } as unknown as MouseEvent;

    component.onBackdropClick(mockEvent);
    expect(emitted).toBeTrue();
  });

  it('ne devrait PAS émettre cancelled si le clic provient d’un élément enfant du panel (cas limite intérieur)', () => {
    let emitted = false;
    component.cancelled.subscribe(() => {
      emitted = true;
    });

    const backdropTarget = document.createElement('div');
    const childTarget = document.createElement('button');
    const mockEvent = {
      target: childTarget,
      currentTarget: backdropTarget,
    } as unknown as MouseEvent;

    component.onBackdropClick(mockEvent);
    expect(emitted).toBeFalse();
  });

  it('devrait fermer la modale (émettre cancelled) sur la touche Echap (Escape)', () => {
    let emitted = false;
    component.cancelled.subscribe(() => {
      emitted = true;
    });

    component.onKeydown(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(emitted).toBeTrue();
  });

  it('ne devrait pas fermer la modale sur une autre touche (ex: Enter ou Tab)', () => {
    let emitted = false;
    component.cancelled.subscribe(() => {
      emitted = true;
    });

    component.onKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(emitted).toBeFalse();
  });

  it('devrait calculer la variante prioritaire (type prend le dessus sur variant si défini)', () => {
    fixture.componentRef.setInput('variant', 'danger');
    fixture.componentRef.setInput('type', 'info');
    fixture.detectChanges();

    expect(component.effectiveVariant()).toBe('info');
  });

  it('devrait utiliser confirmText et cancelText alternatifs si définis', () => {
    fixture.componentRef.setInput('confirmLabel', 'Confirmer');
    fixture.componentRef.setInput('confirmText', 'Oui, procéder');
    fixture.componentRef.setInput('cancelLabel', 'Annuler');
    fixture.componentRef.setInput('cancelText', 'Non, revenir');
    fixture.detectChanges();

    expect(component.effectiveConfirmLabel()).toBe('Oui, procéder');
    expect(component.effectiveCancelLabel()).toBe('Non, revenir');
  });
});
