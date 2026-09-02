import { Request, Response } from "express";
import path from "path";
import fs from "fs";
import { getBulkPhotoDir, ensureDirExists, removeDirSync } from "../services/storageService.js";
import { scrapeDriveFolderEntries, proxyDriveFileContent } from "../services/driveService.js";
import { isOneDriveUrl, scrapeOneDriveFolderEntries, proxyOneDriveFileContent } from "../services/oneDriveService.js";
import { isDbConnected } from "../services/dbService.js";
import { EventModel as _EventModel } from "../models/Event.js";
import { extractDescriptorsFromBuffer } from "../services/faceEmbeddingService.js";
// Cast to any to avoid mongoose v8 TypeScript overload union incompatibility
const EventModel = _EventModel as any;

export interface EventData {
  eventId: string;
  folderId: string;
  accessToken: string;
  orgName: string;
  eventName: string;
  photos: string[];
  driveFiles?: { id: string; thumbUrl: string; name: string }[];
  /** Pre-computed face embeddings (128-d per face) for each photo — Vercel-safe JS matching */
  faceDescriptors?: { name: string; thumbUrl: string; descriptors: number[][] }[];
  coverImage?: string;
  description?: string;
  eventLocation?: string;
  eventType?: string;
}

// In-memory fallback store (used when DB is unavailable / no MONGODB_URI)
export const events: Record<string, EventData> = {};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Sync a DB document into the in-memory map for consistency */
function syncToMemory(doc: any) {
  const driveFiles = doc.driveFiles || [];
  let photos = doc.photos || [];
  if (photos.length === 0 && driveFiles.length > 0) {
    photos = driveFiles.map((f: any) => f.thumbUrl || `/api/drive-proxy/${f.id}`);
  }

  const plain: EventData = {
    eventId:         doc.eventId,
    folderId:        doc.folderId,
    accessToken:     doc.accessToken,
    orgName:         doc.orgName,
    eventName:       doc.eventName,
    photos,
    driveFiles,
    faceDescriptors: doc.faceDescriptors || [],
    coverImage:      doc.coverImage,
    description:     doc.description,
    eventLocation:   doc.eventLocation,
    eventType:       doc.eventType,
  };
  events[doc.eventId] = plain;
  return plain;
}

/** Load all events from MongoDB into memory on startup */
export async function loadEventsFromDB() {
  if (!isDbConnected()) {
    loadEventsFromDisk();
    return;
  }
  try {
    const docs = await (EventModel.find() as any).lean() as any[];
    docs.forEach(syncToMemory);
    console.log(`[eventController] Loaded ${docs.length} events from MongoDB.`);
  } catch (err) {
    console.warn("[eventController] Could not load events from MongoDB:", err);
    loadEventsFromDisk();
  }
}

/** Legacy disk persistence (used locally / without DB) */
const getDbFilePath = () => path.join(getBulkPhotoDir(), "events_db.json");

function saveEventsToDisk() {
  try {
    const dbPath = getDbFilePath();
    const dir = path.dirname(dbPath);
    ensureDirExists(dir);
    fs.writeFileSync(dbPath, JSON.stringify(events, null, 2));
  } catch (err) {
    // Expected to fail on Vercel (read-only FS), already using DB
    console.warn("[eventController] Could not persist events to disk (using DB instead).");
  }
}

function loadEventsFromDisk() {
  try {
    const dbPath = getDbFilePath();
    if (fs.existsSync(dbPath)) {
      const data = fs.readFileSync(dbPath, "utf-8");
      const loaded = JSON.parse(data);
      Object.assign(events, loaded);
    }
  } catch (err) {
    console.warn("[eventController] Could not load events from disk:", err);
  }

  // Seed a sample event if nothing exists
  try {
    if (Object.keys(events).length === 0) {
      const sampleEventId = "evt_sample";
      const eventDir = getBulkPhotoDir(sampleEventId);
      ensureDirExists(eventDir);

      const photos: string[] = [];
      const samplesDir = path.join(process.cwd(), "bulk_photo_samples");
      if (fs.existsSync(samplesDir)) {
        const sampleFiles = fs.readdirSync(samplesDir);
        for (const file of sampleFiles) {
          const srcPath = path.join(samplesDir, file);
          const destPath = path.join(eventDir, file);
          try { fs.copyFileSync(srcPath, destPath); } catch (e) {}
          photos.push(`/bulk_photo/${sampleEventId}/${file}`);
        }
      }

      events[sampleEventId] = {
        eventId: sampleEventId,
        folderId: "local_upload",
        accessToken: "sample_token",
        orgName: "Photopic Studio",
        eventName: "Summer Celebration & Gala 2026",
        photos,
        coverImage: "https://images.unsplash.com/photo-1519741497674-611481863552?w=800&auto=format&fit=crop&q=80"
      };

      saveEventsToDisk();
    }
  } catch (err) {
    console.warn("[eventController] Sample event initialization skipped:", err);
  }
}

