import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IStudent {
	name: string;
	email: string;
	githubUsername?: string;
}

export interface IMilestone {
	title: string;
	description?: string;
	dueDate: Date;
	completed: boolean;
	/** Links this per-team copy back to the course-wide milestone it was seeded
	 *  from, so editing/deleting it on the course page can find every copy.
	 *  Absent for any milestone that predates this linkage (legacy data). */
	courseMilestoneId?: Types.ObjectId;
}

export interface ITeamDoc extends Document {
	courseId: Types.ObjectId;
	name: string;
	students: Types.DocumentArray<IStudent>;
	githubRepo?: string;
	githubOwner?: string;
	githubRepoName?: string;
	googleDriveFolder?: string;
	milestones: Types.DocumentArray<IMilestone>;
}

const StudentSchema = new Schema<IStudent>(
	{
		name: { type: String, required: true },
		email: { type: String, required: true },
		githubUsername: { type: String },
	},
	{ _id: true },
);

const MilestoneSchema = new Schema<IMilestone>(
	{
		title: { type: String, required: true },
		description: { type: String },
		dueDate: { type: Date, required: true },
		completed: { type: Boolean, default: false },
		courseMilestoneId: { type: Schema.Types.ObjectId },
	},
	{ _id: true },
);

const TeamSchema = new Schema<ITeamDoc>(
	{
		courseId: { type: Schema.Types.ObjectId, ref: 'Course', required: true },
		name: { type: String, required: true, trim: true },
		students: [StudentSchema],
		githubRepo: { type: String },
		githubOwner: { type: String },
		githubRepoName: { type: String },
		googleDriveFolder: { type: String },
		milestones: [MilestoneSchema],
	},
	{ timestamps: true },
);

export default mongoose.model<ITeamDoc>('Team', TeamSchema);
