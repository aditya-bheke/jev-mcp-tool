import { CheckpointEngine } from './checkpoints.js';
import { ErrorIntel } from './errorIntel.js';
import { EvictionStore } from './evicted.js';
import { Indexer } from './indexer.js';
import { InvestigationEngine } from './investigations.js';
import { MemoryEngine } from './memory.js';
import { Router } from './router.js';
import { SearchEngine } from './search.js';
import { Telemetry } from './telemetry.js';

/** Engines only keep a reference to ctx; they reach each other lazily through ctx.engines. */
export function createEngines(ctx) {
  return {
    telemetry: new Telemetry(ctx),
    memory: new MemoryEngine(ctx),
    indexer: new Indexer(ctx),
    search: new SearchEngine(ctx),
    evicted: new EvictionStore(ctx),
    errors: new ErrorIntel(ctx),
    checkpoints: new CheckpointEngine(ctx),
    investigations: new InvestigationEngine(ctx),
    router: new Router(ctx),
  };
}
