import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type { Project } from "@claudex/shared";

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  trusted: number;
  created_at: string;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    trusted: row.trusted === 1,
    createdAt: row.created_at,
  };
}

export class ProjectStore {
  constructor(private readonly db: Database.Database) {}

  list(): Project[] {
    return (
      this.db
        .prepare("SELECT * FROM projects ORDER BY created_at DESC")
        .all() as ProjectRow[]
    ).map(toProject);
  }

  findById(id: string): Project | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(id) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  findByPath(absPath: string): Project | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE path = ?")
      .get(absPath) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  create(input: { name: string; path: string; trusted: boolean }): Project {
    const row: ProjectRow = {
      id: nanoid(12),
      name: input.name,
      path: input.path,
      trusted: input.trusted ? 1 : 0,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, trusted, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.name, row.path, row.trusted, row.created_at);
    return toProject(row);
  }

  setTrusted(id: string, trusted: boolean): void {
    this.db
      .prepare("UPDATE projects SET trusted = ? WHERE id = ?")
      .run(trusted ? 1 : 0, id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
}
