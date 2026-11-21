type Key = {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

// DOM codes already describe physical modifiers: Command/Windows = Meta,
// Option/Alt = Alt. Translating Meta to Control breaks Win+R, Win+Tab, etc.
export function remoteKeyAction(key: Key, targetPlatform: string) {
  const pasteModifier =
    targetPlatform === "darwin"
      ? key.metaKey && !key.ctrlKey
      : key.ctrlKey && !key.metaKey;
  if (key.code === "KeyV" && pasteModifier && !key.altKey && !key.shiftKey)
    return "paste";
  if (key.key.length === 1 && !key.metaKey && !key.ctrlKey && !key.altKey)
    return "text";
  return "key";
}

export function isModifier(code: string) {
  return /^(Meta|Control|Alt|Shift)(Left|Right)$/.test(code);
}
