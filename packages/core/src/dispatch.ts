import { isAutomaticState, roleForState } from "./states.js";
import type {
  ActiveRunSnapshot,
  DispatchBudgetPolicy,
  DispatchConcurrencyPolicy,
  DispatchDecision,
  RepositoryRef,
  TaskSnapshot,
} from "./types.js";
import { resolveRepositoryForTask } from "./repository-routing.js";

export function decideDispatch(
  task: TaskSnapshot,
  repositories: readonly RepositoryRef[],
  activeRuns: readonly ActiveRunSnapshot[],
  now = new Date(),
  concurrencyPolicy: DispatchConcurrencyPolicy = {},
  budgetPolicy: DispatchBudgetPolicy = {},
): DispatchDecision {
  const reasons: string[] = [];
  const role = roleForState(task.state);

  if (!isAutomaticState(task.state)) {
    reasons.push(`state ${task.state} is not automatic`);
  }

  const repository = resolveRepositoryForTask(task, repositories);
  if (!repository) {
    reasons.push("task has no resolvable repository");
  } else if (repository.status !== "active") {
    reasons.push(`repository ${repository.slug} is not active`);
  }

  if (task.blocked) {
    reasons.push("task is marked blocked");
  }

  if (task.humanRequired) {
    reasons.push("task requires human action");
  }

  if (hasActiveLease(task.id, activeRuns, now)) {
    reasons.push("task already has an active run lease");
  }

  if (
    repository &&
    exceedsRepositoryConcurrency(repository.id, activeRuns, now, concurrencyPolicy)
  ) {
    reasons.push(`repository ${repository.slug} has reached active run concurrency limit`);
  }

  if (role && exceedsRoleConcurrency(role, activeRuns, now, concurrencyPolicy)) {
    reasons.push(`role ${role} has reached active run concurrency limit`);
  }

  if (exceedsRunBudget(task, budgetPolicy)) {
    reasons.push("task estimated cost exceeds per-run budget");
  }

  if (reasons.length > 0) {
    return {
      dispatchable: false,
      reasons,
    };
  }

  return {
    dispatchable: true,
    role,
    reasons,
  };
}

function exceedsRunBudget(task: TaskSnapshot, policy: DispatchBudgetPolicy): boolean {
  const limit = normalizeBudget(policy.maxEstimatedCostUsdPerRun);
  if (
    limit === undefined ||
    task.estimatedCostUsd === undefined ||
    task.estimatedCostUsd === null
  ) {
    return false;
  }

  return task.estimatedCostUsd > limit;
}

function hasActiveLease(
  taskId: string,
  activeRuns: readonly ActiveRunSnapshot[],
  now: Date,
): boolean {
  return activeRuns.some((run) => {
    if (run.taskId !== taskId) {
      return false;
    }

    if (!["queued", "claimed", "running"].includes(run.status)) {
      return false;
    }

    return !run.leaseExpiresAt || run.leaseExpiresAt > now;
  });
}

function exceedsRepositoryConcurrency(
  repositoryId: string,
  activeRuns: readonly ActiveRunSnapshot[],
  now: Date,
  policy: DispatchConcurrencyPolicy,
): boolean {
  const limit = normalizeLimit(policy.maxActiveRunsPerRepository);
  if (!limit) {
    return false;
  }

  return (
    activeRuns.filter((run) => run.repositoryId === repositoryId && hasActiveRunLease(run, now))
      .length >= limit
  );
}

function exceedsRoleConcurrency(
  role: NonNullable<DispatchDecision["role"]>,
  activeRuns: readonly ActiveRunSnapshot[],
  now: Date,
  policy: DispatchConcurrencyPolicy,
): boolean {
  const limit = normalizeLimit(policy.maxActiveRunsPerRole);
  if (!limit) {
    return false;
  }

  return (
    activeRuns.filter((run) => run.role === role && hasActiveRunLease(run, now)).length >= limit
  );
}

function hasActiveRunLease(run: ActiveRunSnapshot, now: Date): boolean {
  if (!["queued", "claimed", "running"].includes(run.status)) {
    return false;
  }

  return !run.leaseExpiresAt || run.leaseExpiresAt > now;
}

function normalizeLimit(value: number | undefined): number | undefined {
  if (!value || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeBudget(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }

  return value >= 0 ? value : undefined;
}
