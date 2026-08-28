import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * A course-wide milestone template. Created/edited/deleted by the teacher on
 * the course page, and cascaded (see courseController) into a linked copy on
 * every team in the course — each team then tracks its own `completed` state
 * for that copy independently on `Team.milestones`.
 */
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
