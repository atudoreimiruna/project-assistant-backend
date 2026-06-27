import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IStudentBreakdown {
  email: string;
  name: string;
  commits: number;
  prs: number;
  contributionScore: number; // 0-100 rough score
}

export interface ITeamReportDoc extends Document {
  teamId: Types.ObjectId;
  generatedAt: Date;
  // raw activity snapshot used to generate this report
  activityCount: number;
  // structured output from Claude
  summary: string;
  status: 'ON_TRACK' | 'AT_RISK' | 'BLOCKED';
  concerns: string[];
  recommendations: string[];
  studentBreakdown: IStudentBreakdown[];
  // full raw text for debugging / display
  rawText: string;
}

const StudentBreakdownSchema = new Schema<IStudentBreakdown>(
  {
    email: { type: String, required: true },
    name: { type: String, required: true },
    commits: { type: Number, default: 0 },
    prs: { type: Number, default: 0 },
    contributionScore: { type: Number, default: 0 },
  },
  { _id: false },
);

const TeamReportSchema = new Schema<ITeamReportDoc>(
  {
    teamId: { type: Schema.Types.ObjectId, ref: 'Team', required: true },
    generatedAt: { type: Date, default: Date.now },
    activityCount: { type: Number, default: 0 },
    summary: { type: String, required: true },
    status: {
      type: String,
      enum: ['ON_TRACK', 'AT_RISK', 'BLOCKED'],
      required: true,
    },
    concerns: [{ type: String }],
    recommendations: [{ type: String }],
    studentBreakdown: [StudentBreakdownSchema],
    rawText: { type: String, default: '' },
  },
  { timestamps: true },
);

// Keep only the latest report per team easily retrievable
TeamReportSchema.index({ teamId: 1, generatedAt: -1 });

export default mongoose.model<ITeamReportDoc>('TeamReport', TeamReportSchema);
