// Clean mode: open Stash's own DeleteScenesDialog, so deleting from a battle behaves exactly like
// deleting in Stash (same options and defaults, file list, delete call and toast).
//
// The dialog needs Stash's React context (intl, configuration, Apollo, toasts), so it can't be
// rendered standalone. Instead a small bridge component is patched into Stash's navbar (always
// mounted) and opens the dialog when Battle asks for it. react-bootstrap portals the modal to
// <body>; CSS lifts it above the battle modal while Battle is open.

import { graphqlQuery } from "../graphql";
import type { ReactNode } from "../pluginApi";
import type { Scene } from "../types";

/** Scene fields DeleteScenesDialog reads (file list, funscript, mutation ids). */
interface DeletableScene {
  id: string;
  title: string | null;
  interactive: boolean;
  files: { path: string }[];
}

const OPEN_EVENT = "stash-battle:open-delete-dialog";
const CLOSE_EVENT = "stash-battle:close-delete-dialog";

let bridgeRegistered = false;
let pendingResult: ((deleted: boolean) => void) | null = null;
/** Stash's DeleteScenesDialog component, once its chunk has loaded. */
let DeleteScenesDialog: unknown = null;
let dialogLoaded: Promise<void> = Promise.resolve();

function settle(deleted: boolean): void {
  const resolve = pendingResult;
  pendingResult = null;
  resolve?.(deleted);
}

/** True when this Stash exposes its delete dialog to plugins (Clean mode depends on it). */
export function isStashDeleteDialogAvailable(): boolean {
  return bridgeRegistered;
}

export function isDeleteDialogOpen(): boolean {
  return pendingResult !== null;
}

/** Close the dialog without deleting (e.g. when the battle modal closes). */
export function cancelDeleteDialog(): void {
  if (!pendingResult) return;
  window.dispatchEvent(new CustomEvent(CLOSE_EVENT));
  settle(false);
}

/** Patch the bridge into Stash's navbar. Call once at startup, before the navbar renders. */
export function registerDeleteDialogBridge(): void {
  const api = window.PluginApi;
  if (bridgeRegistered || !api?.loadableComponents?.DeleteScenesDialog) {
    if (!api?.loadableComponents?.DeleteScenesDialog) {
      console.warn("[Stash Battle] Stash's delete dialog isn't available to plugins; Clean mode is disabled");
    }
    return;
  }
  bridgeRegistered = true;
  const { React } = api;

  // Load the dialog's chunk up front so it opens instantly
  dialogLoaded = api.loadableComponents
    .DeleteScenesDialog()
    .then((mod) => {
      DeleteScenesDialog = mod.DeleteScenesDialog ?? mod.default ?? null;
    })
    .catch((e) => console.error("[Stash Battle] Failed to load Stash's delete dialog:", e));

  function DeleteBridge(): ReactNode {
    const [scene, setScene] = React.useState<DeletableScene | null>(null);

    React.useEffect(() => {
      const open = (e: Event): void => {
        // The navbar can render more than once; the first bridge to hear the event handles it.
        // preventDefault tells confirmDeleteScene the request was picked up.
        e.stopImmediatePropagation();
        e.preventDefault();
        setScene((e as CustomEvent<DeletableScene>).detail);
      };
      const close = (): void => setScene(null);
      window.addEventListener(OPEN_EVENT, open);
      window.addEventListener(CLOSE_EVENT, close);
      return () => {
        window.removeEventListener(OPEN_EVENT, open);
        window.removeEventListener(CLOSE_EVENT, close);
      };
    }, []);

    if (!scene || !DeleteScenesDialog) return null;
    return React.createElement(DeleteScenesDialog, {
      selected: [scene],
      onClose: (deleted: boolean) => {
        setScene(null);
        settle(deleted);
      },
    });
  }

  // Stash appends the rendered result after the call's args, and another plugin's `before` patch
  // can change how many args there are, so the result is always the last one, not a fixed slot.
  api.patch.after("MainNavBar.UtilityItems", (...args: unknown[]) =>
    React.createElement(
      React.Fragment,
      null,
      args[args.length - 1] as ReactNode,
      React.createElement(DeleteBridge),
    ),
  );
}

/**
 * Open Stash's delete dialog for `scene`. Resolves true once Stash has deleted it, false if the
 * user cancelled (or the delete failed — Stash shows its own error toast).
 */
export async function confirmDeleteScene(scene: Scene): Promise<boolean> {
  if (!bridgeRegistered) return false;
  cancelDeleteDialog();
  await dialogLoaded;
  if (!DeleteScenesDialog) return false;

  const { findScene } = await graphqlQuery<{ findScene: DeletableScene | null }>(
    `query BattleDeletableScene($id: ID!) { findScene(id: $id) { id title interactive files { path } } }`,
    { id: scene.id },
  );
  if (!findScene) return false;

  const result = new Promise<boolean>((resolve) => {
    pendingResult = resolve;
  });

  // Stash renders the navbar after plugins load, so the bridge is mounted well before anyone can
  // click a delete button; if it somehow isn't, say so rather than faking a navigation
  if (!requestDialog(findScene)) {
    console.warn("[Stash Battle] Stash's delete dialog bridge isn't mounted");
    settle(false);
    window.alert("Couldn't open Stash's delete dialog. Reload the page and try again.");
  }
  return result;
}

/** Ask the bridge to open the dialog; false if no bridge is mounted to pick it up. */
function requestDialog(scene: DeletableScene): boolean {
  const request = new CustomEvent(OPEN_EVENT, { detail: scene, cancelable: true });
  return !window.dispatchEvent(request);
}
