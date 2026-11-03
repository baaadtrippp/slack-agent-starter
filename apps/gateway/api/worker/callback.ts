import { handle } from '../../src/runtime.js';

export const GET = (request: Request) => handle(request, 'callback');
export const POST = GET;
