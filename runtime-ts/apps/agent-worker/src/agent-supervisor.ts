import { createHash } from "node:crypto";
import { type AgentThreadId, agentThreadId } from "@cube-runtime/domain";
import {
  type RuntimeAgentEvent,
  type ThreadActiveHistoryV1,
  type ThreadHistoryMessageV1,
  threadActiveHistoryDigest,
} from "@cube-runtime/pi-adapter";
import { digestCanonical } from "./mutation-protocol.js";
import type {
  AgentControlPersistencePort,
  AgentControlPort,
  AgentExecutionIdentity,
  AgentForkTurns,
  AgentMailboxUpdate,
  AgentSummary,
  ConsumedExternalEffectAuthorization,
  DelegableAgentToolName,
  WorkerAgentSessionPort,
} from "./ports.js";
import { DELEGABLE_AGENT_TOOL_NAMES } from "./ports.js";

interface ChildState {
  readonly agentThreadId: AgentThreadId;
  readonly path: string;
  readonly task: string;
  readonly tools: readonly DelegableAgentToolName[];
  readonly toolManifestDigest: ReturnType<typeof digestCanonical>;
  readonly forkTurns: AgentForkTurns;
  turnOrdinal: number;
  status: AgentSummary["status"];
  history: ThreadActiveHistoryV1 | undefined;
  session: WorkerAgentSessionPort | undefined;
  interruptRequested: boolean;
  readonly pendingSteers: string[];
  readonly activeMessages: string[];
}

interface AgentSupervisorDependencies {
  readonly persistence: AgentControlPersistencePort;
  readonly rootAgentThreadId: AgentThreadId;
  readonly attemptId: string;
  readonly fence: Parameters<AgentControlPersistencePort["initializeRoot"]>[0]["fence"];
  readonly maxThreads?: number;
  readonly maxConcurrentAgents?: number;
  readonly createSession: (input: {
    readonly identity: AgentExecutionIdentity;
    readonly tools: readonly DelegableAgentToolName[];
    readonly history?: ThreadActiveHistoryV1;
  }) => Promise<WorkerAgentSessionPort>;
  readonly authorizeModelStart: (input: {
    readonly identity: AgentExecutionIdentity;
    readonly prompt: string;
  }) => Promise<ConsumedExternalEffectAuthorization>;
  readonly onToolEvent: (
    identity: AgentExecutionIdentity,
    event: Extract<RuntimeAgentEvent, { type: "tool.started" | "tool.completed" }>,
  ) => Promise<void>;
}

const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_FINAL_BYTES = 64 * 1024;

