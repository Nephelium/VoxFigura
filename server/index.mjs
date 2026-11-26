import { handleCardRequest } from './card-encoding.mjs';
import { startProxy } from './proxy.mjs';

startProxy(handleCardRequest);
