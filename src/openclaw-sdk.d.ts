declare module "openclaw/plugin-sdk/channel-entry-contract" {
  export function defineBundledChannelEntry<TPlugin = unknown, TApi = unknown>(options: {
    id: string;
    name: string;
    description: string;
    importMetaUrl: string;
    plugin: {
      specifier: string;
      exportName?: string;
    };
    registerCliMetadata?: (api: TApi) => void;
    registerFull?: (api: TApi) => void;
  }): TPlugin;
}

declare module "openclaw/plugin-sdk/channel-reply-pipeline" {
  export function createChannelReplyPipeline(params: {
    cfg: unknown;
    agentId: string;
    channel?: string;
    accountId?: string;
    typing?: {
      start: () => Promise<void> | void;
      onStartError?: (err: unknown) => void;
    };
  }): {
    typingCallbacks?: unknown;
  };
}

declare module "openclaw/plugin-sdk/media-runtime" {
  export function saveMediaBuffer(
    buffer: Buffer,
    contentType: string,
    source?: string,
    subdir?: string,
    fileName?: string,
  ): Promise<{ path: string; contentType?: string | null }>;

  export function buildAgentMediaPayload(
    mediaList: Array<{ path: string; contentType?: string | null }>,
  ): {
    MediaPath?: string;
    MediaType?: string;
    MediaPaths?: string[];
    MediaTypes?: string[];
  };
}
