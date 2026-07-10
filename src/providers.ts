import { createDefaultTmuConfig } from "./config";
import { YOUTUBE_CACHE_PROVIDER_ID, type Provider } from "./domain";
import {
  createYouTubeCacheProvider,
  type YouTubeCacheProviderOptions,
} from "./youtube-cache";

export function createDefaultProviders(options: {
  youtubeCache?: YouTubeCacheProviderOptions;
} = {}): Record<typeof YOUTUBE_CACHE_PROVIDER_ID, Provider> {
  const cacheOptions = options.youtubeCache ?? createDefaultTmuConfig().youtubeCache;
  return {
    [YOUTUBE_CACHE_PROVIDER_ID]: createYouTubeCacheProvider(cacheOptions),
  };
}
