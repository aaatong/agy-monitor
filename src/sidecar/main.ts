import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  buildHealthResponse,
  buildMonitorStateResponse,
  updateModelLimit,
} from './state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_INDEX_PATH = join(__dirname, 'web', 'index.html');

const app = new SidecarApp();

app.page('/', () => {
  try {
    return readFileSync(WEB_INDEX_PATH, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      `<!doctype html><html><body><h1>AGY Monitor UI missing</h1><pre>${message}</pre></body></html>`,
      { status: 500, contentType: 'text/html; charset=utf-8' },
    );
  }
});

app.api('/api/health', () => buildHealthResponse(), 'GET');

app.api(
  '/api/state',
  (data) => {
    const queryRootId =
      data && typeof data.rootId === 'string' ? data.rootId.trim() : '';
    const queryConvId =
      data && typeof data.conversationId === 'string' ? data.conversationId.trim() : '';
    const envConvId =
      typeof app.config?.conversationId === 'string' ? app.config.conversationId.trim() : '';
    const clientRootId =
      data && typeof data.clientRootId === 'string' ? data.clientRootId.trim() : undefined;
    const clientSource =
      data && typeof data.clientSource === 'string' ? data.clientSource.trim() : undefined;
    const scope =
      data && typeof data.scope === 'string' ? data.scope.trim() : undefined;
    const clientScope =
      data && typeof data.clientScope === 'string' ? data.clientScope.trim() : undefined;
    const rawVersion = data?.version;
    const parsedVersion =
      typeof rawVersion === 'number'
        ? rawVersion
        : typeof rawVersion === 'string' && rawVersion.trim() !== ''
          ? Number(rawVersion)
          : undefined;

    return buildMonitorStateResponse({
      rootId: queryRootId || undefined,
      conversationId: queryConvId || undefined,
      envConversationId: envConvId || undefined,
      scope: scope || undefined,
      clientRootId,
      clientSource,
      clientScope,
      version:
        typeof parsedVersion === 'number' && Number.isFinite(parsedVersion)
          ? parsedVersion
          : undefined,
    });
  },
  'GET',
);

app.api('/api/model-limit', (data) => {
  const model = data && typeof data.model === 'string' ? data.model : '';
  const rawLimit = data?.limitTokens;
  const limitTokens = typeof rawLimit === 'number' ? rawLimit : Number(rawLimit);
  const result = updateModelLimit(model, limitTokens);
  if (!result.ok) {
    return new Response(JSON.stringify(result), {
      status: 400,
      contentType: 'application/json',
    });
  }
  return result;
});

app.run();
