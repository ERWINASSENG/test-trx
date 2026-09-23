import { TestBed } from '@angular/core/testing';
import { ConfigurationJournalComponent } from './configuration-journal';

describe('ConfigurationJournalComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ConfigurationJournalComponent],
    });
  });

  it('devrait être instancié avec succès', () => {
    const fixture = TestBed.createComponent(ConfigurationJournalComponent);
    const component = fixture.componentInstance;
    expect(component).toBeTruthy();
  });
});
