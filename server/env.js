// Loads ./.env into process.env when the file exists, and says nothing when it doesn't. Values
// already set in the shell win. The entry points (index.js, seed.js) import this first, so modules
// that read process.env at import time (server/ai.js) see the file's values.
import { existsSync } from "node:fs";

const ENV_FILE = ".env";

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
