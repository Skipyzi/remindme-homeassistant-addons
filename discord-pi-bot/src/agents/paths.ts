import { resolve } from "node:path";

/** Where the CLI agents keep their accounts, sessions and working folders. */
export const agentDirectory = () => resolve(process.env.AGENT_DATA_DIR || "./data/agents");
