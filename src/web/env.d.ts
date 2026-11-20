interface AntigravitySidecarBridge {
  conversationId?: string;
  fetch?: (path: string, init?: RequestInit) => Promise<Response>;
  ui?: {
    toggleConversation?: (conversationId: string) => void;
  };
}

declare global {
  interface Window {
    sidecar?: AntigravitySidecarBridge;
  }
}

export {};
