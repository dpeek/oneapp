declare global {
  const chrome: {
    runtime: {
      readonly lastError?: { message?: string };
      sendMessage(
        extensionId: string,
        message: unknown,
        callback: (response: unknown) => void,
      ): void;
      onMessageExternal: {
        addListener(
          listener: (
            message: unknown,
            sender: {
              origin?: string;
              frameId?: number;
              tab?: { id?: number };
            },
            respond: (response: unknown) => void,
          ) => boolean | undefined,
        ): void;
      };
    };
    storage: {
      local: {
        get(key: string): Promise<Record<string, unknown>>;
        set(values: Record<string, unknown>): Promise<void>;
        remove(key: string): Promise<void>;
        setAccessLevel(options: {
          accessLevel: "TRUSTED_CONTEXTS";
        }): Promise<void>;
      };
    };
    tabs: {
      create(options: {
        active: boolean;
        url: string;
      }): Promise<{ id?: number }>;
      update(
        id: number,
        options: { active: boolean; url: string },
      ): Promise<unknown>;
      query(options: {
        active: boolean;
        currentWindow: boolean;
      }): Promise<{ url?: string }[]>;
    };
  };
}

export {};
