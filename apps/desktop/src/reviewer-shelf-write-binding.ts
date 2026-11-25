import {
  createShelfBindingFromConfirmedSelection,
  parseShelfBindingJson,
  persistShelfBinding,
  validateShelfBindingForUse,
  type SecureShelfBindingPersistenceAdapter,
  type ShelfBindingErrorCode,
} from "./shelf-binding.js";
import type { ShelfBindingStoragePaths } from "./shelf-binding-store.js";

export interface ReviewerShelfBindingContext {
  readonly shelfName: string;
  readonly shelfRoot: string;
  readonly shelfLocationPath: string;
  readonly privateShelfLocator: string;
  readonly typedMarker: unknown;
}

export interface ReviewerShelfBindingOptions {
  readonly storagePaths: ShelfBindingStoragePaths;
  readonly store: SecureShelfBindingPersistenceAdapter;
  readonly context: ReviewerShelfBindingContext;
  readonly confirmRebind: (reason: ShelfBindingErrorCode | "binding-missing", context: ReviewerShelfBindingContext) => Promise<boolean>;
  readonly reloadConfiguration: () => Promise<string | null>;
  readonly reloadTypedMarker: () => Promise<unknown>;
}

export interface ReviewerShelfWriteCoordination {
  readonly expectedShelfId: string;
  readonly coordinationRoot: string;
}

/** Resolve the stable binding before the product Reviewer writer runs. */
export async function resolveReviewerShelfWriteCoordination(
  options: ReviewerShelfBindingOptions,
): Promise<ReviewerShelfWriteCoordination> {
  const { context, store, storagePaths } = options;
  if (context.shelfRoot.length === 0 || context.privateShelfLocator.length === 0
    || pathBasenameConfiguration(context.shelfLocationPath) !== "shelf_location.yml") {
    throw new Error("The configured Private Shelf binding is invalid.");
  }

  let previousText: string | null;
  try { previousText = await store.readBindingText(); } catch {
    throw new Error("The saved Private Shelf binding cannot be read.");
  }
  const parsed = previousText === null ? null : parseShelfBindingJson(previousText);
  if (previousText !== null && (parsed === null || parsed.kind === "error")) {
    // A corrupt or newer descriptor is not silently replaced. Replacing it needs
    // a dedicated repair flow rather than normal Reviewer approval.
    throw new Error("The saved Private Shelf binding is invalid or unsupported.");
  }

  if (parsed?.kind === "valid") {
    const current = validateShelfBindingForUse({
      binding: parsed.binding,
      shelfLocationPath: context.shelfLocationPath,
      privateShelfLocator: context.privateShelfLocator,
      marker: context.typedMarker,
    });
    if (current.kind === "valid") {
      return Object.freeze({
        expectedShelfId: current.binding.expectedShelfId,
        coordinationRoot: storagePaths.coordinationRoot,
      });
    }
    if (!canReconfirm(current.code)) throw new Error("The configured Private Shelf binding cannot be verified.");
    const confirmed = await options.confirmRebind(current.code, context);
    if (!confirmed) throw new Error("Shelf binding confirmation was declined.");
  } else if (parsed === null) {
    const confirmed = await options.confirmRebind("binding-missing", context);
    if (!confirmed) throw new Error("Shelf binding confirmation was declined.");
  } else {
    throw new Error("The configured Private Shelf binding is unavailable.");
  }

  const latestLocator = await options.reloadConfiguration();
  const latestMarker = await options.reloadTypedMarker();
  if (latestLocator !== context.privateShelfLocator || !sameTypedShelfMarker(latestMarker, context.typedMarker)) {
    throw new Error("The configured Private Shelf changed during confirmation.");
  }
  const generation = parsed?.kind === "valid" ? parsed.binding.generation + 1 : 1;
  const candidate = createShelfBindingFromConfirmedSelection({
    shelfLocationPath: context.shelfLocationPath,
    privateShelfLocator: context.privateShelfLocator,
    confirmedMarker: context.typedMarker,
    generation,
  });
  if (candidate.kind === "error") throw new Error("The selected Private Shelf cannot be bound.");
  const stored = await persistShelfBinding(store, candidate.binding, parsed?.kind === "valid" ? parsed.binding.generation : null);
  if (stored.kind === "error") throw new Error("The confirmed Private Shelf binding could not be saved.");
  return Object.freeze({
    expectedShelfId: stored.binding.expectedShelfId,
    coordinationRoot: storagePaths.coordinationRoot,
  });
}

function pathBasenameConfiguration(value: string): string {
  const separator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return value.slice(separator + 1).toLocaleLowerCase("en-US");
}

function canReconfirm(code: ShelfBindingErrorCode): boolean {
  return code === "configuration-reference-mismatch"
    || code === "locator-changed"
    || code === "shelf-identity-mismatch";
}

function sameTypedShelfMarker(left: unknown, right: unknown): boolean {
  if (left === null || typeof left !== "object" || right === null || typeof right !== "object") return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return a.version === 1 && b.version === 1
    && a.type === "shelf" && b.type === "shelf"
    && typeof a.id === "string" && typeof b.id === "string"
    && a.id.toLowerCase() === b.id.toLowerCase();
}
