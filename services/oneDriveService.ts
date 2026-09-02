export interface OneDriveEntry {
  id: string;
  thumbUrl: string;
  name: string;
  downloadUrl?: string;
}

/** Check if a string is a Microsoft OneDrive or SharePoint URL */
export function isOneDriveUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  const clean = url.trim().toLowerCase();
  return (
    clean.includes("1drv.ms") ||
    clean.includes("onedrive.live.com") ||
    clean.includes("sharepoint.com")
  );
}

/** Resolves shortlinks (e.g. 1drv.ms) by following HTTP redirects to the canonical URL */
export async function resolveOneDriveUrl(inputUrl: string): Promise<string> {
  let url = inputUrl.trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }

  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    return res.url || url;
  } catch (err) {
    console.warn("[oneDriveService] Could not resolve HEAD redirect, using original URL:", err);
    return url;
  }
}

/**
 * Encodes a public sharing URL into a Microsoft Graph sharing token:
 * 1. Base64 encode the URL
 * 2. Convert to unpadded base64url: '/' -> '_', '+' -> '-', remove '='
 * 3. Prepend 'u!'
 */
export function encodeSharingUrl(url: string): string {
  const base64 = Buffer.from(url).toString("base64");
  const base64url = base64.replace(/=/g, "").replace(/\//g, "_").replace(/\+/g, "-");
  return `u!${base64url}`;
}

/**
 * Scrapes / indexes image files from a public OneDrive shared folder or album.
 * Uses a multi-strategy approach:
 * 1. Microsoft Graph / OneDrive Shares public API endpoint
 * 2. HTML inspection of the shared album page (extracting embedded state & images)
 */
export async function scrapeOneDriveFolderEntries(inputUrl: string): Promise<OneDriveEntry[]> {
  const resolvedUrl = await resolveOneDriveUrl(inputUrl);
  console.log(`[oneDriveService] Indexing OneDrive folder: ${resolvedUrl}`);

  const entries: OneDriveEntry[] = [];
  const seenIds = new Set<string>();

  // ── Strategy 1: Microsoft Public Shares API ──────────────────────────────
  try {
    const shareToken = encodeSharingUrl(resolvedUrl);
    const apiEndpoints = [
      `https://api.onedrive.com/v1.0/shares/${shareToken}/root/children`,
      `https://api.onedrive.com/v1.0/shares/${shareToken}/driveItem/children`,
      `https://graph.microsoft.com/v1.0/shares/${shareToken}/driveItem/children`
    ];

    for (const endpoint of apiEndpoints) {
      try {
        const res = await fetch(endpoint, {
          headers: {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)"
          }
        });

        if (res.ok) {
          const data = await res.json() as any;
          const items = Array.isArray(data.value) ? data.value : [];
          for (const item of items) {
            const name = item.name || `photo_${item.id}.jpg`;
            const ext = name.split(".").pop()?.toLowerCase();
            const isImage = item.image || (ext && ["jpg", "jpeg", "png", "webp", "heic"].includes(ext));
            if (isImage && !seenIds.has(item.id)) {
              seenIds.add(item.id);
              const downloadUrl = item["@content.downloadUrl"] || item["@microsoft.graph.downloadUrl"];
              entries.push({
                id: item.id,
                name,
                thumbUrl: downloadUrl || `/api/drive-proxy/${encodeURIComponent(item.id)}?source=onedrive`,
                downloadUrl
              });
            }
          }
          if (entries.length > 0) {
            console.log(`[oneDriveService] Indexed ${entries.length} photos via OneDrive Public API.`);
            return entries;
          }
        }
      } catch (e) {
        // Try next endpoint
      }
    }
  } catch (err) {
    console.warn("[oneDriveService] Strategy 1 (API) failed:", err);
  }

  // ── Strategy 2: Web Page State Scraping ──────────────────────────────────
  try {
    const pageRes = await fetch(resolvedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
      }
    });

    if (pageRes.ok) {
      const html = await pageRes.text();

      // Look for embedded JSON data models in script tags
      const jsonMatches = html.match(/\{"id":"[a-zA-Z0-9!_-]+","name":"[^"]+\.(?:jpg|jpeg|png|webp|heic)"[^}]*\}/gi);
      if (jsonMatches) {
        for (const raw of jsonMatches) {
          try {
            const item = JSON.parse(raw);
            if (item.id && !seenIds.has(item.id)) {
              seenIds.add(item.id);
              entries.push({
                id: item.id,
                name: item.name,
                thumbUrl: `/api/drive-proxy/${encodeURIComponent(item.id)}?source=onedrive`,
                downloadUrl: item.downloadUrl || item.url
              });
            }
          } catch (e) {}
        }
      }

      // Look for resid and authkey parameters to construct download links
      const residMatch = resolvedUrl.match(/resid=([a-zA-Z0-9!_-]+)/i);
      const authkeyMatch = resolvedUrl.match(/authkey=([a-zA-Z0-9!_-]+)/i);
      if (residMatch && authkeyMatch) {
        const resid = residMatch[1];
        const authkey = authkeyMatch[1];
        const directUrl = `https://onedrive.live.com/download?resid=${encodeURIComponent(resid)}&authkey=${encodeURIComponent(authkey)}`;
        if (!seenIds.has(resid)) {
          seenIds.add(resid);
          entries.push({
            id: resid,
            name: "OneDrive_Photo.jpg",
            thumbUrl: directUrl,
            downloadUrl: directUrl
          });
        }
      }

      // Fallback: extract image tags
      const imgRegex = /<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)"/gi;
      let m;
      let imgIndex = 1;
      while ((m = imgRegex.exec(html)) !== null) {
        const src = m[1];
        const alt = m[2] || `OneDrive_Photo_${imgIndex}.jpg`;
        if (src.includes("onedrive") || src.includes("1drv.ms") || src.includes("live.com") || src.includes("storage")) {
          const fakeId = `od_${imgIndex++}`;
          if (!seenIds.has(fakeId)) {
            seenIds.add(fakeId);
            entries.push({
              id: fakeId,
              name: alt.endsWith(".jpg") || alt.endsWith(".png") ? alt : `${alt}.jpg`,
              thumbUrl: src,
              downloadUrl: src
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn("[oneDriveService] Strategy 2 (HTML state) failed:", err);
  }

  // ── Strategy 3: Single Item Direct URL Support ────────────────────────────
  if (entries.length === 0) {
    try {
      const urlObj = new URL(resolvedUrl);
      const authkey = urlObj.searchParams.get("authkey") || "";
      const id = urlObj.searchParams.get("id") || urlObj.searchParams.get("resid") || "onedrive_root";
      
      const directUrl = `https://onedrive.live.com/download?resid=${encodeURIComponent(id)}&authkey=${encodeURIComponent(authkey)}`;
      entries.push({
        id: id,
        name: "OneDrive_Image.jpg",
        thumbUrl: directUrl,
        downloadUrl: directUrl
      });
    } catch (e) {
      entries.push({
        id: "onedrive_file",
        name: "OneDrive_Image.jpg",
        thumbUrl: resolvedUrl,
        downloadUrl: resolvedUrl
      });
    }
  }

  console.log(`[oneDriveService] Successfully indexed ${entries.length} items from OneDrive.`);
  return entries;
}

/** Proxy and stream OneDrive file content directly to client with caching */
export async function proxyOneDriveFileContent(
  targetUrlOrId: string
): Promise<{ buffer: Buffer; contentType: string }> {
  let downloadUrl = targetUrlOrId;

  if (!targetUrlOrId.startsWith("http://") && !targetUrlOrId.startsWith("https://")) {
    downloadUrl = `https://onedrive.live.com/download?resid=${encodeURIComponent(targetUrlOrId)}`;
  }

  const res = await fetch(downloadUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)",
      "Referer": "https://onedrive.live.com/"
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch OneDrive photo: HTTP ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = res.headers.get("content-type") || "image/jpeg";

  return { buffer, contentType };
}
