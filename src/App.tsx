import React, { useEffect, useMemo, useRef, useState, type JSX } from "react";

// ------------------------------
// Helpers
// ------------------------------
function parseTxtList(text: string): string[] {
  return text
    .split(/\r?\n/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#")); // allow comments with #
}

function pickRandomUnique<T>(items: T[], count: number): T[] {
  const copy = [...items];
  // Fisher–Yates shuffle
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

function buildWatchVideosUrl(videoIds: string[]): string {
  const ids = videoIds.filter(Boolean);
  if (!ids.length) return "";
  return `https://www.youtube.com/watch_videos?video_ids=${encodeURIComponent(ids.join(","))}`;
}

function safeJsonParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function nowMs(): number {
  return Date.now();
}

// ------------------------------
// Tiny cache in localStorage
// ------------------------------
type CacheEntry = { ts: number; videoIds: string[] };
type CacheShape = Record<string, CacheEntry>;

const CACHE_KEY = "yt_ost_cache_v1";

function loadCache(): CacheShape {
  return safeJsonParse<CacheShape>(localStorage.getItem(CACHE_KEY) || "{}", {});
}

function saveCache(cacheObj: CacheShape): void {
  localStorage.setItem(CACHE_KEY, JSON.stringify(cacheObj));
}

function getCacheEntry(queryKey: string): CacheEntry | undefined {
  const cache = loadCache();
  return cache[queryKey];
}

function setCacheEntry(queryKey: string, entry: CacheEntry): void {
  const cache = loadCache();
  cache[queryKey] = entry;
  saveCache(cache);
}

function clearCache(): void {
  localStorage.removeItem(CACHE_KEY);
}

// ------------------------------
// YouTube Search (Data API v3)
// ------------------------------
type YoutubeSearchArgs = {
  apiKey: string;
  q: string;
  maxResults?: number;
  signal?: AbortSignal;
};

type YoutubeSearchResponse = {
  items?: Array<{
    id?: {
      videoId?: string;
    };
  }>;
};

async function youtubeSearch({
  apiKey,
  q,
  maxResults = 10,
  signal,
}: YoutubeSearchArgs): Promise<string[]> {
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("q", q);
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("safeSearch", "strict");

  // First try with header (some setups support it). If it fails, fallback to ?key=
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "X-goog-api-key": apiKey },
    signal,
  });

  if (res.status === 403 || res.status === 400) {
    const url2 = new URL(url.toString());
    url2.searchParams.set("key", apiKey);
    const res2 = await fetch(url2.toString(), { signal });

    if (!res2.ok) {
      const txt = await res2.text();
      throw new Error(`YouTube API error (${res2.status}): ${txt}`);
    }

    const data2 = (await res2.json()) as YoutubeSearchResponse;
    return (data2.items || [])
      .map((it) => it?.id?.videoId)
      .filter((v): v is string => Boolean(v));
  }

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`YouTube API error (${res.status}): ${txt}`);
  }

  const data = (await res.json()) as YoutubeSearchResponse;
  return (data.items || [])
    .map((it) => it?.id?.videoId)
    .filter((v): v is string => Boolean(v));
}

