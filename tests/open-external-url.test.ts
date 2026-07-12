import { describe, expect, test } from "vitest";
import { youtubeTrackUrl } from "../src/open-external-url";

describe("YouTube Track URLs", () => {
  test("derives a non-autoplaying embed URL from the Track stable ID", () => {
    expect(youtubeTrackUrl("abc_123-XYZ")).toBe("https://www.youtube.com/embed/abc_123-XYZ?autoplay=0");
  });
});
