import type { CiState, Event, Workflow } from './model.js';

export type CheckState = 'failing' | 'pending' | 'passing' | 'skipped' | 'terminal' | 'unknown';

export function checkState(status: string, conclusion: string | null): CheckState {
  if (status !== 'completed') return 'pending';
  if (['failure', 'timed_out', 'action_required', 'startup_failure'].includes(conclusion ?? '')) return 'failing';
  if (conclusion === 'success') return 'passing';
  if (conclusion === 'neutral' || conclusion === 'skipped') return 'skipped';
  if (conclusion === 'cancelled' || conclusion === 'stale') return 'terminal';
  return 'unknown';
}

export function evaluateCi(head: string, previous: CiState | undefined, observed: Workflow[], at: string): { state: CiState; event: Event | null } {
  const prior: CiState = previous ?? { runs: [], selected: [], unresolved: [], outcome: null, uncertain: false, transition: 0 };
  const versions = new Map<string, Workflow>();
  let uncertain = false;
  const current = observed.filter(run => run.head === head);
  const candidates = [
    ...prior.unresolved.filter(old => !current.some(run => run.id === old.id
      && (old.attempt === null || (run.attempt !== null && run.attempt >= old.attempt))
      && ((old.attempt !== null && run.attempt !== null && run.attempt > old.attempt)
        || Date.parse(run.updatedAt) >= Date.parse(old.updatedAt)))),
    ...current,
  ];
  const all = [...prior.runs, ...candidates];
  const ordered = (run: Workflow) => run.workflowId !== null && run.trigger !== null && run.runNumber !== null && run.attempt !== null;
  const identity = new Map<string, string>();
  for (const run of all) {
    if (!ordered(run)) {
      if (all.some(repair => ordered(repair) && repair.id === run.id
        && (run.attempt === null || repair.attempt! >= run.attempt)
        && Date.parse(repair.updatedAt) >= Date.parse(run.updatedAt))) continue;
      uncertain = true;
      continue;
    }
    const metadata = JSON.stringify([run.workflowId, run.trigger, run.runNumber]);
    if (identity.has(run.id) && identity.get(run.id) !== metadata) uncertain = true;
    identity.set(run.id, metadata);
    const key = JSON.stringify([run.id, run.attempt]);
    const existing = versions.get(key);
    if (existing && Date.parse(run.updatedAt) === Date.parse(existing.updatedAt)) {
      const signature = (value: Workflow) => JSON.stringify({
        ...value, updatedAt: new Date(value.updatedAt).toISOString(), jobs: [...value.jobs].sort((a, b) => a.id.localeCompare(b.id)),
      });
      if (signature(run) !== signature(existing)) uncertain = true;
    }
    if (!existing || Date.parse(run.updatedAt) > Date.parse(existing.updatedAt)) versions.set(key, run);
  }
  const selected = new Map<string, Workflow>();
  for (const run of versions.values()) {
    const key = JSON.stringify([run.workflowId, run.trigger]);
    const old = selected.get(key);
    if (old && run.runNumber === old.runNumber && run.id !== old.id) uncertain = true;
    if (!old || run.runNumber! > old.runNumber! || (run.id === old.id && run.attempt! > old.attempt!)) selected.set(key, run);
  }
  if (uncertain) return { state: { ...prior, unresolved: candidates, uncertain: true }, event: null };
  const workflows = [...selected.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, run]) => run);
  const states = workflows.map(run => checkState(run.status, run.conclusion));
  const outcome = states.includes('failing') ? 'failure'
    : states.includes('passing') && states.every(state => state === 'passing' || state === 'skipped') ? 'success' : null;
  const changed = outcome !== prior.outcome;
  const state: CiState = {
    runs: [...versions.values()], selected: workflows, unresolved: [], outcome, uncertain: false,
    transition: prior.transition + Number(changed),
  };
  return {
    state,
    event: changed && outcome ? {
      source: 'ci', id: `${head}:${state.transition}:${outcome}`, kind: outcome === 'failure' ? 'ci_failure' : 'ci_success',
      occurredAt: at, actor: null, body: '',
    } : null,
  };
}

export function ciSummary(state: CiState | undefined): {
  outcome: 'failure' | 'success' | null; uncertain: boolean;
  counts: Record<CheckState, number>; workflows: { id: string; name: string; trigger: string; run: string; attempt: number | null; state: CheckState; jobs: { name: string; state: CheckState }[] }[];
} {
  const counts: Record<CheckState, number> = { failing: 0, pending: 0, passing: 0, skipped: 0, terminal: 0, unknown: 0 };
  const workflows = (state?.selected ?? []).map(run => ({
    id: run.workflowId!, name: run.name, trigger: run.trigger!, run: run.id, attempt: run.attempt,
    state: checkState(run.status, run.conclusion),
    jobs: run.jobs.map(job => {
      const status = checkState(job.status, job.conclusion);
      counts[status]++;
      return { name: job.name, state: status };
    }),
  }));
  return { outcome: state?.outcome ?? null, uncertain: state?.uncertain ?? false, counts, workflows };
}
