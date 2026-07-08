import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  NavidromeApiError,
  createDefaultTmuConfig,
  createNavidromeProvider,
  navidromeServerId,
  type NavidromeConfig,
  type NavidromeFetcher,
} from "../src/index";

function navidromeConfig(overrides: Partial<NavidromeConfig> = {}): NavidromeConfig {
  return createDefaultTmuConfig({
    providers: {
      navidrome: {
        enabled: true,
        serverUrl: "https://music.example.test",
        username: "alex",
        password: "secret-password",
        clientName: "tmu-test",
        ...overrides,
      },
    },
  }).providers.navidrome;
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function okPayload(extra: Record<string, unknown> = {}) {
  return {
    "subsonic-response": {
      status: "ok",
      version: "1.16.1",
      ...extra,
    },
  };
}

describe("Navidrome Provider", () => {
  test("sends Subsonic token and salt auth parameters with JSON format", async () => {
    const seenUrls: URL[] = [];
    const fetcher: NavidromeFetcher = async (url) => {
      seenUrls.push(new URL(url));
      return jsonResponse(okPayload());
    };
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher,
      saltFactory: () => "abc123",
    });

    await provider.validateConnection();

    const url = seenUrls[0];
    expect(url?.pathname).toBe("/rest/ping.view");
    expect(url?.searchParams.get("u")).toBe("alex");
    expect(url?.searchParams.get("s")).toBe("abc123");
    expect(url?.searchParams.get("t")).toBe(md5("secret-passwordabc123"));
    expect(url?.searchParams.get("v")).toBe("1.16.1");
    expect(url?.searchParams.get("c")).toBe("tmu-test");
    expect(url?.searchParams.get("f")).toBe("json");
  });

  test("validates the connection with ping success", async () => {
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async () => jsonResponse(okPayload()),
      saltFactory: () => "salt",
    });

    const state = await provider.validateConnection();

    expect(state).toEqual({
      status: "connected",
      serverUrl: "https://music.example.test",
      message: "ping succeeded",
    });
  });

  test("surfaces ping HTTP failures as API failure state", async () => {
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async () => jsonResponse({ error: "nope" }, { status: 503, statusText: "Service Unavailable" }),
      saltFactory: () => "salt",
    });

    const state = await provider.validateConnection();

    expect(state.status).toBe("api-failure");
    expect(state.message).toContain("HTTP 503 Service Unavailable from ping");
  });

  test("surfaces Subsonic auth failed payloads even when HTTP succeeds", async () => {
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async () => jsonResponse({
        "subsonic-response": {
          status: "failed",
          error: {
            code: 40,
            message: "Wrong username or password",
          },
        },
      }),
      saltFactory: () => "salt",
    });

    const state = await provider.validateConnection();

    expect(state.status).toBe("auth-failure");
    expect(state.message).toBe("Wrong username or password (code 40)");
  });

  test("rejects failed Subsonic payloads from successful HTTP responses as API errors", async () => {
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async () => jsonResponse({
        "subsonic-response": {
          status: "failed",
          error: {
            code: 70,
            message: "The requested data was not found",
          },
        },
      }),
      saltFactory: () => "salt",
    });

    await expect(provider.listArtists()).rejects.toMatchObject({
      name: "NavidromeApiError",
      kind: "api",
      code: 70,
      message: "The requested data was not found (code 70)",
    } satisfies Partial<NavidromeApiError>);
  });

  test("preserves Navidrome server IDs as strings while parsing library entries", async () => {
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async () => jsonResponse(okPayload({
        artists: {
          index: [
            {
              name: "A",
              artist: [
                { id: 101, name: "Alpha", albumCount: "2", coverArt: 202 },
                { id: "003", name: "Zero Padded", albumCount: 1, coverArt: "cover-003" },
              ],
            },
          ],
        },
      })),
      saltFactory: () => "salt",
    });

    const artists = await provider.listArtists();

    expect(artists).toEqual([
      { id: "101", name: "Alpha", albumCount: 2, coverArtId: "202" },
      { id: "003", name: "Zero Padded", albumCount: 1, coverArtId: "cover-003" },
    ]);
    expect(navidromeServerId(1234567890)).toBe("1234567890");
  });

  test("redacts secret fields from surfaced request failures", async () => {
    const provider = createNavidromeProvider({
      config: navidromeConfig({
        token: "secret-token",
        salt: "secret-salt",
      }),
      fetcher: async () => {
        throw new Error("leaked secret-password secret-token secret-salt");
      },
      saltFactory: () => "salt",
    });

    const state = await provider.validateConnection();

    expect(state.status).toBe("api-failure");
    expect(state.message).toContain("[redacted]");
    expect(state.message).not.toContain("secret-password");
    expect(state.message).not.toContain("secret-token");
    expect(state.message).not.toContain("secret-salt");
  });

  test("redacts generated auth token and salt from surfaced request failures", async () => {
    const generatedSalt = "generated-salt";
    const generatedToken = md5(`secret-password${generatedSalt}`);
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async (url) => {
        throw new Error(`failed URL ${url.toString()}`);
      },
      saltFactory: () => generatedSalt,
    });

    const state = await provider.validateConnection();

    expect(state.status).toBe("api-failure");
    expect(state.message).toContain("[redacted]");
    expect(state.message).not.toContain("secret-password");
    expect(state.message).not.toContain(generatedSalt);
    expect(state.message).not.toContain(generatedToken);
  });
});

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}
