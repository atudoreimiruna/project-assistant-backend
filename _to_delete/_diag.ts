import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import Team from './src/models/Team';
import ActivityLog from './src/models/ActivityLog';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI as string);

  const teams = await Team.find({}).limit(20);
  for (const team of teams) {
    const activityCount = await ActivityLog.countDocuments({ teamId: team._id });
    if (activityCount === 0) continue;

    const commitCount = await ActivityLog.countDocuments({ teamId: team._id, type: 'commit' });
    const prCount = await ActivityLog.countDocuments({ teamId: team._id, type: 'pr' });
    const withStudentEmail = await ActivityLog.countDocuments({ teamId: team._id, studentEmail: { $exists: true, $ne: null } });

    console.log(`\n=== Team: ${team.name} (${team._id}) ===`);
    console.log(`activity=${activityCount} commits=${commitCount} prs=${prCount} withStudentEmail=${withStudentEmail}`);
    console.log('students:', team.students.map((s) => JSON.stringify(s.email)).join(', '));

    const sampleCommits = await ActivityLog.find({ teamId: team._id, type: 'commit' }).limit(5);
    console.log('sample commit studentEmail values:', sampleCommits.map((a) => JSON.stringify(a.studentEmail)).join(', '));
    console.log('sample commit descriptions:', sampleCommits.map((a) => a.description).join(' | '));
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
