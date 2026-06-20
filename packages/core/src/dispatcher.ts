import { decideDispatch } from "./dispatch.js";
import { resolveRepositoryForTask } from "./repository-routing.js";
import type {
  ActiveRunSnapshot,
  AgentRole,
  DispatchBudgetPolicy,
  DispatchConcurrencyPolicy,
  DispatchDecision,
  RepositoryRef,
  TaskSnapshot,
} from "./types.js";

export interface DispatchCandidate {
  task: TaskSnapshot;
  decision: DispatchDecision;
}

export interface ClaimedRun {
  taskId: string;
  identifier: string;
  repositoryId: string;
  role: AgentRole;
  leaseOwner: string;
  leaseExpiresAt: Date;
  maxActiveRunsPerRepository?: number;
  maxActiveRunsPerRole?: number;
  maxActiveRunsPerAgent?: number;
  maxEstimatedCostUsdPerRun?: number;
}

export interface DispatchCycleInput {
  tasks: readonly TaskSnapshot[];
  repositories: readonly RepositoryRef[];
  activeRuns: readonly ActiveRunSnapshot[];
  workerId: string;
  leaseTtlMs: number;
  concurrencyPolicy?: DispatchConcurrencyPolicy;
  budgetPolicy?: DispatchBudgetPolicy;
  now?: Date;
}

export interface DispatchCycleResult {
  candidates: DispatchCandidate[];
  claimed: ClaimedRun[];
  skipped: DispatchCandidate[];
}

export function runDispatchCycle(input: DispatchCycleInput): DispatchCycleResult {
  const now = input.now ?? new Date();
  const candidates: DispatchCandidate[] = [];
  const claimed: ClaimedRun[] = [];
  const activeRuns: ActiveRunSnapshot[] = [...input.activeRuns];

  for (const task of input.tasks) {
    const decision = decideDispatch(
      task,
      input.repositories,
      activeRuns,
      now,
      input.concurrencyPolicy,
      input.budgetPolicy,
    );
    const candidate = { task, decision };
    candidates.push(candidate);

    if (!candidate.decision.dispatchable || !candidate.decision.role) {
      continue;
    }

    const repository = resolveRepositoryForTask(candidate.task, input.repositories);
    if (!repository) {
      throw new Error(`Dispatchable task ${candidate.task.identifier} has no repository`);
    }

    const run = {
      taskId: candidate.task.id,
      identifier: candidate.task.identifier,
      repositoryId: repository.id,
      role: candidate.decision.role as AgentRole,
      leaseOwner: input.workerId,
      leaseExpiresAt: new Date(now.getTime() + input.leaseTtlMs),
      ...(input.concurrencyPolicy?.maxActiveRunsPerRepository
        ? {
            maxActiveRunsPerRepository: input.concurrencyPolicy.maxActiveRunsPerRepository,
          }
        : {}),
      ...(input.concurrencyPolicy?.maxActiveRunsPerRole
        ? { maxActiveRunsPerRole: input.concurrencyPolicy.maxActiveRunsPerRole }
        : {}),
      ...(input.concurrencyPolicy?.maxActiveRunsPerAgent
        ? { maxActiveRunsPerAgent: input.concurrencyPolicy.maxActiveRunsPerAgent }
        : {}),
      ...(input.budgetPolicy?.maxEstimatedCostUsdPerRun !== undefined
        ? { maxEstimatedCostUsdPerRun: input.budgetPolicy.maxEstimatedCostUsdPerRun }
        : {}),
    };
    claimed.push(run);
    activeRuns.push({
      taskId: run.taskId,
      repositoryId: run.repositoryId,
      role: run.role,
      status: "claimed",
      leaseExpiresAt: run.leaseExpiresAt,
    });
  }

  return {
    candidates,
    claimed,
    skipped: candidates.filter((candidate) => !candidate.decision.dispatchable),
  };
}
