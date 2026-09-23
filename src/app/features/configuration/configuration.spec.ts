import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ConfigurationComponent } from './configuration';

describe('ConfigurationComponent', () => {
  let component: ConfigurationComponent;
  let fixture: ComponentFixture<ConfigurationComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConfigurationComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ConfigurationComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create the configuration component (nominal case)', () => {
    expect(component).toBeTruthy();
  });

  it('should render the configuration heading and container', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const heading = compiled.querySelector('#configuration-heading');
    expect(heading).toBeTruthy();
    expect(heading?.textContent).toContain('Configuration');
  });

  it('should render the descriptive placeholder section', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const placeholder = compiled.querySelector('section');
    expect(placeholder).toBeTruthy();
    expect(placeholder?.textContent).toContain('Module Configuration');
  });
});
