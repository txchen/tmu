import { execFile } from "node:child_process";

export type ExternalUrlOpener = (url: string) => Promise<void>;

export function youtubeTrackUrl(videoId: string): string {
  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=0`;
}

export const openExternalUrl: ExternalUrlOpener = async (url) => {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    execFile(command, [url], { timeout: 10_000 }, (error) => {
      if (error) reject(new Error(`Could not open browser: ${error.message}`));
      else resolve();
    });
  });
};
