declare module 'sidecar_sdk' {
  export interface SidecarResponseInit {
    status?: number;
    contentType?: string;
    headers?: Record<string, string>;
  }

  export class Response {
    constructor(body: string | Buffer, init?: SidecarResponseInit);
  }

  export interface SidecarConfig {
    conversationId?: string;
    [key: string]: unknown;
  }

  export type PageHandler = (data?: Record<string, unknown>) => string | Response | Promise<string | Response>;
  export type ApiHandler = (data: Record<string, unknown>) => unknown | Response | Promise<unknown | Response>;

  export class SidecarApp {
    readonly config: SidecarConfig;
    constructor();
    page(path: string, handler: PageHandler): void;
    api(path: string, handler: ApiHandler, method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'): void;
    run(): void;
  }
}
