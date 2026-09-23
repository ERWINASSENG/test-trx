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
});
