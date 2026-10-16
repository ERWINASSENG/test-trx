export type AppNotificationType = 'assignment' | 'reminder';

export interface AppNotification {
  id: string;
  notificationType: AppNotificationType;
  title: string;
  message: string;
  href: string;
  sourceType: 'prospect' | 'quote' | 'dossier' | 'sales_activity';
  sourceId: string;
  readAt: string | null;
  createdAt: string;
}
