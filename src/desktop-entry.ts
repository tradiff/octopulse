import { fileURLToPath } from "node:url";

import { APP_ICON_PNG_URL } from "./app-icon.js";

export const DESKTOP_ENTRY_ID = "octopulse";
export const DESKTOP_ENTRY_FILE_NAME = `${DESKTOP_ENTRY_ID}.desktop`;

export function renderDesktopEntry(): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=Octopulse",
    "Comment=Local PR activity monitor",
    `Icon=${fileURLToPath(APP_ICON_PNG_URL)}`,
    "Exec=/usr/bin/true",
    "Terminal=false",
    "NoDisplay=true",
    "X-GNOME-UsesNotifications=true",
    "",
  ].join("\n");
}
