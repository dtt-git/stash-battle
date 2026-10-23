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
}

declare global {
  interface Window {
    PluginApi?: PluginApiLike;
  }
}
