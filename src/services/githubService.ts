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
	/**
	 * False when `email` is a fallback placeholder (`login@users.noreply.github.com`)
	 * rather than a real, deliverable address — GitHub's public API usually
	 * doesn't expose one. The UI should flag this and let the professor edit it
	 * before import, instead of silently saving an address that will bounce.
	 */
	hasRealEmail: boolean;
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

// GitHub's public "keep my email private" placeholder — never a deliverable
// address, whether it's the bare login form or the numeric-id-prefixed form
// GitHub uses as the commit-author email for accounts with that setting on.
const isNoreplyEmail = (email: string | null | undefined): boolean =>
	!!email && /@users\.noreply\.github\.com$/i.test(email);

/**
 * Best-effort real email lookup for a GitHub login. The public profile API
 * (`GET /users/{login}`) only returns an email when the account owner has
 * explicitly made it public, which is the exception rather than the rule —
 * most of the time it's `null`, and naively falling back to a fake
 * `login@users.noreply.github.com` address produces something that bounces
 * every reminder email sent to it. As a second attempt, we look at that
 * contributor's own recent commits in this repo: the git commit
 * `author.email` is whatever's in their local git config, which for many
 * people (unlike the profile email) is their everyday address — unless
 * they've enabled GitHub's email-privacy setting, in which case GitHub
 * rewrites it to the same noreply placeholder, and we correctly give up
 * rather than "recover" a fake address.
 */
const resolveContributorProfile = async (
	owner: string,
	repo: string,
	login: string,
): Promise<{ name: string; email: string; hasRealEmail: boolean }> => {
	let name = login;
	let email = `${login}@users.noreply.github.com`;
	let hasRealEmail = false;

	const userRes = await fetch(`https://api.github.com/users/${login}`, { headers: getHeaders() });
	if (userRes.ok) {
		const user = await userRes.json() as any;
		if (user.name) name = user.name;
		if (user.email && !isNoreplyEmail(user.email)) {
			email = user.email;
			hasRealEmail = true;
		}
	}

	if (!hasRealEmail) {
		try {
			const commitsRes = await fetch(
				`https://api.github.com/repos/${owner}/${repo}/commits?author=${login}&per_page=5`,
				{ headers: getHeaders() },
			);
			if (commitsRes.ok) {
				const commits = await commitsRes.json() as any[];
				if (Array.isArray(commits)) {
					const realEmailCommit = commits.find(
						(c: any) => c.commit?.author?.email && !isNoreplyEmail(c.commit.author.email),
					);
					if (realEmailCommit) {
						email = realEmailCommit.commit.author.email;
						hasRealEmail = true;
					}
				}
			}
		} catch {
			// Best-effort only — fall through with the placeholder.
		}
	}

	return { name, email, hasRealEmail };
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

	// GitHub's own username is a far more reliable attribution key than the git
	// commit author's email: that email is whatever's in the contributor's local
	// git config, which is very often a personal address or GitHub's "keep my
	// email private" noreply alias — neither matches the roster email a student
	// registered with. The GitHub login GitHub itself resolves for a commit/PR
	// (and the PR author, which never even exposes an email via this API) does
	// match what's stored as each student's githubUsername.
	const usernameToEmail = new Map<string, string>(
		(team.students || [])
			.filter((s: any) => s.githubUsername)
			.map((s: any) => [s.githubUsername.toLowerCase(), s.email.toLowerCase()]),
	);

	const resolveStudentEmail = (login: string | undefined, email: string | undefined): string | undefined => {
		const byLogin = login && usernameToEmail.get(login.toLowerCase());
		if (byLogin) return byLogin;
		const lowerEmail = email?.toLowerCase();
		return lowerEmail && studentEmails.has(lowerEmail) ? lowerEmail : undefined;
	};

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
		const studentEmail = resolveStudentEmail(c.author?.login, c.commit?.author?.email);

		const exists = await ActivityLog.findOne({ 'metadata.githubId': ghId });
		if (exists) {
			// Re-attribute: this commit's author-login-based resolution is
			// re-derived from the *current* roster on every sync, so it stays
			// correct even after the professor edits a student's email (e.g. to
			// replace a bad noreply placeholder) or reassigns a GitHub username —
			// cases that used to leave already-logged activity permanently stuck
			// pointing at whatever email was resolved the first time. We only
			// ever apply a freshly *resolved* email, so a transient lookup miss
			// never blanks out a good attribution that's already stored.
			if (studentEmail && exists.studentEmail !== studentEmail) {
				exists.studentEmail = studentEmail;
				await exists.save();
			}
			continue;
		}

		const description = `Commit ${ghId} by ${c.commit?.author?.name || c.author?.login || 'unknown'}: ${c.commit?.message?.split('\n')[0]}`;

		await ActivityLog.create({
			teamId,
			type: 'commit',
			studentEmail,
			description,
			timestamp: new Date(c.commit?.author?.date || Date.now()),
			metadata: { githubId: ghId, url: c.html_url, githubLogin: c.author?.login },
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
		// The pulls list endpoint never includes the author's email at all — login
		// (GitHub username) is the only identity it gives us, and it's also the
		// more reliable one.
		const studentEmail = resolveStudentEmail(p.user?.login, p.user?.email);

		const exists = await ActivityLog.findOne({ 'metadata.githubId': ghId });
		if (exists) {
			// Same re-attribution as commits above — keeps PR activity pointed at
			// the roster's current email for this GitHub login.
			if (studentEmail && exists.studentEmail !== studentEmail) {
				exists.studentEmail = studentEmail;
				await exists.save();
			}
			continue;
		}

		const description = `PR #${p.number} ${p.title} by ${p.user?.login}`;

		await ActivityLog.create({
			teamId,
			type: 'pr',
			studentEmail,
			description,
			timestamp: new Date(p.updated_at || Date.now()),
			metadata: { githubId: ghId, url: p.html_url, state: p.state, githubLogin: p.user?.login },
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

		const { name, email, hasRealEmail } = await resolveContributorProfile(owner, repo, login);

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

		previews.push({ name, email, githubUsername: login, alreadyMember, possibleDuplicate, hasRealEmail });
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

		const { name, email } = await resolveContributorProfile(owner, repo, login);

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
