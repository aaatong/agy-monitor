import type {
  ModelLimitRequest,
  ModelLimitResponse,
  MonitorStateResponse,
} from '../../shared/types';

function getFetcher(): (path: string, init?: RequestInit) => Promise<Response> {
  return window.sidecar?.fetch
    ? (p: string, init?: RequestInit) => window.sidecar!.fetch!(p, init)
    : (p: string, init?: RequestInit) => window.fetch(p, init);
}

export interface FetchStateParams {
  version?: number;
  conversationId?: string;
  rootId?: string;
}

export async function fetchMonitorState(
  params: FetchStateParams,
): Promise<MonitorStateResponse> {
  const qs = new URLSearchParams();
  if (params.version !== undefined) {
    qs.set('version', String(params.version));
  }
  if (params.conversationId) {
    qs.set('conversationId', params.conversationId);
  }
  if (params.rootId) {
    qs.set('rootId', params.rootId);
  }
  const query = qs.toString();
  const path = query ? `/api/state?${query}` : '/api/state';

  const fetcher = getFetcher();
  const res = await fetcher(path, {
    method: 'GET',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as MonitorStateResponse;
}

export async function saveModelLimit(
  payload: ModelLimitRequest,
): Promise<ModelLimitResponse> {
  const fetcher = getFetcher();
  const res = await fetcher('/api/model-limit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as ModelLimitResponse;
}
