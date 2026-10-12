import { BridgeAgentClient } from '../src/sdk.js';

async function main() {
  const client = new BridgeAgentClient({
    agentId: 'stream-agent',
    agentName: 'stream_reporter',
    description: 'Slow Node SDK agent reporting progress and partial output',
    capabilities: ['streaming'],
    expectedDuration: 'slow 1-3 min',
    token: 'stream_token_123',
    hubUrl: 'ws://127.0.0.1:3001/agent/ws',
  });

  await client.connect();
  console.log('[StreamAgent] Connected and online.');

  client.onTask(async (task, ctx) => {
    console.log(`[StreamAgent] Received task: ${task.prompt}`);
    ctx.progress('Processing chunk 1/3', 33, 20);
    ctx.partial('Intermediate analysis: Step 1 completed with status OK');
    await new Promise((r) => setTimeout(r, 2000));
    ctx.progress('Processing chunk 2/3', 66, 10);
    ctx.partial('Intermediate analysis: Step 2 completed. Final aggregation in progress.');
    await new Promise((r) => setTimeout(r, 2000));
    return 'Final completed report from stream_reporter agent.';
  });
}

main().catch(console.error);
