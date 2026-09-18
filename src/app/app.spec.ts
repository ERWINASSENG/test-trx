import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { NotificationService } from './core/services/notification.service';

describe('App', () => {
  let component: App;
  let fixture: ComponentFixture<App>;
  let notificationService: NotificationService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        NotificationService,
        provideRouter([]),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(App);
    component = fixture.componentInstance;
    notificationService = TestBed.inject(NotificationService);
    fixture.detectChanges();
  });

  it('should create the app', () => {
    expect(component).toBeTruthy();
  });

  it('should expose notifications signal from NotificationService', () => {
    expect(component.notifications()).toEqual([]);

    notificationService.warning('Opération en double détectée', 'Doublon');
    fixture.detectChanges();

    const notifs = component.notifications();
    expect(notifs.length).toBe(1);
    expect(notifs[0].title).toBe('Doublon');
    expect(notifs[0].message).toBe('Opération en double détectée');
    expect(notifs[0].type).toBe('warning');

    const compiled = fixture.nativeElement as HTMLElement;
    const notifElement = compiled.querySelector('[role="alert"]');
    expect(notifElement).toBeTruthy();
    expect(notifElement?.textContent).toContain('Doublon');
    expect(notifElement?.textContent).toContain('Opération en double détectée');
  });

  it('should dismiss notification when dismissNotification is called', () => {
    const id = notificationService.info('Info test');
    fixture.detectChanges();
    expect(component.notifications().length).toBe(1);

    component.dismissNotification(id);
    fixture.detectChanges();
    expect(component.notifications().length).toBe(0);
  });
});