// ── Controllers ───────────────────────────────────────────────────────────────

export const createEvent = async (req: Request, res: Response) => {
  const { eventId, folderId, accessToken = "default_token", orgName, eventName, coverImage } = req.body;
  if (!eventId || !folderId) {
    return res.status(400).json({ error: "Missing required parameters: eventId and folderId are required" });
  }

  try {
    const eventDir = getBulkPhotoDir(eventId);
    ensureDirExists(eventDir);

    if (folderId === "local_upload") {
      return res.status(400).json({
        error: "Local disk storage is disabled. Please connect a Microsoft OneDrive or Google Drive folder."
      });
    }

    let driveFiles: { id: string; thumbUrl: string; name: string }[] = [];
    if (isOneDriveUrl(folderId)) {
      driveFiles = await scrapeOneDriveFolderEntries(folderId);
    } else {
      driveFiles = await scrapeDriveFolderEntries(folderId);
    }

    const photos: string[] = driveFiles.map(f => f.thumbUrl || `/api/drive-proxy/${f.id}`);

    const eventData: EventData = {
      eventId, folderId, accessToken,
      orgName: orgName || "Photographer",
      eventName: eventName || "New Event",
      photos,
      driveFiles,
      coverImage
    };
    events[eventId] = eventData;

    if (isDbConnected()) {
      await EventModel.findOneAndUpdate(
        { eventId },
        { $set: eventData },
        { upsert: true, new: true }
      ).exec();
    } else {
      saveEventsToDisk();
    }

    res.json({ success: true, event: eventData });

    // Background: compute face embeddings for Vercel-compatible JS matching
    setImmediate(() => computeEmbeddingsBackground(eventId).catch(e =>
      console.warn('[eventController] Background embedding failed:', e?.message)
    ));
  } catch (error: any) {
    console.error("Failed to create event:", error);
    res.status(500).json({ error: "Failed to create event" });
  }
};

// ── Face Embedding Background Job ────────────────────────────────────────────

/**
 * Downloads each event photo thumbnail and extracts face descriptors (128-d)
 * using face-api.js + TF.js CPU. Stores them on the event for Vercel matching.
 * Runs in the background after event create/update so the API response is fast.
 */
