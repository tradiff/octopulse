declare module "freedesktop-notifications" {
  export interface NotificationProperties {
    appName?: string;
    summary: string;
    body?: string;
    actions?: Record<string, string>;
  }

  export class Notification {
    constructor(properties: NotificationProperties);
    push(): Promise<void>;
    on(event: "action", listener: (action: string) => void): this;
    on(event: "close", listener: (closedBy: string) => void): this;
  }

  const freedesktopNotifications: {
    Notification: typeof Notification;
  };

  export default freedesktopNotifications;
}
