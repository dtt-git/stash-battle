// Minimal typing for the parts of Stash's window.PluginApi that Stash Battle uses.

export type ReactNode = unknown;

export interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: ReactNode[]): ReactNode;
  Fragment: unknown;
  useState<T>(initial: T): [T, (value: T) => void];
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
}

export interface PluginApiLike {
  React: ReactLike;
  /** Patchable components, keyed by name (e.g. "MainNavBar.MenuItems"). */
  components?: Record<string, unknown>;
  /** Loaders resolving to the component's module (they don't add it to `components`). */
  loadableComponents?: Record<string, () => Promise<Record<string, unknown>>>;
  patch: {
    /** `fn` gets the render function's args and returns the args to render with instead. */
    before(component: string, fn: (...args: unknown[]) => unknown[]): void;
    /** `fn` gets the render function's args with the rendered result appended last. */
    after(component: string, fn: (...args: unknown[]) => ReactNode): void;
  };
  /** Stash's own events, e.g. "stash:location" after each SPA navigation. */
  Event?: EventTarget;
  utils?: {
    StashService?: {
      /** Stash's Apollo client: the cache behind Stash's own pages. */
      getClient?(): ApolloClientLike;
    };
  };
}

/** The parts of Apollo's InMemoryCache that Stash Battle uses to keep Stash's pages current. */
export interface ApolloCacheLike {
  identify(object: { __typename: string; id: string }): string | undefined;
  modify(options: { id: string; fields: Record<string, (existing: unknown) => unknown> }): boolean;
  evict(options: { id: string; fieldName?: string }): boolean;
  gc(): string[];
}

export interface ApolloClientLike {
  cache: ApolloCacheLike;
}

declare global {
  interface Window {
    PluginApi?: PluginApiLike;
  }
}
