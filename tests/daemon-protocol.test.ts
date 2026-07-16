import { describe, expect, test } from "vitest";
import { encodeFrame, FrameDecoder } from "../src/daemon-protocol";

describe("daemon protocol framing", () => {
  test("decodes partial and adjacent length-prefixed JSON frames", () => {
    const decoder = new FrameDecoder();
    const bytes = Buffer.concat([encodeFrame({ one: 1 }), encodeFrame({ two: 2 })]);
    expect(decoder.push(bytes.subarray(0, 3))).toEqual([]);
    expect(decoder.push(bytes.subarray(3))).toEqual([{ one: 1 }, { two: 2 }]);
  });

  test("rejects malformed, empty, and oversized frames", () => {
    expect(() => new FrameDecoder().push(Buffer.from([0, 0, 0, 0]))).toThrow("length");
    expect(() => new FrameDecoder(2).push(Buffer.from([0, 0, 0, 3]))).toThrow("length");
    const malformed = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("{")]);
    expect(() => new FrameDecoder().push(malformed)).toThrow("JSON");
  });
});
