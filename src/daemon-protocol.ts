import { Buffer } from "node:buffer";

export const DAEMON_PROTOCOL_VERSION = 1;
export const MAX_DAEMON_FRAME_BYTES = 8 * 1024 * 1024;

export class FrameDecoder {
  private pending = Buffer.alloc(0);
  constructor(private readonly maximum = MAX_DAEMON_FRAME_BYTES) {}

  push(chunk: Uint8Array): unknown[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: unknown[] = [];
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length === 0 || length > this.maximum) throw new Error(`Invalid daemon frame length: ${length}`);
      if (this.pending.length < length + 4) break;
      const bytes = this.pending.subarray(4, length + 4);
      this.pending = this.pending.subarray(length + 4);
      try { frames.push(JSON.parse(bytes.toString("utf8"))); }
      catch { throw new Error("Invalid daemon JSON frame"); }
    }
    return frames;
  }
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length === 0 || body.length > MAX_DAEMON_FRAME_BYTES) throw new Error(`Invalid daemon frame length: ${body.length}`);
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
