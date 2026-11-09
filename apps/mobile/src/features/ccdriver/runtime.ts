import { fetch as nativeFetch } from "expo/fetch";
import type { CCDriverFetch } from "@t3tools/client-runtime/ccdriver/client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { CCDriverController } from "@t3tools/client-runtime/ccdriver/controller";

const fetchWithTimeout: CCDriverFetch = async (input, init) => {
  const controller = new AbortController();
  const parent = init?.signal;
  const abort = () => controller.abort();
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort);
  const timer = setTimeout(abort, 15_000);
  try {
    return await nativeFetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
};

export function makeCCDriverController() {
  return new CCDriverController({
    fetch: fetchWithTimeout,
    allowLocalHttp: __DEV__,
    newID: () => Crypto.randomUUID(),
    secrets: {
      read: (key) => SecureStore.getItemAsync(key),
      write: (key, value) =>
        SecureStore.setItemAsync(key, value, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }),
      remove: (key) => SecureStore.deleteItemAsync(key),
    },
    data: {
      read: (key) => AsyncStorage.getItem(key),
      write: (key, value) => AsyncStorage.setItem(key, value),
      remove: (key) => AsyncStorage.removeItem(key),
    },
  });
}
