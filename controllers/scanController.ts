import { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import os from "os";
import { events, findEvent } from "./eventController.js";
import { initAnalytics, eventAnalytics } from "./analyticsController.js";
import { getBulkPhotoDir, ensureDirExists, removeDirSync } from "../services/storageService.js";
import { runPythonScan } from "../services/faceScanService.js";
import { matchDescriptor, extractDescriptorsFromBuffer } from "../services/faceEmbeddingService.js";

const scanRateLimit = new Map<string, { count: number; resetTime: number }>();

export const rateLimiter = (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const limit = 30;
  const windowMs = 60 * 1000;

  let record = scanRateLimit.get(ip);
  if (!record || record.resetTime < now) {
    record = { count: 1, resetTime: now + windowMs };
    scanRateLimit.set(ip, record);
    return next();
  }

  if (record.count >= limit) {
    return res.status(429).json({ error: "Too many scan requests. Please wait a minute before trying again." });
  }

  record.count += 1;
  next();
};

export const scanFaces = async (req: Request, res: Response) => {
  let tempSelfiePath = "";
  let scanTempDir = "";

  try {
    const { eventId, referenceImage, selfieDescriptor } = req.body;

    if (!eventId || (!referenceImage && !selfieDescriptor)) {
      return res.status(400).json({ error: "Missing required parameters: eventId and referenceImage or selfieDescriptor" });
    }

    let event = await findEvent(eventId);
    if (!event) {
      const allEvents = Object.keys(events);
      if (allEvents.length > 0) {
        event = events[allEvents[0]];
      }
    }

    if (!event) {
      return res.status(404).json({ error: "Event not found. Organizer must re-sync the folder." });
    }

    const resolvedEventId = event.eventId || eventId;
    initAnalytics(resolvedEventId);
    if (eventAnalytics[resolvedEventId]) {
      eventAnalytics[resolvedEventId].faceScans += 1;
    }

    // ─── PRIMARY PATH: Client-sent descriptor (works on Vercel) ──────────────
    // The browser extracts the 128-d face descriptor using face-api.js and sends it here.
    // We do pure-JS cosine similarity against pre-computed event photo embeddings.
    if (selfieDescriptor && Array.isArray(selfieDescriptor) && selfieDescriptor.length === 128) {
      const faceDescriptors = event.faceDescriptors || [];

      if (faceDescriptors.length > 0) {
        console.log(`[scanController] JS matching selfie descriptor against ${faceDescriptors.length} photos (Vercel-safe)`);
        const matches = matchDescriptor(selfieDescriptor as number[], faceDescriptors);

        return res.json({
          matches: matches.map(m => m.thumbUrl),
          count: matches.length,
          engine: "faceapi-js-cosine",
          details: matches.slice(0, 5),
        });
      }

      // No pre-computed descriptors yet — try to extract on-the-fly from referenceImage
      // and compare against all photos by downloading them (only works if Python path also fails)
      console.warn(`[scanController] No faceDescriptors for event ${resolvedEventId}. Falling back to photo list.`);
    }

    // ─── SECONDARY PATH: Server-side Python/OpenCV (local development) ───────
    // Works only when Python + OpenCV are available (local dev, Docker/Render).
    if (referenceImage) {
      const matches = referenceImage.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        const base64Data = matches[2];
        const mimeType = matches[1];
        const ext = mimeType.split('/')[1] || 'jpg';

        const allCloudFiles = (event.driveFiles && event.driveFiles.length > 0)
          ? event.driveFiles
          : (event.photos || []).map((p, idx) => ({ id: `p_${idx}`, name: path.basename(p), thumbUrl: p }));

        let scanBulkDir = getBulkPhotoDir(eventId);
        let pythonMatched = false;
        let matchedUrls: string[] = [];

        // Try Python scan (local/Docker only)
        try {
          const uniqueId = crypto.randomBytes(8).toString("hex");
          scanTempDir = path.join(os.tmpdir(), `potopic_scan_${uniqueId}`);
          ensureDirExists(scanTempDir);
          tempSelfiePath = path.join(scanTempDir, `selfie.${ext}`);
          fs.writeFileSync(tempSelfiePath, Buffer.from(base64Data, 'base64'));

          ensureDirExists(scanBulkDir);
          const driveFiles = event.driveFiles || [];

          if (driveFiles.length > 0) {
            const existingFiles = new Set(fs.readdirSync(scanBulkDir));
            const missing = driveFiles.filter(f => !existingFiles.has(f.name));

            if (missing.length > 0) {
              console.log(`[scanController] Downloading ${missing.length} missing photos for scanning...`);
              const batchSize = 12;
              for (let i = 0; i < missing.length; i += batchSize) {
                const batch = missing.slice(i, i + batchSize);
                await Promise.all(
                  batch.map(async (file) => {
                    const destPath = path.join(scanBulkDir, file.name);
                    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 100) return;
                    let downloadUrl = file.thumbUrl;
                    if (downloadUrl.includes("googleusercontent.com")) {
                      downloadUrl = downloadUrl.replace(/=s\d+$/, "=s768");
                    }
                    try {
                      const fileRes = await fetch(downloadUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
                      if (fileRes.ok) {
                        const buf = Buffer.from(await fileRes.arrayBuffer());
                        fs.writeFileSync(destPath, buf);
                      }
                    } catch (e) {}
                  })
                );
              }
            }
          }

          console.log(`[scanController] Running OpenCV SFace scan (${fs.readdirSync(scanBulkDir).length} photos)...`);
          const result = await runPythonScan(tempSelfiePath, scanBulkDir);
          if (result && !result.error && Array.isArray(result.matches)) {
            matchedUrls = result.matches.map((m: any) => {
              const diskPath = path.join(scanBulkDir, m.name);
              if (fs.existsSync(diskPath)) {
                return `/bulk_photo/${eventId}/${encodeURIComponent(m.name)}`;
              }
              const matchFile = event!.driveFiles?.find(f => f.name === m.name);
              if (matchFile?.id) return `/api/drive-proxy/${matchFile.id}`;
              if (matchFile?.thumbUrl) return matchFile.thumbUrl;
              return `/bulk_photo/${eventId}/${encodeURIComponent(m.name)}`;
            }).filter(Boolean) as string[];
            pythonMatched = true;
          }
        } catch (err: any) {
          console.warn("[scanController] Python scan not available:", err?.message || err);
        }

        if (scanTempDir && fs.existsSync(scanTempDir)) {
          try { removeDirSync(scanTempDir); } catch (e) {}
        }

        if (pythonMatched) {
          return res.json({
            matches: matchedUrls,
            count: matchedUrls.length,
            engine: "opencv-sface-biometrics",
          });
        }

        // ─── FALLBACK: JS server-side extraction from raw selfie image ────────
        // Extract descriptor from the base64 selfie right here on the server
        // using face-api.js (works on Vercel, but no pre-computed event embeddings).
        try {
          const selfieBuffer = Buffer.from(base64Data, 'base64');
          const selfieDescs = await extractDescriptorsFromBuffer(selfieBuffer);
          if (selfieDescs.length > 0 && (event.faceDescriptors?.length ?? 0) > 0) {
            const bestSelfieDesc = selfieDescs[0];
            const matches = matchDescriptor(bestSelfieDesc, event.faceDescriptors!);
            if (matches.length > 0) {
              return res.json({
                matches: matches.map(m => m.thumbUrl),
                count: matches.length,
                engine: "faceapi-js-server-fallback",
              });
            }
          }
        } catch (jsErr: any) {
          console.warn("[scanController] JS server-side extraction failed:", jsErr?.message);
        }

        // ─── LAST RESORT: Return event photos so attendee sees something ─────
        const candidateUrls = allCloudFiles.map(f => {
          if (f.thumbUrl) return f.thumbUrl;
          if (f.id) return `/api/drive-proxy/${encodeURIComponent(f.id)}`;
          return null;
        }).filter(Boolean) as string[];

        return res.json({
          matches: candidateUrls.slice(0, 60),
          count: Math.min(candidateUrls.length, 60),
          engine: "cloud-stream-fallback",
          notice: "Face embeddings not yet computed for this event. Admin should re-sync to enable accurate matching.",
        });
      }
    }

    return res.status(400).json({ error: "Invalid or missing image data." });

  } catch (error: any) {
    console.error("Scan error:", error);
    if (scanTempDir && fs.existsSync(scanTempDir)) {
      try { removeDirSync(scanTempDir); } catch (e) {}
    }
    res.status(500).json({ error: error.message || "An error occurred during face scan." });
  }
};
