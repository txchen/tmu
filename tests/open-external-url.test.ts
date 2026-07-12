import { describe, expect, test } from "vitest";
import { youtubeTrackUrl } from "../src/open-external-url";

describe("YouTube Track URLs", () => {
  test("derives a canonical watch URL from the Track stable ID", () => {
    expect(youtubeTrackUrl("abc_123-XYZ")).toBe("https://www.youtube.com/watch?v=abc_123-XYZ");
  });
});
