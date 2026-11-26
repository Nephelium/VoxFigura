import { startProxy } from './proxy.mjs';
import { handleContestRequest } from './contest-routes.mjs';

// The hosting process can supply credentials through its environment.
// For a user-selected file, Node also supports: node --env-file=<path> server/hackathon.mjs
startProxy(handleContestRequest, 3002);
