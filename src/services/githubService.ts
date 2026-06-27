import Team from '../models/Team';
// use global fetch (Node 18+). If running on older Node, install node-fetch.
import ActivityLog from '../models/ActivityLog';

export const parseRepoUrl = (repoUrl: string) => {
	// supports HTTPS and git@ urls
	try {
		if (repoUrl.startsWith('git@')) {
			// git@github.com:owner/repo.git
			const parts = repoUrl.split(':')[1].replace(/\.git$/, '');
			const [owner, repo] = parts.split('/');
			return { owner, repo };
		}

		const u = new URL(repoUrl);
		const parts = u.pathname
			.replace(/^\//, '')
			.replace(/\.git$/, '')
			.split('/');
		const [owner, repo] = parts;
		return { owner, repo };
	} catch (err) {
		return null;
	}
};

const getHeaders = () => {
	const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
	const token = process.env.GITHUB_TOKEN?.trim();
	if (token && token.length > 10) headers['Authorization'] = `token ${token}`;
	return headers;
};

export const syncTeamRepo = async (teamId: string) => {
	const team = await Team.findById(teamId);
	if (!team) throw new Error('Team not found');

	let repo: { owner: string; repo: string } | null = null;

	if (team.githubOwner && team.githubRepoName) {
		repo = { owner: team.githubOwner, repo: team.githubRepoName };
	} else if (team.githubRepo) {
		repo = parseRepoUrl(team.githubRepo);
	}

	if (!repo) throw new Error('No valid GitHub repo on this team');

	const studentEmails = new Set((team.students || []).map((s: any) => s.email.toLowerCase()));

	const sinceDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(); // last 30 days

	// fetch commits
	const commitsRes = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/commits?since=${sinceDate}&per_page=100`, { headers: getHeaders() });
	if (!commitsRes.ok) {
		const errBody = await commitsRes.json().catch(() => ({}));
		throw new Error(`Failed fetching commits: ${commitsRes.status} - ${(errBody as any).message || ''}`);
	}
	const commits = await commitsRes.json() as any[];
	if (!Array.isArray(commits)) throw new Error(`Unexpected commits response: ${JSON.stringify(commits)}`);

	for (const c of commits) {
		const ghId = c.sha;
		const exists = await ActivityLog.findOne({ 'metadata.githubId': ghId });
		if (exists) continue;

		const authorEmail = c.commit?.author?.email?.toLowerCase();
		const studentEmail = authorEmail && studentEmails.has(authorEmail) ? authorEmail : undefined;
		const description = `Commit ${ghId} by ${c.commit?.author?.name || c.author?.login || 'unknown'}: ${c.commit?.message?.split('\n')[0]}`;

		await ActivityLog.create({
			teamId,
			type: 'commit',
			studentEmail,
			description,
			timestamp: new Date(c.commit?.author?.date || Date.now()),
			metadata: { githubId: ghId, url: c.html_url },
		});
	}

	// fetch PRs (recently updated)
	const prsRes = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`, { headers: getHeaders() });
	if (!prsRes.ok) {
		const errBody = await prsRes.json().catch(() => ({}));
		throw new Error(`Failed fetching PRs: ${prsRes.status} - ${(errBody as any).message || ''}`);
	}
	const prs = await prsRes.json() as any[];
	if (!Array.isArray(prs)) throw new Error(`Unexpected PRs response: ${JSON.stringify(prs)}`);

	for (const p of prs) {
		const ghId = `pr-${p.number}`;
		const exists = await ActivityLog.findOne({ 'metadata.githubId': ghId });
		if (exists) continue;

		// try to map author to student
		const authorEmail = p.user?.email?.toLowerCase();
		const studentEmail = authorEmail && studentEmails.has(authorEmail) ? authorEmail : undefined;
		const description = `PR #${p.number} ${p.title} by ${p.user?.login}`;

		await ActivityLog.create({
			teamId,
			type: 'pr',
			studentEmail,
			description,
			timestamp: new Date(p.updated_at || Date.now()),
			metadata: { githubId: ghId, url: p.html_url, state: p.state },
		});
	}

	return { commits: commits.length, prs: prs.length };
};

export default { syncTeamRepo };
