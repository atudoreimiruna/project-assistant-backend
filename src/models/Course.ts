import mongoose, { Schema, Document, Types } from 'mongoose';

export interface ICourseMilestone {
  title: string;
  description?: string;
  dueDate: Date;
}

export interface ICourseDoc extends Document {
  teacherId: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  startDate: Date;
  endDate: Date;
  milestones: Types.DocumentArray<ICourseMilestone>;
}

const CourseMilestoneSchema = new Schema<ICourseMilestone>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String },
    dueDate: { type: Date, required: true },
  },
  { _id: true },
);

const CourseSchema = new Schema<ICourseDoc>(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: 'Teacher', required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    milestones: [CourseMilestoneSchema],
  },
  { timestamps: true }
);

export default mongoose.model<ICourseDoc>('Course', CourseSchema);
