import { type Role, uuidv7 } from "@rea-web/contracts";
import type { Database } from "../database.js";
import { conflictOnUnique, firstRow, toIso } from "../support.js";
import type {
  ApiTokenRecord,
  MemberListing,
  MembershipRecord,
  ProjectRecord,
  ProjectWithRole,
  SessionRecord,
  UserRecord,
} from "../types.js";

export interface UsersRepository {
  create(input: {
    id?: string;
    email: string;
    password_hash: string;
    display_name?: string | null;
  }): Promise<UserRecord>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  count(): Promise<number>;
}

export function usersRepository(db: Database): UsersRepository {
  return {
    create: (input) =>
      conflictOnUnique("email already registered", async () => {
        const result = await db.query<UserRecord>(
          `INSERT INTO users(id, email, password_hash, display_name)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [
            input.id ?? uuidv7(),
            input.email,
            input.password_hash,
            input.display_name ?? null,
          ],
        );
        return result.rows[0] as UserRecord;
      }),
    async findByEmail(email) {
      const result = await db.query<UserRecord>(
        "SELECT * FROM users WHERE email = $1",
        [email],
      );
      return firstRow(result.rows);
    },
    async findById(id) {
      const result = await db.query<UserRecord>(
        "SELECT * FROM users WHERE id = $1",
        [id],
      );
      return firstRow(result.rows);
    },
    async count() {
      const result = await db.query<{ n: number }>(
        "SELECT count(*) AS n FROM users",
      );
      return result.rows[0]?.n ?? 0;
    },
  };
}

export interface SessionsRepository {
  create(input: {
    id: string;
    user_id: string;
    expires_at: string | Date;
  }): Promise<SessionRecord>;
  /** Returns the session only while it has not expired. */
  findActive(id: string): Promise<SessionRecord | null>;
  delete(id: string): Promise<boolean>;
  deleteExpired(): Promise<number>;
}

export function sessionsRepository(db: Database): SessionsRepository {
  return {
    async create(input) {
      const result = await db.query<SessionRecord>(
        `INSERT INTO sessions(id, user_id, expires_at) VALUES ($1, $2, $3)
         RETURNING *`,
        [input.id, input.user_id, toIso(input.expires_at)],
      );
      return result.rows[0] as SessionRecord;
    },
    async findActive(id) {
      const result = await db.query<SessionRecord>(
        "SELECT * FROM sessions WHERE id = $1 AND expires_at > clock_timestamp()",
        [id],
      );
      return firstRow(result.rows);
    },
    async delete(id) {
      const result = await db.query("DELETE FROM sessions WHERE id = $1", [id]);
      return (result.rowCount ?? 0) > 0;
    },
    async deleteExpired() {
      const result = await db.query(
        "DELETE FROM sessions WHERE expires_at <= clock_timestamp()",
      );
      return result.rowCount ?? 0;
    },
  };
}

export interface ApiTokensRepository {
  create(input: {
    id?: string;
    user_id: string;
    name: string;
    token_hash: string;
    expires_at?: string | Date | null;
  }): Promise<ApiTokenRecord>;
  /** Not revoked, not expired; records `last_used_at`. */
  findActiveByHash(hash: string): Promise<ApiTokenRecord | null>;
  listByUser(user_id: string): Promise<ApiTokenRecord[]>;
  /** Revokes only a token owned by `user_id`; false when none matched. */
  revoke(id: string, user_id: string): Promise<boolean>;
}

export function apiTokensRepository(db: Database): ApiTokensRepository {
  return {
    async create(input) {
      const result = await db.query<ApiTokenRecord>(
        `INSERT INTO api_tokens(id, user_id, name, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          input.id ?? uuidv7(),
          input.user_id,
          input.name,
          input.token_hash,
          input.expires_at === undefined || input.expires_at === null
            ? null
            : toIso(input.expires_at),
        ],
      );
      return result.rows[0] as ApiTokenRecord;
    },
    async findActiveByHash(hash) {
      const result = await db.query<ApiTokenRecord>(
        `UPDATE api_tokens SET last_used_at = clock_timestamp()
         WHERE token_hash = $1 AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > clock_timestamp())
         RETURNING *`,
        [hash],
      );
      return firstRow(result.rows);
    },
    async listByUser(user_id) {
      const result = await db.query<ApiTokenRecord>(
        "SELECT * FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC, id DESC",
        [user_id],
      );
      return result.rows;
    },
    async revoke(id, user_id) {
      const result = await db.query(
        `UPDATE api_tokens SET revoked_at = clock_timestamp()
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [id, user_id],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export interface ProjectsRepository {
  /** Inserts the project and an `owner` membership for `created_by` atomically. */
  create(input: {
    id?: string;
    slug: string;
    name: string;
    created_by: string;
  }): Promise<ProjectRecord>;
  findById(id: string): Promise<ProjectRecord | null>;
  findBySlug(slug: string): Promise<ProjectRecord | null>;
  listForUser(user_id: string): Promise<ProjectWithRole[]>;
}

export function projectsRepository(db: Database): ProjectsRepository {
  return {
    create: (input) =>
      conflictOnUnique("project slug already exists", () =>
        db.withTransaction(async (client) => {
          const result = await client.query<ProjectRecord>(
            `INSERT INTO projects(id, slug, name, created_by)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [input.id ?? uuidv7(), input.slug, input.name, input.created_by],
          );
          const project = result.rows[0] as ProjectRecord;
          await client.query(
            `INSERT INTO memberships(project_id, user_id, role)
             VALUES ($1, $2, 'owner')`,
            [project.id, input.created_by],
          );
          return project;
        }),
      ),
    async findById(id) {
      const result = await db.query<ProjectRecord>(
        "SELECT * FROM projects WHERE id = $1",
        [id],
      );
      return firstRow(result.rows);
    },
    async findBySlug(slug) {
      const result = await db.query<ProjectRecord>(
        "SELECT * FROM projects WHERE slug = $1",
        [slug],
      );
      return firstRow(result.rows);
    },
    async listForUser(user_id) {
      const result = await db.query<ProjectWithRole>(
        `SELECT p.*, m.role FROM projects p
         JOIN memberships m ON m.project_id = p.id
         WHERE m.user_id = $1 ORDER BY p.created_at, p.id`,
        [user_id],
      );
      return result.rows;
    },
  };
}

