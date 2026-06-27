import mongoose, { Schema, Document } from 'mongoose';

export interface ICourseDoc extends Document {
  teacherId: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  startDate: Date;
  endDate: Date;
}

const CourseSchema = new Schema<ICourseDoc>(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: 'Teacher', required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
  },
  { timestamps: true }
);

export default mongoose.model<ICourseDoc>('Course', CourseSchema);
