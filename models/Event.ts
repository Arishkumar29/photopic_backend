import mongoose, { Document, Schema } from "mongoose";

export interface IEvent extends Document {
  eventId: string;
  folderId: string;
  accessToken: string;
  orgName: string;
  eventName: string;
  photos: string[];
  driveFiles?: { id: string; thumbUrl: string; name: string }[];
  /** Pre-computed face embeddings (128-d) for each photo — for JS-based Vercel matching */
  faceDescriptors?: { name: string; thumbUrl: string; descriptors: number[][] }[];
  coverImage?: string;
  description?: string;
  eventLocation?: string;
  eventType?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const EventSchema = new Schema<IEvent>(
  {
    eventId:     { type: String, required: true, unique: true, index: true },
    folderId:    { type: String, required: true },
    accessToken: { type: String, default: "default_token" },
    orgName:     { type: String, default: "Photographer" },
    eventName:   { type: String, default: "New Event" },
    photos:      { type: [String], default: [] },
    driveFiles: [
      {
        id:       String,
        thumbUrl: String,
        name:     String,
      },
    ],
    faceDescriptors: [
      {
        name:        String,
        thumbUrl:    String,
        descriptors: [[Number]],
      },
    ],
    coverImage:     { type: String },
    description:    { type: String },
    eventLocation:  { type: String },
    eventType:      { type: String },
  },
  { timestamps: true }
);

export const EventModel =
  mongoose.models.Event || mongoose.model<IEvent>("Event", EventSchema);
