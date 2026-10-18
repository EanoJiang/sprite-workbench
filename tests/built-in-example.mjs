import fs from 'node:fs/promises';

// Browser regressions follow the same checked-in snapshot as the application.
export default JSON.parse(await fs.readFile(new URL('../public/built-in-example/manifest.json', import.meta.url), 'utf8'));
