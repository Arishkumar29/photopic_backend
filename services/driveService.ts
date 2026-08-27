import path from "path";
import fs from "fs";

export interface DriveEntry {
  id: string;
  thumbUrl: string;
  name: string;
}

export async function scrapeDriveFolderEntries(folderId: string): Promise<DriveEntry[]> {
  const url = `https://drive.google.com/embeddedfolderview?id=${folderId}`;
  console.log(`Scraping public Google Drive folder metadata: ${folderId}`);
  
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch embedded folderview. Status: ${response.status}`);
  }

  const html = await response.text();
  const regex = /href="https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)\/view[^>]*>[\s\S]*?<img src="([^"]+)" alt="[^"]*Image"[\s\S]*?<div class="flip-entry-title">([^<]+)<\/div>/g;

  let match;
  const driveFiles: DriveEntry[] = [];

  while ((match = regex.exec(html)) !== null) {
    const fileId = match[1];
    const thumbUrl = match[2];
    const filename = match[3];

    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext && ['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      driveFiles.push({ id: fileId, thumbUrl, name: filename });
    }
  }

  console.log(`Successfully indexed ${driveFiles.length} files from Drive in memory.`);
  return driveFiles;
}

export async function downloadDriveFiles(targetFiles: DriveEntry[], eventDir: string): Promise<string[]> {
  const downloadedPhotos: string[] = [];
  const batchSize = 6;

  for (let i = 0; i < targetFiles.length; i += batchSize) {
    const batch = targetFiles.slice(i, i + batchSize);
    console.log(`Downloading batch ${Math.floor(i / batchSize) + 1} / ${Math.ceil(targetFiles.length / batchSize)}...`);
    
    await Promise.all(
      batch.map(async (file) => {
        const destPath = path.join(eventDir, file.name);
        const downloadUrl = file.thumbUrl.replace(/=s\d+$/, "=s1024");

        const maxRetries = 3;
        let success = false;
        let attempt = 0;

        while (attempt < maxRetries && !success) {
          attempt++;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 12000);

          try {
            const fileRes = await fetch(downloadUrl, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Referer": "https://drive.google.com/",
                "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
              },
              signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!fileRes.ok) {
              throw new Error(`Download status: ${fileRes.status}`);
            }

            const buffer = Buffer.from(await fileRes.arrayBuffer());
            fs.writeFileSync(destPath, buffer);
            downloadedPhotos.push(file.name);
            success = true;
          } catch (err: any) {
            clearTimeout(timeoutId);
            const isAbort = err.name === 'AbortError';
            const errMsg = isAbort ? 'Request timed out (12s)' : err.message || err;
            console.warn(`[Sync Attempt ${attempt}/${maxRetries}] Failed to download ${file.name}: ${errMsg}`);
            if (attempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, attempt * 500));
            }
          }
        }
      })
    );
  }

  return downloadedPhotos;
}

export async function proxyDriveFileContent(fileId: string): Promise<{ buffer: Buffer; contentType: string }> {
  const urlsToTry = [
    `https://lh3.googleusercontent.com/d/${fileId}=w1600`,
    `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`,
    `https://drive.google.com/uc?export=download&id=${fileId}`
  ];

  for (const url of urlsToTry) {
    try {
      const fileRes = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://drive.google.com/",
          "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
        }
      });

      if (fileRes.ok) {
        const contentType = fileRes.headers.get("content-type") || "image/jpeg";
        const arrayBuffer = await fileRes.arrayBuffer();
        if (arrayBuffer.byteLength > 100) {
          return {
            buffer: Buffer.from(arrayBuffer),
            contentType
          };
        }
      }
    } catch (err) {
      // try next source
    }
  }

  throw new Error(`Failed to download image from Google Drive for file ${fileId}`);
}