async function computeEmbeddingsBackground(eventId: string): Promise<void> {
  const event = events[eventId];
  if (!event) return;

  const driveFiles = event.driveFiles || [];
  if (driveFiles.length === 0) return;

  console.log(`[embeddings] Computing face descriptors for ${driveFiles.length} photos in event ${eventId}...`);
  const t0 = Date.now();

  const descriptorEntries: { name: string; thumbUrl: string; descriptors: number[][] }[] = [];

  // Process in batches to avoid OOM
  const BATCH = 10;
  for (let i = 0; i < driveFiles.length; i += BATCH) {
    const batch = driveFiles.slice(i, i + BATCH);
    await Promise.all(batch.map(async (file) => {
      try {
        let url = file.thumbUrl || '';
        if (url.includes('googleusercontent.com')) {
          url = url.replace(/=s\d+$/, '=s400');
        }
        const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) return;
        const buf = Buffer.from(await res.arrayBuffer());
        const descs = await extractDescriptorsFromBuffer(buf);
        if (descs.length > 0) {
          descriptorEntries.push({ name: file.name, thumbUrl: file.thumbUrl, descriptors: descs });
        }
      } catch (e: any) {
        // Skip photos that fail to download or have no face
      }
    }));

    if (i % 50 === 0 || i + BATCH >= driveFiles.length) {
      console.log(`[embeddings] ${Math.min(i + BATCH, driveFiles.length)}/${driveFiles.length} processed, ${descriptorEntries.length} faces found`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[embeddings] Done in ${elapsed}s — ${descriptorEntries.length} photos with faces for event ${eventId}`);

  // Persist to in-memory store and MongoDB
  event.faceDescriptors = descriptorEntries;
  if (isDbConnected()) {
    try {
      await EventModel.findOneAndUpdate(
        { eventId },
        { $set: { faceDescriptors: descriptorEntries } }
      ).exec();
      console.log(`[embeddings] Saved ${descriptorEntries.length} descriptor entries to MongoDB for ${eventId}`);
    } catch (e: any) {
      console.warn('[embeddings] Failed to save to MongoDB:', e?.message);
    }
  }
}

/** HTTP endpoint: POST /api/events/:eventId/compute-embeddings (admin-triggered) */
export const computeEmbeddings = async (req: Request, res: Response) => {
  const { eventId } = req.params;
  const event = await findEvent(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  // Respond immediately then compute in background
  res.json({ success: true, message: `Computing embeddings for ${event.driveFiles?.length || 0} photos. This runs in the background — check back in a minute.` });

  setImmediate(() => computeEmbeddingsBackground(eventId).catch(e =>
    console.warn('[computeEmbeddings] Background job failed:', e?.message)
  ));
};

export async function findEvent(eventId: string): Promise<EventData | null> {
  if (events[eventId]) return events[eventId];
  if (isDbConnected()) {
    try {
      const doc = await (EventModel.findOne({ eventId }) as any).lean();
      if (doc) return syncToMemory(doc);
    } catch (err) {
      console.warn(`[findEvent] Failed to load event ${eventId} from DB:`, err);
    }
  }
  return null;
}

export const getEvents = async (req: Request, res: Response) => {
  if (isDbConnected()) {
    try {
      const docs = await (EventModel.find() as any).lean() as any[];
      docs.forEach(syncToMemory);
    } catch (err) {
      console.warn("Could not query DB in getEvents:", err);
    }
  }

  // Backfill photos array for any event where photos is empty but driveFiles exists
  Object.values(events).forEach(e => {
    if ((!e.photos || e.photos.length === 0) && e.driveFiles && e.driveFiles.length > 0) {
      e.photos = e.driveFiles.map(f => f.thumbUrl || `/api/drive-proxy/${f.id}`);
    }
  });

  res.json({ events: Object.values(events) });
};

export const deleteEvent = async (req: Request, res: Response) => {
  const { eventId } = req.params;
  const event = await findEvent(eventId);
  if (event) {
    const eventDir = getBulkPhotoDir(eventId);
    removeDirSync(eventDir);
    delete events[eventId];

    if (isDbConnected()) {
      try { await EventModel.deleteOne({ eventId }); } catch (e) {}
    } else {
      saveEventsToDisk();
    }

    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Event not found" });
  }
};

export const updateEvent = async (req: Request, res: Response) => {
  const { eventId } = req.params;
  const { eventName, orgName, coverImage, description, eventLocation, eventType, folderId } = req.body;
  const event = await findEvent(eventId);
  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }

  if (eventName !== undefined) event.eventName = eventName;
  if (orgName !== undefined) event.orgName = orgName;
  if (coverImage !== undefined) event.coverImage = coverImage;
  if (description !== undefined) event.description = description;
  if (eventLocation !== undefined) event.eventLocation = eventLocation;
  if (eventType !== undefined) event.eventType = eventType;

  if (folderId !== undefined && folderId !== event.folderId) {
    if (folderId === "local_upload") {
      return res.status(400).json({ error: "Local disk storage is disabled. Please connect a Microsoft OneDrive or Google Drive folder." });
    }
    event.folderId = folderId;
    if (folderId.trim()) {
      try {
        if (isOneDriveUrl(folderId)) {
          event.driveFiles = await scrapeOneDriveFolderEntries(folderId);
        } else {
          event.driveFiles = await scrapeDriveFolderEntries(folderId);
        }
      } catch (e) {
        console.warn("Could not scrape updated cloud folder:", e);
      }
    }
  }

  if (isDbConnected()) {
    try { await EventModel.findOneAndUpdate({ eventId }, { $set: event }).exec(); } catch (e) {}
  } else {
    saveEventsToDisk();
  }

  res.json({ success: true, event });
};

export const uploadEventPhotos = async (req: Request, res: Response) => {
  return res.status(400).json({
    error: "Local disk storage is disabled. Please connect a Microsoft OneDrive or Google Drive folder to host your event photos in the cloud."
  });
};

export const clearEventPhotos = async (req: Request, res: Response) => {
  const { eventId } = req.params;
  const event = await findEvent(eventId);
  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }

  try {
    event.photos = [];
    event.driveFiles = [];

    if (isDbConnected()) {
      try { await EventModel.findOneAndUpdate({ eventId }, { $set: { photos: [], driveFiles: [] } }).exec(); } catch (e) {}
    } else {
      saveEventsToDisk();
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to clear event photos" });
  }
};

export const proxyDriveImage = async (req: Request, res: Response) => {
  const { fileId } = req.params;
  const isOneDrive = req.query.source === "onedrive" || fileId.startsWith("od_") || isOneDriveUrl(fileId);

  try {
    if (isOneDrive) {
      const { buffer, contentType } = await proxyOneDriveFileContent(fileId);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(buffer);
    }

    const { buffer, contentType } = await proxyDriveFileContent(fileId);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(buffer);
  } catch (err: any) {
    console.warn(`Drive proxy stream failed for ${fileId}:`, err?.message || err);
    if (!isOneDrive) {
      return res.redirect(`https://lh3.googleusercontent.com/d/${fileId}=w1600`);
    }
    return res.status(404).send("Image not found");
  }
};

export const proxyOneDriveImage = async (req: Request, res: Response) => {
  const fileUrlOrId = (req.query.url as string) || (req.query.id as string) || req.params.fileId;
  if (!fileUrlOrId) return res.status(400).json({ error: "Missing file url or id" });

  try {
    const { buffer, contentType } = await proxyOneDriveFileContent(fileUrlOrId);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(buffer);
  } catch (err: any) {
    console.warn("[oneDriveService] Proxy error:", err);
    return res.status(404).json({ error: "Could not stream OneDrive image" });
  }
};