// ------------------------------
// App
// ------------------------------
export default function App(): JSX.Element {
  const [apiKey, setApiKey] = useState<string>("");
  const [rememberKey, setRememberKey] = useState<boolean>(false);

  const [rawListText, setRawListText] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");

  const [countX, setCountX] = useState<number>(5);
  const [resultsPoolN, setResultsPoolN] = useState<number>(10);
  const [suffix, setSuffix] = useState<string>(" OST");
  const [maxVideosPerItem, setMaxVideosPerItem] = useState<number>(1);

  const [status, setStatus] = useState<string>("");
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [pickedVideoIds, setPickedVideoIds] = useState<string[]>([]);
  const [finalUrl, setFinalUrl] = useState<string>("");

  const abortRef = useRef<AbortController | null>(null);

  // Load key if previously saved
  useEffect(() => {
    const saved = localStorage.getItem("yt_api_key");
    if (saved) {
      setApiKey(saved);
      setRememberKey(true);
    }
  }, []);

  // Save/remove key based on toggle
  useEffect(() => {
    const trimmed = apiKey.trim();
    if (rememberKey && trimmed) {
      localStorage.setItem("yt_api_key", trimmed);
    } else {
      localStorage.removeItem("yt_api_key");
    }
  }, [rememberKey, apiKey]);

  const parsedList = useMemo(() => parseTxtList(rawListText), [rawListText]);

  function onUploadTxt(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = () => setRawListText(String(reader.result || ""));
    reader.readAsText(file);
  }

  function stop(): void {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("Stopped.");
  }

  async function generate(): Promise<void> {
    setFinalUrl("");
    setPickedVideoIds([]);
    setSelectedItems([]);

    const key = apiKey.trim();
    if (!key) {
      setStatus("Please paste your YouTube API key.");
      return;
    }
    if (parsedList.length === 0) {
      setStatus("Upload or paste a list first (one item per line).");
      return;
    }

    // Abort any previous run
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const x = Math.max(1, Math.min(countX, parsedList.length));
    const n = Math.max(1, Math.min(resultsPoolN, 50));
    const perItem = Math.max(1, Math.min(maxVideosPerItem, 5)); // keep small

    const chosen = pickRandomUnique(parsedList, x);
    setSelectedItems(chosen);

    setStatus(`Selected ${chosen.length} items. Searching YouTube...`);

    const allVideoIds: (string | null)[] = [];

    try {
      for (let i = 0; i < chosen.length; i++) {
        const item = chosen[i];
        const query = `${item}${suffix}`.trim();

        // Cache key depends on query + pool size
        const cacheKey = `${query}::top${n}`;

        // Use cache if not too old (7 days)
        const cached = getCacheEntry(cacheKey);
        const cacheMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

        let videoIdsPool: string[] = [];

        if (cached && nowMs() - cached.ts < cacheMaxAgeMs) {
          videoIdsPool = cached.videoIds;
        } else {
          setStatus(`Searching (${i + 1}/${chosen.length}): ${query}`);
          const ids = await youtubeSearch({
            apiKey: key,
            q: query,
            maxResults: n,
            signal: controller.signal,
          });
          videoIdsPool = ids;
          setCacheEntry(cacheKey, { ts: nowMs(), videoIds: ids });
        }

        if (videoIdsPool.length === 0) {
          allVideoIds.push(null);
          continue;
        }

        const picked = pickRandomUnique(videoIdsPool, Math.min(perItem, videoIdsPool.length));
        allVideoIds.push(...picked);
      }

      const cleaned = allVideoIds.filter((v): v is string => Boolean(v));
      setPickedVideoIds(cleaned);

      if (!cleaned.length) {
        setStatus("No videos found. Try different suffix/search terms or increase pool size.");
        return;
      }

      const url = buildWatchVideosUrl(cleaned);
      setFinalUrl(url);
      setStatus(`Done. Built link with ${cleaned.length} video(s).`);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(err);
      setStatus(`Error: ${msg}`);
    } finally {
      abortRef.current = null;
    }
  }

  return (
    <div
      style={{
        maxWidth: 900,
        margin: "40px auto",
        padding: "0 16px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h2>YouTube OST Randomizer</h2>

      <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8, marginBottom: 16 }}>
        <label style={{ display: "block", marginBottom: 6 }}>YouTube Data API v3 Key:</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Paste your API key here"
          style={{ width: "100%", padding: 8 }}
        />
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <input
            type="checkbox"
            checked={rememberKey}
            onChange={(e) => setRememberKey(e.target.checked)}
          />
          Remember key on this device (localStorage)
        </label>
      </div>

      <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <label style={{ display: "block", marginBottom: 6 }}>Upload list (.txt):</label>
            <input type="file" accept=".txt,text/plain" onChange={onUploadTxt} />
            {fileName ? <div style={{ fontSize: 12, opacity: 0.7 }}>Loaded: {fileName}</div> : null}
          </div>

          <div style={{ flex: 1, minWidth: 260 }}>
            <label style={{ display: "block", marginBottom: 6 }}>Or paste list (one per line):</label>
            <textarea
              value={rawListText}
              onChange={(e) => setRawListText(e.target.value)}
              rows={6}
              style={{ width: "100%", padding: 8 }}
              placeholder={`Example:\nZelda\nFinal Fantasy\nNaruto\nElden Ring\n`}
            />
            <div style={{ fontSize: 12, opacity: 0.7 }}>Parsed items: {parsedList.length}</div>
          </div>
        </div>
      </div>

      <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label>
            X (random items):
            <input
              type="number"
              min={1}
              max={Math.max(1, parsedList.length)}
              value={countX}
              onChange={(e) => setCountX(Number(e.target.value))}
              style={{ marginLeft: 8, width: 80 }}
            />
          </label>

          <label>
            Top N results pool:
            <input
              type="number"
              min={1}
              max={50}
              value={resultsPoolN}
              onChange={(e) => setResultsPoolN(Number(e.target.value))}
              style={{ marginLeft: 8, width: 80 }}
            />
          </label>

          <label>
            Videos per item (Y):
            <input
              type="number"
              min={1}
              max={5}
              value={maxVideosPerItem}
              onChange={(e) => setMaxVideosPerItem(Number(e.target.value))}
              style={{ marginLeft: 8, width: 80 }}
            />
          </label>

          <label style={{ flex: 1, minWidth: 240 }}>
            Search suffix:
            <input
              type="text"
              value={suffix}
              onChange={(e) => setSuffix(e.target.value)}
              style={{ marginLeft: 8, width: "70%" }}
              placeholder=" OST"
            />
          </label>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button onClick={generate}>Generate</button>
          <button onClick={stop} type="button">
            Stop
          </button>
          <button
            onClick={() => {
              clearCache();
              setStatus("Cache cleared.");
            }}
            type="button"
          >
            Clear cache
          </button>
        </div>

        {status ? <div style={{ marginTop: 10, fontSize: 14 }}>{status}</div> : null}
      </div>

      {selectedItems.length > 0 && (
        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8, marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Selected items</h3>
          <ol>
            {selectedItems.map((it) => (
              <li key={it}>{it}</li>
            ))}
          </ol>
        </div>
      )}

      {finalUrl && (
        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Playlist-like URL</h3>
          <input type="text" value={finalUrl} readOnly style={{ width: "100%", padding: 8 }} />
          <div style={{ marginTop: 8 }}>
            <a href={finalUrl} target="_blank" rel="noreferrer">
              Open link
            </a>
          </div>

          <div style={{ marginTop: 12, fontSize: 13, opacity: 0.8 }}>
            Videos included: {pickedVideoIds.length}
          </div>
        </div>
      )}
    </div>
  );
}