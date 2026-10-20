// A process of its own that writes to the initiative store: node tsx store-worker.mts <db file> <worker> <count>
import { openStore } from '../../src/initiatives/store.ts';

const [file, worker, count] = process.argv.slice(2) as [string, string, string];
const store = await openStore(file);
for (let i = 0; i < Number(count); i += 1) {
  const created = await store.createInitiative({ repoPath: '/w/repo', title: `worker ${worker} #${i}`, goal: '' });
  process.stdout.write(`${created.id}\n`);
}
store.close();
