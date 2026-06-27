import mongoose, { Schema, Document } from 'mongoose';

export interface IActivityLogDoc extends Document {
  teamId: mongoose.Types.ObjectId;
  type: 'commit' | 'pr' | 'issue' | 'document';
  studentEmail?: string;
  description: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

const ActivityLogSchema = new Schema<IActivityLogDoc>({
  teamId: { type: Schema.Types.ObjectId, ref: 'Team', required: true },
  type: {
    type: String,
    enum: ['commit', 'pr', 'issue', 'document'],
    required: true,
  },
  studentEmail: { type: String },
  description: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  metadata: { type: Schema.Types.Mixed },
});

// Fast queries by team and time range
ActivityLogSchema.index({ teamId: 1, timestamp: -1 });

export default mongoose.model<IActivityLogDoc>('ActivityLog', ActivityLogSchema);
