import mongoose from "mongoose";

let isConnected = false;

export async function connectDB(): Promise<void> {
  if (isConnected) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[dbService] MONGODB_URI not set — running without database (in-memory only).");
    return;
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
    });
    isConnected = true;
    console.log("[dbService] Connected to MongoDB Atlas.");
  } catch (err) {
    console.error("[dbService] MongoDB connection failed:", err);
    // Non-fatal: app still works in memory-only mode
  }
}

export function isDbConnected(): boolean {
  return isConnected && mongoose.connection.readyState === 1;
}
