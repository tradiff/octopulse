import { spawn } from "node:child_process";

export async function openUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("xdg-open", [url], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`xdg-open exited with code ${code}`));
      }
    });
  });
}
