# Keep a Narrow Provider Abstraction

TMU is removing Navidrome and Local providers and making YouTube Cache the only current Provider, but it will keep a narrow Provider abstraction for future sources. The Provider contract should only cover what the app still needs: listing/searching Tracks and resolving a Track to a local Playback Locator. We are deliberately not keeping provider-root browsing, collection hierarchy, provider filters, capability matrices, or remote playback/search behavior, because the product is now centered on YouTube download, disk cache, and local playback.
