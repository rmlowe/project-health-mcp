import { createParser } from 'eventsource-parser';
import { z } from 'zod';
import { EvidenceError } from './health.js';

const endpoint = 'https://home-climate-dashboard.robertmlowe.workers.dev/mcp';
const collection = z.object({
  retrievedAt: z.iso.datetime({ offset: true }),
  collectionStatus: z.enum(['recent_collections', 'no_data', 'no_recent_collections', 'some_rooms_stale']),
  rooms: z.array(z.object({
    name: z.string(), collectionStale: z.boolean(), validReadingStale: z.boolean(),
  })),
});

async function readReply(response) {
  const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (!response.body || !['application/json', 'text/event-stream'].includes(type)) {
    await response.body?.cancel();
    throw new EvidenceError('invalid_response');
  }
  let reply;
  const parser = createParser({ onEvent(event) {
    if (!event.data || (event.event && event.event !== 'message')) return;
    const message = JSON.parse(event.data);
    if (message?.id === 1) reply = message;
  } });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let json = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      size += value?.byteLength ?? 0;
      if (size > 1_000_000) throw new EvidenceError('response_too_large');
      const chunk = decoder.decode(value, { stream: !done });
      if (type === 'application/json') json += chunk;
      else parser.feed(chunk);
      if (reply || done) break;
    }
    return type === 'application/json' ? JSON.parse(json) : reply;
  } finally {
    await reader.cancel();
  }
}

export async function getHomeClimateHealth(env) {
  const report = { schemaVersion: 1, project: 'home-climate-dashboard', checkedAt: new Date().toISOString(), evidenceUrl: endpoint };
  try {
    if (env.HOME_CLIMATE_MCP_URL !== endpoint || !env.HOME_CLIMATE_ACCESS_CLIENT_ID || !env.HOME_CLIMATE_ACCESS_CLIENT_SECRET) {
      throw new EvidenceError('invalid_configuration');
    }
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: {
        Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
        'CF-Access-Client-Id': env.HOME_CLIMATE_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': env.HOME_CLIMATE_ACCESS_CLIENT_SECRET,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_collection_health', arguments: {} } }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new EvidenceError('http_' + response.status);
    }
    const reply = await readReply(response);
    if (reply?.jsonrpc !== '2.0' || reply.id !== 1 || reply.error || reply.result?.isError) {
      throw new EvidenceError('invalid_tool_result');
    }
    const data = collection.parse(reply.result?.structuredContent);
    let status = 'degraded';
    if (data.collectionStatus === 'no_data' || !data.rooms.length) status = 'unknown';
    else if (data.collectionStatus === 'recent_collections' && data.rooms.every(room => !room.collectionStale && !room.validReadingStale)) status = 'healthy';
    return { ...report, status, ...data };
  } catch (error) {
    const code = error instanceof EvidenceError ? error.code : 'unavailable_or_invalid_response';
    return { ...report, status: 'unknown', code };
  }
}
