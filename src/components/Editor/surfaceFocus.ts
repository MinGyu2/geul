/** A creation's focus intent expires on subsequent user input/navigation. */
export interface SurfaceFocusLease { claim(): boolean; dispose(): void }
const leases = new WeakMap<object, SurfaceFocusLease>();
export const hasSurfaceFocusLease = (editor: object): boolean => leases.has(editor);

export function captureSurfaceFocus(): SurfaceFocusLease {
  let owned = true;
  const cancel = () => { owned = false; dispose(); };
  const modal = (event: FocusEvent) => {
    if (event.target instanceof Element && event.target.closest("[aria-modal='true']")) cancel();
  };
  const dispose = () => {
    document.removeEventListener("pointerdown", cancel, true);
    document.removeEventListener("keydown", cancel, true);
    document.removeEventListener("focusin", modal, true);
  };
  document.addEventListener("pointerdown", cancel, true);
  document.addEventListener("keydown", cancel, true);
  document.addEventListener("focusin", modal, true);
  return { claim: () => { dispose(); return owned; }, dispose };
}

export function setSurfaceFocusLease(editor: object, lease: SurfaceFocusLease): void {
  leases.get(editor)?.dispose();
  leases.set(editor, lease);
}

export function claimSurfaceFocus(editor: object): boolean {
  const lease = leases.get(editor);
  leases.delete(editor);
  return lease?.claim() ?? true;
}

export function releaseSurfaceFocus(editor: object): void {
  leases.get(editor)?.dispose();
  leases.delete(editor);
}
