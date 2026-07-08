import { describe, expect, test } from "bun:test";
import { parseRuntimeArgs } from "../src/index";

describe("runtime args", () => {
  test("parses snapshot target navigation for packaged smoke checks", () => {
    expect(parseRuntimeArgs([
      "--snapshot",
      "--snapshot-target=youtube-url-download",
      "/music/song.flac",
    ])).toEqual({
      snapshot: true,
      snapshotTargetId: "youtube-url-download",
      cliFileArgs: ["/music/song.flac"],
    });

    expect(parseRuntimeArgs([
      "--snapshot",
      "--snapshot-target",
      "navidrome",
    ])).toEqual({
      snapshot: true,
      snapshotTargetId: "navidrome",
      cliFileArgs: [],
    });
  });
});
