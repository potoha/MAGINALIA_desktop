export type NativeInputKeybindingDecision = "dispatch" | "block" | "native";

export interface NativeInputKeybindingOptions {
  readonly commandId: string | null;
  readonly enabled: boolean;
  readonly shadowedSaveDefault: boolean;
  readonly nativeUndoRedoChord?: boolean;
  readonly shadowedQuickOpenDefault?: boolean;
}

/** Keep editor mutations in native fields, while allowing global workbench actions. */
export function decideNativeInputKeybinding({
  commandId,
  enabled,
  shadowedSaveDefault,
  nativeUndoRedoChord = false,
  shadowedQuickOpenDefault = false
}: NativeInputKeybindingOptions): NativeInputKeybindingDecision {
  if (nativeUndoRedoChord) return "native";
  if (commandId === "maginalia.document.save") return enabled ? "dispatch" : "block";
  if (commandId === "maginalia.workbench.showQuickOpen") return enabled ? "dispatch" : "block";
  if (commandId !== null && enabled
    && !commandId.startsWith("maginalia.editor.")
    && commandId !== "maginalia.document.applyProperties") return "dispatch";
  if (shadowedSaveDefault || shadowedQuickOpenDefault) return "block";
  if (commandId?.startsWith("maginalia.editor.") || commandId === "maginalia.document.applyProperties") return "native";
  return "native";
}
