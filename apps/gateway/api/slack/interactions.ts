import { handle } from '../../src/runtime.js';

export const POST = (request: Request) => handle(request, 'interactions');
