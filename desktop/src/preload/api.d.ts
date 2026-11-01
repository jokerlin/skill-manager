import type { SkmApi } from "../shared/types";

declare global {
  interface Window {
    readonly skm: SkmApi;
  }
}
export {};
