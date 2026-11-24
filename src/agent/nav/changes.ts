import fs from 'node:fs';

export type ChangeKind = 'heal' | 'rename' | 'removed' | 'broken_edge' | 'pre_action' | 'new_state';

export interface Change {
  kind: ChangeKind;
  at: string;
  actionId?: string;
  edgeId?: string;
  stateId?: string;
  from?: string;
  to?: string;
  via?: string;
  note?: string;
}

/**
 * Append-only change log (B3). Nothing in the graph is deleted: a renamed
 * control keeps its id, a missing one gets status "missing", a failing edge
 * becomes BROKEN_ACTION, and each of those is written here.
 */
export class ChangeLog {
  entries: Change[] = [];
  constructor(private file?: string) {}

  add(c: Omit<Change, 'at'>): Change {
    const entry = { ...c, at: new Date().toISOString() };
    this.entries.push(entry);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    return entry;
  }

  of(kind: ChangeKind) {
    return this.entries.filter(e => e.kind === kind);
  }
}
