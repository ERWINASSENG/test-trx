import { TestBed } from '@angular/core/testing';
import { ConfigurationParametresComponent } from './configuration-parametres';

describe('ConfigurationParametresComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ConfigurationParametresComponent],
    });
  });

  it('devrait être instancié avec succès', () => {
    const fixture = TestBed.createComponent(ConfigurationParametresComponent);
    const component = fixture.componentInstance;
    expect(component).toBeTruthy();
  });

  it('devrait afficher le titre de la page Paramètres', () => {
    const fixture = TestBed.createComponent(ConfigurationParametresComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('h1')?.textContent?.trim()).toBe('Paramètres');
  });
});
