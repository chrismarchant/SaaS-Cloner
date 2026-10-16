import {
  ReaSession,
  EvidenceOwnershipError,
  type ReaSessionOptions,
} from "./session.js";

/**
 * Owns every live session on a runner. Routes follow-up calls to the owning
 * session and refuses evidence references that belong to another session.
 */
export class SessionManager {
  private readonly sessions = new Map<string, ReaSession>();
  private readonly byInvestigation = new Map<string, string>();

  async open(
    investigationId: string,
    options: ReaSessionOptions,
  ): Promise<ReaSession> {
    if (this.byInvestigation.has(investigationId))
      throw new Error(
        `investigation ${investigationId} already has a live session`,
      );
    const session = new ReaSession(options);
    await session.start();
    this.sessions.set(session.id, session);
    this.byInvestigation.set(investigationId, session.id);
    return session;
  }

  get(sessionId: string): ReaSession | undefined {
    return this.sessions.get(sessionId);
  }

  forInvestigation(investigationId: string): ReaSession | undefined {
    const id = this.byInvestigation.get(investigationId);
    return id ? this.sessions.get(id) : undefined;
  }

  /** Which live session retains this evidence id, if any. */
  ownerOf(evidenceId: string): ReaSession | null {
    for (const session of this.sessions.values())
      if (session.ownsEvidence(evidenceId)) return session;
    return null;
  }

  /** Resolve the session a follow-up must run in, or throw with the real owner. */
  routeEvidence(sessionId: string, evidenceId: string): ReaSession {
    const requested = this.sessions.get(sessionId);
    if (!requested) throw new Error(`session ${sessionId} is not live`);
    if (requested.ownsEvidence(evidenceId)) return requested;
    const owner = this.ownerOf(evidenceId);
    throw new EvidenceOwnershipError(evidenceId, owner?.id ?? null, sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await session.close();
    this.sessions.delete(sessionId);
    for (const [inv, sid] of this.byInvestigation)
      if (sid === sessionId) this.byInvestigation.delete(inv);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  get size(): number {
    return this.sessions.size;
  }
}
