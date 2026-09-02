import { Request, Response } from "express";
import path from "path";
import fs from "fs";
import { getBulkPhotoDir, ensureDirExists, removeDirSync } from "../services/storageService.js";
import { scrapeDriveFolderEntries, proxyDriveFileContent } from "../services/driveService.js";
import { isOneDriveUrl, scrapeOneDriveFolderEntries, proxyOneDriveFileContent } from "../services/oneDriveService.js";
import { isDbConnected } from "../services/dbService.js";
import { EventModel as _EventModel } from "../models/Event.js";
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
    const eventDir = getBulkPhotoDir(doc.eventId);
    photos = driveFiles.map((f: any) => {
      const diskPath = path.join(eventDir, f.name);
      if (fs.existsSync(diskPath)) {
        return `/bulk_photo/${doc.eventId}/${encodeURIComponent(f.name)}`;
      }
      return `/api/drive-proxy/${f.id}`;
    });
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
  } catch (error: any) {
    console.error("Failed to create event:", error);
    res.status(500).json({ error: "Failed to create event" });
  }
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
      const eventDir = getBulkPhotoDir(e.eventId);
      e.photos = e.driveFiles.map(f => {
        const diskPath = path.join(eventDir, f.name);
        if (fs.existsSync(diskPath)) {
          return `/bulk_photo/${e.eventId}/${encodeURIComponent(f.name)}`;
        }
        return `/api/drive-proxy/${f.id}`;
      });
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

  // Check if this file is already on local disk in bulk_photo
  for (const ev of Object.values(events)) {
    const match = ev.driveFiles?.find(f => f.id === fileId);
    if (match) {
      const diskPath = path.join(getBulkPhotoDir(ev.eventId), match.name);
      if (fs.existsSync(diskPath) && fs.statSync(diskPath).size > 100) {
        return res.sendFile(diskPath);
      }
    }
  }

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

// ── Face Embedding Storage Endpoint ──────────────────────────────────────────

/**
 * POST /api/events/:eventId/compute-embeddings
 * Accepts pre-computed face descriptors from the admin panel and stores them.
 * The admin browser runs face-api.js to extract descriptors per photo and sends
 * them here to be persisted in MongoDB for Vercel-compatible JS matching.
 */
export const computeEmbeddings = async (req: Request, res: Response) => {
  const { eventId } = req.params;
  const { descriptors } = req.body; // { descriptors: [{name, thumbUrl, descriptors: number[][]}] }
  const event = await findEvent(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  if (descriptors && Array.isArray(descriptors) && descriptors.length > 0) {
    event.faceDescriptors = descriptors;
    if (isDbConnected()) {
      try {
        await EventModel.findOneAndUpdate(
          { eventId },
          { $set: { faceDescriptors: descriptors } }
        ).exec();
        console.log(`[embeddings] Stored ${descriptors.length} descriptor entries for event ${eventId}`);
      } catch (e: any) {
        console.warn('[embeddings] Failed to save to MongoDB:', e?.message);
      }
    }
    return res.json({ success: true, count: descriptors.length, message: `Stored ${descriptors.length} face descriptors for event ${eventId}.` });
  }

  // No descriptors sent — just check status
  return res.json({
    success: true,
    count: event.faceDescriptors?.length || 0,
    message: `Event ${eventId} has ${event.faceDescriptors?.length || 0} photos with pre-computed face descriptors.`
  });
};