export interface MembershipsRepository {
  upsert(input: {
    project_id: string;
    user_id: string;
    role: Role;
  }): Promise<MembershipRecord>;
  roleFor(project_id: string, user_id: string): Promise<Role | null>;
  list(project_id: string): Promise<MemberListing[]>;
  remove(project_id: string, user_id: string): Promise<boolean>;
}

export function membershipsRepository(db: Database): MembershipsRepository {
  return {
    async upsert(input) {
      const result = await db.query<MembershipRecord>(
        `INSERT INTO memberships(project_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
         RETURNING *`,
        [input.project_id, input.user_id, input.role],
      );
      return result.rows[0] as MembershipRecord;
    },
    async roleFor(project_id, user_id) {
      const result = await db.query<{ role: Role }>(
        "SELECT role FROM memberships WHERE project_id = $1 AND user_id = $2",
        [project_id, user_id],
      );
      return result.rows[0]?.role ?? null;
    },
    async list(project_id) {
      const result = await db.query<MemberListing>(
        `SELECT m.*, u.email, u.display_name FROM memberships m
         JOIN users u ON u.id = m.user_id
         WHERE m.project_id = $1 ORDER BY m.created_at, u.email`,
        [project_id],
      );
      return result.rows;
    },
    async remove(project_id, user_id) {
      const result = await db.query(
        "DELETE FROM memberships WHERE project_id = $1 AND user_id = $2",
        [project_id, user_id],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}
