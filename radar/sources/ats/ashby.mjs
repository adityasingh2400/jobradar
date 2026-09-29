// Ashby job boards. Uses the same lightweight GraphQL query the hosted board page uses
// (~80x smaller than the documented posting API, which ships every description);
// falls back to the documented API if GraphQL fails.

const u = (s) => { try { return new URL(s); } catch { return null; } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const QUERY = `query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
  jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
    jobPostings { id title locationName workplaceType employmentType compensationTierSummary secondaryLocations { locationName } }
  }
}`;

export default {
  id: 'ashby',
  label: 'Ashby',
  kind: 'platform',
  direct: true,
  interval: 90,
  coldInterval: 600,

  instanceFromUrl(url, company) {
    const x = u(url);
    if (!x || x.hostname !== 'jobs.ashbyhq.com') return null;
    const org = decodeURIComponent(x.pathname.split('/').filter(Boolean)[0] || '');
    if (!org) return null;
    return { key: `ashby:${org.toLowerCase()}`, org, company };
  },

  canon(url) {
    const x = u(url);
    if (!x || x.hostname !== 'jobs.ashbyhq.com') return null;
    const id = x.pathname.split('/').filter(Boolean)[1];
    return id && UUID.test(id) ? `ashby:${id.toLowerCase()}` : null;
  },

  async poll(inst, ctx) {
    let postings;
    try {
      const r = await ctx.http.json('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams', {
        method: 'POST',
        body: { operationName: 'ApiJobBoardWithTeams', variables: { organizationHostedJobsPageName: inst.org }, query: QUERY },
      });
      if (!r?.data?.jobBoard) throw new Error(r?.errors?.[0]?.message || 'ashby: board not found');
      postings = r.data.jobBoard.jobPostings.map((p) => ({
        id: p.id, title: p.title, employmentType: p.employmentType, comp: p.compensationTierSummary,
        locations: [p.locationName, ...(p.secondaryLocations || []).map((s) => s.locationName)].filter(Boolean),
        remote: p.workplaceType === 'Remote',
      }));
    } catch (e) {
      const r = await ctx.http.json(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(inst.org)}?includeCompensation=true`, { timeout: 40_000 });
      postings = (r.jobs || []).filter((p) => p.isListed !== false).map((p) => ({
        id: p.jobUrl?.split('/').pop() || p.id, title: p.title, employmentType: p.employmentType,
        comp: p.compensation?.compensationTierSummary || null, postedAt: p.publishedAt,
        locations: [p.location, ...(p.secondaryLocations || []).map((s) => s.location)].filter(Boolean),
        remote: p.isRemote,
      }));
    }
    const items = [];
    for (const p of postings) {
      const intern = p.employmentType === 'Intern';
      if (!ctx.isInternTitle(p.title) && !intern) continue;
      if (!UUID.test(p.id)) continue;
      items.push({
        sid: `ashby:${p.id.toLowerCase()}`,
        title: String(p.title).trim(),
        intern,
        url: `https://jobs.ashbyhq.com/${encodeURIComponent(inst.org)}/${p.id}`,
        company: inst.company,
        locations: p.remote && !p.locations.some((l) => /remote/i.test(l)) ? [...p.locations, 'Remote'] : p.locations,
        postedAt: p.postedAt || null,
        comp: p.comp || null,
      });
    }
    return { complete: true, items };
  },
};
