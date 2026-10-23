// A small confirmation dialog inside the Stash Battle modal (switching Stash ratings, Reset ELO).
// The confirm button can run an async action: the dialog stays open while it runs, closes when
// it succeeds, and shows the error if it fails.

export interface ConfirmDialogOptions {
  title: string;
  /** HTML body. */
  body: string;
  confirmLabel: string;
  /** Label on the confirm button while `action` runs. */
  workingLabel?: string;
  /** Runs on confirm; the dialog resolves true only once it succeeds. */
  action?: () => Promise<void>;
}

let cancelOpen: (() => void) | null = null;

export function isConfirmDialogOpen(): boolean {
  return cancelOpen !== null;
}

/** Cancel the open dialog (Escape), unless its action is running. */
export function cancelConfirmDialog(): void {
  cancelOpen?.();
}

/** Show the dialog; resolves true when confirmed (and its action succeeded), false when cancelled. */
export function confirmDialog(opts: ConfirmDialogOptions): Promise<boolean> {
  cancelOpen?.();
  const host = document.getElementById("sb-modal");
  if (!host) return Promise.resolve(false);

  const overlay = document.createElement("div");
  overlay.className = "sb-dialog-backdrop";
  overlay.innerHTML = `
      <div class="sb-dialog" role="dialog" aria-modal="true" aria-labelledby="sb-dialog-title">
        <h3 id="sb-dialog-title" class="sb-dialog-title">${opts.title}</h3>
        <div class="sb-dialog-body">${opts.body}</div>
        <p class="sb-dialog-error" hidden></p>
        <div class="sb-dialog-actions">
          <button type="button" class="btn btn-secondary" data-role="cancel">Cancel</button>
          <button type="button" class="btn btn-primary" data-role="confirm">${opts.confirmLabel}</button>
        </div>
      </div>`;
  host.appendChild(overlay);

  const confirmBtn = overlay.querySelector<HTMLButtonElement>('[data-role="confirm"]') as HTMLButtonElement;
  const cancelBtn = overlay.querySelector<HTMLButtonElement>('[data-role="cancel"]') as HTMLButtonElement;
  const error = overlay.querySelector<HTMLElement>(".sb-dialog-error") as HTMLElement;
  confirmBtn.focus();

  return new Promise<boolean>((resolve) => {
    let busy = false;
    const close = (result: boolean): void => {
      overlay.remove();
      cancelOpen = null;
      resolve(result);
    };
    cancelOpen = () => {
      if (!busy) close(false);
    };

    cancelBtn.addEventListener("click", () => cancelOpen?.());
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cancelOpen?.();
    });
    confirmBtn.addEventListener("click", async () => {
      if (!opts.action) {
        close(true);
        return;
      }
      busy = true;
      error.hidden = true;
      confirmBtn.disabled = cancelBtn.disabled = true;
      confirmBtn.textContent = opts.workingLabel ?? "Working...";
      try {
        await opts.action();
        close(true);
      } catch (e) {
        busy = false;
        confirmBtn.disabled = cancelBtn.disabled = false;
        confirmBtn.textContent = opts.confirmLabel;
        error.textContent = `That didn't work: ${e instanceof Error ? e.message : String(e)}. You can try again.`;
        error.hidden = false;
      }
    });
  });
}
