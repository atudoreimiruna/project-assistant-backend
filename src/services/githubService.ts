import Team from '../models/Team';
// use global fetch (Node 18+). If running on older Node, install node-fetch.
import ActivityLog from '../models/ActivityLog';

export interface ContributorPreview {
	name: string;
	email: string;
	githubUsername?: string;
	alreadyMember: boolean;
	/** Name of existing member whose display name closely matches this contributor */
	possibleDuplicate?: string;
}

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

export const addCollaborator = async (owner: string, repo: string, username: string): Promise<void> => {
	const res = await fetch(
		`https://api.github.com/repos/${owner}/${repo}/collaborators/${username}`,
		{ method: 'PUT', headers: { ...getHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ permission: 'push' }) },
	);
	if (res.status !== 201 && res.status !== 204) {
		const body = await res.json().catch(() => ({}));
		throw new Error(`GitHub add collaborator failed: ${res.status} - ${(body as any).message || ''}`);
	}
};

export const removeCollaborator = async (owner: string, repo: string, username: string): Promise<void> => {
	const res = await fetch(
		`https://api.github.com/repos/${owner}/${repo}/collaborators/${username}`,
		{ method: 'DELETE', headers: getHeaders() },
	);
	if (res.status !== 204) {
		const body = await res.json().catch(() => ({}));
		throw new Error(`GitHub remove collaborator failed: ${res.status} - ${(body as any).message || ''}`);
	}
};

export const previewGithubContributors = async (teamId: string): Promise<ContributorPreview[]> => {
	const team = await Team.findById(teamId);
	if (!team || !team.githubOwner || !team.githubRepoName) return [];
	const { githubOwner: owner, githubRepoName: repo } = team;

	const res = await fetch(
		`https://api.github.com/repos/${owner}/${repo}/contributors?per_page=100`,
		{ headers: getHeaders() },
	);
	if (!res.ok) return [];

	const contributors = await res.json() as any[];
	if (!Array.isArray(contributors)) return [];

	const existingEmails = new Set(team.students.map((s: any) => s.email.toLowerCase()));
	const existingUsernames = new Set(
		team.students.filter((s: any) => s.githubUsername).map((s: any) => (s.githubUsername as string).toLowerCase()),
	);
	// For fuzzy name matching: lowercase names of existing members
	const existingNames = team.students.map((s: any) => ({ name: (s.name as string).toLowerCase(), display: s.name as string }));

	const previews: ContributorPreview[] = [];

	for (const contributor of contributors) {
		const login: string = contributor.login;
		if (!login || contributor.type === 'Bot') continue;

		let name = login;
		let email = `${login}@users.noreply.github.com`;

		const userRes = await fetch(`https://api.github.com/users/${login}`, { headers: getHeaders() });
		if (userRes.ok) {
			const user = await userRes.json() as any;
			if (user.name) name = user.name;
			if (user.email) email = user.email;
		}

		const alreadyMember =
			existingUsernames.has(login.toLowerCase()) ||
			existingEmails.has(email.toLowerCase());

		// Check for a name-only near-match (not already an exact member)
		let possibleDuplicate: string | undefined;
		if (!alreadyMember) {
			const lowerName = name.toLowerCase();
			const match = existingNames.find((e) => e.name === lowerName);
			if (match) possibleDuplicate = match.display;
		}

		previews.push({ name, email, githubUsername: login, alreadyMember, possibleDuplicate });
	}

	return previews;
};

export const importGithubContributors = async (teamId: string): Promise<void> => {
	const team = await Team.findById(teamId);
	if (!team || !team.githubOwner || !team.githubRepoName) return;
	const { githubOwner: owner, githubRepoName: repo } = team;

	const res = await fetch(
		`https://api.github.com/repos/${owner}/${repo}/contributors?per_page=100`,
		{ headers: getHeaders() },
	);
	if (!res.ok) return; // silently skip (e.g. private repo with no token)

	const contributors = await res.json() as any[];
	if (!Array.isArray(contributors)) return;

	const existingUsernames = new Set(
		team.students
			.filter((s: any) => s.githubUsername)
			.map((s: any) => (s.githubUsername as string).toLowerCase()),
	);

	for (const contributor of contributors) {
		const login: string = contributor.login;
		if (!login || contributor.type === 'Bot') continue;
		if (existingUsernames.has(login.toLowerCase())) continue;

		// Fetch public profile for name + email
		let name = login;
		let email = `${login}@users.noreply.github.com`;

		const userRes = await fetch(`https://api.github.com/users/${login}`, { headers: getHeaders() });
		if (userRes.ok) {
			const user = await userRes.json() as any;
			if (user.name) name = user.name;
			if (user.email) email = user.email;
		}

		team.students.push({ name, email, githubUsername: login });
		existingUsernames.add(login.toLowerCase());
	}

	await team.save();
};

export const syncTeamCollaborators = async (teamId: string): Promise<void> => {
	const team = await Team.findById(teamId);
	if (!team || !team.githubOwner || !team.githubRepoName) return;
	const { githubOwner: owner, githubRepoName: repo } = team;

	await Promise.allSettled(
		team.students
			.filter((s: any) => s.githubUsername)
			.map((s: any) => addCollaborator(owner, repo, s.githubUsername!)),
	);
};

export default { syncTeamRepo, addCollaborator, removeCollaborator, syncTeamCollaborators };
