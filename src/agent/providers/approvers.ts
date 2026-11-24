import readline from 'node:readline/promises';
import type { Approver } from '../core/ports.js';

/** Approves everything; picks a fixed style. For scripts, tests and --yes. */
export class AutoApprover implements Approver {
  constructor(private styleName: 'fast' | 'calm' = 'calm', private print = true) {}
  async storyboard(text: string): Promise<string> {
    if (this.print) console.log(`\n${text}\n(auto-approved)\n`);
    return 'approve';
  }
  async style(): Promise<'fast' | 'calm'> { return this.styleName; }
}

/** Asks on the terminal. */
export class CliApprover implements Approver {
  private async ask(q: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return await rl.question(q); } finally { rl.close(); }
  }
  async storyboard(text: string): Promise<string> {
    console.log('\n' + text + '\n');
    return this.ask('Approve this storyboard? ("approve", or describe a change) > ');
  }
  async style(samples: { name: 'fast' | 'calm'; file: string }[]): Promise<'fast' | 'calm'> {
    for (const s of samples) console.log(`  ${s.name}: ${s.file}`);
    while (true) {
      const a = (await this.ask('Which style do you prefer? [fast/calm] > ')).trim().toLowerCase();
      if (a.startsWith('f')) return 'fast';
      if (a.startsWith('c')) return 'calm';
    }
  }
}