function boundedText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return value.slice(0, end);
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 40)}`;
}

function forkHistory(
  source: ThreadActiveHistoryV1 | undefined,
  policy: AgentForkTurns,
): ThreadActiveHistoryV1 | undefined {
  if (source === undefined || policy === "none") return undefined;
  if (policy === "all") return source;
  const userIndexes = source.messages.flatMap((message, index) =>
    message.role === "user" ? [index] : [],
  );
  const start = userIndexes[Math.max(0, userIndexes.length - policy)] ?? source.messages.length;
  const messages = source.messages.slice(start);
  if (messages.length === 0) return undefined;
  const unsigned = {
    schemaVersion: 1 as const,
    projectionSchemaVersion: 1 as const,
    throughSequence: source.throughSequence,
    messages: Object.freeze([...messages]),
  };
  return Object.freeze({ ...unsigned, digest: threadActiveHistoryDigest(unsigned) });
}

function appendTurnHistory(
  history: ThreadActiveHistoryV1 | undefined,
  prompt: string,
  turn: Extract<RuntimeAgentEvent, { type: "turn.completed" }>,
): ThreadActiveHistoryV1 {
  const messages: ThreadHistoryMessageV1[] = [...(history?.messages ?? [])];
  let sequence = history?.throughSequence ?? 0;
  messages.push({ sequence: ++sequence, role: "user", text: prompt, timestamp: Date.now() });
  messages.push({ sequence: ++sequence, role: "assistant", ...turn.assistant });
  for (const result of turn.toolResults) {
    messages.push({ sequence: ++sequence, role: "toolResult", ...result });
  }
  const unsigned = {
    schemaVersion: 1 as const,
    projectionSchemaVersion: 1 as const,
    throughSequence: sequence,
    messages: Object.freeze(messages),
  };
  return Object.freeze({ ...unsigned, digest: threadActiveHistoryDigest(unsigned) });
}

function finalText(turn: Extract<RuntimeAgentEvent, { type: "turn.completed" }>): string {
  return boundedText(
    turn.assistant.content
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join("\n")
      .trim() || "子 Agent 已完成任务，但没有返回文本摘要。",
    MAX_FINAL_BYTES,
  );
}

export class AgentSupervisor implements AgentControlPort {
  readonly #children = new Map<AgentThreadId, ChildState>();
  readonly #paths = new Map<string, AgentThreadId>();
  readonly #updates: AgentMailboxUpdate[] = [];
  readonly #waiters = new Set<() => void>();
  readonly #activeTasks = new Set<Promise<void>>();
  readonly #interruptedCommands = new Map<string, AgentThreadId>();
  readonly #maxThreads: number;
  readonly #maxActiveSubagents: number;
  #parentHistory: ThreadActiveHistoryV1 | undefined;
  #stopping = false;

  constructor(private readonly dependencies: AgentSupervisorDependencies) {
    this.#maxThreads = dependencies.maxThreads ?? 16;
    this.#maxActiveSubagents = (dependencies.maxConcurrentAgents ?? 4) - 1;
    if (this.#maxActiveSubagents < 1) throw new Error("AGENT_CAPACITY_INVALID");
  }

  async initialize(): Promise<void> {
    const result = await this.dependencies.persistence.initializeRoot({
      fence: this.dependencies.fence,
      attemptId: this.dependencies.attemptId,
      rootAgentThreadId: this.dependencies.rootAgentThreadId,
    });
    if (result.outcome !== "ready") {
      throw new Error(`AGENT_ROOT_${result.outcome.toUpperCase()}`);
    }
    for (const conversation of result.conversations) {
      if (conversation.toolManifestDigest !== digestCanonical({ tools: conversation.tools })) {
        throw new Error("AGENT_TOOL_MANIFEST_CONFLICT");
      }
      const child: ChildState = {
        agentThreadId: conversation.agentThreadId,
        path: conversation.canonicalPath,
        task: conversation.task,
        tools: conversation.tools,
        toolManifestDigest: conversation.toolManifestDigest,
        forkTurns: conversation.forkTurns,
        turnOrdinal: conversation.turnOrdinal,
        status: "idle",
        history: conversation.history,
        session: undefined,
        interruptRequested: false,
        pendingSteers: [],
        activeMessages: [],
      };
      this.#children.set(child.agentThreadId, child);
      this.#paths.set(child.path, child.agentThreadId);
    }
  }

  setParentHistory(history: ThreadActiveHistoryV1 | undefined): void {
    this.#parentHistory = history;
  }

  async spawn(input: Parameters<AgentControlPort["spawn"]>[0]): Promise<AgentSummary> {
    if (this.#stopping) throw new Error("AGENT_SUPERVISOR_STOPPING");
    if (
      typeof input.forkTurns === "number" &&
      (!Number.isSafeInteger(input.forkTurns) || input.forkTurns < 1 || input.forkTurns > 10_000)
    ) {
      throw new Error("AGENT_FORK_TURNS_INVALID");
    }
    const task = boundedText(input.task, MAX_MESSAGE_BYTES);
    if (!task.trim()) throw new Error("AGENT_TASK_INVALID");
    const tools = this.#validateTools(input.tools);
    const toolManifestDigest = digestCanonical({ tools });
    const commandId = stableId("cmd", "spawn", input.callId);
    const childId = agentThreadId(
      stableId(
        "agent",
        this.dependencies.fence.scope.threadId,
        this.dependencies.fence.scope.runId,
        commandId,
      ),
    );
    if (!this.#children.has(childId)) this.#assertCapacity();
    const turnId = stableId("turn", childId, "1");
    const path = `/root/${childId.slice(0, 18)}`;
    const history = forkHistory(this.#parentHistory, input.forkTurns);
    const snapshot = {
      agentThreadId: childId,
      parentAgentThreadId: this.dependencies.rootAgentThreadId,
      canonicalPath: path,
      task,
      tools,
      toolManifestDigest,
      forkTurns: input.forkTurns,
      turnId,
      turnOrdinal: 1,
      ...(history === undefined ? {} : { history }),
    } as const;
    const persisted = await this.dependencies.persistence.spawn({
      fence: this.dependencies.fence,
      attemptId: this.dependencies.attemptId,
      commandId,
      argsDigest: digestCanonical({
        task,
        tools,
        toolManifestDigest,
        forkTurns: input.forkTurns,
      }),
      snapshot,
      maxThreads: this.#maxThreads,
      maxActiveSubagents: this.#maxActiveSubagents,
    });
    if (persisted.outcome === "capacity") throw new Error("AGENT_CAPACITY_EXCEEDED");
    if (persisted.outcome !== "created" && persisted.outcome !== "replayed") {
      throw new Error(`AGENT_SPAWN_${persisted.outcome.toUpperCase()}`);
    }
    let child = this.#children.get(childId);
    if (child === undefined) {
      child = {
        agentThreadId: childId,
        path,
        task,
        tools,
        toolManifestDigest,
        forkTurns: input.forkTurns,
        turnOrdinal: 1,
        status: "running",
        history,
        session: undefined,
        interruptRequested: false,
        pendingSteers: [],
        activeMessages: [],
      };
      this.#children.set(childId, child);
      this.#paths.set(path, childId);
      this.#startTurn(child, turnId, task);
    }
    return this.#summary(child);
  }

  async sendMessage(input: Parameters<AgentControlPort["sendMessage"]>[0]): Promise<void> {
    const child = this.#requireChild(input.target);
    if (child.status !== "running") {
      throw new Error("AGENT_NOT_RUNNING");
    }
    const message = boundedText(input.message, MAX_MESSAGE_BYTES);
    const commandId = stableId("cmd", "send", input.callId);
    const recorded = await this.dependencies.persistence.recordCommand({
      fence: this.dependencies.fence,
      attemptId: this.dependencies.attemptId,
      callerAgentThreadId: this.dependencies.rootAgentThreadId,
      commandId,
      kind: "send_message",
      argsDigest: digestCanonical({ target: child.agentThreadId, message }),
      result: Object.freeze({ delivered: true }),
    });
    if (recorded !== "recorded" && recorded !== "replayed") {
      throw new Error(`AGENT_MESSAGE_${recorded.toUpperCase()}`);
    }
    const mailbox = await this.dependencies.persistence.appendMailbox({
      fence: this.dependencies.fence,
      attemptId: this.dependencies.attemptId,
      commandId: `${commandId}:mailbox`,
      recipientAgentThreadId: child.agentThreadId,
      senderAgentThreadId: this.dependencies.rootAgentThreadId,
      kind: "message",
      payload: message,
    });
    if (mailbox.outcome !== "created" && mailbox.outcome !== "replayed") {
      throw new Error(`AGENT_MESSAGE_${mailbox.outcome.toUpperCase()}`);
    }
    if (mailbox.outcome === "replayed") return;
    child.activeMessages.push(message);
    if (child.session === undefined) {
      child.pendingSteers.push(message);
      return;
    }
    try {
      await child.session.steer({ text: message, attachments: [] });
    } catch (error) {
      child.activeMessages.pop();
      throw error;
    }
  }

  async followUp(input: Parameters<AgentControlPort["followUp"]>[0]): Promise<AgentSummary> {
    if (this.#stopping) throw new Error("AGENT_SUPERVISOR_STOPPING");
    const child = this.#requireChild(input.target);
    if (child.status === "running" || child.session !== undefined) {
      throw new Error("AGENT_BUSY");
    }
    const ordinal = child.turnOrdinal + 1;
    const turnId = stableId("turn", child.agentThreadId, String(ordinal));
    const task = boundedText(input.task, MAX_MESSAGE_BYTES);
    if (!task.trim()) throw new Error("AGENT_TASK_INVALID");
    const prompt = task;
    const persisted = await this.dependencies.persistence.queueFollowUp({
      fence: this.dependencies.fence,
      attemptId: this.dependencies.attemptId,
      callerAgentThreadId: this.dependencies.rootAgentThreadId,
      commandId: stableId("cmd", "follow", input.callId),
      argsDigest: digestCanonical({ target: child.agentThreadId, task }),
      agentThreadId: child.agentThreadId,
      turnId,
      turnOrdinal: ordinal,
      task: prompt,
      maxActiveSubagents: this.#maxActiveSubagents,
    });
    if (persisted !== "created" && persisted !== "replayed") {
      throw new Error(`AGENT_FOLLOW_UP_${persisted.toUpperCase()}`);
    }
    if (persisted === "replayed") return this.#summary(child);
    child.turnOrdinal = ordinal;
    child.status = "running";
    child.interruptRequested = false;
    this.#startTurn(child, turnId, prompt);
    return this.#summary(child);
  }

  async interrupt(input: Parameters<AgentControlPort["interrupt"]>[0]): Promise<AgentSummary> {
    const child = this.#requireChild(input.target);
    const commandId = stableId("cmd", "interrupt", input.callId);
    const interrupted = this.#interruptedCommands.get(commandId);
    if (interrupted !== undefined) {
      if (interrupted !== child.agentThreadId) throw new Error("AGENT_INTERRUPT_CONFLICT");
      return this.#summary(child);
    }
    if (child.status !== "running" || child.session === undefined)
      throw new Error("AGENT_NOT_RUNNING");
    const recorded = await this.dependencies.persistence.recordCommand({
      fence: this.dependencies.fence,
      attemptId: this.dependencies.attemptId,
      callerAgentThreadId: this.dependencies.rootAgentThreadId,
      commandId,
      kind: "interrupt",
      argsDigest: digestCanonical({ target: child.agentThreadId }),
      result: Object.freeze({ interrupted: true }),
    });
    if (recorded !== "recorded" && recorded !== "replayed") {
      throw new Error(`AGENT_INTERRUPT_${recorded.toUpperCase()}`);
    }
    child.interruptRequested = true;
    await child.session.abort();
    this.#interruptedCommands.set(commandId, child.agentThreadId);
    return this.#summary(child);
  }

  async list(): Promise<readonly AgentSummary[]> {
    return Object.freeze([...this.#children.values()].map((child) => this.#summary(child)));
  }

  async wait(
    input: Parameters<AgentControlPort["wait"]>[0],
  ): Promise<readonly AgentMailboxUpdate[]> {
    const available = () => this.#updates.filter((item) => item.sequence > input.afterSequence);
    const current = available();
    if (current.length > 0 || input.timeoutMs <= 0 || input.signal?.aborted) return current;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#waiters.delete(finish);
        input.signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.min(60_000, input.timeoutMs));
      this.#waiters.add(finish);
      input.signal?.addEventListener("abort", finish, { once: true });
    });
    return Object.freeze(available());
  }

  async drain(): Promise<void> {
    while (this.#activeTasks.size > 0) await Promise.all([...this.#activeTasks]);
  }

  async abortAll(): Promise<void> {
    this.#stopping = true;
    await Promise.all(
      [...this.#children.values()].flatMap((child) =>
        child.session === undefined ? [] : [child.session.abort().catch(() => undefined)],
      ),
    );
    await this.drain();
  }

  #startTurn(child: ChildState, turnId: string, prompt: string): void {
    const task = this.#runTurn(child, turnId, prompt).catch(() => undefined);
    this.#activeTasks.add(task);
    void task.finally(() => this.#activeTasks.delete(task));
  }

  async #runTurn(child: ChildState, turnId: string, prompt: string): Promise<void> {
    const identity: AgentExecutionIdentity = Object.freeze({
      agentThreadId: child.agentThreadId,
      agentTurnId: turnId,
      agentKind: "subagent",
    });
    let session: WorkerAgentSessionPort | undefined;
    let completedTurn: Extract<RuntimeAgentEvent, { type: "turn.completed" }> | undefined;
    let completedHistory = child.history;
    let completedTurnCount = 0;
    let toolFailure: Error | undefined;
    const pendingToolEvents = new Set<Promise<void>>();
    try {
      const started = await this.dependencies.persistence.startTurn({
        fence: this.dependencies.fence,
        attemptId: this.dependencies.attemptId,
        agentThreadId: child.agentThreadId,
        turnId,
      });
      if (started !== "started" && started !== "replayed") {
        throw new Error(`AGENT_TURN_START_${started.toUpperCase()}`);
      }
      if (this.#stopping) throw new Error("AGENT_SUPERVISOR_STOPPING");
      session = await this.dependencies.createSession({
        identity,
        tools: child.tools,
        ...(child.history === undefined ? {} : { history: child.history }),
      });
      child.session = session;
      for (const message of child.pendingSteers.splice(0)) {
        await session.steer({ text: message, attachments: [] });
      }
      if (this.#stopping) {
        child.interruptRequested = true;
        await session.abort().catch(() => undefined);
        throw new Error("AGENT_SUPERVISOR_STOPPING");
      }
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "turn.completed") {
          const turnPrompt =
            completedTurnCount === 0 ? prompt : (child.activeMessages.shift() ?? "继续执行任务");
          completedTurnCount += 1;
          completedHistory = appendTurnHistory(completedHistory, turnPrompt, event);
          completedTurn = event;
        }
        if (event.type === "tool.started" || event.type === "tool.completed") {
          const persistence = this.dependencies
            .onToolEvent(identity, event)
            .catch((error) => {
              toolFailure =
                error instanceof Error ? error : new Error("AGENT_TOOL_PERSISTENCE_FAILED");
              void session?.abort().catch(() => undefined);
            })
            .finally(() => pendingToolEvents.delete(persistence));
          pendingToolEvents.add(persistence);
        }
      });
      try {
        const prepared = await session.prepareInput({ text: prompt, attachments: [] });
        const authorization = await this.dependencies.authorizeModelStart({ identity, prompt });
        const outcome = await session.runPrompt(prepared, authorization);
        while (pendingToolEvents.size > 0) await Promise.all([...pendingToolEvents]);
        if (toolFailure !== undefined) throw toolFailure;
        if (outcome.kind !== "completed" || completedTurn === undefined) {
          throw new Error(`AGENT_TURN_${outcome.kind.toUpperCase()}`);
        }
      } finally {
        unsubscribe();
      }
      if (completedHistory === undefined) throw new Error("AGENT_HISTORY_MISSING");
      const answer = finalText(completedTurn);
      const settled = await this.dependencies.persistence.settleTurn({
        fence: this.dependencies.fence,
        attemptId: this.dependencies.attemptId,
        agentThreadId: child.agentThreadId,
        turnId,
        status: "completed",
        finalAnswer: answer,
        history: completedHistory,
      });
      if (settled !== "settled" && settled !== "replayed") {
        throw new Error(`AGENT_TURN_SETTLE_${settled.toUpperCase()}`);
      }
      child.history = completedHistory;
      child.status = "idle";
      await this.#publish(child, turnId, "final_answer", answer);
    } catch (error) {
      const interrupted = child.interruptRequested || this.#stopping;
      child.status = interrupted ? "interrupted" : "failed";
      const message = boundedText(
        error instanceof Error ? error.message : "子 Agent 执行失败",
        MAX_MESSAGE_BYTES,
      );
      await this.dependencies.persistence
        .settleTurn({
          fence: this.dependencies.fence,
          attemptId: this.dependencies.attemptId,
          agentThreadId: child.agentThreadId,
          turnId,
          status: interrupted ? "interrupted" : "failed",
          errorCode: interrupted ? "INTERRUPTED" : "SUBAGENT_FAILED",
        })
        .catch(() => undefined);
      await this.#publish(child, turnId, "error", message).catch(() => undefined);
    } finally {
      child.activeMessages.length = 0;
      child.pendingSteers.length = 0;
      child.session = undefined;
      session?.dispose();
    }
  }

  async #publish(
    child: ChildState,
    turnId: string,
    kind: "final_answer" | "error",
    payload: string,
  ): Promise<void> {
    const persisted = await this.dependencies.persistence.appendMailbox({
      fence: this.dependencies.fence,
      attemptId: this.dependencies.attemptId,
      commandId: stableId("mail", child.agentThreadId, turnId, kind),
      recipientAgentThreadId: this.dependencies.rootAgentThreadId,
      senderAgentThreadId: child.agentThreadId,
      kind,
      payload,
    });
    if (persisted.outcome !== "created" && persisted.outcome !== "replayed") {
      throw new Error(`AGENT_MAILBOX_${persisted.outcome.toUpperCase()}`);
    }
    this.#updates.push({ sequence: persisted.sequence, senderPath: child.path, kind, payload });
    this.#updates.sort((left, right) => left.sequence - right.sequence);
    for (const wake of this.#waiters) wake();
  }

  #requireChild(target: string): ChildState {
    const byId = this.#children.get(target as AgentThreadId);
    const pathId = this.#paths.get(target);
    const child = byId ?? (pathId === undefined ? undefined : this.#children.get(pathId));
    if (child === undefined) throw new Error("AGENT_NOT_FOUND");
    return child;
  }

  #validateTools(tools: readonly DelegableAgentToolName[]): readonly DelegableAgentToolName[] {
    const allowed = new Set<DelegableAgentToolName>(DELEGABLE_AGENT_TOOL_NAMES);
    const unique = [...new Set(tools)];
    if (unique.some((tool) => !allowed.has(tool))) {
      throw new Error("AGENT_TOOLS_INVALID");
    }
    return Object.freeze(unique);
  }

  #assertCapacity(): void {
    const active = [...this.#children.values()].filter(
      (child) => child.status === "running",
    ).length;
    if (this.#children.size >= this.#maxThreads || active >= this.#maxActiveSubagents) {
      throw new Error("AGENT_CAPACITY_EXCEEDED");
    }
  }

  #summary(child: ChildState): AgentSummary {
    return Object.freeze({
      agentThreadId: child.agentThreadId,
      path: child.path,
      task: child.task,
      status: child.status,
      turnOrdinal: child.turnOrdinal,
      tools: child.tools,
    });
  }
}

export function rootAgentThreadId(attemptId: string): AgentThreadId {
  return agentThreadId(`root_${createHash("sha256").update(attemptId, "utf8").digest("hex")}`);
}
